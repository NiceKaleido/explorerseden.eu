#!/usr/bin/env node
'use strict';

/**
 * Fetches structure + biome lists for vanilla Minecraft and external Modrinth packs,
 * then writes data-pack-configurator/data/pack-data.json.
 *
 * Run during CI after the clone phase so source repos are available for EE pack scanning.
 */

const fs = require('fs');
const path = require('path');
const { createWriteStream, existsSync, mkdirSync, statSync } = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..', '..');
const OUT_PATH = path.join(ROOT, 'data-pack-configurator', 'data', 'pack-data.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'configurator-pack-data');

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// MC_VERSIONS_OF_INTEREST is derived dynamically from the Mojang manifest at runtime.

const EXTERNAL_PACKS = [
  { slug: 'biomes-o-plenty',      displayName: "Biomes O' Plenty" },
  { slug: 'terralith',            displayName: 'Terralith' },
  { slug: 'dungeons-and-taverns', displayName: 'Dungeons and Taverns' },
  { slug: 'incendium',            displayName: 'Incendium' },
  { slug: 'explorify',            displayName: 'Explorify' },
];

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_UA  = 'ExplorersEdenWebsite/1.0 (github.com/Explorers-Eden)';
const MCMETA_API   = 'https://api.github.com/repos/misode/mcmeta/git/trees';

// ── Helpers ──────────────────────────────────────────────────────────────────

function warn(msg) { console.warn('[configurator-data] WARNING:', msg); }
function log(msg)  { console.log('[configurator-data]', msg); }

async function fetchJson(url, headers = {}) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': MODRINTH_UA, Accept: 'application/json', ...headers },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

function isFreshCache(filePath) {
  if (!existsSync(filePath)) return false;
  return (Date.now() - statSync(filePath).mtimeMs) < CACHE_TTL_MS;
}

async function downloadToCache(url, cacheFile) {
  if (isFreshCache(cacheFile)) return cacheFile;
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  const resp = await fetch(url, { headers: { 'User-Agent': MODRINTH_UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`);
  const buf = await resp.arrayBuffer();
  fs.writeFileSync(cacheFile, Buffer.from(buf));
  return cacheFile;
}

// ── ZIP extraction ────────────────────────────────────────────────────────────

function loadJSZip() {
  // Standard require (works after npm install, or via NODE_PATH in CI)
  try { return require('jszip'); } catch { /* fall through */ }
  // Explicit path fallbacks for environments without proper NODE_PATH
  for (const p of [
    path.join(ROOT, '.cache', 'wiki-node-deps', 'node_modules', 'jszip'),
    path.join(ROOT, 'node_modules', 'jszip'),
  ]) {
    if (existsSync(p)) { try { return require(p); } catch { /* skip */ } }
  }
  throw new Error('jszip not found — run npm install or check wiki-node-deps cache');
}

async function extractIdsFromZip(zipPath) {
  const JSZip = loadJSZip();
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);
  const ids = { structures: [], biomes: [] };
  for (const zipEntryPath of Object.keys(zip.files)) {
    if (/^data\/[^/]+\/worldgen\/structure\/.+\.json$/.test(zipEntryPath)) {
      const parts = zipEntryPath.split('/');
      if (parts[1] === 'minecraft') continue;
      ids.structures.push(`${parts[1]}:${parts.slice(4).join('/').replace(/\.json$/, '')}`);
    } else if (/^data\/[^/]+\/worldgen\/biome\/.+\.json$/.test(zipEntryPath)) {
      const parts = zipEntryPath.split('/');
      if (parts[1] === 'minecraft') continue;
      ids.biomes.push(`${parts[1]}:${parts.slice(4).join('/').replace(/\.json$/, '')}`);
    }
  }
  return ids;
}

// ── pack_format → version table ───────────────────────────────────────────────

// Returns { map, versions } — map is pack_format → MC version string.
// Starts from a hardcoded table (Mojang's version API doesn't expose pack formats),
// then extends it with any newer releases discovered via the mcmeta tag list.
async function buildPackFormatMap() {
  const yaml = require('js-yaml');
  const versionMappings = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', 'version-mappings.yml'), 'utf8'));

  // YAML is version → format; invert to format → latest version (last entry per format wins)
  const map = {};
  for (const [ver, fmt] of Object.entries(versionMappings.data_pack_formats)) {
    map[String(fmt)] = String(ver);
  }
  const knownVersions = new Set(Object.keys(versionMappings.data_pack_formats));

  // Try to discover any newer versions not yet in the hardcoded table
  try {
    log('Checking mcmeta for newer MC versions…');
    const authHeaders = {
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    };
    const refs = await fetchJson('https://api.github.com/repos/misode/mcmeta/git/refs/tags', authHeaders);

    for (const ref of refs) {
      const tag = ref.ref.replace('refs/tags/', '');
      if (!tag.endsWith('-data')) continue;
      const ver = tag.slice(0, -5);
      // Only release versions — pre-releases / snapshots share formats with their release
      if (!/^\d+\.\d+(\.\d+)?$/.test(ver)) continue;
      const [major, minor] = ver.split('.').map(Number);
      // Accept 1.21+ (legacy scheme) OR 26.x+ (year-based scheme starting 2026)
      const isLegacy = major === 1 && minor >= 21;
      const isYearBased = major >= 26;
      if (!isLegacy && !isYearBased) continue;
      if (knownVersions.has(ver)) continue;

      try {
        const resp = await fetch(
          `https://raw.githubusercontent.com/misode/mcmeta/${tag}/pack.mcmeta`,
          { headers: { 'User-Agent': MODRINTH_UA } },
        );
        if (!resp.ok) continue;
        const meta = await resp.json();
        const fmt = meta?.pack?.pack_format;
        if (fmt != null) {
          map[String(fmt)] = ver;
          knownVersions.add(ver);
          log(`  Discovered ${ver} → pack_format ${fmt}`);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    warn(`Could not extend pack_format map via mcmeta: ${err.message}`);
  }

  const versions = [...new Set(Object.values(map))].sort();
  log(`Pack format versions: ${versions.join(', ')}`);
  return { map, versions };
}

// ── Vanilla structures + biomes via misode/mcmeta ─────────────────────────────

async function fetchVanillaData(mcVersion) {
  log(`Fetching vanilla data for ${mcVersion}…`);
  const result = { structures: [], biomes: [] };
  try {
    const tag = `${mcVersion}-data`;
    const cacheKey = path.join(CACHE_DIR, 'vanilla', `${mcVersion}.json`);
    if (isFreshCache(cacheKey)) {
      return JSON.parse(fs.readFileSync(cacheKey, 'utf8'));
    }
    const tree = await fetchJson(`${MCMETA_API}/${tag}?recursive=1`, {
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    });
    for (const item of (tree.tree || [])) {
      if (item.type !== 'blob') continue;
      const p = item.path;
      // Vanilla worldgen/structure and worldgen/biome JSONs are always flat (no subdirs)
      if (/^data\/minecraft\/worldgen\/structure\/[^/]+\.json$/.test(p)) {
        result.structures.push('minecraft:' + p.split('/')[4].replace(/\.json$/, ''));
      } else if (/^data\/minecraft\/worldgen\/biome\/[^/]+\.json$/.test(p)) {
        result.biomes.push('minecraft:' + p.split('/')[4].replace(/\.json$/, ''));
      }
    }
    mkdirSync(path.dirname(cacheKey), { recursive: true });
    fs.writeFileSync(cacheKey, JSON.stringify(result));
    log(`  ${mcVersion}: ${result.structures.length} structures, ${result.biomes.length} biomes`);
  } catch (err) {
    warn(`Could not fetch vanilla data for ${mcVersion}: ${err.message}`);
  }
  return result;
}

// ── Vanilla item list via misode/mcmeta ───────────────────────────────────────
// Fetches all item IDs from the latest MC version.
// 1.21.2+: items are at data/minecraft/item/*.json
// Older:   fall back to assets/minecraft/models/item/*.json
async function fetchVanillaItems(mcVersion) {
  const cacheKey = path.join(CACHE_DIR, 'vanilla-items', `${mcVersion}.json`);
  if (isFreshCache(cacheKey)) {
    log(`  Using cached vanilla items for ${mcVersion}`);
    return JSON.parse(fs.readFileSync(cacheKey, 'utf8'));
  }

  log(`Fetching vanilla items for ${mcVersion}…`);
  const items = [];
  try {
    const tag = `${mcVersion}-data`;
    const authHeaders = {
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    };
    const tree = await fetchJson(`${MCMETA_API}/${tag}?recursive=1`, authHeaders);

    for (const entry of (tree.tree || [])) {
      if (entry.type !== 'blob') continue;
      const p = entry.path;
      if (/^data\/minecraft\/item\/[^/]+\.json$/.test(p)) {
        items.push('minecraft:' + p.split('/')[3].replace(/\.json$/, ''));
      }
    }

    // Fallback: assets/minecraft/models/item/ (older versions without data/minecraft/item/)
    if (!items.length) {
      const assetsTag = `${mcVersion}-assets`;
      try {
        const assetsTree = await fetchJson(`${MCMETA_API}/${assetsTag}?recursive=1`, authHeaders);
        for (const entry of (assetsTree.tree || [])) {
          if (entry.type !== 'blob') continue;
          const p = entry.path;
          if (/^assets\/minecraft\/models\/item\/[^/]+\.json$/.test(p)) {
            items.push('minecraft:' + p.split('/')[4].replace(/\.json$/, ''));
          }
        }
      } catch { /* assets tag may not exist */ }
    }

    items.sort();
    mkdirSync(path.dirname(cacheKey), { recursive: true });
    fs.writeFileSync(cacheKey, JSON.stringify(items));
    log(`  vanilla items ${mcVersion}: ${items.length} items`);
  } catch (err) {
    warn(`Could not fetch vanilla items for ${mcVersion}: ${err.message}`);
  }
  return items;
}

// ── External pack data from Modrinth ─────────────────────────────────────────

async function fetchExternalPackData(slug, displayName, mcVersions) {
  log(`Fetching Modrinth data for ${slug}…`);
  const packEntry = { slug, displayName, byVersion: {} };
  try {
    // Include all common loaders so mods (fabric/forge) with embedded data packs are covered
    const loaders = encodeURIComponent(JSON.stringify(['datapack', 'fabric', 'forge', 'neoforge', 'quilt']));
    const versions = await fetchJson(`${MODRINTH_API}/project/${slug}/version?loaders=${loaders}`);
    // Group by game version — keep only versions we have vanilla data for
    const byGameVer = {};
    for (const ver of versions) {
      for (const gv of (ver.game_versions || [])) {
        if (!mcVersions.includes(gv)) continue;
        if (!byGameVer[gv] || ver.date_published > byGameVer[gv].date_published) {
          byGameVer[gv] = ver;
        }
      }
    }

    for (const [gameVer, ver] of Object.entries(byGameVer)) {
      const primaryFile = ver.files?.find(f => f.primary) ?? ver.files?.[0];
      if (!primaryFile?.url) continue;

      const versionId = ver.id;
      const cacheFile = path.join(CACHE_DIR, slug, `${versionId}.zip`);
      const cacheResult = path.join(CACHE_DIR, slug, `${versionId}.ids.json`);

      let ids;
      if (isFreshCache(cacheResult)) {
        ids = JSON.parse(fs.readFileSync(cacheResult, 'utf8'));
      } else {
        try {
          await downloadToCache(primaryFile.url, cacheFile);
          ids = await extractIdsFromZip(cacheFile);
          mkdirSync(path.dirname(cacheResult), { recursive: true });
          fs.writeFileSync(cacheResult, JSON.stringify(ids));
        } catch (err) {
          warn(`  Could not process ${slug} version ${versionId}: ${err.message}`);
          ids = { structures: [], biomes: [] };
        }
      }

      packEntry.byVersion[gameVer] = ids;
      log(`  ${slug} ${gameVer}: ${ids.structures.length} structures, ${ids.biomes.length} biomes`);
    }
  } catch (err) {
    warn(`Could not fetch ${slug} from Modrinth: ${err.message}`);
  }
  return packEntry;
}

// ── Vanilla worldgen tag pre-resolution ──────────────────────────────────────

// Fetches all data/minecraft/tags/worldgen/biome/*.json and structure/*.json
// for the given MC version from misode/mcmeta and fully resolves them into
// flat ID lists.  Result: { biome: { "#minecraft:is_overworld": [...], ... }, structure: {...} }
async function fetchVanillaTags(mcVersion) {
  const cacheKey = path.join(CACHE_DIR, 'vanilla-tags', `${mcVersion}.json`);
  if (isFreshCache(cacheKey)) {
    log(`  Using cached vanilla tags for ${mcVersion}`);
    return JSON.parse(fs.readFileSync(cacheKey, 'utf8'));
  }

  log(`Fetching vanilla worldgen tags for ${mcVersion}…`);
  const result = { biome: {}, structure: {} };

  try {
    const tag = `${mcVersion}-data`;
    const authHeaders = {
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    };
    const tree = await fetchJson(`${MCMETA_API}/${tag}?recursive=1`, authHeaders);

    // Collect paths of all worldgen biome/structure tag files
    const tagFilePaths = [];
    for (const item of (tree.tree || [])) {
      if (item.type !== 'blob') continue;
      if (/^data\/minecraft\/tags\/worldgen\/(biome|structure)\//.test(item.path)) {
        tagFilePaths.push(item.path);
      }
    }

    // Fetch raw tag JSON files (sequential — raw.githubusercontent.com is not rate-limited)
    const rawTags = { biome: {}, structure: {} };
    for (const filePath of tagFilePaths) {
      const m = filePath.match(/\/tags\/worldgen\/(biome|structure)\/(.+)\.json$/);
      if (!m) continue;
      const [, type, localName] = m;
      const tagRef = `#minecraft:${localName}`;
      try {
        const resp = await fetch(
          `https://raw.githubusercontent.com/misode/mcmeta/${tag}/${filePath}`,
          { headers: { 'User-Agent': MODRINTH_UA } }
        );
        if (!resp.ok) continue;
        rawTags[type][tagRef] = (await resp.json()).values || [];
      } catch { /* skip */ }
    }

    // Recursively resolve tag refs to flat biome/structure ID lists
    function resolveVanillaTag(tagRef, type, visited = new Set()) {
      if (visited.has(tagRef)) return [];
      visited.add(tagRef);
      const out = [];
      for (const entry of (rawTags[type]?.[tagRef] || [])) {
        const id = typeof entry === 'string' ? entry : (entry?.id ?? entry?.value ?? null);
        if (!id) continue;
        if (id.startsWith('#')) {
          resolveVanillaTag(id, type, new Set(visited)).forEach(r => out.push(r));
        } else {
          out.push(id);
        }
      }
      return [...new Set(out)];
    }

    for (const type of ['biome', 'structure']) {
      for (const tagRef of Object.keys(rawTags[type])) {
        const resolved = resolveVanillaTag(tagRef, type);
        if (resolved.length) result[type][tagRef] = resolved;
      }
    }

    log(`  vanilla tags: ${Object.keys(result.biome).length} biome tags, ${Object.keys(result.structure).length} structure tags`);
    mkdirSync(path.dirname(cacheKey), { recursive: true });
    fs.writeFileSync(cacheKey, JSON.stringify(result));
  } catch (err) {
    warn(`Could not fetch vanilla tags for ${mcVersion}: ${err.message}`);
  }

  return result;
}

// ── EE manifests → structures + biomes ───────────────────────────────────────

function scanDirRecursive(dir, ns, prefix, out, suffix) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      scanDirRecursive(fullPath, ns, prefix ? `${prefix}/${entry}` : entry, out, suffix);
    } else if (entry.endsWith(suffix)) {
      const localId = (prefix ? `${prefix}/` : '') + entry.slice(0, -suffix.length);
      out.push(`${ns}:${localId}`);
    }
  }
}

function readEeManifests() {
  const result = {};
  const sourceRoot = path.join(ROOT, '.cache', 'source-repos');
  if (!existsSync(sourceRoot)) return result;

  let slugDirs;
  try { slugDirs = fs.readdirSync(sourceRoot); } catch { return result; }

  for (const slugDir of slugDirs) {
    let stat;
    try { stat = fs.statSync(path.join(sourceRoot, slugDir)); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const dataDir = path.join(sourceRoot, slugDir, 'data');
    if (!existsSync(dataDir)) continue;

    const structures = [];
    const biomes = [];

    let nsDirs;
    try { nsDirs = fs.readdirSync(dataDir); } catch { continue; }
    for (const ns of nsDirs) {
      if (ns === 'minecraft') continue;
      try { if (!fs.statSync(path.join(dataDir, ns)).isDirectory()) continue; } catch { continue; }
      const structDir = path.join(dataDir, ns, 'worldgen', 'structure');
      if (existsSync(structDir)) scanDirRecursive(structDir, ns, '', structures, '.json');
      const biomeDir = path.join(dataDir, ns, 'worldgen', 'biome');
      if (existsSync(biomeDir)) scanDirRecursive(biomeDir, ns, '', biomes, '.json');
    }

    if (!structures.length && !biomes.length) continue;

    // Display name: try pack.mcmeta description, fall back to slug → Title Case
    let displayName = slugDir.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const mcmetaPath = path.join(sourceRoot, slugDir, 'pack.mcmeta');
    if (existsSync(mcmetaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(mcmetaPath, 'utf8'));
        const rawDesc = meta?.pack?.description;
        if (typeof rawDesc === 'string' && rawDesc.trim()) displayName = rawDesc.trim();
      } catch { /* ignore */ }
    }

    result[slugDir] = { displayName, structures, biomes };
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  // 1. pack_format table + discovered MC versions (drives all downstream fetches)
  const { map: packFormatToVersion, versions: mcVersions } = await buildPackFormatMap();

  // 2. Vanilla per version — automatically covers future releases
  const vanillaByVersion = {};
  for (const v of mcVersions) {
    vanillaByVersion[v] = await fetchVanillaData(v);
  }

  // 3. External Modrinth packs (sequential to respect rate limits)
  const externalPacks = [];
  for (const { slug, displayName } of EXTERNAL_PACKS) {
    externalPacks.push(await fetchExternalPackData(slug, displayName, mcVersions));
  }

  // 4. Vanilla worldgen tags + item list — use latest version (stable across minor versions)
  const latestVersion = mcVersions[mcVersions.length - 1];
  const vanillaTags = await fetchVanillaTags(latestVersion);
  const vanillaItems = await fetchVanillaItems(latestVersion);

  // 5. EE manifests as version-agnostic entries
  const eeManifests = readEeManifests();
  for (const [slug, { displayName, structures, biomes }] of Object.entries(eeManifests)) {
    const exists = externalPacks.some(p => p.slug === slug);
    if (!exists && (structures.length || biomes.length)) {
      externalPacks.push({
        slug,
        displayName,
        byVersion: { all: { structures, biomes } },
      });
    }
  }

  // 6. Write output
  const output = {
    generated: new Date().toISOString(),
    packFormatToVersion,
    vanillaByVersion,
    externalPacks,
    vanillaTags,
    vanillaItems,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  log(`Wrote ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  warn(`Script failed: ${err.message}`);
  // Exit 0 so a data-fetch failure doesn't block the deploy
  process.exit(0);
});
