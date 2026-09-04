#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = process.env.SOURCE_REPO_ROOT || process.cwd();
const workflowRoot = process.env.WORKFLOW_ROOT || path.resolve(__dirname, '..', '..');
const outRoot = process.env.RECIPE_MARKDOWN_OUTPUT_ROOT || process.env.WIKI_RECIPE_MARKDOWN_OUTPUT_ROOT || path.join(process.env.WIKI_OUTPUT_ROOT || path.join(repoRoot, 'wiki'), 'recipes');
const vanillaRoot = process.env.VANILLA_ASSET_ROOT || path.join(workflowRoot, '.cache', 'vanilla-assets', 'active');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function stat(p) { try { return fs.statSync(p); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function s(v, fallback = '') {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return s(v.id ?? v.value ?? v.item ?? v.tag ?? v.model ?? v.name, fallback);
  return fallback;
}
function idParts(id, def = 'minecraft') {
  const raw = s(id).replace(/^#/, '');
  const i = raw.indexOf(':');
  return i >= 0 ? [raw.slice(0, i), raw.slice(i + 1)] : [def, raw];
}
function prettyId(id) {
  const [ns, name] = idParts(id);
  return name.split('/').pop().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function prettyTranslateKey(key) {
  // Lang keys look like "item.<namespace>.<path.with.dots>" — strip the
  // leading category/namespace segments so a missing translation degrades to
  // "Stone Broadsword" rather than "Item.Fabled Roots.Stone Broadsword".
  const parts = s(key).split('.').filter(Boolean);
  const rest = parts.length > 2 ? parts.slice(2) : parts;
  return rest.join(' ').split('/').pop().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function file(root, ...parts) {
  const p = path.join(root, ...parts);
  return exists(p) ? p : null;
}
function findAsset(ns, folder, name, ext = '.json') {
  const clean = s(name).replace(/\\/g, '/').replace(new RegExp(`${ext.replace('.', '\\.')}$`), '');
  return file(repoRoot, 'assets', ns, folder, `${clean}${ext}`) || file(vanillaRoot, 'assets', ns, folder, `${clean}${ext}`);
}
function findData(ns, folder, name, ext = '.json') {
  const clean = s(name).replace(/\\/g, '/').replace(new RegExp(`${ext.replace('.', '\\.')}$`), '');
  return file(repoRoot, 'data', ns, folder, `${clean}${ext}`) || file(vanillaRoot, 'data', ns, folder, `${clean}${ext}`);
}

function loadLangs() {
  const merged = {};
  const collect = (root) => {
    if (!exists(path.join(root, 'assets'))) return;
    for (const ns of fs.readdirSync(path.join(root, 'assets'))) {
      const langDir = path.join(root, 'assets', ns, 'lang');
      if (!exists(langDir)) continue;
      for (const name of ['en_us.json', 'en_us.lang']) {
        const p = path.join(langDir, name);
        if (!exists(p)) continue;
        if (name.endsWith('.json')) Object.assign(merged, readJson(p) || {});
        else {
          for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
            const i = line.indexOf('=');
            if (i > 0) merged[line.slice(0, i)] = line.slice(i + 1);
          }
        }
      }
    }
  };
  collect(vanillaRoot);
  collect(repoRoot);
  return merged;
}
const lang = loadLangs();

function jukeboxSongTitle(components) {
  if (!components) return null;
  const jukebox = components['minecraft:jukebox_playable'] || components.jukebox_playable;
  if (!jukebox) return null;
  const songId = typeof jukebox === 'string' ? jukebox : s(jukebox.song);
  if (!songId) return null;
  const [ns, rawName] = idParts(songId);
  const p = findData(ns, 'jukebox_song', rawName);
  if (!p) return null;
  const json = readJson(p);
  const desc = json?.description;
  if (!desc) return null;
  if (typeof desc === 'string') return desc;
  if (desc.translate && lang[desc.translate]) return lang[desc.translate];
  if (desc.text) return desc.text;
  return null;
}

function langForItem(id, components) {
  const songTitle = jukeboxSongTitle(components);
  const itemName = components?.['minecraft:item_name'] || components?.item_name || components?.itemName;
  if (itemName) {
    let baseName = null;
    if (typeof itemName === 'string') baseName = itemName;
    else if (itemName.translate && lang[itemName.translate]) baseName = lang[itemName.translate];
    else if (itemName.text) baseName = itemName.text;
    if (baseName != null) return songTitle ? `${baseName} (${songTitle})` : baseName;
  }
  // Paintings: surface the variant title so the recipe doesn't just say
  // "Painting" for every painting recipe.
  if (s(id).replace(/^minecraft:/, '') === 'painting' && components) {
    const v = paintingVariantTitle(components);
    if (v) return `Painting (${v})`;
  }
  // Try item_model for a better lang name when no item_name is set.
  const itemModel = s(components?.['minecraft:item_model'] ?? components?.item_model ?? components?.itemModel);
  if (itemModel) {
    const [mns, mname] = idParts(itemModel);
    for (const key of [`item.${mns}.${mname.replace(/\//g, '.')}`, `block.${mns}.${mname.replace(/\//g, '.')}`]) {
      if (lang[key]) return songTitle ? `${lang[key]} (${songTitle})` : lang[key];
    }
  }
  const [ns, name] = idParts(id);
  const keys = [
    `item.${ns}.${name.replace(/\//g, '.')}`,
    `block.${ns}.${name.replace(/\//g, '.')}`,
    `entity.${ns}.${name.replace(/\//g, '.')}`,
  ];
  for (const key of keys) if (lang[key]) return songTitle ? `${lang[key]} (${songTitle})` : lang[key];
  // No lang entry anywhere (missing upstream translation). Prefer prettifying
  // the pack's own intended translate key over the generic base item id, so
  // e.g. a re-skinned stone_sword still reads "Stone Broadsword" and not
  // the vanilla "Stone Sword".
  if (itemName?.translate) {
    const pretty = prettyTranslateKey(itemName.translate);
    return songTitle ? `${pretty} (${songTitle})` : pretty;
  }
  return songTitle ? `${prettyId(id)} (${songTitle})` : prettyId(id);
}

function paintingVariantTitle(components) {
  // 1.21+ stores the variant under either the slash-style key or the legacy
  // nested form. The value can be a string id ("minecraft:kebab") or an inline
  // object with { title, asset_id, width, height, author }.
  const raw = components['minecraft:painting/variant']
    || components.painting?.variant
    || components.variant
    || components['minecraft:painting_variant'];
  if (!raw) return null;
  // Inline object with explicit title.
  if (typeof raw === 'object' && raw.title) {
    if (typeof raw.title === 'string') return raw.title;
    if (raw.title.translate && lang[raw.title.translate]) return lang[raw.title.translate];
    if (raw.title.text) return raw.title.text;
  }
  // String id, or inline object with asset_id.
  const id = typeof raw === 'string' ? raw : s(raw.asset_id || raw.id);
  if (!id) return null;
  const [ns, name] = idParts(id);
  const key = `painting.${ns}.${name}.title`;
  if (lang[key]) return lang[key];
  return prettyId(id);
}
function normalizeTagPath(name) {
  return s(name).replace(/^#/, '').replace(/^tags\/items?\//, '').replace(/^items?\//, '');
}
function tagDisplayName(tagId) {
  const [ns, raw] = idParts(tagId);
  const clean = normalizeTagPath(raw);
  const key = `tag.item.${ns}.${clean.replace(/\//g, '.')}`;
  if (lang[key]) return lang[key];
  return `#${ns}:${clean}`;
}
function resolveTag(tagId, seen = new Set()) {
  const [ns, raw] = idParts(tagId);
  const clean = normalizeTagPath(raw);
  const key = `${ns}:${clean}`;
  if (seen.has(key)) return [];
  seen.add(key);

  const p = [
    findData(ns, 'tags/item', clean),
    findData(ns, 'tags/items', clean),
    findData(ns, 'tags', `item/${clean}`),
    findData(ns, 'tags', `items/${clean}`),
  ].find(Boolean);

  const json = p ? readJson(p) : null;
  const values = Array.isArray(json?.values) ? json.values : [];
  const out = [];

  for (const entry of values) {
    let value = entry;
    if (entry && typeof entry === 'object') value = entry.id ?? entry.value ?? entry.item ?? entry.tag;
    value = s(value);
    if (!value) continue;
    if (value.startsWith('#')) out.push(...resolveTag(value.slice(1), seen));
    else out.push(value);
  }

  return [...new Set(out)];
}
function ingredientName(ing, details) {
  if (!ing) return '';
  if (Array.isArray(ing)) {
    const names = ing.flatMap(x => [ingredientName(x, details)]).filter(Boolean);
    return names.length ? names.join(' / ') : '';
  }
  if (typeof ing === 'string') {
    if (ing.startsWith('#')) return tagNameWithDetails(ing.slice(1), details);
    return langForItem(ing);
  }
  if (typeof ing === 'object') {
    const item = s(ing.item ?? ing.id);
    const tag = s(ing.tag);
    if (item) return langForItem(item, ing.components || ing.components_patch || ing.componentsPatch);
    if (tag) return tagNameWithDetails(tag, details);
  }
  return '';
}
function tagNameWithDetails(tag, details) {
  const display = tagDisplayName(tag);
  const resolved = resolveTag(tag);
  if (resolved.length) {
    details.tags.set(display, resolved.map(x => langForItem(x)));
  }
  return display;
}
function resultName(result) {
  if (!result) return '';
  if (typeof result === 'string') return langForItem(result);
  if (Array.isArray(result)) return result.map(resultName).filter(Boolean).join(' / ');
  const item = s(result.item ?? result.id);
  if (!item) return '';
  const count = Number(result.count || 1);
  const name = langForItem(item, result.components || result.components_patch || result.componentsPatch);
  return count > 1 ? `${name} ×${count}` : name;
}
function recipeTitle(recipe, fallbackId) {
  const result = resultName(recipe.result || recipe.output || recipe.results);
  if (result) return result.replace(/\s×\d+$/, '');
  return prettyId(fallbackId);
}
function typeName(type) {
  const t = s(type).replace(/^minecraft:/, '');
  return ({
    crafting_shaped: 'Crafting: Shaped',
    crafting_shapeless: 'Crafting: Shapeless',
    smelting: 'Furnace Smelting',
    blasting: 'Blasting',
    smoking: 'Smoking',
    campfire_cooking: 'Campfire Cooking',
    stonecutting: 'Stonecutting',
    smithing_transform: 'Smithing: Transform',
    smithing_trim: 'Smithing: Trim',
    crafting_special_armordye: 'Special Crafting: Armor Dye',
    crafting_special_bannerduplicate: 'Special Crafting: Banner Duplicate',
    crafting_special_bookcloning: 'Special Crafting: Book Cloning',
    crafting_special_firework_rocket: 'Special Crafting: Firework Rocket',
    crafting_special_firework_star: 'Special Crafting: Firework Star',
    crafting_special_firework_star_fade: 'Special Crafting: Firework Star Fade',
    crafting_special_mapcloning: 'Special Crafting: Map Cloning',
    crafting_special_mapextending: 'Special Crafting: Map Extending',
    crafting_special_repairitem: 'Special Crafting: Repair Item',
    crafting_special_shielddecoration: 'Special Crafting: Shield Decoration',
    crafting_special_shulkerboxcoloring: 'Special Crafting: Shulker Box Coloring',
    crafting_special_suspiciousstew: 'Special Crafting: Suspicious Stew',
    crafting_special_tippedarrow: 'Special Crafting: Tipped Arrow',
  })[t] || t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function mdEscape(v) {
  return s(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
function renderDetails(details) {
  if (!details.tags.size) return '';
  const sections = [];
  for (const [tag, items] of details.tags.entries()) {
    sections.push(`<details>\n<summary>${mdEscape(tag)}</summary>\n\n${items.map(x => `- ${mdEscape(x)}`).join('\n')}\n\n</details>`);
  }
  return sections.join('\n\n');
}
function shapedTable(recipe, details) {
  const pattern = recipe.pattern || [];
  const key = recipe.key || {};
  const rows = [];

  for (let y = 0; y < 3; y++) {
    const cells = [];
    const line = s(pattern[y]);
    for (let x = 0; x < 3; x++) {
      const ch = line[x] || ' ';
      const value = ch === ' ' ? '' : ingredientName(key[ch], details);
      cells.push(`<td>${mdEscape(value)}</td>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }

  return `<table class="ee-recipe-grid">\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`;
}
function shapelessList(recipe, details) {
  const arr = recipe.ingredients || [];
  if (!arr.length) return '*No ingredients listed.*';
  return arr.map(x => `- ${mdEscape(ingredientName(x, details))}`).join('\n');
}
function cookingBody(recipe, details) {
  const input = ingredientName(recipe.ingredient || recipe.input, details);
  const result = resultName(recipe.result || recipe.output);
  const extras = [];
  if (recipe.experience != null) extras.push(`**Experience:** ${recipe.experience}`);
  if (recipe.cookingtime != null) extras.push(`**Cooking time:** ${recipe.cookingtime} ticks`);
  return `**Input:** ${mdEscape(input)}\n\n**Result:** ${mdEscape(result)}${extras.length ? `\n\n${extras.join('\n')}` : ''}`;
}
function stonecuttingBody(recipe, details) {
  return `**Input:** ${mdEscape(ingredientName(recipe.ingredient || recipe.input, details))}\n\n**Result:** ${mdEscape(resultName(recipe.result || recipe.output))}`;
}
function smithingBody(recipe, details) {
  const lines = [];
  if (recipe.template) lines.push(`**Template:** ${mdEscape(ingredientName(recipe.template, details))}`);
  if (recipe.base) lines.push(`**Base:** ${mdEscape(ingredientName(recipe.base, details))}`);
  if (recipe.addition) lines.push(`**Addition:** ${mdEscape(ingredientName(recipe.addition, details))}`);
  if (recipe.result) lines.push(`**Result:** ${mdEscape(resultName(recipe.result))}`);
  return lines.join('\n\n') || '*No smithing fields listed.*';
}
function genericBody(recipe, details) {
  const lines = [];
  for (const [k, v] of Object.entries(recipe)) {
    if (['type', 'category', 'group'].includes(k)) continue;

    if (k === 'result' || k === 'output' || k === 'results') {
      lines.push(`**${k}:** ${mdEscape(resultName(v))}`);
    } else if (k === 'ingredient' || k === 'ingredients' || k === 'input' || k === 'inputs') {
      if (Array.isArray(v)) lines.push(`**${k}:**\n${v.map(x => `- ${mdEscape(ingredientName(x, details))}`).join('\n')}`);
      else lines.push(`**${k}:** ${mdEscape(ingredientName(v, details))}`);
    } else if (k === 'template' || k === 'base' || k === 'addition') {
      lines.push(`**${k}:** ${mdEscape(ingredientName(v, details))}`);
    } else if (typeof v !== 'object') {
      lines.push(`**${k}:** ${mdEscape(v)}`);
    }
  }
  return lines.length ? lines.join('\n\n') : '*Special recipe. See in-game recipe book for dynamic behavior.*';
}

function collectTagsDeep(value, details) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectTagsDeep(entry, details);
    return;
  }
  if (typeof value === 'string') {
    if (value.startsWith('#')) tagNameWithDetails(value.slice(1), details);
    return;
  }
  if (typeof value === 'object') {
    const tag = s(value.tag);
    if (tag) tagNameWithDetails(tag, details);

    // Common recipe ingredient containers across vanilla/custom recipe types.
    for (const key of [
      'ingredient', 'ingredients', 'input', 'inputs',
      'template', 'base', 'addition',
      'item', 'items', 'value', 'values',
      'key'
    ]) {
      if (value[key] != null && key !== 'item') collectTagsDeep(value[key], details);
    }

    // Shaped crafting key maps use arbitrary single-character keys.
    if (value.key && typeof value.key === 'object') {
      for (const entry of Object.values(value.key)) collectTagsDeep(entry, details);
    }
  }
}

function renderRecipe(id, recipe) {
  const details = { tags: new Map() };
  collectTagsDeep(recipe, details);
  const type = s(recipe.type).replace(/^minecraft:/, '');
  const title = recipeTitle(recipe, id);
  const lines = [`# ${mdEscape(title)}`, '', `**Type:** ${mdEscape(typeName(recipe.type))}`];
  lines.push('', `**Recipe ID:** \`${id}\``, '');

  if (type === 'crafting_shaped') {
    lines.push('## Pattern', '', shapedTable(recipe, details), '', `**Result:** ${mdEscape(resultName(recipe.result || recipe.output))}`);
  } else if (type === 'crafting_shapeless') {
    lines.push('## Ingredients', '', shapelessList(recipe, details), '', `**Result:** ${mdEscape(resultName(recipe.result || recipe.output))}`);
  } else if (['smelting', 'blasting', 'smoking', 'campfire_cooking'].includes(type)) {
    lines.push(cookingBody(recipe, details));
  } else if (type === 'stonecutting') {
    lines.push(stonecuttingBody(recipe, details));
  } else if (type === 'smithing_transform' || type === 'smithing_trim') {
    lines.push(smithingBody(recipe, details));
  } else if (type.startsWith('crafting_special_')) {
    lines.push('*Special crafting recipe. Ingredients and result are determined dynamically by Minecraft.*');
  } else {
    lines.push(genericBody(recipe, details));
  }

  const d = renderDetails(details);
  if (d) lines.push('', '## Tags', '', d);
  lines.push('');
  return lines.join('\n');
}
function collectRecipes() {
  const out = [];
  const dataRoot = path.join(repoRoot, 'data');
  if (!exists(dataRoot)) return out;
  for (const ns of fs.readdirSync(dataRoot)) {
    const nsDir = path.join(dataRoot, ns);
    if (!stat(nsDir)?.isDirectory()) continue;
    for (const folder of ['recipe', 'recipes']) {
      const root = path.join(nsDir, folder);
      if (!exists(root)) continue;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile() && e.name.endsWith('.json')) {
            const json = readJson(p);
            if (!json?.type) continue;
            const rel = path.relative(root, p).split(path.sep).join('/');
            const id = `${ns}:${rel.replace(/\.json$/, '')}`;
            out.push({ ns, root, file: p, rel, id, json });
          }
        }
      }
    }
  }
  return out;
}
function main() {
  const recipes = collectRecipes();
  let count = 0;
  for (const r of recipes) {
    const outDir = path.join(outRoot, r.ns, 'recipe', path.dirname(r.rel));
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, path.basename(r.rel, '.json') + '.md');
    fs.writeFileSync(outFile, renderRecipe(r.id, r.json), 'utf8');
    count++;
  }
  if (count) console.log(`Generated ${count} recipe markdown file(s).`);
}
main();
