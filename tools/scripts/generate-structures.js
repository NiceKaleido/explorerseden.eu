// scripts/generate-structures.js
const fs = require("fs");
const path = require("path");
const https = require("https");
const nbt = require("prismarine-nbt");

const inputRoot = "data";
const assetsRoot = "assets";
const outputRoot = process.env.WIKI_MARKDOWN_OUTPUT_ROOT || path.join(process.env.WIKI_OUTPUT_ROOT || "wiki", "markdown");
const outputExtension = ".md";
const vanillaRoot = process.env.VANILLA_ASSET_ROOT || path.join(__dirname, "..", "..", ".cache", "vanilla-assets", "active");
const itemRenderRoot = process.env.ITEM_RENDER_OUTPUT_ROOT || (process.env.WIKI_OUTPUT_ROOT ? path.join(process.env.WIKI_OUTPUT_ROOT, "images", "items") : null);
const wikiOutputRoot = process.env.WIKI_OUTPUT_ROOT || null;
const SITE_BASE = "https://explorerseden.eu";

const IGNORED_BLOCKS = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:water",
  "minecraft:lava",
  "minecraft:jigsaw"
]);

const IGNORED_ENTITIES = new Set([
  "minecraft:marker",
  "minecraft:text_display",
  "minecraft:block_display",
  "minecraft:item_display"
]);

function walk(dir) {
  let files = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }

  return files;
}

function loadLangFiles() {
  const result = {};

  for (const file of walk(assetsRoot)) {
    if (!file.endsWith(path.join("lang", "en_us.json"))) continue;

    try {
      Object.assign(result, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      console.warn(`Could not read lang file: ${file}`);
    }
  }

  return result;
}

const lang = loadLangFiles();

function compareVersionParts(a, b) {
  const aParts = String(a).split(".").map(part => Number(part));
  const bParts = String(b).split(".").map(part => Number(part));
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i++) {
    const aValue = Number.isFinite(aParts[i]) ? aParts[i] : 0;
    const bValue = Number.isFinite(bParts[i]) ? bParts[i] : 0;

    if (aValue !== bValue) return aValue - bValue;
  }

  return String(a).localeCompare(String(b));
}

function readVersionsFromReleaseInfo() {
  const file = "release_infos.yml";
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const versions = [];
  let inVersions = false;
  let versionsIndent = null;

  for (const line of lines) {
    const match = line.match(/^(\s*)Versions\s*:/);

    if (match) {
      inVersions = true;
      versionsIndent = match[1].length;
      continue;
    }

    if (!inVersions) continue;

    const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;

    if (line.trim() && currentIndent <= versionsIndent && !line.trim().startsWith("-")) {
      break;
    }

    const versionMatch = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?/);
    if (versionMatch) versions.push(versionMatch[1]);
  }

  return versions.sort(compareVersionParts);
}

function getLatestMinecraftVersionFromReleaseInfo() {
  const versions = readVersionsFromReleaseInfo();
  return versions.length > 0 ? versions.at(-1) : null;
}

const vanillaLootTableVersion = getLatestMinecraftVersionFromReleaseInfo();

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getMinecraftVersionsFromReleaseInfo() {
  return readVersionsFromReleaseInfo();
}

function getVanillaLootTableRefs() {
  const versions = getMinecraftVersionsFromReleaseInfo();
  const latestFirst = versions.slice().reverse();

  return unique([
    vanillaLootTableVersion && `${vanillaLootTableVersion}-data`,
    vanillaLootTableVersion,
    ...latestFirst.map(version => `${version}-data`),
    ...latestFirst,
    "data"
  ]);
}

function getVanillaLootTableSourceLabel() {
  const refs = getVanillaLootTableRefs();
  return refs.length > 0 ? refs.join(", ") : "unknown";
}

function fetchJson(url) {
  return new Promise(resolve => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "Explorers-Eden-Markdown-Generator"
          }
        },
        response => {
          if (response.statusCode !== 200) {
            response.resume();
            resolve(null);
            return;
          }

          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => {
            body += chunk;
          });
          response.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        }
      )
      .on("error", () => resolve(null));
  });
}

function titleCase(id) {
  return String(id)
    .replace(/^#/, "")
    .replace(/^[^:]+:/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function addCount(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function cleanTag(id) {
  return String(id).replace(/^#/, "");
}

function normalizeTagPath(name) {
  return String(name).replace(/^#/, "").replace(/^tags\/items?\//, "").replace(/^items?\//, "");
}

function findTagFile(ns, cleanName) {
  for (const folder of ["tags/item", "tags/items"]) {
    const localPath = path.join(inputRoot, ns, folder, `${cleanName}.json`);
    if (fs.existsSync(localPath)) return localPath;
  }
  if (vanillaRoot) {
    for (const folder of ["tags/item", "tags/items"]) {
      const vanillaPath = path.join(vanillaRoot, "data", ns, folder, `${cleanName}.json`);
      if (fs.existsSync(vanillaPath)) return vanillaPath;
    }
  }
  return null;
}

function resolveItemTag(tagId, seen = new Set()) {
  const cleaned = cleanTag(tagId);
  const [ns, rawName] = cleaned.includes(":") ? cleaned.split(":") : ["minecraft", cleaned];
  const name = normalizeTagPath(rawName);
  const key = `${ns}:${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const file = findTagFile(ns, name);
  if (!file) return [];
  let json;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const values = Array.isArray(json?.values) ? json.values : [];
  const out = [];
  for (const entry of values) {
    let value = entry;
    if (entry && typeof entry === "object") value = entry.id ?? entry.value ?? entry.item ?? entry.tag;
    value = String(value ?? "");
    if (!value) continue;
    if (value.startsWith("#")) out.push(...resolveItemTag(value.slice(1), seen));
    else out.push(value);
  }
  return [...new Set(out)];
}

function findEnchantmentTagFile(ns, cleanName) {
  for (const folder of ["tags/enchantment", "tags/enchantments"]) {
    const localPath = path.join(inputRoot, ns, folder, `${cleanName}.json`);
    if (fs.existsSync(localPath)) return localPath;
  }
  if (vanillaRoot) {
    for (const folder of ["tags/enchantment", "tags/enchantments"]) {
      const vanillaPath = path.join(vanillaRoot, "data", ns, folder, `${cleanName}.json`);
      if (fs.existsSync(vanillaPath)) return vanillaPath;
    }
  }
  return null;
}

function resolveEnchantmentTag(tagId, seen = new Set()) {
  const cleaned = cleanTag(tagId);
  const [ns, rawName] = cleaned.includes(":") ? cleaned.split(":") : ["minecraft", cleaned];
  const name = normalizeTagPath(rawName);
  const key = `${ns}:${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const file = findEnchantmentTagFile(ns, name);
  if (!file) return [];
  let json;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const values = Array.isArray(json?.values) ? json.values : [];
  const out = [];
  for (const entry of values) {
    let value = entry;
    if (entry && typeof entry === "object") value = entry.id ?? entry.value ?? entry.tag;
    value = String(value ?? "");
    if (!value) continue;
    if (value.startsWith("#")) out.push(...resolveEnchantmentTag(value.slice(1), seen));
    else out.push(value);
  }
  return [...new Set(out)];
}

function enchantmentDisplayName(enchId) {
  const [ns, rawName] = enchId.includes(":") ? enchId.split(":") : ["minecraft", enchId];
  const dotPath = rawName.replace(/\//g, ".");
  return lang[`enchantment.${ns}.${dotPath}`] ?? titleCase(enchId);
}

function getItemModelId(entry) {
  for (const cs of getComponentSources(entry)) {
    const model = cs?.["minecraft:item_model"] ?? cs?.item_model;
    if (model && typeof model === "string") return model;
  }
  return null;
}

function getJukeboxSongFile(songId) {
  const cleaned = cleanTag(songId);
  const [ns, rawName] = cleaned.includes(":") ? cleaned.split(":") : ["minecraft", cleaned];
  const localPath = path.join(inputRoot, ns, "jukebox_song", `${rawName}.json`);
  if (fs.existsSync(localPath)) return localPath;
  if (vanillaRoot) {
    const vanillaPath = path.join(vanillaRoot, "data", ns, "jukebox_song", `${rawName}.json`);
    if (fs.existsSync(vanillaPath)) return vanillaPath;
  }
  return null;
}

function getJukeboxSongTitle(entry) {
  for (const cs of getComponentSources(entry)) {
    const jukebox = cs?.["minecraft:jukebox_playable"];
    if (!jukebox) continue;
    const songId = typeof jukebox === "string" ? jukebox : (jukebox.song ?? null);
    if (!songId) continue;
    const file = getJukeboxSongFile(songId);
    if (!file) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      const title = resolveTextComponent(json.description);
      if (title) return title;
    } catch { }
  }
  return null;
}

function itemDisplayName(itemId) {
  const [ns, rawName] = itemId.includes(":") ? itemId.split(":") : ["minecraft", itemId];
  const dotPath = rawName.replace(/\//g, ".");
  return lang[`item.${ns}.${dotPath}`] ?? lang[`block.${ns}.${dotPath}`] ?? titleCase(itemId);
}

function itemOutputName(itemId) {
  const hashIdx = itemId.indexOf("#");
  const baseId = hashIdx >= 0 ? itemId.slice(0, hashIdx) : itemId;
  const colorHex = hashIdx >= 0 ? itemId.slice(hashIdx + 1) : null;
  const [ns, rawName] = baseId.includes(":") ? baseId.split(":") : ["minecraft", baseId];
  const name = rawName.replace(/\//g, "_") + (colorHex ? `_${colorHex}` : "");
  return { ns, name };
}

function getItemDyedColor(entry) {
  for (const cs of getComponentSources(entry)) {
    const dc = cs?.["minecraft:dyed_color"];
    if (dc == null) continue;
    const num = typeof dc === "number" ? dc : (dc?.rgb ?? null);
    if (num != null) return (num >>> 0).toString(16).toUpperCase().padStart(6, "0");
  }
  return null;
}

function itemIconUrl(itemId) {
  if (!wikiOutputRoot || !itemRenderRoot) return null;
  const { ns, name } = itemOutputName(itemId);
  const imgPath = path.resolve(itemRenderRoot, ns, `${name}.png`);
  const wikiParent = path.resolve(path.dirname(wikiOutputRoot));
  const rel = path.relative(wikiParent, imgPath).replace(/\\/g, "/");
  return `${SITE_BASE}/wiki/${rel}`;
}

function itemIconHtml(itemId) {
  const url = itemIconUrl(itemId);
  if (!url) return "";
  return `<img src="${url}" height="16" style="vertical-align:middle; image-rendering:pixelated"> `;
}

const neededItemIcons = new Set();

function writeItemIconManifest() {
  if (!itemRenderRoot || !neededItemIcons.size) return;
  const manifestPath = path.join(itemRenderRoot, ".item-icon-requests.json");
  let existing = [];
  try {
    if (fs.existsSync(manifestPath)) existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch { }
  const merged = [...new Set([...existing, ...neededItemIcons])];
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(merged));
  } catch (e) {
    console.warn(`Could not write item icon manifest: ${e.message}`);
  }
}

function renderTagDetails(details) {
  if (!details.tags.size) return "";
  const sections = [];
  for (const [tag, itemIds] of details.tags.entries()) {
    for (const id of itemIds) neededItemIcons.add(id);
    const items = itemIds.map(id => `- ${itemIconHtml(id)}${itemDisplayName(id)}`).join("\n");
    sections.push(`<details>\n<summary>${tag}</summary>\n\n${items}\n\n</details>`);
  }
  return sections.join("\n\n");
}

function renderEnchantmentTagDetails(details) {
  if (!details.enchantmentTags?.size) return "";
  const sections = [];
  for (const [tag, enchIds] of details.enchantmentTags.entries()) {
    const items = enchIds.map(id => `- ${enchantmentDisplayName(id)}`).join("\n");
    sections.push(`<details>\n<summary>${tag}</summary>\n\n${items}\n\n</details>`);
  }
  return sections.join("\n\n");
}

function getEnchantedBookLabel(entry, details) {
  const randomlyFn = entry.functions?.find(f => f.function === "minecraft:enchant_randomly");
  const withLevelsFn = entry.functions?.find(f => f.function === "minecraft:enchant_with_levels");

  if (randomlyFn) {
    const options = randomlyFn.options ?? randomlyFn.enchantments;
    if (options !== undefined) {
      const optList = Array.isArray(options) ? options : [options];
      if (optList.length === 1) {
        const opt = String(optList[0]);
        if (opt.startsWith("#")) {
          const tagId = opt.slice(1);
          const displayTag = `#${tagId}`;
          if (details) {
            const resolved = resolveEnchantmentTag(tagId);
            if (resolved.length) details.enchantmentTags.set(displayTag, resolved);
          }
          return `Enchanted Book (${displayTag})`;
        }
        return `Enchanted Book (${enchantmentDisplayName(opt)})`;
      }
      for (const opt of optList) {
        const s = String(opt);
        if (s.startsWith("#") && details) {
          const tagId = s.slice(1);
          const resolved = resolveEnchantmentTag(tagId);
          if (resolved.length) details.enchantmentTags.set(`#${tagId}`, resolved);
        }
      }
    }
    return "Enchanted Book (Random)";
  }

  if (withLevelsFn) {
    const options = withLevelsFn.options;
    let enchantPart = null;

    if (options !== undefined) {
      const optList = Array.isArray(options) ? options : [options];
      if (optList.length === 1) {
        const opt = String(optList[0]);
        if (opt.startsWith("#")) {
          const tagId = opt.slice(1);
          const displayTag = `#${tagId}`;
          if (details) {
            const resolved = resolveEnchantmentTag(tagId);
            if (resolved.length) details.enchantmentTags.set(displayTag, resolved);
          }
          enchantPart = displayTag;
        } else {
          enchantPart = enchantmentDisplayName(opt);
        }
      } else {
        for (const opt of optList) {
          const s = String(opt);
          if (s.startsWith("#") && details) {
            const tagId = s.slice(1);
            const resolved = resolveEnchantmentTag(tagId);
            if (resolved.length) details.enchantmentTags.set(`#${tagId}`, resolved);
          }
        }
      }
    }

    const levels = withLevelsFn.levels;
    let levelPart = null;
    if (typeof levels === "number") levelPart = `Lvl ${levels}`;
    else if (levels?.min !== undefined && levels?.max !== undefined) {
      levelPart = levels.min === levels.max
        ? `Lvl ${levels.min}`
        : `Lvl ${levels.min}–${levels.max}`;
    }

    const suffix = enchantPart ?? levelPart;
    return suffix ? `Enchanted Book (${suffix})` : "Enchanted Book (Random)";
  }

  return "Enchanted Book";
}

function getStructureInfo(file) {
  const parts = file.split(path.sep);
  const dataIndex = parts.indexOf("data");
  const structureIndex = parts.indexOf("structure");

  if (dataIndex === -1 || structureIndex === -1) return null;
  if (structureIndex !== dataIndex + 2) return null;

  const namespace = parts[dataIndex + 1];
  const relativeParts = parts.slice(structureIndex + 1);
  if (relativeParts.length === 0) return null;

  const topFolder =
    relativeParts.length > 1
      ? relativeParts[0]
      : path.basename(relativeParts[0], ".nbt");

  const structureFile = relativeParts.join("/").replace(/\.nbt$/, "");

  return { namespace, topFolder, structureFile };
}

function collectLootTables(obj, map = new Map()) {
  if (obj === null || obj === undefined) return map;

  if (Array.isArray(obj)) {
    for (const value of obj) collectLootTables(value, map);
    return map;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      if ((key === "LootTable" || key === "loot_table") && typeof value === "string") {
        addCount(map, value);
      }

      collectLootTables(value, map);
    }
  }

  return map;
}

function getPalette(structure) {
  if (Array.isArray(structure.palette)) return structure.palette;
  if (Array.isArray(structure.palettes?.[0])) return structure.palettes[0];
  return [];
}

function getBlockNameFromPaletteEntry(entry) {
  return entry?.Name ?? entry?.name ?? null;
}

function collectStructureData(structure) {
  const blockCounts = new Map();
  const entityCounts = new Map();
  const lootTables = new Map();

  const palette = getPalette(structure);

  for (const block of structure.blocks ?? []) {
    const state = palette[block.state];
    const blockName = getBlockNameFromPaletteEntry(state);

    if (blockName && !IGNORED_BLOCKS.has(blockName)) {
      addCount(blockCounts, blockName);
    }

    if (block.nbt) collectLootTables(block.nbt, lootTables);
  }

  for (const entity of structure.entities ?? []) {
    const entityData = entity.nbt ?? entity;
    const entityId = entityData.id;

    if (entityId && !IGNORED_ENTITIES.has(entityId)) {
      addCount(entityCounts, entityId);
    }

    collectLootTables(entityData, lootTables);
  }

  return { blockCounts, entityCounts, lootTables };
}

function mergeTotals(target, source) {
  for (const [key, count] of source.blockCounts.entries()) {
    addCount(target.blockCounts, key, count);
  }

  for (const [key, count] of source.entityCounts.entries()) {
    addCount(target.entityCounts, key, count);
  }

  for (const [lootTable, count] of source.lootTables.entries()) {
    addCount(target.lootTables, lootTable, count);
  }
}

function sortedCountRows(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sortedLootTables(map) {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function resolveTextComponent(component) {
  if (component === undefined || component === null) return null;
  if (typeof component === "string") return component;

  if (typeof component === "object") {
    if (component.translate === "filled_map.buried_treasure") return "Buried Treasure Map";

    if (component.translate) {
      return lang[component.translate] ?? component.fallback ?? component.translate;
    }

    if (component.text) return component.text;
    if (component.fallback) return component.fallback;
  }

  return null;
}

function withInheritedFunctions(entry, inheritedFunctions = []) {
  const functions = [
    ...inheritedFunctions,
    ...(entry.functions ?? [])
  ];

  return functions.length > 0 ? { ...entry, functions } : entry;
}

function loadItemModifier(name) {
  const cleaned = cleanTag(name);
  const [ns, rawPath] = cleaned.includes(":") ? cleaned.split(":") : ["minecraft", cleaned];
  const filePath = path.join(inputRoot, ns, "item_modifier", `${rawPath}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(json) ? json : [json];
  } catch {
    return [];
  }
}

function resolveEntryFunctions(entry) {
  const resolved = [];
  for (const fn of entry.functions ?? []) {
    if (fn.function === "minecraft:reference") {
      resolved.push(...loadItemModifier(fn.name ?? ""));
    } else {
      resolved.push(fn);
    }
  }
  return resolved;
}

function getComponentSources(entry) {
  const resolvedFunctions = resolveEntryFunctions(entry);
  return [
    entry.components,
    ...resolvedFunctions
      .filter(f => f.function === "minecraft:set_components")
      .map(f => f.components ?? {})
  ];
}

function getItemNameComponent(entry) {
  for (const components of getComponentSources(entry)) {
    const itemName = components?.["minecraft:item_name"] ?? components?.item_name;
    if (itemName !== undefined) return itemName;
  }

  const resolvedFunctions = resolveEntryFunctions(entry);
  const nameFn =
    resolvedFunctions.find(f => f.function === "minecraft:set_name") ??
    resolvedFunctions.find(f => f.function === "minecraft:set_custom_name");

  return nameFn?.name;
}

function getStackSize(entry) {
  const fn = entry.functions?.find(f => f.function === "minecraft:set_count");
  if (!fn) return "1";

  const count = fn.count;
  if (typeof count === "number") return String(count);

  if (count?.min !== undefined && count?.max !== undefined) return `${count.min}–${count.max}`;
  if (count?.type === "minecraft:uniform") return `${count.min}–${count.max}`;

  return "1";
}

function isEnchantedBook(entry) {
  return (
    entry.name === "minecraft:book" &&
    entry.functions?.some(
      f =>
        f.function === "minecraft:enchant_with_levels" ||
        f.function === "minecraft:enchant_randomly"
    )
  );
}

function getLootTableFile(id) {
  const cleaned = cleanTag(id);
  const [namespace, lootPath] = cleaned.includes(":")
    ? cleaned.split(":")
    : ["minecraft", cleaned];

  return path.join(inputRoot, namespace, "loot_table", `${lootPath}.json`);
}

async function fetchVanillaLootTableJson(id) {
  const cleaned = cleanTag(id);
  const [namespace, lootPath] = cleaned.includes(":")
    ? cleaned.split(":")
    : ["minecraft", cleaned];

  if (namespace !== "minecraft") return null;

  const refs = getVanillaLootTableRefs();

  for (const ref of refs) {
    const url = `https://raw.githubusercontent.com/misode/mcmeta/${ref}/data/minecraft/loot_table/${lootPath}.json`;
    const json = await fetchJson(url);

    if (json) {
      console.log(`Fetched vanilla loot table ${cleaned} from mcmeta ${ref}`);
      return json;
    }
  }

  console.warn(`Could not find vanilla loot table ${cleaned} in repo or mcmeta refs: ${getVanillaLootTableSourceLabel()}`);
  return null;
}

async function loadLootTableJson(id) {
  const file = getLootTableFile(id);

  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      console.warn(`Could not read loot table: ${file}`);
    }
  }

  return await fetchVanillaLootTableJson(id);
}

function flattenRawEntries(entries, inheritedFunctions = []) {
  const result = [];

  for (const entry of entries ?? []) {
    const entryFunctions = [
      ...inheritedFunctions,
      ...(entry.functions ?? [])
    ];

    if (
      entry.type === "minecraft:alternatives" ||
      entry.type === "minecraft:group" ||
      entry.type === "minecraft:sequence"
    ) {
      result.push(...flattenRawEntries(entry.children ?? [], entryFunctions));
      continue;
    }

    result.push(withInheritedFunctions(entry, inheritedFunctions));
  }

  return result;
}

async function getSingleEntryFromLootTable(id, seen = new Set()) {
  const cleaned = cleanTag(id);
  if (seen.has(cleaned)) return null;
  seen.add(cleaned);

  const json = await loadLootTableJson(cleaned);
  if (!json) return null;

  try {
    const entries = [];

    for (const pool of json.pools ?? []) {
      entries.push(...flattenRawEntries(pool.entries ?? [], pool.functions ?? []));
    }

    const nonEmptyEntries = entries.filter(e => e.type !== "minecraft:empty");
    if (nonEmptyEntries.length === 1) return nonEmptyEntries[0];
  } catch {
    return null;
  }

  return null;
}

async function getItemName(entry, seenLootTables = new Set(), details = null) {
  if (entry.type === "minecraft:empty") return "Empty";

  if (entry.type === "minecraft:loot_table") {
    const lootTable = cleanTag(entry.value ?? entry.name ?? "unknown");
    const singleEntry = await getSingleEntryFromLootTable(lootTable, seenLootTables);

    if (singleEntry) return await getItemName(singleEntry, seenLootTables, details);

    return `Loot Table (${lootTable})`;
  }

  if (entry.type === "minecraft:tag") {
    const tagId = entry.name ?? "unknown";
    const cleaned = cleanTag(tagId);
    const [ns, rawName] = cleaned.includes(":") ? cleaned.split(":") : ["minecraft", cleaned];
    const display = `#${ns}:${normalizeTagPath(rawName)}`;
    if (details) {
      const resolved = resolveItemTag(cleaned);
      if (resolved.length) details.tags.set(display, resolved);
    }
    return display;
  }

  if (isEnchantedBook(entry)) return getEnchantedBookLabel(entry, details);

  const songTitle = getJukeboxSongTitle(entry);

  const customName = resolveTextComponent(getItemNameComponent(entry));
  if (customName) return songTitle ? `${customName} (${songTitle})` : customName;

  const itemModelId = getItemModelId(entry);
  const baseName = entry.name
    ? itemDisplayName(itemModelId ?? entry.name)
    : titleCase(entry.type ?? "unknown");

  return songTitle ? `${baseName} (${songTitle})` : baseName;
}

async function getItemId(entry, seenLootTables = new Set()) {
  if (entry.type === "minecraft:empty") return null;
  if (entry.type === "minecraft:loot_table") {
    const lootTable = cleanTag(entry.value ?? entry.name ?? "unknown");
    const singleEntry = await getSingleEntryFromLootTable(lootTable, seenLootTables);
    if (singleEntry) return await getItemId(singleEntry, seenLootTables);
    return null;
  }
  if (entry.type === "minecraft:tag") return null;
  if (!entry.name) return null;

  // item_model component overrides the rendered icon — check it first
  for (const components of getComponentSources(entry)) {
    if (!components) continue;
    const model = components["minecraft:item_model"] ?? components.item_model;
    if (model && typeof model === "string") return model;
  }

  if (isEnchantedBook(entry)) return "minecraft:enchanted_book";
  return entry.name;
}

async function flattenEntries(
  entries,
  inheritedWeight = 1,
  inheritedFunctions = [],
  seenLootTables = new Set(),
  details = null
) {
  const result = [];

  for (const entry of entries ?? []) {
    const weight = entry.weight ?? 1;
    const combinedWeight = inheritedWeight * weight;

    const entryFunctions = [
      ...inheritedFunctions,
      ...(entry.functions ?? [])
    ];

    if (
      entry.type === "minecraft:alternatives" ||
      entry.type === "minecraft:group" ||
      entry.type === "minecraft:sequence"
    ) {
      result.push(
        ...await flattenEntries(
          entry.children ?? [],
          combinedWeight,
          entryFunctions,
          seenLootTables,
          details
        )
      );
      continue;
    }

    if (entry.type === "minecraft:loot_table") {
      const lootTable = cleanTag(entry.value ?? entry.name ?? "unknown");

      if (seenLootTables.has(lootTable)) {
        result.push({
          item: `Loot Table (${lootTable})`,
          itemId: null,
          stackSize: getStackSize(withInheritedFunctions(entry, inheritedFunctions)),
          weight: combinedWeight
        });
        continue;
      }

      const nestedJson = await loadLootTableJson(lootTable);

      if (!nestedJson) {
        result.push({
          item: `Loot Table (${lootTable})`,
          itemId: null,
          stackSize: getStackSize(withInheritedFunctions(entry, inheritedFunctions)),
          weight: combinedWeight
        });
        continue;
      }

      const nextSeenLootTables = new Set(seenLootTables);
      nextSeenLootTables.add(lootTable);

      for (const nestedPool of nestedJson.pools ?? []) {
        result.push(
          ...await flattenEntries(
            nestedPool.entries ?? [],
            combinedWeight,
            [
              ...entryFunctions,
              ...(nestedPool.functions ?? [])
            ],
            nextSeenLootTables,
            details
          )
        );
      }

      continue;
    }

    const inheritedEntry = withInheritedFunctions(entry, inheritedFunctions);

    const itemId = await getItemId(inheritedEntry, seenLootTables);
    const dyedColor = itemId ? getItemDyedColor(inheritedEntry) : null;
    result.push({
      item: await getItemName(inheritedEntry, seenLootTables, details),
      itemId,
      iconId: itemId && dyedColor ? `${itemId}#${dyedColor}` : itemId,
      stackSize: getStackSize(inheritedEntry),
      weight: combinedWeight
    });
  }

  return result;
}

function mergeRowsByItem(rows) {
  const merged = new Map();

  for (const row of rows) {
    const key = `${row.pool}::${row.item}::${row.stackSize}`;

    if (!merged.has(key)) merged.set(key, { ...row });
    else merged.get(key).weight += row.weight;
  }

  return [...merged.values()];
}

async function renderMergedPools(pools, details = null) {
  const rows = [];

  for (const [poolIndex, pool] of (pools ?? []).entries()) {
    const flattenedEntries = await flattenEntries(pool.entries ?? [], 1, pool.functions ?? [], new Set(), details);
    const nonEmptyFlattenedEntries = flattenedEntries.filter(entry => entry.item !== "Empty");
    const totalWeight = flattenedEntries.reduce((sum, entry) => sum + entry.weight, 0);

    const mergedEntries = mergeRowsByItem(
      nonEmptyFlattenedEntries.map(entry => ({
        ...entry,
        pool: poolIndex + 1
      }))
    );

    for (const entry of mergedEntries) {
      const chanceValue = totalWeight > 0 ? entry.weight / totalWeight : 0;

      rows.push({
        item: entry.item,
        itemId: entry.itemId,
        iconId: entry.iconId ?? entry.itemId,
        stackSize: entry.stackSize,
        pool: entry.pool,
        weight: Number(entry.weight.toFixed(2)),
        chanceValue,
        chance: `${(chanceValue * 100).toFixed(1)}%`
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.pool - b.pool ||
      b.chanceValue - a.chanceValue ||
      a.item.localeCompare(b.item)
  );

  for (const row of rows) {
    if (row.iconId) neededItemIcons.add(row.iconId);
  }

  return `| Item | Stack Size | Pool | Weight | Chance |
|:-----|:----------:|:----:|:------:|:------:|
${rows
  .map(row => {
    const icon = row.iconId ? itemIconHtml(row.iconId) : "";
    return `| ${icon}${row.item} | ${row.stackSize} | ${row.pool} | ${row.weight} | ${row.chance} |`;
  })
  .join("\n")}`;
}

function renderCountTable(title, singular, rows) {
  if (rows.length === 0) {
    return `### ${title}

*None*
`;
  }

  return `### ${title}

| ${singular} | Count |
|:-----|:-----:|
${rows.map(([name, count]) => `| ${titleCase(name)} | ${count} |`).join("\n")}
`;
}

function renderLootTableTable(lootTables) {
  if (lootTables.length === 0) {
    return `### Loot Tables

*None*
`;
  }

  return `### Loot Tables

| Loot Table | Count |
|:-----|:-----:|
${lootTables.map(([id, count]) => `| ${id} | ${count} |`).join("\n")}
`;
}

async function renderGeneratedLootSection(lootTables) {
  const sorted = sortedLootTables(lootTables);

  if (sorted.length === 0) {
    return "";
  }

  const tables = [];

  for (const [id, count] of sorted) {
    const json = await loadLootTableJson(id);

    let content;

    if (!json) {
      content = `Could not find this loot table locally or in mcmeta refs: ${getVanillaLootTableSourceLabel()}.`;
    } else {
      const details = { tags: new Map(), enchantmentTags: new Map() };
      const tableSection = await renderMergedPools(json.pools ?? [], details);
      const tagSection = renderTagDetails(details);
      const enchantmentTagSection = renderEnchantmentTagDetails(details);
      const contentParts = [tableSection];
      if (tagSection) contentParts.push(`#### Tags\n\n${tagSection}`);
      if (enchantmentTagSection) contentParts.push(`#### Enchantment Tags\n\n${enchantmentTagSection}`);
      content = contentParts.join("\n\n");
    }

    tables.push(`<details>
<summary><strong>${id}</strong> (${count} ${pluralize(count, "use")})</summary>

${content}

</details>`);
  }

const intro =
  sorted.length === 1
    ? `There is one loot table used in this structure:`
    : `There are ${sorted.length} loot tables used in this structure:`;

return `# Generated Loot

${intro}

${tables.join("\n\n")}

`;
}

function renderTextSummary(data, isPart = false) {
  const blocks = sortedCountRows(data.blockCounts).map(([name]) => titleCase(name));
  const entities = sortedCountRows(data.entityCounts).map(([name]) => titleCase(name));

  const blocksLine =
    blocks.length > 0
      ? `${isPart ? "The structure part" : "The structure"} is composed of the following blocks: ${blocks.join(", ")}.`
      : `${isPart ? "The structure part" : "The structure"} does not contain any notable blocks.`;

  const entitiesLine =
    entities.length > 0
      ? `Additionally, the following entities may spawn during its generation: ${entities.join(", ")}.`
      : "";

  return `${blocksLine}

${entitiesLine ? entitiesLine + "\n\n" : ""}`;
}

function renderStructureSection(structureFile, data) {
  return `<details>
<summary><strong>${titleCase(structureFile)}</strong></summary>

${renderTextSummary(data, true)}${renderCountTable("Blocks", "Block", sortedCountRows(data.blockCounts))}

${renderCountTable("Entities", "Entity", sortedCountRows(data.entityCounts))}

${renderLootTableTable(sortedLootTables(data.lootTables))}

</details>`;
}

function renderSummarySection(totals) {
  return `# Contents

${renderTextSummary(totals, false)}`;
}

async function generateMarkdown(groupName, structures, totals) {
  const generatedLoot = await renderGeneratedLootSection(totals.lootTables);

  return `${generatedLoot}${renderSummarySection(totals)}

## Per-Structure File Contents

${structures.map(entry => renderStructureSection(entry.structureFile, entry.data)).join("\n\n")}
`;
}

async function readNbtFile(file) {
  const buffer = fs.readFileSync(file);
  const parsed = await nbt.parse(buffer);
  return nbt.simplify(parsed.parsed);
}

function removeStaleOutputFiles(validOutputFiles, namespaces) {
  for (const namespace of namespaces) {
    const structureRoot = path.join(outputRoot, namespace, "structure");

    if (!fs.existsSync(structureRoot)) continue;

    const outputFiles = walk(structureRoot).filter(file => file.endsWith(outputExtension));

    for (const file of outputFiles) {
      const normalized = path.normalize(file);

      if (!validOutputFiles.has(normalized)) {
        fs.rmSync(file);
        console.log(`Removed stale ${file}`);
      }
    }
  }
}


function getWorldgenStructureInfo(file) {
  const parts = file.split(path.sep);
  const dataIndex = parts.indexOf("data");
  const worldgenIndex = parts.indexOf("worldgen");
  const structureIndex = parts.indexOf("structure");

  if (dataIndex === -1 || worldgenIndex === -1 || structureIndex === -1) return null;
  if (worldgenIndex !== dataIndex + 2 || structureIndex !== worldgenIndex + 1) return null;

  const namespace = parts[dataIndex + 1];
  const relativePath = parts.slice(structureIndex + 1).join("/").replace(/\.json$/, "");

  return {
    namespace,
    id: `${namespace}:${relativePath}`,
    relativePath
  };
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function splitResourceLocation(id, defaultNamespace = "minecraft") {
  if (String(id).includes(":")) {
    const [namespace, ...rest] = String(id).split(":");
    return [namespace, rest.join(":")];
  }

  return [defaultNamespace, String(id)];
}

function addResourceLocation(value, result) {
  if (typeof value !== "string") return;
  if (value === "minecraft:empty") return;
  if (!value.includes(":")) return;
  if (value.startsWith("#")) return;
  result.add(value);
}

function collectTemplatePoolsFromObject(value, result = new Set()) {
  if (value === null || value === undefined) return result;

  if (typeof value === "string") {
    addResourceLocation(value, result);
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTemplatePoolsFromObject(item, result);
    return result;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (
        key === "start_pool" ||
        key === "fallback" ||
        key === "pool" ||
        key === "template_pool" ||
        key === "target_pool"
      ) {
        collectTemplatePoolsFromObject(nested, result);
        continue;
      }

      collectTemplatePoolsFromObject(nested, result);
    }
  }

  return result;
}

function getTemplatePoolFile(poolId) {
  const [namespace, poolPath] = splitResourceLocation(poolId);
  return path.join(inputRoot, namespace, "worldgen", "template_pool", `${poolPath}.json`);
}

function getStructureNbtFileFromLocation(location) {
  const [namespace, structurePath] = splitResourceLocation(location);
  return path.join(inputRoot, namespace, "structure", `${structurePath}.nbt`);
}

function collectElementLocations(element, result = new Set()) {
  if (!element || typeof element !== "object") return result;

  if (typeof element.location === "string") {
    result.add(element.location);
  }

  if (Array.isArray(element.elements)) {
    for (const nested of element.elements) {
      collectElementLocations(nested.element ?? nested, result);
    }
  }

  if (element.element) {
    collectElementLocations(element.element, result);
  }

  return result;
}

function collectJigsawPoolsFromNbt(value, result = new Set()) {
  if (value === null || value === undefined) return result;

  if (Array.isArray(value)) {
    for (const item of value) collectJigsawPoolsFromNbt(item, result);
    return result;
  }

  if (typeof value !== "object") return result;

  const blockId = value.id ?? value.Id ?? value.Name ?? value.name;
  const likelyJigsaw =
    blockId === "minecraft:jigsaw" ||
    value.pool !== undefined ||
    value.target_pool !== undefined ||
    value.final_state !== undefined;

  if (likelyJigsaw) {
    addResourceLocation(value.pool, result);
    addResourceLocation(value.target_pool, result);
  }

  for (const nested of Object.values(value)) {
    collectJigsawPoolsFromNbt(nested, result);
  }

  return result;
}

async function collectJigsawPoolsFromStructureFile(structureFile) {
  if (!fs.existsSync(structureFile)) return new Set();

  try {
    const structure = await readNbtFile(structureFile);
    return collectJigsawPoolsFromNbt(structure);
  } catch (error) {
    console.warn(`Could not inspect jigsaw pools in ${structureFile}: ${error.message}`);
    return new Set();
  }
}

async function collectStructureFilesFromTemplatePool(poolId, seenPools = new Set(), result = new Set()) {
  if (seenPools.has(poolId)) return result;
  seenPools.add(poolId);

  const poolFile = getTemplatePoolFile(poolId);
  const poolJson = readJsonIfExists(poolFile);
  if (!poolJson) return result;

  for (const element of poolJson.elements ?? []) {
    const elementData = element.element ?? element;
    const locations = collectElementLocations(elementData);

    for (const location of locations) {
      const structureFile = getStructureNbtFileFromLocation(location);

      if (!fs.existsSync(structureFile)) continue;

      const alreadyHadFile = result.has(structureFile);
      result.add(structureFile);

      if (!alreadyHadFile) {
        const jigsawPools = await collectJigsawPoolsFromStructureFile(structureFile);

        for (const nestedPool of jigsawPools) {
          await collectStructureFilesFromTemplatePool(nestedPool, seenPools, result);
        }
      }
    }
  }

  if (poolJson.fallback && poolJson.fallback !== "minecraft:empty") {
    await collectStructureFilesFromTemplatePool(poolJson.fallback, seenPools, result);
  }

  return result;
}

async function collectStructureFilesForWorldgenStructure(worldgenFile) {
  const info = getWorldgenStructureInfo(worldgenFile);
  const json = readJsonIfExists(worldgenFile);
  if (!info || !json) return null;

  const pools = collectTemplatePoolsFromObject(json);
  const files = new Set();

  for (const poolId of pools) {
    await collectStructureFilesFromTemplatePool(poolId, new Set(), files);
  }

  return {
    namespace: info.namespace,
    relativePath: info.relativePath,
    id: info.id,
    files: [...files].sort()
  };
}


async function main() {
  const worldgenStructureFiles = walk(inputRoot)
    .filter(file => file.endsWith(".json"))
    .filter(file => getWorldgenStructureInfo(file) !== null)
    .sort();

  const validOutputFiles = new Set();
  const namespaces = new Set();

  if (worldgenStructureFiles.length > 0) {
    console.log(`Generating structure markdown from ${worldgenStructureFiles.length} worldgen structure file(s).`);

    for (const worldgenFile of worldgenStructureFiles) {
      const worldgenInfo = getWorldgenStructureInfo(worldgenFile);
      const group = await collectStructureFilesForWorldgenStructure(worldgenFile);

      if (!group || group.files.length === 0) {
        console.warn(`No template NBT files found for worldgen structure ${worldgenFile}`);
        continue;
      }

      namespaces.add(worldgenInfo.namespace);

      const structures = [];
      const totals = {
        blockCounts: new Map(),
        entityCounts: new Map(),
        lootTables: new Map()
      };

      for (const file of group.files) {
        const structure = await readNbtFile(file);
        const data = collectStructureData(structure);
        const structureInfo = getStructureInfo(file);

        structures.push({
          structureFile: structureInfo?.structureFile ?? file,
          data
        });

        mergeTotals(totals, data);
      }

      structures.sort((a, b) => a.structureFile.localeCompare(b.structureFile));

      // This is the requested output shape:
      // data/<namespace>/worldgen/structure/foo/bar.json
      // -> wiki/markdown/<namespace>/structure/foo/bar.md
      const outputPath = path.join(
        outputRoot,
        worldgenInfo.namespace,
        "structure",
        `${worldgenInfo.relativePath}${outputExtension}`
      );

      validOutputFiles.add(path.normalize(outputPath));

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(
        outputPath,
        await generateMarkdown(worldgenInfo.relativePath, structures, totals)
      );

      console.log(`Generated ${outputPath} from ${worldgenFile}`);
    }

    removeStaleOutputFiles(validOutputFiles, namespaces);
    return;
  }

  console.log("No worldgen structure JSON files found; falling back to raw NBT structure grouping.");

  const structureFiles = walk(inputRoot)
    .filter(file => file.endsWith(".nbt"))
    .map(file => ({ file, info: getStructureInfo(file) }))
    .filter(entry => entry.info !== null);

  const groups = new Map();

  for (const { file, info } of structureFiles) {
    const key = `${info.namespace}:${info.topFolder}`;

    if (!groups.has(key)) {
      groups.set(key, {
        namespace: info.namespace,
        topFolder: info.topFolder,
        files: []
      });
    }

    groups.get(key).files.push({
      path: file,
      structureFile: info.structureFile
    });
  }

  for (const group of groups.values()) {
    namespaces.add(group.namespace);

    const structures = [];
    const totals = {
      blockCounts: new Map(),
      entityCounts: new Map(),
      lootTables: new Map()
    };

    for (const file of group.files) {
      const structure = await readNbtFile(file.path);
      const data = collectStructureData(structure);

      structures.push({
        structureFile: file.structureFile,
        data
      });

      mergeTotals(totals, data);
    }

    structures.sort((a, b) => a.structureFile.localeCompare(b.structureFile));

    const outputPath = path.join(
      outputRoot,
      group.namespace,
      "structure",
      `${group.topFolder}${outputExtension}`
    );

    validOutputFiles.add(path.normalize(outputPath));

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, await generateMarkdown(group.topFolder, structures, totals));

    console.log(`Generated ${outputPath}`);
  }

  removeStaleOutputFiles(validOutputFiles, namespaces);
  writeItemIconManifest();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});