#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const yaml = require('js-yaml');
let PNG = null;
try { ({ PNG } = require('pngjs')); } catch { /* optional */ }

const SITE_BASE = 'https://explorerseden.eu';
const COLS = 7;
const ENCHANT_COLS = 7;

const outputRoot = process.env.WIKI_OUTPUT_ROOT;
const slug = process.env.WIKI_DATAPACK_SLUG;
const sourceRoot = process.env.ENCHANTMENT_SOURCE_ROOT;

if (!outputRoot || !slug) {
  console.error('generate-overview: missing WIKI_OUTPUT_ROOT or WIKI_DATAPACK_SLUG');
  process.exit(1);
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function titleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function stripFormatting(s) {
  return String(s || '').replace(/§./g, '').trim();
}

function imgUrl(imgAbsPath) {
  const wikiDir = path.dirname(outputRoot);
  const rel = path.relative(wikiDir, imgAbsPath).replace(/\\/g, '/');
  return `${SITE_BASE}/wiki/${rel}`;
}

function loadLang() {
  const lang = {};
  if (!sourceRoot || !exists(sourceRoot)) return lang;
  const assetsDir = path.join(sourceRoot, 'assets');
  for (const e of safeReaddir(assetsDir)) {
    if (!e.isDirectory()) continue;
    const langPath = path.join(assetsDir, e.name, 'lang', 'en_us.json');
    if (exists(langPath)) {
      try { Object.assign(lang, JSON.parse(fs.readFileSync(langPath, 'utf8'))); }
      catch (err) { console.warn(`Could not parse ${langPath}: ${err.message}`); }
    }
  }
  return lang;
}

// Prefer north.png at shallowest directory depth, fall back to any PNG.
function findFirstPng(dir) {
  const allPngs = [];
  function scan(d, depth) {
    for (const e of safeReaddir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) scan(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.png')) allPngs.push({ p, depth, name: e.name });
    }
  }
  scan(dir, 0);
  if (!allPngs.length) return null;
  const north = allPngs.filter(x => x.name === 'north.png');
  if (north.length) {
    north.sort((a, b) => a.depth - b.depth || a.p.localeCompare(b.p));
    return north[0].p;
  }
  allPngs.sort((a, b) => a.depth - b.depth || a.p.localeCompare(b.p));
  return allPngs[0].p;
}

function sourceNamespaces() {
  if (!sourceRoot || !exists(sourceRoot)) return [];
  const dataDir = path.join(sourceRoot, 'data');
  return safeReaddir(dataDir).filter(e => e.isDirectory()).map(e => e.name);
}

// ─── Blacklist ──────────────────────────────────────────────────────────────

function loadBlacklist() {
  const blacklistPath = path.join(__dirname, '..', 'overview_blacklist.yml');
  if (!exists(blacklistPath)) return {};
  try { return yaml.load(fs.readFileSync(blacklistPath, 'utf8')) || {}; }
  catch { return {}; }
}

function matchesGlob(name, pattern) {
  const regex = new RegExp(
    '^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i'
  );
  return regex.test(name);
}

function isBlacklisted(name, patterns) {
  return Array.isArray(patterns) && patterns.some(p => matchesGlob(name, p));
}

// ─── Collectors ────────────────────────────────────────────────────────────

function collectVariants(lang) {
  const entityDir = path.join(outputRoot, 'images', 'entity');
  if (!exists(entityDir)) return {};
  const namespaces = sourceNamespaces();
  const result = {};

  for (const mobTypeEntry of safeReaddir(entityDir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!mobTypeEntry.isDirectory() || mobTypeEntry.name === 'npc') continue;
    const mobType = mobTypeEntry.name;
    const mobTypeDir = path.join(entityDir, mobType);
    const variants = [];

    for (const variantEntry of safeReaddir(mobTypeDir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!variantEntry.isDirectory()) continue;
      const variantId = variantEntry.name;
      const adultPng = path.join(mobTypeDir, variantId, 'adult.png');
      if (!exists(adultPng)) continue;

      let name = titleCase(variantId);
      for (const ns of namespaces) {
        const key = `entity.${ns}.${mobType}.${variantId}`;
        if (lang[key]) { name = stripFormatting(lang[key]); break; }
      }
      variants.push({ id: variantId, name, imgPath: adultPng });
    }
    if (variants.length) result[mobType] = variants.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}

// Mirrors generate-loot-tables.js getItemId: item_model component overrides entry.name as the
// rendered icon ID. Dyed-color variants append #RRGGBB to form the final iconId.
function collectLootTableItems(lang) {
  if (!sourceRoot || !exists(sourceRoot)) return new Map();
  const items = new Map(); // iconId → customName | null
  const dataDir = path.join(sourceRoot, 'data');

  function getComponentSources(entry) {
    return [
      entry.components,
      ...(entry.functions || [])
        .filter(f => f.function === 'minecraft:set_components')
        .map(f => f.components || {})
    ];
  }

  function getEffectiveBaseId(entry) {
    for (const cs of getComponentSources(entry)) {
      if (!cs) continue;
      const model = cs['minecraft:item_model'] ?? cs.item_model;
      if (model && typeof model === 'string') return model;
    }
    return typeof entry.name === 'string' ? entry.name : null;
  }

  function getEntryDyedColor(entry) {
    for (const cs of getComponentSources(entry)) {
      if (!cs) continue;
      const dc = cs['minecraft:dyed_color'];
      if (dc == null) continue;
      const num = typeof dc === 'number' ? dc : (dc?.rgb ?? null);
      if (num != null) return (num >>> 0).toString(16).toUpperCase().padStart(6, '0');
    }
    return null;
  }

  function resolveText(component) {
    if (!component) return null;
    if (typeof component === 'string') return component;
    if (typeof component === 'object') {
      if (component.translate) return stripFormatting(lang[component.translate] || component.fallback || '');
      if (component.text) return component.text;
    }
    return null;
  }

  function getJukeboxSongTitle(entry) {
    for (const cs of getComponentSources(entry)) {
      if (!cs) continue;
      const jukebox = cs['minecraft:jukebox_playable'];
      if (!jukebox) continue;
      const songId = typeof jukebox === 'string' ? jukebox : (jukebox.song ?? null);
      if (!songId) continue;
      const cleanId = songId.replace(/^#/, '');
      const [ns, rawName] = cleanId.includes(':') ? cleanId.split(':') : ['minecraft', cleanId];
      const songFile = path.join(sourceRoot, 'data', ns, 'jukebox_song', `${rawName}.json`);
      if (!exists(songFile)) continue;
      try {
        const json = JSON.parse(fs.readFileSync(songFile, 'utf8'));
        const title = resolveText(json.description);
        if (title) return title;
      } catch { }
    }
    return null;
  }

  function getEntryCustomName(entry) {
    let customName = null;
    for (const cs of getComponentSources(entry)) {
      if (!cs) continue;
      const n = cs['minecraft:item_name'] ?? cs['minecraft:custom_name'];
      if (n) { customName = resolveText(n); if (customName) break; }
    }
    if (!customName) {
      for (const fn of (entry.functions || [])) {
        if ((fn.function === 'minecraft:set_name' || fn.function === 'minecraft:set_custom_name') && fn.name) {
          customName = resolveText(fn.name);
          if (customName) break;
        }
      }
    }
    const songTitle = getJukeboxSongTitle(entry);
    if (customName && songTitle) return `${customName} (${songTitle})`;
    return customName || songTitle || null;
  }

  const SKIP_TYPES = new Set([
    'minecraft:loot_table', 'minecraft:alternatives', 'minecraft:group',
    'minecraft:sequence', 'minecraft:tag', 'minecraft:empty'
  ]);

  function processEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { entry.forEach(processEntry); return; }
    for (const key of ['pools', 'entries', 'children']) {
      if (entry[key]) processEntry(entry[key]);
    }
    if (entry.type && SKIP_TYPES.has(entry.type)) return;
    const baseId = getEffectiveBaseId(entry);
    if (!baseId || !baseId.includes(':') || baseId.startsWith('#')) return;
    const color = getEntryDyedColor(entry);
    const iconId = color ? `${baseId}#${color}` : baseId;
    if (!items.has(iconId)) items.set(iconId, getEntryCustomName(entry));
    // Also index by filename-safe key: render script replaces '/' with '_' in model paths,
    // so 'wawo:compass/copper' → PNG 'compass_copper.png' → lookup key 'wawo:compass_copper'.
    const colonIdx = iconId.indexOf(':');
    if (colonIdx > 0) {
      const namePart = iconId.slice(colonIdx + 1);
      if (namePart.includes('/')) {
        const altKey = `${iconId.slice(0, colonIdx)}:${namePart.replace(/\//g, '_')}`;
        if (!items.has(altKey)) items.set(altKey, items.get(iconId));
      }
    }
  }

  function walkDir(dir) {
    for (const entry of safeReaddir(dir)) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkDir(p); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try { processEntry(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { }
    }
  }

  for (const nsEntry of safeReaddir(dataDir)) {
    if (!nsEntry.isDirectory()) continue;
    const lootTableDir = path.join(dataDir, nsEntry.name, 'loot_table');
    if (exists(lootTableDir)) walkDir(lootTableDir);
  }

  return items;
}

function collectItems(lang) {
  const itemsDir = path.join(outputRoot, 'images', 'items');
  if (!exists(itemsDir)) return [];

  const lootMap = collectLootTableItems(lang); // iconId → customName
  const hasLootFilter = lootMap.size > 0;

  const all = [];

  for (const nsEntry of safeReaddir(itemsDir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!nsEntry.isDirectory() || nsEntry.name === 'minecraft') continue;
    const ns = nsEntry.name;
    const nsDir = path.join(itemsDir, ns);

    for (const fileEntry of safeReaddir(nsDir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.png')) continue;
      const itemId = fileEntry.name.slice(0, -4);

      // For hex-color variants (e.g. biome_brew_443D4D), reconstruct the loot map key
      // as ns:base#HEX (mirrors how generate-loot-tables.js forms iconId).
      const hexMatch = itemId.match(/^(.+)_([0-9A-Fa-f]{6})$/);
      const plainId = `${ns}:${itemId}`;
      const colorId = hexMatch ? `${ns}:${hexMatch[1]}#${hexMatch[2]}` : null;

      let lootCustomName = null;
      if (hasLootFilter) {
        if (lootMap.has(plainId)) {
          lootCustomName = lootMap.get(plainId);
        } else if (colorId && lootMap.has(colorId)) {
          lootCustomName = lootMap.get(colorId);
        } else {
          continue; // not in any loot table — skip
        }
      }

      // Resolve display name: loot table custom name > lang key > (for hex variants) base lang key
      let name = lootCustomName ? stripFormatting(lootCustomName) : '';
      if (!name) name = stripFormatting(lang[`block.${ns}.${itemId}`] || lang[`item.${ns}.${itemId}`] || '');
      if (!name && hexMatch) {
        name = stripFormatting(lang[`item.${ns}.${hexMatch[1]}`] || lang[`block.${ns}.${hexMatch[1]}`] || '');
      }
      if (!name) name = titleCase(itemId);

      all.push({ id: itemId, name, imgPath: path.join(nsDir, fileEntry.name) });
    }
  }
  return all;
}

function collectStructures(lang) {
  const structuresDir = path.join(outputRoot, 'images', 'structures');
  if (!exists(structuresDir)) return [];
  const namespaces = sourceNamespaces();
  const structures = [];

  for (const nsEntry of safeReaddir(structuresDir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!nsEntry.isDirectory() || nsEntry.name === 'minecraft') continue;
    const ns = nsEntry.name;
    const nsDir = path.join(structuresDir, ns);

    for (const structEntry of safeReaddir(nsDir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!structEntry.isDirectory()) continue;
      const structureId = structEntry.name;
      const structDir = path.join(nsDir, structureId);
      const imgPath = findFirstPng(structDir);
      if (!imgPath) continue;

      let name = titleCase(structureId);
      for (const langNs of namespaces) {
        const key = `structure.${langNs}.${structureId}`;
        if (lang[key]) { name = stripFormatting(lang[key]); break; }
      }
      structures.push({ id: structureId, name, imgPath });
    }
  }
  return structures.sort((a, b) => a.name.localeCompare(b.name));
}

function collectEnchantments(lang) {
  if (!sourceRoot || !exists(sourceRoot)) return [];
  const result = [];

  for (const ns of sourceNamespaces()) {
    const enchantDir = path.join(sourceRoot, 'data', ns, 'enchantment');
    if (!exists(enchantDir)) continue;

    for (const fileEntry of safeReaddir(enchantDir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.json')) continue;
      const enchantId = fileEntry.name.slice(0, -5);
      const key = `enchantment.${ns}.${enchantId}`;
      if (lang[key]) {
        result.push({ id: enchantId, name: stripFormatting(lang[key]) });
      }
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── APNG helpers ───────────────────────────────────────────────────────────

function crc32apng(buf) {
  let t = crc32apng._t;
  if (!t) { t = crc32apng._t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function apngChunk(type, data = Buffer.alloc(0)) {
  const t = Buffer.from(type, 'ascii'), o = Buffer.alloc(12 + data.length);
  o.writeUInt32BE(data.length, 0); t.copy(o, 4); data.copy(o, 8);
  o.writeUInt32BE(crc32apng(Buffer.concat([t, data])), 8 + data.length);
  return o;
}

function rawIdatApng(rgba, w, h) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  return zlib.deflateSync(raw, { level: 9 });
}

function buildApng(frameBuffers, delayMs = 500) {
  const frames = frameBuffers.map(b => PNG.sync.read(b));
  const width = frames[0].width, height = frames[0].height;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunks = [sig, apngChunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4);
  chunks.push(apngChunk('acTL', actl));
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(seq++, 0); fc.writeUInt32BE(width, 4); fc.writeUInt32BE(height, 8);
    fc.writeUInt32BE(0, 12); fc.writeUInt32BE(0, 16);
    fc.writeUInt16BE(delayMs, 20); fc.writeUInt16BE(1000, 22); fc[24] = 0; fc[25] = 0;
    chunks.push(apngChunk('fcTL', fc));
    const comp = rawIdatApng(frames[i].data, width, height);
    if (i === 0) chunks.push(apngChunk('IDAT', comp));
    else { const fd = Buffer.alloc(4 + comp.length); fd.writeUInt32BE(seq++, 0); comp.copy(fd, 4); chunks.push(apngChunk('fdAT', fd)); }
  }
  chunks.push(apngChunk('IEND'));
  return Buffer.concat(chunks);
}

// Group collected items by common base prefix (everything before the last '_'-separated word).
// Pass 1: group by stripping the last segment.
// Pass 2: merge sub-groups (whose key is a prefix-extension of a larger group) into the parent.
//   Only a group with >= MIN_PARENT_SIZE items qualifies as a merge target, preventing
//   unrelated singletons (e.g. waypoint_lock) from absorbing waypoint_hub_* variants.
// Groups of 2+ variants get an APNG written to {nsDir}/groups/{base}.png.
// Singletons pass through unchanged.
const MIN_PARENT_SIZE = 3;

function groupItemVariants(items, lang) {
  if (!PNG) return items;

  // Pass 1: group by stripping last underscore segment
  const baseMap = new Map(); // `${ns}:${base}` → { ns, base, nsDir, items[] }
  for (const item of items) {
    const nsDir = path.dirname(item.imgPath);
    const ns = path.basename(nsDir);
    const idParts = item.id.split('_');
    const base = idParts.length > 1 ? idParts.slice(0, -1).join('_') : item.id;
    const key = `${ns}:${base}`;
    if (!baseMap.has(key)) baseMap.set(key, { ns, base, nsDir, items: [] });
    baseMap.get(key).items.push(item);
  }

  // Pass 2: merge sub-groups into parent groups with >= MIN_PARENT_SIZE items
  const mergedInto = new Set();
  for (const [key] of baseMap) {
    const colonIdx = key.indexOf(':');
    const ns = key.slice(0, colonIdx);
    const base = key.slice(colonIdx + 1);
    const parts = base.split('_');
    for (let i = parts.length - 1; i >= 1; i--) {
      const parentKey = `${ns}:${parts.slice(0, i).join('_')}`;
      if (baseMap.has(parentKey) && baseMap.get(parentKey).items.length >= MIN_PARENT_SIZE) {
        baseMap.get(parentKey).items.push(...baseMap.get(key).items);
        mergedInto.add(key);
        break;
      }
    }
  }

  const result = [];
  for (const [key, { ns, base, nsDir, items: group }] of baseMap) {
    if (mergedInto.has(key)) continue;
    if (group.length === 1) { result.push(group[0]); continue; }

    const sorted = group.slice().sort((a, b) => a.id.localeCompare(b.id));
    const groupsDir = path.join(nsDir, 'groups');
    const apngPath = path.join(groupsDir, `${base}.png`);

    try {
      fs.mkdirSync(groupsDir, { recursive: true });
      const frameBuffers = sorted.map(item => fs.readFileSync(item.imgPath));
      fs.writeFileSync(apngPath, buildApng(frameBuffers));

      let groupName = stripFormatting(lang[`item.${ns}.${base}`] || lang[`block.${ns}.${base}`] || '');
      if (!groupName) groupName = titleCase(base);
      result.push({ id: base, name: groupName, imgPath: apngPath });
    } catch (err) {
      console.warn(`generate-overview: APNG failed for ${ns}:${base} — ${err.message}`);
      result.push(...group);
    }
  }
  return result;
}

// ─── HTML grid builders ─────────────────────────────────────────────────────

function makeGrid(items, makeTd, makeEmptyTd, cols = COLS) {
  const effectiveCols = items.length < cols ? items.length : cols;
  const rows = [];
  for (let i = 0; i < items.length; i += effectiveCols) {
    const row = items.slice(i, i + effectiveCols);
    const cells = row.map(makeTd);
    while (cells.length < effectiveCols) cells.push(makeEmptyTd());
    rows.push(`<tr>\n${cells.join('\n\n')}\n</tr>`);
  }
  return `<table>\n${rows.join('\n\n')}\n</table>`;
}

function imgCell(href, src, label) {
  return `<td align="center">\n<a href="${href}">\n<img src="${src}" width="96"><br>\n${label}\n</a>\n</td>`;
}

function emptyImgCell(href) {
  return `<td align="center">\n<a href="${href}">\n\n</a>\n</td>`;
}

function enchantCell(href, label) {
  return `<td><a href="${href}">${label}</a></td>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const lang = loadLang();
  const blacklist = loadBlacklist();
  const sections = [];

  const variantsByType = collectVariants(lang);
  const filteredVariantsByType = Object.fromEntries(
    Object.entries(variantsByType).map(([mobType, variants]) => [
      mobType,
      variants.filter(v => !isBlacklisted(v.name, blacklist.MobVariants))
    ]).filter(([, variants]) => variants.length > 0)
  );
  if (Object.keys(filteredVariantsByType).length > 0) {
    sections.push('# Mob Variants');
    for (const [mobType, variants] of Object.entries(filteredVariantsByType).sort((a, b) => titleCase(a[0]).localeCompare(titleCase(b[0])))) {
      sections.push(`\n## ${titleCase(mobType)}`);
      sections.push(makeGrid(
        variants,
        v => imgCell(`/${slug}/variants/${mobType}/${v.id}`, imgUrl(v.imgPath), v.name),
        () => emptyImgCell(`/${slug}/variants/${mobType}/`)
      ));
    }
  }

  const rawItems = collectItems(lang)
    .filter(e => !isBlacklisted(e.name, blacklist.Items));
  const allItems = groupItemVariants(rawItems, lang)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (allItems.length > 0) {
    sections.push('\n# Items');
    sections.push(makeGrid(
      allItems,
      entry => imgCell(`/${slug}/items/${entry.id}`, imgUrl(entry.imgPath), entry.name),
      () => emptyImgCell(`/${slug}/items/`)
    ));
  }

  const structures = collectStructures(lang)
    .filter(s => !isBlacklisted(s.name, blacklist.Structures));
  if (structures.length > 0) {
    sections.push('\n# Structures');
    sections.push(makeGrid(
      structures,
      s => imgCell(`/${slug}/structures/${s.id}`, imgUrl(s.imgPath), s.name),
      () => emptyImgCell(`/${slug}/structures/`)
    ));
  }

  const enchantments = collectEnchantments(lang)
    .filter(e => !isBlacklisted(e.name, blacklist.Enchantments));
  if (enchantments.length > 0) {
    sections.push('\n# Enchantments');
    sections.push(makeGrid(
      enchantments,
      e => enchantCell(`/${slug}/enchantments/${e.id}`, e.name),
      () => '<td></td>',
      ENCHANT_COLS
    ));
  }

  if (!sections.length) {
    console.log(`generate-overview: nothing to write for ${slug}, skipping.`);
    return;
  }

  const outDir = path.join(outputRoot, 'markdown');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'overview.md');
  fs.writeFileSync(outFile, sections.join('\n') + '\n', 'utf8');
  console.log(
    `generate-overview: wrote ${outFile} — ` +
    `${Object.values(variantsByType).reduce((s, v) => s + v.length, 0)} variants, ` +
    `${rawItems.length} blocks/items (${allItems.length} entries after grouping), ` +
    `${structures.length} structures, ${enchantments.length} enchantments`
  );
}

main();
