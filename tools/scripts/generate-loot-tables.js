const fs = require("fs");
const path = require("path");
const https = require("https");

const inputRoot = "data";
const assetsRoot = "assets";
const outputRoot = process.env.WIKI_MARKDOWN_OUTPUT_ROOT || path.join(process.env.WIKI_OUTPUT_ROOT || "wiki", "markdown");
const vanillaRoot = process.env.VANILLA_ASSET_ROOT || path.join(__dirname, "..", "..", ".cache", "vanilla-assets", "active");
const itemRenderRoot = process.env.ITEM_RENDER_OUTPUT_ROOT || (process.env.WIKI_OUTPUT_ROOT ? path.join(process.env.WIKI_OUTPUT_ROOT, "images", "items") : null);
const wikiOutputRoot = process.env.WIKI_OUTPUT_ROOT || null;
const SITE_BASE = "https://explorerseden.eu";

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


function titleCase(id) {
  return String(id)
    .replace(/^#/, "")
    .replace(/^[^:]+:/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
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

function getCountRange(count) {
  if (typeof count === "number") return { min: count, max: count };

  if (count && typeof count === "object") {
    if (count.min !== undefined && count.max !== undefined) {
      return { min: Number(count.min), max: Number(count.max) };
    }

    if (count.type === "minecraft:uniform" && count.min !== undefined && count.max !== undefined) {
      return { min: Number(count.min), max: Number(count.max) };
    }
  }

  return null;
}

function formatStackRange(min, max) {
  return min === max ? String(min) : `${min} - ${max}`;
}

function formatTruncatedNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return String(value);

  const factor = 10 ** decimals;
  const truncated = Math.trunc(value * factor) / factor;

  return truncated.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function getStackSizeOutcomes(entry) {
  const fn = entry.functions?.find(f => f.function === "minecraft:set_count");
  if (!fn) {
    return [{ stackSize: "1", weightFactor: 1, isEmpty: false }];
  }

  const count = fn.count;
  const range = getCountRange(count);

  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    return [{ stackSize: "1", weightFactor: 1, isEmpty: false }];
  }

  if (range.min === range.max) {
    return [{
      stackSize: String(range.min),
      weightFactor: 1,
      isEmpty: range.min === 0
    }];
  }

  const min = Math.ceil(range.min);
  const max = Math.floor(range.max);

  if (Number.isInteger(range.min) && Number.isInteger(range.max) && max >= min && max - min <= 256) {
    const totalCount = max - min + 1;
    const outcomes = [];

    if (min <= 0 && max >= 0) {
      outcomes.push({
        stackSize: "0",
        weightFactor: 1 / totalCount,
        isEmpty: true
      });
    }

    const visibleMin = Math.max(min, 1);
    const visibleMax = max;

    if (visibleMax >= visibleMin) {
      outcomes.push({
        stackSize: formatStackRange(visibleMin, visibleMax),
        weightFactor: (visibleMax - visibleMin + 1) / totalCount,
        isEmpty: false
      });
    }

    return outcomes;
  }

  if (range.min <= 0 && range.max >= 0) {
    console.warn(`Cannot exactly split non-integer stack size range ${range.min}–${range.max}; treating it as one visible range.`);
  }

  return [{
    stackSize: formatStackRange(range.min, range.max),
    weightFactor: 1,
    isEmpty: false
  }];
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

async function flattenEntries(entries, inheritedWeight = 1, inheritedFunctions = [], details = null, seenLootTables = new Set()) {
  const result = [];

  for (const entry of entries ?? []) {
    const weight = entry.weight ?? 1;
    const combinedWeight = inheritedWeight * weight;

    const entryFunctions = [
      ...inheritedFunctions,
      ...(entry.functions ?? [])
    ];

    const inheritedEntry = withInheritedFunctions(entry, inheritedFunctions);

    if (
      entry.type === "minecraft:alternatives" ||
      entry.type === "minecraft:group" ||
      entry.type === "minecraft:sequence"
    ) {
      result.push(...await flattenEntries(entry.children ?? [], combinedWeight, entryFunctions, details, seenLootTables));
      continue;
    }

    if (entry.type === "minecraft:loot_table") {
      const lootTable = cleanTag(entry.value ?? entry.name ?? "unknown");

      if (!seenLootTables.has(lootTable)) {
        const nestedJson = await loadLootTableJson(lootTable);

        if (nestedJson) {
          const nextSeen = new Set(seenLootTables);
          nextSeen.add(lootTable);

          for (const nestedPool of nestedJson.pools ?? []) {
            // Flatten inner entries with weight 1 to get relative weights, then normalize.
            // Each roll of the outer entry pulls exactly one item from the nested pool,
            // so we scale each inner item's probability by (inner_weight / inner_total).
            const innerEntries = await flattenEntries(
              nestedPool.entries ?? [],
              1,
              [...entryFunctions, ...(nestedPool.functions ?? [])],
              details,
              nextSeen
            );
            const innerTotal = innerEntries.reduce((sum, e) => sum + e.weight, 0);
            if (innerTotal > 0) {
              for (const e of innerEntries) {
                result.push({ ...e, weight: combinedWeight * (e.weight / innerTotal) });
              }
            }
          }
          continue;
        }
      }

      // Circular reference or unresolvable table — show as opaque entry
      for (const outcome of getStackSizeOutcomes(inheritedEntry)) {
        result.push({
          item: `Loot Table (${lootTable})`,
          itemId: null,
          stackSize: outcome.stackSize,
          weight: combinedWeight * outcome.weightFactor
        });
      }
      continue;
    }

    const item = await getItemName(inheritedEntry, undefined, details);
    const itemId = await getItemId(inheritedEntry);
    const dyedColor = itemId ? getItemDyedColor(inheritedEntry) : null;
    const iconId = itemId && dyedColor ? `${itemId}#${dyedColor}` : itemId;

    for (const outcome of getStackSizeOutcomes(inheritedEntry)) {
      result.push({
        item: outcome.isEmpty ? "Empty" : item,
        itemId: outcome.isEmpty ? null : itemId,
        iconId: outcome.isEmpty ? null : iconId,
        stackSize: outcome.stackSize,
        weight: combinedWeight * outcome.weightFactor
      });
    }
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
    const flattenedEntries = await flattenEntries(pool.entries ?? [], 1, pool.functions ?? [], details);
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
        weight: formatTruncatedNumber(entry.weight, 2),
        chanceValue,
        chance: `${formatTruncatedNumber(chanceValue * 100, 1)}%`
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

async function generateMarkdown(json, sourcePath) {
  const title = titleCase(path.basename(sourcePath, ".json"));
  const details = { tags: new Map(), enchantmentTags: new Map() };
  const tableSection = await renderMergedPools(json.pools ?? [], details);

  const parts = [`# ${title}`, "", tableSection];

  const tagSection = renderTagDetails(details);
  if (tagSection) {
    parts.push("", "#### Tags", "", tagSection);
  }

  const enchantmentTagSection = renderEnchantmentTagDetails(details);
  if (enchantmentTagSection) {
    parts.push("", "#### Enchantment Tags", "", enchantmentTagSection);
  }

  parts.push("");
  return parts.join("\n");
}

function getLootTableInfo(file) {
  const parts = file.split(path.sep);
  const dataIndex = parts.indexOf("data");
  const lootTableIndex = parts.indexOf("loot_table");

  if (dataIndex === -1 || lootTableIndex === -1) return null;
  if (lootTableIndex !== dataIndex + 2) return null;

  return {
    namespace: parts[dataIndex + 1],
    relativePath: parts.slice(lootTableIndex + 1).join(path.sep)
  };
}

function removeStaleMarkdownFiles(validOutputFiles, namespaces) {
  for (const namespace of namespaces) {
    const lootTableRoot = path.join(outputRoot, namespace, "loot_table");

    if (!fs.existsSync(lootTableRoot)) continue;

    for (const file of walk(lootTableRoot).filter(file => file.endsWith(".md"))) {
      const normalized = path.normalize(file);

      if (!validOutputFiles.has(normalized)) {
        fs.rmSync(file);
        console.log(`Removed stale ${file}`);
      }
    }
  }
}

async function main() {
  const lootTableFiles = walk(inputRoot)
    .filter(file => file.endsWith(".json"))
    .map(file => ({ file, info: getLootTableInfo(file) }))
    .filter(entry => entry.info !== null);

  const validOutputFiles = new Set();
  const namespaces = new Set();

  for (const { file, info } of lootTableFiles) {
    namespaces.add(info.namespace);

    const json = JSON.parse(fs.readFileSync(file, "utf8"));

    const outputPath = path.join(
      outputRoot,
      info.namespace,
      "loot_table",
      info.relativePath.replace(/\.json$/, ".md")
    );

    validOutputFiles.add(path.normalize(outputPath));

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, await generateMarkdown(json, file));

    console.log(`Generated ${outputPath}`);
  }

  removeStaleMarkdownFiles(validOutputFiles, namespaces);
  writeItemIconManifest();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
