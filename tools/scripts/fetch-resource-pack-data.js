#!/usr/bin/env node
'use strict';

/**
 * Fetches the latest data pack release per Minecraft version for every EE project
 * listed in tools/modrinth_projects.yml, checks each ZIP for an assets/ folder,
 * and writes resource-pack-assembler/data/pack-data.json.
 *
 * Also builds a resource-pack format → MC version map from misode/mcmeta -assets tags.
 *
 * Run during CI after the generate phase.
 */

const fs   = require('fs');
const path = require('path');
const { existsSync, mkdirSync, statSync } = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────

const ROOT      = path.join(__dirname, '..', '..');
const YAML_PATH = path.join(ROOT, 'tools', 'modrinth_projects.yml');
const OUT_PATH  = path.join(ROOT, 'resource-pack-assembler', 'data', 'pack-data.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'resource-pack-data');

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_UA  = 'ExplorersEdenWebsite/1.0 (github.com/Explorers-Eden)';

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg)  { console.log('[resource-pack-data]', msg); }
function warn(msg) { console.warn('[resource-pack-data] WARNING:', msg); }

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
  if (isFreshCache(cacheFile)) return;
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  const resp = await fetch(url, { headers: { 'User-Agent': MODRINTH_UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`);
  const buf = await resp.arrayBuffer();
  fs.writeFileSync(cacheFile, Buffer.from(buf));
}

// ── YAML parser ──────────────────────────────────────────────────────────────

function loadProjectsYaml(yamlPath) {
  const yaml = require('js-yaml');
  const raw = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('modrinth_projects.yml is empty or invalid');
  return Object.entries(raw).map(([slug, name]) => ({ slug, name: String(name) }));
}

// ── JSZip loader ─────────────────────────────────────────────────────────────

function loadJSZip() {
  try { return require('jszip'); } catch { /* fall through */ }
  for (const p of [
    path.join(ROOT, '.cache', 'wiki-node-deps', 'node_modules', 'jszip'),
    path.join(ROOT, 'node_modules', 'jszip'),
  ]) {
    if (existsSync(p)) { try { return require(p); } catch { /* skip */ } }
  }
  throw new Error('jszip not found — run npm install or check wiki-node-deps cache');
}

// ── ZIP asset check ──────────────────────────────────────────────────────────

async function measureZipAssetBytes(zipPath) {
  const JSZip = loadJSZip();
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);
  let assetBytes = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (name.startsWith('assets/') && !entry.dir) {
      assetBytes += entry._data?.uncompressedSize ?? 0;
    }
  }
  return assetBytes;
}

// ── Resource-pack format map ─────────────────────────────────────────────────

// Returns { mcVersion: rpPackFormat } by reading pack.mcmeta from misode/mcmeta -assets tags.
// Seeds from a hardcoded table, then extends with newly discovered versions.
async function buildRpFormatMap() {
  const yaml = require('js-yaml');
  const versionMappings = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', 'version-mappings.yml'), 'utf8'));

  const map = Object.fromEntries(
    Object.entries(versionMappings.resource_pack_formats).map(([k, v]) => [String(k), Number(v)])
  );
  const knownVersions = new Set(Object.keys(map));

  try {
    log('Checking misode/mcmeta for newer resource-pack formats…');
    const authHeaders = {
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    };
    const refs = await fetchJson('https://api.github.com/repos/misode/mcmeta/git/refs/tags', authHeaders);

    for (const ref of refs) {
      const tag = ref.ref.replace('refs/tags/', '');
      if (!tag.endsWith('-assets')) continue;
      const ver = tag.slice(0, -7);
      if (!/^\d+\.\d+(\.\d+)?$/.test(ver)) continue;
      const [major, minor] = ver.split('.').map(Number);
      const isLegacy   = major === 1 && minor >= 21;
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
          map[ver] = fmt;
          knownVersions.add(ver);
          log(`  Discovered ${ver} → RP pack_format ${fmt}`);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    warn(`Could not extend RP format map: ${err.message}`);
  }

  log(`RP format map covers: ${Object.keys(map).sort().join(', ')}`);
  return map;
}

// ── Per-project Modrinth version fetching ────────────────────────────────────

async function fetchProjectData(slug, name) {
  log(`Fetching Modrinth versions for ${slug}…`);
  const entry = { slug, name, byVersion: {} };

  try {
    const loaders = encodeURIComponent(JSON.stringify(['datapack']));
    const versions = await fetchJson(`${MODRINTH_API}/project/${slug}/version?loaders=${loaders}`);

    // Group by game version — pick latest date_published per version
    const byGameVer = {};
    for (const ver of versions) {
      for (const gv of (ver.game_versions || [])) {
        if (!byGameVer[gv] || ver.date_published > byGameVer[gv].date_published) {
          byGameVer[gv] = ver;
        }
      }
    }

    for (const [gameVer, ver] of Object.entries(byGameVer)) {
      const primaryFile = ver.files?.find(f => f.primary) ?? ver.files?.[0];
      if (!primaryFile?.url) continue;

      const versionId  = ver.id;
      const cacheZip   = path.join(CACHE_DIR, slug, `${versionId}.zip`);
      const cacheMeta  = path.join(CACHE_DIR, slug, `${versionId}.meta.json`);

      let assetBytes;
      if (isFreshCache(cacheMeta)) {
        assetBytes = JSON.parse(fs.readFileSync(cacheMeta, 'utf8')).assetBytes;
      }
      if (assetBytes == null) {
        try {
          await downloadToCache(primaryFile.url, cacheZip);
          assetBytes = await measureZipAssetBytes(cacheZip);
          mkdirSync(path.dirname(cacheMeta), { recursive: true });
          fs.writeFileSync(cacheMeta, JSON.stringify({ assetBytes }));
        } catch (err) {
          warn(`  Could not process ${slug} ${versionId}: ${err.message}`);
          assetBytes = 0;
        }
      }

      entry.byVersion[gameVer] = {
        fileUrl:   primaryFile.url,
        versionId,
        hasAssets: assetBytes > 0,
        assetBytes,
      };

      log(`  ${slug} ${gameVer}: ${assetBytes} asset bytes`);
    }
  } catch (err) {
    warn(`Could not fetch ${slug} from Modrinth: ${err.message}`);
  }

  return entry;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const projects = loadProjectsYaml(YAML_PATH);
  log(`Loaded ${projects.length} projects from modrinth_projects.yml`);

  const [rpFormats, projectData] = await Promise.all([
    buildRpFormatMap(),
    Promise.all(projects.map(({ slug, name }) => fetchProjectData(slug, name))),
  ]);

  const out = {
    generated: new Date().toISOString(),
    rpFormats,
    projects: projectData,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  log(`Written → ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
