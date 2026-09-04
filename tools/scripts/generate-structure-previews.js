// scripts/generate-structure-previews.js
const fs = require("fs");
const path = require("path");
const nbt = require("prismarine-nbt");
const { PNG } = require("pngjs");
const crypto = require("crypto");

// deepslate is an ES module. Its package.json "exports" field doesn't expose
// the UMD bundle as a public subpath, so require("deepslate/...") fails. Load
// the UMD file directly by absolute path — the bundle IS shipped in the package,
// just not declared in exports.
let deepslate = null;
{
  const candidates = [
    path.join(process.env.NODE_PATH || "", "deepslate", "dist", "deepslate.umd.cjs"),
    path.join(__dirname, "..", "..", ".cache", "wiki-node-deps", "node_modules", "deepslate", "dist", "deepslate.umd.cjs"),
    path.join(process.cwd(), ".cache", "wiki-node-deps", "node_modules", "deepslate", "dist", "deepslate.umd.cjs"),
    path.join(process.cwd(), "node_modules", "deepslate", "dist", "deepslate.umd.cjs"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try { deepslate = require(p); break; } catch {}
    }
  }
  if (!deepslate) console.warn("deepslate not found — falling back to legacy renderer");
}

// Virtual texture atlas for deepslate's SpecialRenderers. Each texture id gets
// assigned a unique vertical slot [0, slot, 1, slot+1] in atlas space, so we can
// run deepslate's BlockModel.getMesh / SpecialRenderers.getBlockMesh without an
// actual texture atlas image. After mesh generation, each quad's vertex UVs let
// us decode which texture id the quad uses (Math.floor of the v coord = slot).
class DeepslateVirtualAtlas {
  constructor() {
    this.slots = new Map();
    this.textureIds = [];
  }
  _slot(id) {
    const key = id?.toString ? id.toString() : String(id);
    if (this.slots.has(key)) return this.slots.get(key);
    const slot = this.textureIds.length;
    this.slots.set(key, slot);
    this.textureIds.push(key);
    return slot;
  }
  getTextureAtlas() { return { data: new Uint8ClampedArray(0), width: 0, height: 0 }; }
  getTextureUV(id) {
    const slot = this._slot(id);
    return [0, slot, 1, slot + 1];
  }
  getPixelSize() { return 16; }
}

function resolveDeepslateTexture(textureId) {
  // textureId is "namespace:path/to/texture" with no .png suffix. tryLoadTextureWithFallback
  // handles primary + entity-fallback + TEXTURE_FALLBACKS lookup in one place.
  const normalized = textureId.includes(":") ? textureId : `minecraft:${textureId}`;
  return tryLoadTextureWithFallback(normalized);
}

// Blocks that ARE the water-with-a-plant: rendering an extra water cube around
// them via deepslate's getBlockMesh waterlogged-add path just buries the plant.
// Vanilla MC renders these blocks AS water with the plant inside, but in a 3D
// preview the surrounding water just obscures the structure.
const SUPPRESS_WATERLOG_FOR = new Set([
  "minecraft:seagrass",
  "minecraft:tall_seagrass",
  "minecraft:kelp",
  "minecraft:kelp_plant",
  "minecraft:sea_pickle",
  "minecraft:bubble_column",
  "minecraft:fire_coral", "minecraft:brain_coral", "minecraft:bubble_coral",
  "minecraft:horn_coral", "minecraft:tube_coral",
  "minecraft:fire_coral_fan", "minecraft:brain_coral_fan", "minecraft:bubble_coral_fan",
  "minecraft:horn_coral_fan", "minecraft:tube_coral_fan",
  "minecraft:fire_coral_wall_fan", "minecraft:brain_coral_wall_fan", "minecraft:bubble_coral_wall_fan",
  "minecraft:horn_coral_wall_fan", "minecraft:tube_coral_wall_fan"
]);

function bakeViaDeepslateSpecialRenderer(blockName, properties) {
  if (!deepslate?.SpecialRenderers?.getBlockMesh || !deepslate?.BlockState) return null;
  const props = {};
  for (const [k, v] of Object.entries(properties)) props[k] = String(v);
  let blockState, atlas, mesh;
  try {
    blockState = new deepslate.BlockState(deepslate.Identifier.parse(blockName), props);
    atlas = new DeepslateVirtualAtlas();
    mesh = deepslate.SpecialRenderers.getBlockMesh(blockState, undefined, atlas, deepslate.Cull.none());
  } catch (e) { return null; }
  if (!mesh || !mesh.quads || mesh.quads.length === 0) return null;

  // Deepslate's BlockState.isWaterlogged() hardcodes seagrass, tall_seagrass,
  // kelp, kelp_plant, bubble_column, and coral variants as always-waterlogged
  // regardless of the property, so getBlockMesh always adds a water cube
  // around them. In the preview viewer that buries the actual plant. Drop the
  // water quads for these blocks here.
  const dropWater = SUPPRESS_WATERLOG_FOR.has(blockName);

  const baked = [];
  for (const q of mesh.quads) {
    const verts = [q.v1, q.v2, q.v3, q.v4];
    if (!verts.every(v => v?.texture && v?.textureLimit && v?.pos)) continue;
    const slot = Math.floor(verts[0].textureLimit[1] + 1e-6);
    const textureId = atlas.textureIds[slot];
    if (!textureId) continue;
    const isWater = textureId.includes("water_still") || textureId.includes("water_flow");
    if (dropWater && isWater) continue;
    const texture = resolveDeepslateTexture(textureId);
    const points = verts.map(v => ({ x: v.pos.x, y: v.pos.y, z: v.pos.z }));
    const uvVertices = verts.map(v => ({
      u: v.texture[0] * 16,
      v: (v.texture[1] - slot) * 16
    }));
    const us = uvVertices.map(u => u.u), vs = uvVertices.map(u => u.v);
    const uvBox = [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
    // Deepslate writes the per-vertex tint colour via setColor() during banner /
    // signs / shulker (etc.) mesh build. Forward it as a per-quad colorTint so
    // the viewer can multiply texture × dye color and produce a coloured banner
    // instead of plain white.
    const c = verts[0].color;
    let colorTint = null;
    if (Array.isArray(c) && c.length >= 3 && (c[0] < 0.995 || c[1] < 0.995 || c[2] < 0.995)) {
      colorTint = {
        r: Math.max(0, Math.min(255, Math.round(c[0] * 255))),
        g: Math.max(0, Math.min(255, Math.round(c[1] * 255))),
        b: Math.max(0, Math.min(255, Math.round(c[2] * 255))),
        a: 255
      };
    }
    // Water surfaces from the waterlogged-fallback path need the plains-water
    // biome tint (the texture itself is a faint blue-grey; without the tint
    // the water reads as washed-out).
    baked.push({
      blockName,
      faceName: "special",
      points,
      texture,
      uv: uvBox,
      uvRotation: 0,
      uvVertices,
      tintIndex: isWater ? 0 : null,
      colorTint,
      shade: 1,
      depthOffset: faceDepth(points)
    });
  }
  return baked;
}

const inputRoot = process.env.STRUCTURE_INPUT_ROOT ?? "data";
const outputRoot = process.env.STRUCTURE_PREVIEW_OUTPUT_ROOT ?? path.join("wiki", "images", "structures");
const vanillaAssetRoot = process.env.VANILLA_ASSET_ROOT ?? path.join(".cache", "vanilla-assets");
const generateWorldgenStructurePreviews = String(process.env.STRUCTURE_PREVIEW_WORLDGEN ?? "true") !== "false";

const tileWidth = Number(process.env.STRUCTURE_PREVIEW_TILE_WIDTH ?? 32);
const tileHeight = Number(process.env.STRUCTURE_PREVIEW_TILE_HEIGHT ?? 18);
const blockHeight = Number(process.env.STRUCTURE_PREVIEW_BLOCK_HEIGHT ?? 22);
const padding = Number(process.env.STRUCTURE_PREVIEW_PADDING ?? 48);
const maxImageSize = Number(process.env.STRUCTURE_PREVIEW_MAX_SIZE ?? 900);
const transparentBackground = String(process.env.STRUCTURE_PREVIEW_TRANSPARENT ?? "true") !== "false";
const pngCompressionLevel = Math.min(9, Math.max(0, Number(process.env.STRUCTURE_PREVIEW_PNG_COMPRESSION ?? 9)));
const previewSeed = String(process.env.STRUCTURE_PREVIEW_SEED ?? crypto.randomBytes(8).toString("hex"));

const previewRotations = [
  { name: "north", degrees: 0 },
  { name: "east", degrees: 90 },
  { name: "south", degrees: 180 },
  { name: "west", degrees: 270 }
];

const IGNORED_BLOCKS = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:structure_void",
  "minecraft:barrier",
  "minecraft:light",
]);

// Do not invent a fake full cube when a block has no resolved model elements.
// Missing/special-rendered blocks should be omitted rather than appearing as
// bogus oak-plank/default cubes in previews.

function shortBlockName(blockName) {
  return String(blockName || "").replace(/^minecraft:/, "");
}


const modelCache = new Map();
const resolvedModelCache = new Map();
const textureCache = new Map();
const bakedModelCache = new Map();
const fallbackColorCache = new Map();
const textureAverageCache = new Map();

const stats = {
  mainImages: 0,
  structuresRead: 0,
  poolsRead: 0,
  jigsawPoolsFollowed: 0,
  jigsawBlocksResolved: 0,
  textureHits: 0,
  textureMisses: 0,
  bakedQuads: 0,
  skippedMissingModels: 0
};

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

function splitResourceLocation(id, defaultNamespace = "minecraft") {
  if (String(id).includes(":")) {
    const [namespace, ...rest] = String(id).split(":");
    return [namespace, rest.join(":")];
  }

  return [defaultNamespace, String(id)];
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

  return { namespace, topFolder };
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

function getPalette(structure) {
  if (Array.isArray(structure.palette)) return structure.palette;
  if (Array.isArray(structure.palettes?.[0])) return structure.palettes[0];
  return [];
}

function getBlockNameFromPaletteEntry(entry) {
  return entry?.Name ?? entry?.name ?? null;
}

async function readNbtFile(file) {
  const buffer = fs.readFileSync(file);
  const parsed = await nbt.parse(buffer);
  stats.structuresRead++;
  return nbt.simplify(parsed.parsed);
}

// Backstop for critical vanilla textures (chain, banner_base, enderdragon/dragon)
// that CI extraction sometimes silently drops. The files are committed to the
// workflow repo so the build cannot ship a broken-active-cache fallback.
const vanillaAssetBackstop = path.resolve(__dirname, "..", "vanilla-asset-fallback");

function readAssetBuffer(assetPath) {
  const local = path.join(...assetPath.split("/"));
  if (fs.existsSync(local)) return fs.readFileSync(local);

  const vanilla = path.join(vanillaAssetRoot, ...assetPath.split("/"));
  if (fs.existsSync(vanilla)) return fs.readFileSync(vanilla);

  const backstop = path.join(vanillaAssetBackstop, ...assetPath.split("/"));
  if (fs.existsSync(backstop)) return fs.readFileSync(backstop);

  return null;
}

function readJsonAsset(assetPath) {
  if (modelCache.has(assetPath)) return modelCache.get(assetPath);

  const buffer = readAssetBuffer(assetPath);
  if (!buffer) {
    modelCache.set(assetPath, null);
    return null;
  }

  try {
    const json = JSON.parse(buffer.toString("utf8"));
    modelCache.set(assetPath, json);
    return json;
  } catch {
    modelCache.set(assetPath, null);
    return null;
  }
}

function readTextureAsset(assetPath) {
  if (textureCache.has(assetPath)) {
    const cached = textureCache.get(assetPath);
    if (cached !== null) return cached;
    // Cached null: the file was missing on a previous lookup. Re-check disk
    // once in case it landed in the meantime (e.g. vanilla-assets finishing
    // extraction after a generator started). If still gone, return null
    // without re-reading. If now present, fall through and re-read.
    const segs = assetPath.split("/");
    if (!fs.existsSync(path.join(...segs))
        && !fs.existsSync(path.join(vanillaAssetRoot, ...segs))
        && !fs.existsSync(path.join(vanillaAssetBackstop, ...segs))) {
      return null;
    }
    textureCache.delete(assetPath);
  }

  const buffer = readAssetBuffer(assetPath);
  if (!buffer) {
    textureCache.set(assetPath, null);
    stats.textureMisses++;
    return null;
  }

  try {
    const png = PNG.sync.read(buffer);
    Object.defineProperty(png, "__assetPath", { value: assetPath, enumerable: false });
    textureCache.set(assetPath, png);
    stats.textureHits++;
    return png;
  } catch {
    textureCache.set(assetPath, null);
    stats.textureMisses++;
    return null;
  }
}

function stringifyProperties(properties = {}) {
  return Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function parseVariantKey(key) {
  if (!key) return {};

  const result = {};
  for (const part of key.split(",")) {
    const [name, value] = part.split("=");
    if (name && value !== undefined) result[name] = value;
  }

  return result;
}

function variantMatchesBlockState(variantKey, properties = {}) {
  const variant = parseVariantKey(variantKey);

  for (const [key, value] of Object.entries(variant)) {
    if (String(properties[key]) !== String(value)) return false;
  }

  return true;
}

function whenClauseMatches(when, properties = {}) {
  if (!when) return true;

  if (Array.isArray(when.OR)) return when.OR.some(clause => whenClauseMatches(clause, properties));
  if (Array.isArray(when.AND)) return when.AND.every(clause => whenClauseMatches(clause, properties));

  for (const [key, expected] of Object.entries(when)) {
    if (key === "OR" || key === "AND") continue;

    const actual = String(properties[key]);
    const allowed = String(expected).split("|");

    if (!allowed.includes(actual)) return false;
  }

  return true;
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < String(text).length; i++) {
    hash ^= String(text).charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seedText) {
  // One deterministic sample in [0, 1) for a specific choice key. The base
  // previewSeed is randomized once per run unless STRUCTURE_PREVIEW_SEED is set,
  // so weighted jigsaw and blockstate choices vary between runs but remain
  // reproducible when the logged seed is reused.
  let state = hashString(seedText) || 1;
  state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d);
  state = Math.imul(state ^ (state >>> 12), 0x297a2d39);
  state = (state ^ (state >>> 15)) >>> 0;
  return state / 4294967296;
}

function chooseWeightedEntry(entries, seedText) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  let totalWeight = 0;
  for (const entry of entries) {
    totalWeight += Math.max(0, Number(entry?.weight ?? 1));
  }

  if (totalWeight <= 0) return entries[0] ?? null;

  let roll = seededRandom(seedText) * totalWeight;
  for (const entry of entries) {
    roll -= Math.max(0, Number(entry?.weight ?? 1));
    if (roll <= 0) return entry;
  }

  return entries[entries.length - 1] ?? null;
}

function normalizeVariant(variant, seedText = previewSeed) {
  if (Array.isArray(variant)) return chooseWeightedEntry(variant, seedText);
  return variant ?? null;
}

// Blockstate parsing delegates to deepslate's BlockDefinition for correctness
// (handles variants, multipart with AND/OR conditions, and resolves the matching
// case to one or more model variants). Falls back to the legacy parser only if
// deepslate isn't loadable in this environment.
const dsBlockDefinitionCache = new Map();
function loadDeepslateBlockDefinition(blockName) {
  if (dsBlockDefinitionCache.has(blockName)) return dsBlockDefinitionCache.get(blockName);
  const [namespace, blockPath] = splitResourceLocation(blockName);
  const json = readJsonAsset(`assets/${namespace}/blockstates/${blockPath}.json`);
  const def = (json && deepslate?.BlockDefinition) ? deepslate.BlockDefinition.fromJson(json) : null;
  dsBlockDefinitionCache.set(blockName, def);
  return def;
}

function getModelVariantsFromBlockState(blockName, properties = {}) {
  const [namespace, blockPath] = splitResourceLocation(blockName);

  if (deepslate?.BlockDefinition) {
    const def = loadDeepslateBlockDefinition(blockName);
    if (def) {
      const props = {};
      for (const [k, v] of Object.entries(properties)) props[k] = String(v);
      const variants = def.getModelVariants(props);
      if (variants.length > 0) {
        return variants.map(v => ({
          model: v.model,
          x: Number(v.x ?? 0),
          y: Number(v.y ?? 0),
          z: 0,
          uvlock: Boolean(v.uvlock)
        }));
      }
    }
    return [{ model: `${namespace}:block/${blockPath}`, x: 0, y: 0, z: 0, uvlock: false }];
  }

  // Legacy fallback (only used if deepslate isn't available)
  const blockState = readJsonAsset(`assets/${namespace}/blockstates/${blockPath}.json`);
  if (!blockState) {
    return [{ model: `${namespace}:block/${blockPath}`, x: 0, y: 0, uvlock: false }];
  }
  if (blockState.variants) {
    const exactKey = stringifyProperties(properties);
    let variant = blockState.variants[exactKey];
    if (!variant) {
      const matchingKey = Object.keys(blockState.variants).find(key => variantMatchesBlockState(key, properties));
      if (matchingKey) variant = blockState.variants[matchingKey];
    }
    if (!variant) variant = blockState.variants[""] ?? Object.values(blockState.variants)[0];
    variant = normalizeVariant(variant, `${previewSeed}|blockstate|${blockName}|${stringifyProperties(properties)}`);
    if (variant?.model) {
      return [{ model: variant.model, x: Number(variant.x ?? 0), y: Number(variant.y ?? 0), z: Number(variant.z ?? 0), uvlock: Boolean(variant.uvlock) }];
    }
  }
  if (Array.isArray(blockState.multipart)) {
    const variants = [];
    for (const part of blockState.multipart) {
      if (!whenClauseMatches(part.when, properties)) continue;
      const applies = Array.isArray(part.apply) ? [normalizeVariant(part.apply, `${previewSeed}|multipart|${blockName}|${stringifyProperties(properties)}|${variants.length}`)] : [part.apply];
      for (const apply of applies) {
        if (apply?.model) variants.push({ model: apply.model, x: Number(apply.x ?? 0), y: Number(apply.y ?? 0), z: Number(apply.z ?? 0), uvlock: Boolean(apply.uvlock) });
      }
    }
    if (variants.length > 0) return variants;
  }
  return [{ model: `${namespace}:block/${blockPath}`, x: 0, y: 0, z: 0, uvlock: false }];
}

function resolveTextureReference(textureRef, textures = {}) {
  let current = textureRef;

  for (let i = 0; i < 32; i++) {
    if (!current || typeof current !== "string") return null;

    if (current.startsWith("#")) {
      current = textures[current.slice(1)];
      continue;
    }

    return current;
  }

  return null;
}

function resolveTextureMap(textures = {}) {
  const resolved = { ...textures };

  // Vanilla parented models often define textures through chains such as
  // { particle: "#texture", texture: "block/chain" }. If we keep the raw
  // map around until face baking, models like chains, lanterns, torches, and
  // candles can hit unresolved #keys depending on which parent supplied the
  // face. Resolve every key after the full parent+child texture map has been
  // merged, but keep unresolved entries as-is so debugging is still possible.
  for (const key of Object.keys(resolved)) {
    const value = resolveTextureReference(resolved[key], resolved);
    if (value) resolved[key] = value;
  }

  return resolved;
}

// Blockbench (MC 1.21.11+) emits multi-axis rotation {"x":0,"y":-90,"z":0} instead of
// the single-axis {"axis":"y","angle":-22.5} that our element baking expects.
// Normalize to single-axis by picking the dominant non-zero axis.
function normalizeBlockModelRotations(model) {
  if (!model || !Array.isArray(model.elements)) return model;
  return {
    ...model,
    elements: model.elements.map(el => {
      const r = el.rotation;
      if (r && typeof r === "object" && !("axis" in r) && ("x" in r || "y" in r || "z" in r)) {
        let axis = "y", angle = 0;
        for (const a of ["x", "y", "z"]) {
          if (r[a] != null && Math.abs(r[a]) > Math.abs(angle)) { axis = a; angle = r[a]; }
        }
        return { ...el, rotation: { angle, axis, origin: Array.isArray(r.origin) ? r.origin : [8, 8, 8] } };
      }
      return el;
    })
  };
}

// Deepslate-backed model loader. BlockModel.flatten() walks the parent chain,
// inherits textures and elements, and resolves #refs. We then read the model's
// final textures + elements and pass them to our existing bakeElementQuads.
const dsBlockModelCache = new Map();
const dsBlockModelProvider = {
  getBlockModel(id) {
    const key = `${id.namespace ?? "minecraft"}:${id.path ?? id}`;
    if (dsBlockModelCache.has(key)) return dsBlockModelCache.get(key);
    const namespace = id.namespace ?? "minecraft";
    const modelPath = id.path ?? String(id);
    const json = readJsonAsset(`assets/${namespace}/models/${modelPath}.json`);
    const model = (json && deepslate?.BlockModel) ? deepslate.BlockModel.fromJson(json) : null;
    dsBlockModelCache.set(key, model);
    return model;
  }
};

function mergeModel(modelId) {
  const [namespace, modelPath] = splitResourceLocation(modelId);
  const cacheKey = `${namespace}:${modelPath}`;

  if (resolvedModelCache.has(cacheKey)) return resolvedModelCache.get(cacheKey);

  if (deepslate?.BlockModel && deepslate?.Identifier) {
    const id = new deepslate.Identifier(namespace, modelPath);
    const model = dsBlockModelProvider.getBlockModel(id);
    if (!model) {
      const empty = { textures: {}, elements: [] };
      resolvedModelCache.set(cacheKey, empty);
      return empty;
    }
    // flatten() mutates the model in place by walking parents and merging
    // textures + elements. Idempotent — guards via a generationMarker field.
    model.flatten(dsBlockModelProvider);
    // The flattened model exposes its textures and elements directly (TypeScript
    // "private" doesn't enforce anything at runtime). Convert deepslate's
    // texture entries (already namespaced like "minecraft:block/stone") into
    // the "#"-prefixed format my bakeElementQuads expects in face.texture refs.
    const merged = {
      textures: { ...(model.textures ?? {}) },
      elements: model.elements ?? []
    };
    resolvedModelCache.set(cacheKey, merged);
    return merged;
  }

  // Legacy fallback (only if deepslate isn't loadable)
  return legacyMergeModel(modelId);
}

function legacyMergeModel(modelId, seen = new Set()) {
  const [namespace, modelPath] = splitResourceLocation(modelId);
  const key = `${namespace}:${modelPath}`;
  if (resolvedModelCache.has(key)) return resolvedModelCache.get(key);
  if (seen.has(key)) return { textures: {}, elements: [] };
  seen.add(key);
  const model = normalizeBlockModelRotations(readJsonAsset(`assets/${namespace}/models/${modelPath}.json`));
  if (!model) {
    const empty = { textures: {}, elements: [] };
    resolvedModelCache.set(key, empty);
    return empty;
  }
  let parent = { textures: {}, elements: [] };
  if (model.parent) parent = legacyMergeModel(model.parent, seen);
  const mergedTextures = resolveTextureMap({ ...parent.textures, ...(model.textures ?? {}) });
  const merged = { textures: mergedTextures, elements: model.elements ?? parent.elements ?? [] };
  resolvedModelCache.set(key, merged);
  return merged;
}

function hashColor(text) {
  if (fallbackColorCache.has(text)) return fallbackColorCache.get(text);

  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;

  const hue = Math.abs(hash) % 360;
  const saturation = 28 + (Math.abs(hash >> 8) % 28);
  const lightness = 45 + (Math.abs(hash >> 16) % 18);
  const color = hslToRgb(hue, saturation, lightness);

  fallbackColorCache.set(text, color);
  return color;
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a: 255
  };
}

function fallbackColorForBlock(blockName) {
  const short = blockName.replace(/^minecraft:/, "");

  if (short.includes("leaves")) return { r: 79, g: 140, b: 58, a: 190 };
  if (short.includes("grass") || short.includes("moss")) return { r: 102, g: 138, b: 58, a: 210 };
  if (short.includes("dirt") || short.includes("mud")) return { r: 121, g: 83, b: 58, a: 255 };
  if (short.includes("spruce")) return { r: 122, g: 83, b: 48, a: 255 };
  if (short.includes("oak")) return { r: 185, g: 139, b: 75, a: 255 };
  if (short.includes("log") || short.includes("wood") || short.includes("planks")) return { r: 138, g: 90, b: 47, a: 255 };
  if (short.includes("deepslate") || short.includes("blackstone") || short.includes("basalt")) return { r: 63, g: 65, b: 72, a: 255 };
  if (short.includes("stone") || short.includes("tuff") || short.includes("andesite")) return { r: 119, g: 119, b: 119, a: 255 };
  if (short.includes("sand")) return { r: 214, g: 194, b: 122, a: 255 };
  if (short.includes("amethyst") || short.includes("purple")) return { r: 143, g: 104, b: 200, a: 255 };
  if (short.includes("water")) return { r: 61, g: 117, b: 196, a: 145 };
  if (short.includes("lava")) return { r: 230, g: 90, b: 30, a: 255 };
  if (short.includes("glass")) return { r: 158, g: 208, b: 221, a: 120 };
  if (short.includes("copper")) return { r: 184, g: 121, b: 83, a: 255 };
  if (short.includes("bookshelf") || short.includes("lectern")) return { r: 154, g: 106, b: 50, a: 255 };
  if (short.includes("chest") || short.includes("barrel")) return { r: 176, g: 111, b: 40, a: 255 };

  return hashColor(blockName);
}

const PLAINS_GRASS_TINT = { r: 112, g: 148, b: 64 };
const PLAINS_FOLIAGE_TINT = { r: 86, g: 126, b: 42 };
const PLAINS_WATER_TINT = { r: 63, g: 118, b: 228 };
const STEM_TINT = { r: 127, g: 204, b: 25 };

function multiplyTint(color, tint) {
  // Slightly brighten vanilla biome multiplication for website previews. The
  // raw plains multiplication is technically correct, but it reads too dark on
  // the dark Explorer's Eden viewer background.
  return {
    r: Math.max(0, Math.min(255, Math.round((color.r * tint.r) / 255 * 1.48))),
    g: Math.max(0, Math.min(255, Math.round((color.g * tint.g) / 255 * 1.48))),
    b: Math.max(0, Math.min(255, Math.round((color.b * tint.b) / 255 * 1.48))),
    a: color.a ?? 255
  };
}

function needsPlainsGrassTint(blockName, faceName) {
  const short = blockName.replace(/^minecraft:/, "");
  if (short === "grass_block") return faceName === "up" || faceName === "north" || faceName === "south" || faceName === "west" || faceName === "east";
  if (short === "short_grass" || short === "grass" || short === "tall_grass" || short === "fern" || short === "large_fern" || short === "potted_fern") return true;
  return short.includes("grass") && !short.includes("grass_block_side");
}

function needsPlainsFoliageTint(blockName) {
  const short = blockName.replace(/^minecraft:/, "");
  // Pale oak leaves have their own pale/grey texture color and should not
  // receive the normal plains foliage green tint.
  if (short === "pale_oak_leaves") return false;
  return short.includes("leaves") || short === "vine" || short === "cave_vines" || short === "hanging_roots";
}

function applyBiomeTint(color, blockName, faceName, texturePath) {
  const short = blockName.replace(/^minecraft:/, "");
  if (short === "pale_oak_leaves") return color;
  // Plains water tint: the water block itself, the water inside a water_cauldron,
  // OR any water surface added by deepslate's waterlogged fallback (where the
  // hosting block has its own name like "oak_stairs"). Detect the latter by
  // checking the quad's texture path.
  const isWater = short === "water" || short === "water_cauldron"
    || (texturePath && (texturePath.includes("water_still") || texturePath.includes("water_flow")));
  if (isWater) return { ...PLAINS_WATER_TINT, a: Math.min(color.a ?? 145, 145) };
  if (short === "pumpkin_stem" || short === "melon_stem") return {
    r: Math.max(0, Math.min(255, Math.round(color.r * STEM_TINT.r / 255))),
    g: Math.max(0, Math.min(255, Math.round(color.g * STEM_TINT.g / 255))),
    b: Math.max(0, Math.min(255, Math.round(color.b * STEM_TINT.b / 255))),
    a: color.a ?? 255
  };
  if (needsPlainsGrassTint(blockName, faceName)) return multiplyTint(color, PLAINS_GRASS_TINT);
  if (needsPlainsFoliageTint(blockName)) return multiplyTint(color, PLAINS_FOLIAGE_TINT);
  return color;
}

function sampleTexture(texture, u, v) {
  if (!texture) return null;

  // Animated textures are vertical strips (height > width). Only sample the
  // first frame so campfire, fire, water, and other animated blocks look right.
  const frameSize = texture.height > texture.width ? texture.width : texture.height;
  const x = Math.max(0, Math.min(texture.width - 1, Math.floor(u * texture.width)));
  const y = Math.max(0, Math.min(frameSize - 1, Math.floor(v * frameSize)));
  const idx = (texture.width * y + x) << 2;
  const alpha = texture.data[idx + 3];

  if (alpha < 16) return null;

  return {
    r: texture.data[idx],
    g: texture.data[idx + 1],
    b: texture.data[idx + 2],
    a: alpha
  };
}

function averageOpaqueTextureColor(texture) {
  if (!texture) return null;
  if (textureAverageCache.has(texture)) return textureAverageCache.get(texture);

  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let count = 0;

  // For animated textures (height > width) only average the first frame so the
  // base color matches what sampleTexture returns rather than a blend of all frames.
  const frameH = texture.height > texture.width ? texture.width : texture.height;
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < texture.width; x++) {
      const idx = (texture.width * y + x) << 2;
      const alpha = texture.data[idx + 3];
      if (alpha < 16) continue;
      r += texture.data[idx];
      g += texture.data[idx + 1];
      b += texture.data[idx + 2];
      a += alpha;
      count++;
    }
  }

  const color = count > 0
    ? { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), a: Math.round(a / count) }
    : null;

  textureAverageCache.set(texture, color);
  return color;
}

function sampleTextureForQuad(quad, u, v) {
  const sampled = sampleTexture(quad.texture, u, v);
  if (sampled) return sampled;

  // Chain uses a mostly-transparent texture on very thin geometry. In a tiny
  // isometric preview, exact nearest-neighbor samples often land in transparent
  // holes, making the whole chain disappear. Keep the vanilla model/texture,
  // but use the texture's opaque average for transparent chain samples so the
  // chain remains visible rather than being skipped.
  if (quad.blockName === "minecraft:chain" && quad.texture) {
    return averageOpaqueTextureColor(quad.texture);
  }

  return null;
}

function shadeColor(color, factor) {
  return {
    r: Math.max(0, Math.min(255, Math.round(color.r * factor))),
    g: Math.max(0, Math.min(255, Math.round(color.g * factor))),
    b: Math.max(0, Math.min(255, Math.round(color.b * factor))),
    a: color.a ?? 255
  };
}

function blendPixel(png, x, y, color) {
  x = Math.round(x);
  y = Math.round(y);

  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;

  const idx = (png.width * y + x) << 2;
  const alpha = (color.a ?? 255) / 255;

  if (alpha >= 1 || png.data[idx + 3] === 0) {
    png.data[idx] = color.r;
    png.data[idx + 1] = color.g;
    png.data[idx + 2] = color.b;
    png.data[idx + 3] = Math.round(alpha * 255);
    return;
  }

  const existingAlpha = png.data[idx + 3] / 255;
  const outAlpha = alpha + existingAlpha * (1 - alpha);

  png.data[idx] = Math.round((color.r * alpha + png.data[idx] * existingAlpha * (1 - alpha)) / outAlpha);
  png.data[idx + 1] = Math.round((color.g * alpha + png.data[idx + 1] * existingAlpha * (1 - alpha)) / outAlpha);
  png.data[idx + 2] = Math.round((color.b * alpha + png.data[idx + 2] * existingAlpha * (1 - alpha)) / outAlpha);
  png.data[idx + 3] = Math.round(outAlpha * 255);
}

function pointInPolygon(x, y, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || 0.000001) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
}

function dot2(a, b) {
  return a.x * b.x + a.y * b.y;
}

function solve2d(origin, uPoint, vPoint, x, y) {
  const uAxis = { x: uPoint.x - origin.x, y: uPoint.y - origin.y };
  const vAxis = { x: vPoint.x - origin.x, y: vPoint.y - origin.y };
  const point = { x: x - origin.x, y: y - origin.y };

  const uu = dot2(uAxis, uAxis);
  const uv = dot2(uAxis, vAxis);
  const vv = dot2(vAxis, vAxis);
  const pu = dot2(point, uAxis);
  const pv = dot2(point, vAxis);
  const det = uu * vv - uv * uv;

  if (Math.abs(det) < 0.000001) return { u: 0, v: 0 };

  return {
    u: Math.max(0, Math.min(1, (pu * vv - pv * uv) / det)),
    v: Math.max(0, Math.min(1, (pv * uu - pu * uv) / det))
  };
}

function getFaceUv(face, localU, localV) {
  const uv = face.uv ?? [0, 0, 16, 16];

  const u0 = uv[0] / 16;
  const v0 = uv[1] / 16;
  const u1 = uv[2] / 16;
  const v1 = uv[3] / 16;

  let u = localU;
  let v = localV;

  const rotation = ((face.uvRotation ?? 0) % 360 + 360) % 360;

  if (rotation === 90) {
    [u, v] = [v, 1 - u];
  } else if (rotation === 180) {
    [u, v] = [1 - u, 1 - v];
  } else if (rotation === 270) {
    [u, v] = [1 - v, u];
  }

  return {
    u: u0 + (u1 - u0) * u,
    v: v0 + (v1 - v0) * v
  };
}

function drawTexturedQuad(png, quad) {
  const points = quad.screen;
  const minY = Math.floor(Math.min(...points.map(p => p.y)));
  const maxY = Math.ceil(Math.max(...points.map(p => p.y)));
  const minX = Math.floor(Math.min(...points.map(p => p.x)));
  const maxX = Math.ceil(Math.max(...points.map(p => p.x)));

  const texture = quad.texture;
  const fallback = fallbackColorForBlock(quad.blockName);

  // Because this renderer is orthographic/isometric, affine UV interpolation is
  // stable. This uses baked model-space UV axes rather than ad-hoc screen axes.
  const [p00, p10, , p01] = points;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!pointInPolygon(x + 0.5, y + 0.5, points)) continue;

      const local = solve2d(p00, p10, p01, x + 0.5, y + 0.5);
      const uv = getFaceUv(quad, local.u, local.v);
      const sampled = sampleTextureForQuad(quad, uv.u, uv.v);

      if (texture && !sampled) continue;

      const base = sampled ?? fallback;
      const tinted = (quad.tintIndex !== null && quad.tintIndex !== undefined)
        ? applyBiomeTint(base, quad.blockName, quad.faceName)
        : base;
      blendPixel(png, x, y, shadeColor(tinted, quad.shade));
    }
  }
}

function rotatePointAroundOrigin(point, origin, axis, angleDegrees, rescale = false) {
  if (!angleDegrees) return point;

  const angle = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let x = point.x - origin.x;
  let y = point.y - origin.y;
  let z = point.z - origin.z;

  if (axis === "x") {
    const y2 = y * cos - z * sin;
    const z2 = y * sin + z * cos;
    y = y2;
    z = z2;
  } else if (axis === "y") {
    const x2 = x * cos - z * sin;
    const z2 = x * sin + z * cos;
    x = x2;
    z = z2;
  } else if (axis === "z") {
    const x2 = x * cos - y * sin;
    const y2 = x * sin + y * cos;
    x = x2;
    y = y2;
  }

  // Rescale: stretch the rotated element's projection on the axes perpendicular
  // to the rotation axis, so a 45°-rotated unit element still fills the block.
  // Crucially, the ROTATION AXIS ITSELF must NOT be rescaled — applying scale
  // uniformly to all three axes incorrectly stretches the element along its
  // rotation axis too (e.g. an azalea cross panel rotated 45° around Y would
  // get its y-range stretched from [0,1] to [−0.21, 1.21], making the panel
  // visibly poke above and below the block).
  const scale = rescale ? 1 / Math.max(Math.abs(cos), Math.abs(sin), 0.0001) : 1;
  const sx = axis === "x" ? 1 : scale;
  const sy = axis === "y" ? 1 : scale;
  const sz = axis === "z" ? 1 : scale;

  return {
    x: origin.x + x * sx,
    y: origin.y + y * sy,
    z: origin.z + z * sz
  };
}

function applyElementRotation(point, element) {
  const rotation = element.rotation;
  if (!rotation) return point;

  const origin = {
    x: (rotation.origin?.[0] ?? 8) / 16,
    y: (rotation.origin?.[1] ?? 8) / 16,
    z: (rotation.origin?.[2] ?? 8) / 16
  };

  return rotatePointAroundOrigin(
    point,
    origin,
    rotation.axis ?? "y",
    Number(rotation.angle ?? 0),
    Boolean(rotation.rescale)
  );
}

function applyBlockstateRotation(point, rotation) {
  let rotated = point;
  const center = { x: 0.5, y: 0.5, z: 0.5 };

  // Vanilla applies X first (tilt), then Y (horizontal orient), then Z. The X
  // rotation needs to be negated here because rotatePointAroundOrigin uses a
  // standard right-hand rotation matrix for X, but Minecraft's blockstate
  // variant convention is the OPPOSITE direction (deepslate compensates by
  // calling mat4.rotateX(t, t, -toRadian(variant.x))).
  //
  // The Y matrix in rotatePointAroundOrigin already has its sin terms swapped
  // from the standard right-hand form (a long-standing quirk of this codebase
  // that produces the same direction Minecraft uses for variant.y), so y does
  // NOT need negation — it's already in the right direction. Mixing the two
  // (negating both) was the bug that made every wall lever face the wrong
  // side. Same for Z, which is also standard form.
  if (rotation.x) rotated = rotatePointAroundOrigin(rotated, center, "x", -rotation.x, false);
  if (rotation.y) rotated = rotatePointAroundOrigin(rotated, center, "y", rotation.y, false);
  if (rotation.z) rotated = rotatePointAroundOrigin(rotated, center, "z", -rotation.z, false);

  return rotated;
}

function rotateWorldPoint(point, rotationDegrees, center = { x: 0, z: 0 }) {
  if (!rotationDegrees) return point;

  const angle = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = point.x - center.x;
  const z = point.z - center.z;

  return {
    ...point,
    x: center.x + x * cos - z * sin,
    z: center.z + x * sin + z * cos
  };
}

function isoPoint(x, y, z, offsetX, offsetY, scale = 1) {
  return {
    x: offsetX + (x - z) * (tileWidth / 2) * scale,
    y: offsetY + (x + z) * (tileHeight / 2) * scale - y * blockHeight * scale
  };
}

function projectPoint(point, offsetX, offsetY, scale, rotation = null) {
  const rotated = rotation ? rotateWorldPoint(point, rotation.degrees, rotation.center) : point;
  return isoPoint(rotated.x, rotated.y, rotated.z, offsetX, offsetY, scale);
}

function faceShade(faceName) {
  if (faceName === "up") return 1.15;
  if (faceName === "down") return 0.68;
  if (faceName === "north" || faceName === "south") return 0.82;
  if (faceName === "east" || faceName === "west") return 0.96;
  return 1.0;
}

function faceDepth(points3d) {
  return points3d.reduce((sum, point) => sum + point.x + point.y + point.z, 0) / points3d.length;
}

function defaultFaceUv(faceName, from, to) {
  const [x0, y0, z0] = from;
  const [x1, y1, z1] = to;

  switch (faceName) {
    case "up":
    case "down":
      return [x0, z0, x1, z1];
    case "north":
    case "south":
      return [x0, 16 - y1, x1, 16 - y0];
    case "west":
    case "east":
      return [z0, 16 - y1, z1, 16 - y0];
    default:
      return [0, 0, 16, 16];
  }
}

// When a texture genuinely can't be found (vanilla cache poisoned, mod texture
// missing, entity texture moved between MC versions), fall back to a
// guaranteed-resolvable texture so the block still renders with SOMETHING
// recognisable instead of dropping to its brown/blue hashColor placeholder.
// Map of (full resource id with no .png suffix) -> (fallback resource id).
const TEXTURE_FALLBACKS = {
  "minecraft:block/chain": "minecraft:block/iron_block",
  "minecraft:block/copper_chain": "minecraft:block/copper_block",
  "minecraft:block/exposed_copper_chain": "minecraft:block/exposed_copper",
  "minecraft:block/weathered_copper_chain": "minecraft:block/weathered_copper",
  "minecraft:block/oxidized_copper_chain": "minecraft:block/oxidized_copper",
  "minecraft:block/waxed_copper_chain": "minecraft:block/copper_block",
  "minecraft:block/waxed_exposed_copper_chain": "minecraft:block/exposed_copper",
  "minecraft:block/waxed_weathered_copper_chain": "minecraft:block/weathered_copper",
  "minecraft:block/waxed_oxidized_copper_chain": "minecraft:block/oxidized_copper",
  "minecraft:entity/banner_base": "minecraft:block/white_wool",
  "minecraft:entity/banner/base": "minecraft:block/white_wool",
  "minecraft:entity/enderdragon/dragon": "minecraft:block/obsidian",
  "minecraft:entity/dragon/dragon": "minecraft:block/obsidian"
};

function tryLoadTextureWithFallback(textureId) {
  const [namespace, texturePath] = splitResourceLocation(textureId);
  let texture = readTextureAsset(`assets/${namespace}/textures/${texturePath}.png`);
  if (texture) return texture;

  // Entity textures are extracted from the vanilla client JAR alongside block
  // textures and are accessible under assets/*/textures/entity/. Try a couple
  // of fallback paths so references like entity/chain or
  // entity/shulker/shulker_white can still resolve when only the block-texture
  // equivalent exists in this MC version.
  if (texturePath.startsWith("entity/")) {
    const parts = texturePath.split("/");
    const name = parts[parts.length - 1];
    const folder = parts.length > 2 ? parts[parts.length - 2] : null;
    texture = readTextureAsset(`assets/${namespace}/textures/block/${name}.png`);
    if (!texture && folder === "shulker") {
      const m = name.match(/^shulker_?(.+)$/);
      texture = m
        ? readTextureAsset(`assets/${namespace}/textures/block/${m[1]}_shulker_box.png`)
        : readTextureAsset(`assets/${namespace}/textures/block/shulker_box.png`);
    }
    if (texture) return texture;
  }

  // Last-resort fallback map. If chain.png is missing from CI's vanilla
  // extraction, render chains as iron_block instead of brown hashColor.
  const fallbackId = TEXTURE_FALLBACKS[textureId];
  if (fallbackId) {
    const [fbNs, fbPath] = splitResourceLocation(fallbackId);
    const fb = readTextureAsset(`assets/${fbNs}/textures/${fbPath}.png`);
    if (fb) return fb;
  }

  return null;
}

function getTextureForFace(modelTextures, faceData, faceName) {
  const textureRef =
    faceData?.texture ??
    modelTextures[faceName] ??
    modelTextures.all ??
    modelTextures.side ??
    modelTextures.particle;

  const textureId = resolveTextureReference(textureRef, modelTextures);
  if (!textureId) return null;

  return tryLoadTextureWithFallback(textureId);
}

function createFaceDefinition(faceName, from, to) {
  const [x0, y0, z0] = from.map(value => value / 16);
  const [x1, y1, z1] = to.map(value => value / 16);

  // Point order is always local UV order:
  // p00 = top-left/origin for texture, p10 = +U, p11 = +U+V, p01 = +V.
  // This is the important change: model baking owns texture axes before the
  // isometric projection sees the face.
  const defs = {
    up: [
      { x: x0, y: y1, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: x1, y: y1, z: z1 },
      { x: x0, y: y1, z: z1 }
    ],
    down: [
      { x: x0, y: y0, z: z1 },
      { x: x1, y: y0, z: z1 },
      { x: x1, y: y0, z: z0 },
      { x: x0, y: y0, z: z0 }
    ],
    // Vertical faces are ordered as Minecraft's model baker sees them from
    // outside the block: p00 is the texture's top-left corner, p10 is +U,
    // p01 is +V/down. The previous order used the isometric screen-facing
    // left/right direction, which mirrored/rotated side textures after block
    // state y-rotations.
    north: [
      { x: x1, y: y1, z: z0 },
      { x: x0, y: y1, z: z0 },
      { x: x0, y: y0, z: z0 },
      { x: x1, y: y0, z: z0 }
    ],
    south: [
      { x: x0, y: y1, z: z1 },
      { x: x1, y: y1, z: z1 },
      { x: x1, y: y0, z: z1 },
      { x: x0, y: y0, z: z1 }
    ],
    west: [
      { x: x0, y: y1, z: z0 },
      { x: x0, y: y1, z: z1 },
      { x: x0, y: y0, z: z1 },
      { x: x0, y: y0, z: z0 }
    ],
    east: [
      { x: x1, y: y1, z: z1 },
      { x: x1, y: y1, z: z0 },
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y0, z: z1 }
    ]
  };

  return defs[faceName] ?? null;
}

function bakeElementQuads(blockName, modelTextures, element, variant) {
  const from = element.from ?? [0, 0, 0];
  const to = element.to ?? [16, 16, 16];
  const quads = [];

  for (const faceName of ["up", "down", "north", "south", "west", "east"]) {
    const rawFaceData = element.faces?.[faceName];
    if (!rawFaceData) continue;

    const localPoints = createFaceDefinition(faceName, from, to);
    if (!localPoints) continue;

    const faceData = {
      ...rawFaceData,
      uv: rawFaceData.uv ?? defaultFaceUv(faceName, from, to)
    };

    const transformed = localPoints.map(point =>
      applyBlockstateRotation(applyElementRotation(point, element), {
        x: variant.x ?? 0,
        y: variant.y ?? 0,
        z: variant.z ?? 0
      })
    );

    quads.push({
      blockName,
      faceName,
      points: transformed,
      texture: getTextureForFace(modelTextures, faceData, faceName),
      uv: faceData.uv,
      uvRotation: faceData.rotation ?? 0,
      tintIndex: rawFaceData.tintindex ?? rawFaceData.tintIndex ?? null,
      shade: faceShade(faceName),
      depthOffset: faceDepth(transformed)
    });
  }

  return quads;
}


function allFaces(texture = null) {
  const face = texture ? { texture } : {};
  return { up: face, down: face, north: face, south: face, west: face, east: face };
}

function bakeFallbackElements(blockName, elements, variant = { x: 0, y: 0, z: 0 }) {
  const baked = [];
  for (const element of elements) baked.push(...bakeElementQuads(blockName, {}, element, variant));
  return baked;
}

function woodTypeFromBlockName(short) {
  const woods = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "bamboo", "crimson", "warped", "pale_oak"];
  for (const wood of woods) {
    if (short === `${wood}_sign` || short === `${wood}_wall_sign` || short === `${wood}_hanging_sign` || short === `${wood}_wall_hanging_sign`) return wood;
    if (short.startsWith(`${wood}_`)) return wood;
  }
  return "oak";
}

function signTextureForBlock(short) {
  const wood = woodTypeFromBlockName(short);
  // Sign entity textures are sheets and do not map well onto a simple baked
  // cuboid, so use the matching plank texture. That is still much closer than
  // the previous untextured/generic fallback and keeps signs readable.
  if (wood === "crimson" || wood === "warped") return `minecraft:block/${wood}_planks`;
  if (wood === "bamboo") return "minecraft:block/bamboo_planks";
  return `minecraft:block/${wood}_planks`;
}

function blockTextureForButton(short) {
  if (short === "stone_button") return "minecraft:block/stone";
  if (short === "polished_blackstone_button") return "minecraft:block/polished_blackstone";
  if (short.endsWith("_button")) {
    const wood = short.replace(/_button$/, "");
    if (["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "bamboo", "pale_oak"].includes(wood)) {
      return `minecraft:block/${wood}_planks`;
    }
    if (wood === "crimson" || wood === "warped") return `minecraft:block/${wood}_planks`;
  }
  return "minecraft:block/stone";
}

function yRotationForFacing(facing, base = "north") {
  const order = ["north", "east", "south", "west"];
  const from = order.indexOf(base);
  const to = order.indexOf(facing);
  if (from === -1 || to === -1) return 0;
  return ((to - from + 4) % 4) * 90;
}

function cuboid(from, to, texture) {
  return { from, to, faces: allFaces(texture) };
}

function wallAttachmentCuboid(facing, depth, y0, y1, inset0, inset1, texture) {
  // For wall-attached blocks, the blockstate `facing` is the direction the
  // button/lever faces. The solid support is behind it, i.e. on the opposite
  // side of this block's local cube. So a north-facing button is drawn on the
  // south edge of the button block, not the north edge.
  switch (facing) {
    case "south":
      return cuboid([inset0, y0, 0], [inset1, y1, depth], texture);
    case "east":
      return cuboid([0, y0, inset0], [depth, y1, inset1], texture);
    case "west":
      return cuboid([16 - depth, y0, inset0], [16, y1, inset1], texture);
    case "north":
    default:
      return cuboid([inset0, y0, 16 - depth], [inset1, y1, 16], texture);
  }
}


function buttonElementsForState(properties, texture) {
  const face = properties.face ?? "wall";
  const facing = properties.facing ?? "north";
  const powered = String(properties.powered ?? "false") === "true";
  const depth = powered ? 1 : 2;

  if (face === "floor") {
    return {
      elements: [cuboid([5, 0, 5], [11, depth, 11], texture)],
      variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
    };
  }

  if (face === "ceiling") {
    return {
      elements: [cuboid([5, 16 - depth, 5], [11, 16, 11], texture)],
      variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
    };
  }

  return {
    elements: [wallAttachmentCuboid(facing, depth, 6, 10, 5, 11, texture)],
    variant: { x: 0, y: 0, z: 0 }
  };
}

function leverElementsForState(properties) {
  const face = properties.face ?? "wall";
  const facing = properties.facing ?? "north";
  const powered = String(properties.powered ?? "false") === "true";
  const baseTexture = "minecraft:block/cobblestone";
  const handleTexture = "minecraft:block/lever";

  if (face === "floor") {
    // Base 6×2×6 on the floor; handle is a 2×8×2 rod tilted around the X axis.
    // y-rotation from the variant orients the tilt toward the correct facing.
    const handleAngle = powered ? -45 : 45;
    return {
      elements: [
        cuboid([5, 0, 5], [11, 2, 11], baseTexture),
        {
          from: [7, 2, 7], to: [9, 10, 9],
          rotation: { origin: [8, 2, 8], axis: "x", angle: handleAngle },
          faces: allFaces(handleTexture)
        }
      ],
      variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
    };
  }

  if (face === "ceiling") {
    // Base 6×2×6 on the ceiling; handle hangs downward and tilts.
    const handleAngle = powered ? 45 : -45;
    return {
      elements: [
        cuboid([5, 14, 5], [11, 16, 11], baseTexture),
        {
          from: [7, 6, 7], to: [9, 14, 9],
          rotation: { origin: [8, 14, 8], axis: "x", angle: handleAngle },
          faces: allFaces(handleTexture)
        }
      ],
      variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
    };
  }

  // Wall lever: canonical south-facing model (wall at z=0, handle extends +z)
  // with y-rotation for other directions. specialBlockModel bypasses
  // snapAttachedModelToSupport so element rotation is safe here.
  // base: wallAttachmentCuboid("south") → cuboid([5,4,0],[11,10,4])
  const handleAngle = powered ? -45 : 45;
  return {
    elements: [
      wallAttachmentCuboid("south", 4, 4, 10, 5, 11, baseTexture),
      {
        from: [7, 4, 1], to: [9, 12, 3],
        rotation: { origin: [8, 4, 2], axis: "x", angle: handleAngle },
        faces: allFaces(handleTexture)
      }
    ],
    variant: { x: 0, y: yRotationForFacing(facing, "south"), z: 0 }
  };
}


function chestElementsForState(blockName, properties = {}) {
  const short = blockName.replace(/^minecraft:/, "");
  const facing = properties.facing ?? "north";

  let tex;
  if (short === "ender_chest") tex = "minecraft:entity/chest/ender";
  else if (short === "trapped_chest") tex = "minecraft:entity/chest/trapped";
  else tex = "minecraft:entity/chest/normal";

  // Chest entity texture is 64×64 px. UV coordinates in Minecraft element space
  // [0,16] are computed as pixel_coord × (16/64) = pixel_coord × 0.25.
  //
  // Standard entity-model UV layout for cube (uvOrigin=[u,v], size=[sx,sy,sz]):
  //   DOWN:  [u+sz,    v,    u+sz+sx,    v+sz  ]  ← floor / interior underside
  //   UP:    [u+sz+sx, v,    u+2*sz+sx,  v+sz  ]  ← exterior top
  //   WEST:  [u,       v+sz, u+sz,       v+sz+sy]
  //   NORTH: [u+sz,    v+sz, u+sz+sx,    v+sz+sy]  ← front face with lock
  //   EAST:  [u+sz+sx, v+sz, u+2*sz+sx,  v+sz+sy]
  //   SOUTH: [u+2*sz+sx, v+sz, u+2*sz+2*sx, v+sz+sy]
  //
  // Body: uvOrigin=[0,19], size=[sx=14, sy=10, sz=14]
  // Lid:  uvOrigin=[0,0],  size=[sx=14, sy=5,  sz=14]
  const f = (px0, py0, px1, py1) => ({
    texture: tex,
    uv: [px0 * 0.25, py0 * 0.25, px1 * 0.25, py1 * 0.25]
  });

  const body = {
    from: [1, 0, 1], to: [15, 10, 15],
    faces: {
      up:    f(28, 19, 42, 33),  // UP = exterior top of body (hidden by lid)
      down:  f(14, 19, 28, 33),  // DOWN = floor of chest
      north: f(14, 33, 28, 43),  // front face with lock
      south: f(42, 33, 56, 43),
      east:  f(28, 33, 42, 43),
      west:  f( 0, 33, 14, 43),
    }
  };

  const lid = {
    from: [1, 10, 1], to: [15, 15, 15],
    faces: {
      up:    f(28,  0, 42, 14),  // UP = exterior decorative top of lid
      down:  f(14,  0, 28, 14),  // DOWN = interior underside of lid
      north: f(14, 14, 28, 19),
      south: f(42, 14, 56, 19),
      east:  f(28, 14, 42, 19),
      west:  f( 0, 14, 14, 19),
    }
  };

  return {
    elements: [body, lid],
    variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
  };
}

function bannerElementsForState(blockName, properties = {}) {
  const short = blockName.replace(/^minecraft:/, "");
  const colorMatch = short.match(/^(\w+?)_(?:wall_)?banner$/);
  const color = colorMatch?.[1] ?? "white";
  const tex = `minecraft:block/${color}_wool`;
  const pole = "minecraft:block/oak_planks";

  if (short.endsWith("_wall_banner")) {
    // Model built with fabric against the south face (z=15–16). Use the same
    // yRotationForFacing convention as wall signs (north=0, east=90, south=180,
    // west=270) so north/west banners show on the south/east faces visible from
    // the isometric SE camera.
    const facing = properties.facing ?? "north";
    const y = yRotationForFacing(facing, "north");
    return {
      elements: [
        cuboid([2, 12.5, 12], [14, 14.5, 16], pole),  // horizontal crossbar attached to wall
        cuboid([2,  1,   15], [14, 12.5, 16], tex),    // fabric hanging below the bar
      ],
      variant: { x: 0, y, z: 0 }
    };
  }

  // Standing banner: pole at centre, fabric panel near the south face of the block
  // (z=14..15) so that after any Y-rotation it lands at a block edge rather than
  // the centre of the block.
  const rotation = Number(properties.rotation ?? 0);
  return {
    elements: [
      cuboid([7, 0, 7], [9, 16, 9], pole),            // centre pole
      cuboid([2, 0, 14], [14, 16, 15], tex),           // fabric panel near south face
    ],
    variant: { x: 0, y: (rotation / 16) * 360, z: 0 }
  };
}



function bedElementsForState(blockName, properties = {}) {
  const short = blockName.replace(/^minecraft:/, "");
  const colors = ["white","orange","magenta","light_blue","yellow","lime","pink","gray","light_gray","cyan","purple","blue","brown","green","red","black"];
  const color = colors.find(c => short === `${c}_bed`) ?? "red";
  // Coords + UVs lifted from deepslate's SpecialRenderers.bedRenderer, which
  // replicates the vanilla BedBlockEntityRenderer exactly. The "foot" variant has
  // its legs at z=0-3 (north end). Vanilla bed.json blockstate facing=north points
  // the head north — that matches base="north" for yRotationForFacing.
  const bed = `minecraft:entity/bed/${color}`;
  const facing = properties.facing ?? "south";
  const isHead = (properties.part ?? "foot") === "head";
  if (isHead) {
    return {
      elements: [
        { from: [0, 3, 0], to: [16, 9, 16], faces: {
            east:  { texture: bed, uv: [0, 1.5, 1.5, 5.5], rotation: 270 },
            south: { texture: bed, uv: [1.5, 0, 5.5, 1.5], rotation: 180 },
            west:  { texture: bed, uv: [5.5, 1.5, 7, 5.5], rotation: 90 },
            up:    { texture: bed, uv: [5.5, 5.5, 1.5, 1.5] },
            down:  { texture: bed, uv: [11, 1.5, 7, 5.5] }
        }},
        { from: [0, 0, 13], to: [3, 3, 16], faces: {
            north: { texture: bed, uv: [14.75, 0.75, 15.5, 1.5] },
            east:  { texture: bed, uv: [14, 0.75, 14.75, 1.5] },
            south: { texture: bed, uv: [13.25, 0.75, 14, 1.5] },
            west:  { texture: bed, uv: [12.5, 0.75, 13.25, 1.5] },
            up:    { texture: bed, uv: [13.25, 0, 14, 0.75] },
            down:  { texture: bed, uv: [14, 0, 14.75, 0.75] }
        }},
        { from: [13, 0, 13], to: [16, 3, 16], faces: {
            north: { texture: bed, uv: [14, 2.25, 14.75, 3] },
            east:  { texture: bed, uv: [13.25, 2.25, 14, 3] },
            south: { texture: bed, uv: [12.5, 2.25, 13.25, 3] },
            west:  { texture: bed, uv: [14.75, 2.25, 15.5, 3] },
            up:    { texture: bed, uv: [13.25, 1.5, 14, 2.25] },
            down:  { texture: bed, uv: [14, 1.5, 14.75, 2.25] }
        }}
      ],
      variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
    };
  }
  // foot
  return {
    elements: [
      { from: [0, 3, 0], to: [16, 9, 16], faces: {
          north: { texture: bed, uv: [5.5, 5.5, 9.5, 7], rotation: 180 },
          east:  { texture: bed, uv: [0, 7, 1.5, 11], rotation: 270 },
          west:  { texture: bed, uv: [5.5, 7, 7, 11], rotation: 90 },
          up:    { texture: bed, uv: [5.5, 11, 1.5, 7] },
          down:  { texture: bed, uv: [11, 7, 7, 11] }
      }},
      { from: [0, 0, 0], to: [3, 3, 3], faces: {
          north: { texture: bed, uv: [12.5, 5.25, 13.25, 6] },
          east:  { texture: bed, uv: [14.75, 5.25, 15.5, 6] },
          south: { texture: bed, uv: [14, 5.25, 14.75, 6] },
          west:  { texture: bed, uv: [13.25, 5.25, 14, 6] },
          up:    { texture: bed, uv: [13.25, 4.5, 14, 5.25] },
          down:  { texture: bed, uv: [14, 4.5, 14.75, 5.25] }
      }},
      { from: [13, 0, 0], to: [16, 3, 3], faces: {
          north: { texture: bed, uv: [13.25, 3.75, 14, 4.5] },
          east:  { texture: bed, uv: [12.5, 3.75, 13.25, 4.5] },
          south: { texture: bed, uv: [14.75, 3.75, 15.5, 4.5] },
          west:  { texture: bed, uv: [14, 3.75, 14.75, 4.5] },
          up:    { texture: bed, uv: [13.25, 3, 14, 3.75] },
          down:  { texture: bed, uv: [14, 3, 14.75, 3.75] }
      }}
    ],
    variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
  };
}

// Skull entity textures use a standard Minecraft skin-style UV layout.
// The head box in each entity model uses UV origin [0,0] and size [8,8,8].
// Entity UV formula for a cube: given uvOrigin=[u,v] and size=[sx,sy,sz]:
//   top:   pixels [u+sz, v]       to [u+sz+sx, v+sz]
//   bottom:pixels [u+sz+sx, v]    to [u+2*sz+sx, v+sz]
//   front: pixels [u+sz, v+sz]    to [u+sz+sx, v+sz+sy]
//   back:  pixels [u+2*sz+sx,v+sz]to [u+2*sz+2*sx,v+sz+sy]
//   left:  pixels [u, v+sz]       to [u+sz, v+sz+sy]
//   right: pixels [u+sz+sx, v+sz] to [u+sz+sx+sz, v+sz+sy]
// Converted to element UV [0,16]: multiply pixel coords by (16/texWidth) for u,
// (16/texHeight) for v.
function skullFaceUvs(texWidth, texHeight) {
  const us = 16 / texWidth, vs = 16 / texHeight;
  // sz=8, sx=8, sy=8, uvOrigin=[0,0]
  return {
    up:    [8*us, 0,     16*us, 8*vs],
    down:  [16*us, 0,    24*us, 8*vs],
    south: [8*us,  8*vs, 16*us, 16*vs],  // front face
    north: [24*us, 8*vs, 32*us, 16*vs],  // back face
    west:  [0,     8*vs,  8*us, 16*vs],  // left face
    east:  [16*us, 8*vs, 24*us, 16*vs],  // right face
  };
}

function skullElementsForState(blockName, properties = {}) {
  const short = blockName.replace(/^minecraft:/, "");
  const isWall = short.includes("_wall_");

  // Map skull type to entity texture path and texture dimensions.
  // All common skull entity textures are present in extracted vanilla assets.
  let tex, texWidth, texHeight;
  if (short.includes("wither") && short.includes("skeleton")) {
    tex = "minecraft:entity/skeleton/wither_skeleton"; texWidth = 64; texHeight = 32;
  } else if (short.includes("skeleton")) {
    tex = "minecraft:entity/skeleton/skeleton"; texWidth = 64; texHeight = 32;
  } else if (short.includes("zombie")) {
    tex = "minecraft:entity/zombie/zombie"; texWidth = 64; texHeight = 64;
  } else if (short.includes("creeper")) {
    tex = "minecraft:entity/creeper/creeper"; texWidth = 64; texHeight = 32;
  } else if (short.includes("piglin")) {
    tex = "minecraft:entity/piglin/piglin"; texWidth = 64; texHeight = 64;
  } else if (short.includes("dragon")) {
    tex = "minecraft:block/obsidian"; texWidth = null; // dragon atlas too complex
  } else {
    tex = "minecraft:entity/player/wide/steve"; texWidth = 64; texHeight = 64;
  }

  const faces = texWidth
    ? (() => {
        const uvs = skullFaceUvs(texWidth, texHeight);
        const f = (dir) => ({ texture: tex, uv: uvs[dir] });
        // For wall skulls the "face" is on local north; for standing it is on local south.
        if (isWall) {
          return { up: f("up"), down: f("down"), north: f("south"), south: f("north"), east: f("east"), west: f("west") };
        }
        return { up: f("up"), down: f("down"), north: f("north"), south: f("south"), east: f("east"), west: f("west") };
      })()
    : null;

  if (isWall) {
    const facing = properties.facing ?? "north";
    const el = faces
      ? { from: [4, 4, 8], to: [12, 12, 16], faces }
      : cuboid([4, 4, 8], [12, 12, 16], tex);
    return { elements: [el], variant: { x: 0, y: yRotationForFacing(facing), z: 0 } };
  }

  const rotation = Number(properties.rotation ?? 0);
  const el = faces
    ? { from: [4, 0, 4], to: [12, 8, 12], faces }
    : cuboid([4, 0, 4], [12, 8, 12], tex);
  return { elements: [el], variant: { x: 0, y: (rotation / 16) * 360, z: 0 } };
}

function shulkerBoxElementsForState(blockName) {
  const short = blockName.replace(/^minecraft:/, "");
  const colorMatch = short.match(/^(\w+)_shulker_box$/);
  const color = colorMatch?.[1] ?? null;
  // Use the block texture path directly — vanilla stores these at block/white_shulker_box etc.
  const tex = color ? `minecraft:block/${color}_shulker_box` : "minecraft:block/shulker_box";
  return {
    elements: [cuboid([0, 0, 0], [16, 16, 16], tex)],
    variant: { x: 0, y: 0, z: 0 }
  };
}

function bellElementsForState(properties = {}) {
  const facing = properties.facing ?? "north";
  const attachment = properties.attachment ?? "floor";
  // Bell body geometry replicates deepslate's SpecialRenderers.bellRenderer
  // exactly (same coordinates Minecraft's entity renderer uses), but with the
  // y/z flip pre-applied so the body sits dome-down inside the block.
  // Original (deepslate) coords are (x, y, z) → flipped to (x, 16-y, 16-z).
  // Body 5,3,5 → 11,10,11  → flipped to x:5-11, y:6-13, z:5-11
  // Crown 4,10,4 → 12,12,12 → flipped to x:4-12, y:4-6, z:4-12
  const bt = "minecraft:entity/bell/bell_body";
  // Bell crown — the wide top of the bell, sits at the bottom after the flip
  const bellCrown = {
    from: [4, 4, 4], to: [12, 6, 12],
    faces: {
      north: { texture: bt, uv: [4, 4.5, 8, 5.5] },
      east:  { texture: bt, uv: [0, 4.5, 4, 5.5] },
      south: { texture: bt, uv: [12, 4.5, 16, 5.5] },
      west:  { texture: bt, uv: [8, 4.5, 12, 5.5] },
      up:    { texture: bt, uv: [8, 9.5, 4, 5.5] },
      down:  { texture: bt, uv: [12, 5.5, 8, 9.5] }
    }
  };
  // Bell body — the narrower dome above, with the loop on top
  const bellBody = {
    from: [5, 6, 5], to: [11, 13, 11],
    faces: {
      north: { texture: bt, uv: [3, 9.5, 6, 13] },
      east:  { texture: bt, uv: [0, 9.5, 3, 13] },
      south: { texture: bt, uv: [9, 9.5, 12, 13] },
      west:  { texture: bt, uv: [6, 9.5, 9, 13] },
      up:    { texture: bt, uv: [6, 9.5, 3, 6] },
      down:  { texture: bt, uv: [9, 6, 6, 9.5] }
    }
  };
  // The yoke/frame uses dark_oak plank colouring as an approximation of the
  // wooden post (vanilla bell entity uses a hard-coded oak tone). Geometry
  // matches the vanilla bell_floor / bell_ceiling / bell_wall / bell_between_walls
  // block models so the support sits where Minecraft draws it in the world.
  const frame = "minecraft:block/dark_oak_planks";
  if (attachment === "ceiling") {
    return {
      elements: [
        cuboid([7, 13, 7], [9, 16, 9], frame),  // short post from bell top to ceiling
        bellBody, bellCrown,
      ],
      variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
    };
  }
  if (attachment === "single_wall") {
    return {
      elements: [
        cuboid([0, 13, 7], [7, 15, 9], frame),  // arm coming out of west wall (canonical)
        cuboid([7, 13, 7], [9, 15, 9], frame),  // small bracket
        bellBody, bellCrown,
      ],
      variant: { x: 0, y: yRotationForFacing(facing, "east"), z: 0 }
    };
  }
  if (attachment === "double_wall") {
    return {
      elements: [
        cuboid([0, 13, 7], [16, 15, 9], frame),  // beam spanning both walls
        bellBody, bellCrown,
      ],
      variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
    };
  }
  // floor: vanilla bell_floor has a 6×3×2 plate base plus two posts going up
  return {
    elements: [
      cuboid([0, 0, 6], [3, 3, 10], frame),        // west base plate
      cuboid([13, 0, 6], [16, 3, 10], frame),      // east base plate
      cuboid([2, 0, 7], [4, 13, 9], frame),        // west post
      cuboid([12, 0, 7], [14, 13, 9], frame),      // east post
      cuboid([2, 13, 7], [14, 15, 9], frame),      // top crossbeam
      bellBody, bellCrown,
    ],
    variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
  };
}

function decoratedPotElementsForState(properties = {}) {
  const facing = properties.facing ?? "north";
  // Element coordinates and UVs lifted from deepslate's SpecialRenderers.decoratedPotRenderer
  // (which replicates the vanilla DecoratedPotBlockEntityRenderer geometry exactly).
  const side = "minecraft:entity/decorated_pot/decorated_pot_side";
  const base = "minecraft:entity/decorated_pot/decorated_pot_base";
  return {
    elements: [
      {
        from: [1, 0, 1], to: [15, 16, 15],
        faces: {
          north: { texture: side, uv: [1, 0, 15, 16] },
          east:  { texture: side, uv: [1, 0, 15, 16] },
          south: { texture: side, uv: [1, 0, 15, 16] },
          west:  { texture: side, uv: [1, 0, 15, 16] },
          up:    { texture: base, uv: [0, 6.5, 7, 13.5] },
          down:  { texture: base, uv: [7, 6.5, 14, 13.5] }
        }
      },
      {
        from: [5, 16, 5], to: [11, 17, 11],
        faces: {
          north: { texture: base, uv: [0, 5.5, 3, 6] },
          east:  { texture: base, uv: [3, 5.5, 6, 6] },
          south: { texture: base, uv: [6, 5.5, 9, 6] },
          west:  { texture: base, uv: [9, 5.5, 12, 6] }
        }
      },
      {
        from: [4, 17, 4], to: [12, 20, 12],
        faces: {
          north: { texture: base, uv: [0, 4, 4, 5.5] },
          east:  { texture: base, uv: [4, 4, 8, 5.5] },
          south: { texture: base, uv: [8, 4, 12, 5.5] },
          west:  { texture: base, uv: [12, 4, 16, 5.5] },
          up:    { texture: base, uv: [4, 0, 8, 4] },
          down:  { texture: base, uv: [8, 0, 12, 4] }
        }
      }
    ],
    variant: { x: 0, y: yRotationForFacing(facing), z: 0 }
  };
}

function conduitElementsForState() {
  // Conduit entity texture: entity/conduit/conduit.png (32×16).
  // The conduit shell is a small cube (6×6×6) centred at [8,8,8].
  // UV layout for 32×16 (scale: x÷2, y×1 to convert px→[0,16]):
  //   size 6×6×6, uvOrigin=[0,0]:
  //     top:[6,0→12,6] bottom:[12,0→18,6]
  //     front:[6,6→12,12] back:[18,6→24,12]
  //     right:[12,6→18,12] left:[0,6→6,12]
  const ct = "minecraft:entity/conduit/conduit";
  const xs = 16/32, ys = 1; // 32×16 texture
  return {
    elements: [{
      from: [5, 5, 5], to: [11, 11, 11],
      faces: {
        up:    { texture: ct, uv: [ 6*xs, 0,    12*xs,  6*ys] },
        down:  { texture: ct, uv: [12*xs, 0,    18*xs,  6*ys] },
        north: { texture: ct, uv: [ 6*xs,  6*ys, 12*xs, 12*ys] },
        south: { texture: ct, uv: [18*xs,  6*ys, 24*xs, 12*ys] },
        east:  { texture: ct, uv: [12*xs,  6*ys, 18*xs, 12*ys] },
        west:  { texture: ct, uv: [ 0,     6*ys,  6*xs, 12*ys] },
      }
    }],
    variant: { x: 0, y: 0, z: 0 }
  };
}

function candleElementsForState(blockName, properties = {}) {
  const short = blockName.replace(/^minecraft:/, "");
  const color = short === "candle" ? "" : short.replace(/_candle$/, "_");
  const candleTexture = `minecraft:block/${color}candle`;
  const litTexture = `minecraft:block/${color}candle_lit`;
  const lit = String(properties.lit ?? "false") === "true";
  const count = Math.max(1, Math.min(4, Number(properties.candles ?? 1) || 1));
  const layouts = {
    1: [[7, 0, 7, 9, 6, 9]],
    2: [[5, 0, 6, 7, 6, 8], [9, 0, 8, 11, 6, 10]],
    3: [[5, 0, 6, 7, 6, 8], [9, 0, 6, 11, 6, 8], [7, 0, 9, 9, 6, 11]],
    4: [[5, 0, 5, 7, 6, 7], [9, 0, 5, 11, 6, 7], [5, 0, 9, 7, 6, 11], [9, 0, 9, 11, 6, 11]]
  };
  const elements = layouts[count].map(([x0,y0,z0,x1,y1,z1]) => cuboid([x0,y0,z0],[x1,y1,z1], candleTexture));
  if (lit) elements.push(...layouts[count].map(([x0,,z0,x1,,z1]) => cuboid([(x0+x1)/2-0.5,6,(z0+z1)/2-0.5],[(x0+x1)/2+0.5,8,(z0+z1)/2+0.5], litTexture)));
  return { elements, variant: { x: 0, y: 0, z: 0 } };
}

function mushroomBlockModel(blockName, properties) {
  const short = blockName.replace(/^minecraft:/, "");
  const capTex = short === "red_mushroom_block" ? "minecraft:block/red_mushroom_block"
    : short === "brown_mushroom_block" ? "minecraft:block/brown_mushroom_block"
    : "minecraft:block/mushroom_stem";
  const insideTex = "minecraft:block/mushroom_block_inside";
  const faces = {};
  for (const face of ["up", "down", "north", "south", "east", "west"]) {
    const isOutside = String(properties[face] ?? "true") === "true";
    faces[face] = { texture: isOutside ? capTex : insideTex };
  }
  return bakeFallbackElements(blockName, [{ from: [0, 0, 0], to: [16, 16, 16], faces }], { x: 0, y: 0, z: 0 });
}

function specialBlockModel(blockName, properties = {}) {
  const short = blockName.replace(/^minecraft:/, "");

  // Water is intentionally invisible.
  if (short === "water") {
    return [];
  }

  // Lava: vanilla blockstate references lava.json with no elements (the game's
  // fluid renderer handles it). Render as a full cube with the lava_still texture.
  if (short === "lava") {
    return bakeFallbackElements(blockName,
      [{ from: [0, 0, 0], to: [16, 16, 16], faces: allFaces("minecraft:block/lava_still") }],
      { x: 0, y: 0, z: 0 });
  }

  // Chain: vanilla chain.json blockstate + chain.json model has 2 thin crossed
  // planes — no parent, no rescale. Vanilla baking via deepslate handles it
  // locally, but CI's vanilla-assets cache occasionally serves a stale
  // extraction without block/chain.png, leaving chains as a brown fallback
  // colour. Emit the geometry directly here as a robust fallback so chains
  // always render regardless of cache state.
  if (short === "chain" || /^(?:exposed_|weathered_|oxidized_|waxed_(?:exposed_|weathered_|oxidized_)?)?copper_chain$/.test(short)) {
    const tex = short === "chain" ? "minecraft:block/chain" : `minecraft:block/${short}`;
    const axis = properties.axis ?? "y";
    // Element 1 is thin in Z (visible faces north/south); element 2 is thin in X
    // (visible faces east/west). Naming them after the thin axis gives degenerate
    // zero-area quads — verified bug from earlier session.
    const elements = [
      { from: [6.5, 0, 8], to: [9.5, 16, 8],
        rotation: { origin: [8, 8, 8], axis: "y", angle: 45 },
        faces: {
          north: { texture: tex, uv: [0, 0, 3, 16] },
          south: { texture: tex, uv: [0, 0, 3, 16] }
        }
      },
      { from: [8, 0, 6.5], to: [8, 16, 9.5],
        rotation: { origin: [8, 8, 8], axis: "y", angle: 45 },
        faces: {
          east: { texture: tex, uv: [3, 0, 6, 16] },
          west: { texture: tex, uv: [3, 0, 6, 16] }
        }
      }
    ];
    const variant = axis === "x" ? { x: 90, y: 90, z: 0 }
                  : axis === "z" ? { x: 90, y: 0, z: 0 }
                  : { x: 0, y: 0, z: 0 };
    return bakeFallbackElements(blockName, elements, variant);
  }

  // Mushroom blocks have 6 independent face boolean properties. Each true face
  // shows the cap/stem texture; each false face shows the inner pore texture.
  // Vanilla blockstate variants don't cover all 64 combinations, so build the
  // cube manually from the per-face properties.
  if (short === "red_mushroom_block" || short === "brown_mushroom_block" || short === "mushroom_stem") {
    return mushroomBlockModel(blockName, properties);
  }

  // Chests, banners: handled by deepslate's SpecialRenderers (called from
  // bakeBlockModel after vanilla baking). Vanilla model for chest/banner is
  // empty — the deepslate special renderer provides full geometry.

  // Lever: vanilla model baking handles all face/facing/powered states correctly
  // when vanilla assets are available. Hand-crafted geometry was removed because
  // it consistently produced wrong geometry across sessions.

  // Buttons: vanilla {wood}_button.json / stone_button.json blockstates describe
  // floor/wall/ceiling × facing × powered correctly. Let vanilla baking handle them.

  // Bed: handled by deepslate's SpecialRenderers in bakeBlockModel.

  // Candle: vanilla candle.json / {color}_candle.json handles all 4 candle counts
  // and the lit/unlit states.

  if (short.endsWith("_wall_sign") || short.endsWith("_wall_hanging_sign")) {
    const y = yRotationForFacing(properties.facing ?? "north", "north");
    const tex = signTextureForBlock(short);
    return bakeFallbackElements(blockName, [
      { from: [2, 4, 14], to: [14, 12, 15.5], faces: allFaces(tex) }
    ], { x: 0, y });
  }

  if (short.endsWith("_sign") || short.endsWith("_hanging_sign")) {
    const rotation = Number(properties.rotation ?? 0);
    const y = (rotation / 16) * 360;
    const tex = signTextureForBlock(short);
    return bakeFallbackElements(blockName, [
      { from: [2, 5, 7.25], to: [14, 13, 8.75], faces: allFaces(tex) },
      { from: [7.25, 0, 7.25], to: [8.75, 5, 8.75], faces: allFaces(tex) }
    ], { x: 0, y });
  }

  // Skull/head blocks: standing variants (dragon_head, skeleton_skull, etc.) are
  // entity-rendered by deepslate's SkullRenderers map — fall through so the
  // SpecialRenderer path in bakeBlockModel produces the real head geometry.
  // Wall variants aren't in deepslate's SkullRenderers, so keep the cube fallback.
  if (short.endsWith("_wall_skull") || short.endsWith("_wall_head")) {
    const skull = skullElementsForState(blockName, properties);
    return bakeFallbackElements(blockName, skull.elements, skull.variant);
  }

  // Shulker boxes: handled by deepslate's SpecialRenderers.shulkerBoxRenderer.

  // Bell: yoke comes from vanilla bell.json, bell BODY comes from deepslate's
  // SpecialRenderers.bellRenderer. Combined in bakeBlockModel.

  // Decorated pot: handled by deepslate's SpecialRenderers.decoratedPotRenderer.

  if (short === "conduit") {
    const conduit = conduitElementsForState();
    return bakeFallbackElements(blockName, conduit.elements, conduit.variant);
  }

  return null;
}

function getAttachmentSnap(blockName, properties = {}) {
  const short = blockName.replace(/^minecraft:/, "");
  // Snapping only applies to buttons. Levers have element-level rotations
  // (the handle tilts ±45° around z); the snap finds the extreme point of the
  // rotated handle and shifts the entire model by that delta, dragging the
  // base plate off the wall it's supposed to attach to. Vanilla lever models
  // are already correctly positioned at the wall boundary, so no snap needed.
  if (!short.endsWith("_button")) return null;

  const face = properties.face ?? "wall";
  const facing = properties.facing ?? "north";

  if (face === "floor") return { axis: "y", side: "min" };
  if (face === "ceiling") return { axis: "y", side: "max" };

  switch (facing) {
    case "south": return { axis: "z", side: "min" };
    case "east": return { axis: "x", side: "min" };
    case "west": return { axis: "x", side: "max" };
    case "north":
    default: return { axis: "z", side: "max" };
  }
}

function snapAttachedModelToSupport(blockName, properties, quads) {
  const snap = getAttachmentSnap(blockName, properties);
  if (!snap || quads.length === 0) return quads;

  let min = Infinity;
  let max = -Infinity;
  for (const quad of quads) {
    for (const point of quad.points) {
      const value = point[snap.axis];
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return quads;

  const target = snap.side === "min" ? 0 : 1;
  const current = snap.side === "min" ? min : max;
  const delta = target - current;
  if (Math.abs(delta) < 0.0001) return quads;

  return quads.map(quad => ({
    ...quad,
    points: quad.points.map(point => ({ ...point, [snap.axis]: point[snap.axis] + delta })),
    depthOffset: faceDepth(quad.points.map(point => ({ ...point, [snap.axis]: point[snap.axis] + delta })))
  }));
}

function snapWallClingFaces(quads) {
  // Snap vine/lichen/sculk faces that are near a block boundary to just INside
  // the block (0.001 units from the boundary, toward the centre). This places
  // the face right in front of the adjacent wall face in the depth buffer so
  // it appears on the wall surface when rendered.
  //
  // Threshold raised from 0.02 to 0.10 because the vanilla vine.json model
  // places the face at z=0.8 element units (= 0.05 normalised), not at the
  // exact boundary. With the tight 0.02 threshold the snap never fired for
  // vines and they appeared 0.05 detached from the wall.
  return quads.map(quad => {
    for (const axis of ['x', 'y', 'z']) {
      const vals = quad.points.map(p => p[axis]);
      const span = Math.max(...vals) - Math.min(...vals);
      if (span > 0.15) continue;
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      if (avg >= 0.90) {
        const newPoints = quad.points.map(p => ({ ...p, [axis]: 0.999 }));
        return { ...quad, points: newPoints, depthOffset: faceDepth(newPoints) };
      }
      if (avg <= 0.10) {
        const newPoints = quad.points.map(p => ({ ...p, [axis]: 0.001 }));
        return { ...quad, points: newPoints, depthOffset: faceDepth(newPoints) };
      }
    }
    return quad;
  });
}

function bakeBlockModel(blockName, properties = {}) {
  const cacheKey = `${blockName}|${stringifyProperties(properties)}`;

  if (bakedModelCache.has(cacheKey)) return bakedModelCache.get(cacheKey);

  const special = specialBlockModel(blockName, properties);
  if (special) {
    bakedModelCache.set(cacheKey, special);
    stats.bakedQuads += special.length;
    return special;
  }

  const variants = getModelVariantsFromBlockState(blockName, properties);
  const baked = [];

  for (const variant of variants) {
    const model = mergeModel(variant.model);
    const elements = model.elements ?? [];

    if (elements.length === 0) {
      stats.skippedMissingModels++;
      continue;
    }

    for (const element of elements) {
      baked.push(...bakeElementQuads(blockName, model.textures, element, variant));
    }
  }

  // Entity-rendered parts (bell body, bed mattress + legs, chest body + lid,
  // banner fabric, sign post + plank, conduit shell, shulker box, decorated pot,
  // skull head, etc.) live in deepslate's SpecialRenderers — for blocks where
  // the vanilla block model is empty or just a sub-frame, this is what makes
  // them visible. Returns empty for blocks that aren't entity-rendered, so
  // it's safe to always call.
  const specialRendererQuads = bakeViaDeepslateSpecialRenderer(blockName, properties);
  if (specialRendererQuads && specialRendererQuads.length) baked.push(...specialRendererQuads);

  const attached = snapAttachedModelToSupport(blockName, properties, baked);
  const short = blockName.replace(/^minecraft:/, "");
  const result = (short === "vine" || short === "glow_lichen" || short === "sculk_vein")
    ? snapWallClingFaces(attached)
    : attached;
  stats.bakedQuads += result.length;
  bakedModelCache.set(cacheKey, result);
  return result;
}

function makeBlockQuads(block, offsetX, offsetY, scale, rotation = null) {
  const bakedModel = bakeBlockModel(block.name, block.properties);
  const quads = [];

  for (const bakedQuad of bakedModel) {
    const worldPoints = bakedQuad.points.map(point => ({
      x: block.x + point.x,
      y: block.y + point.y,
      z: block.z + point.z
    }));

    const rotatedPoints = worldPoints.map(p =>
      rotation ? rotateWorldPoint(p, rotation.degrees, rotation.center) : p
    );
    const avgDepth = rotatedPoints.reduce((s, p) => s + p.x + p.y + p.z, 0) / rotatedPoints.length;
    const minDepth = Math.min(...rotatedPoints.map(p => p.x + p.y + p.z));

    quads.push({
      ...bakedQuad,
      blockName: block.name,
      block,
      screen: worldPoints.map(point => projectPoint(point, offsetX, offsetY, scale, rotation)),
      depth: avgDepth,
      minVertexDepth: minDepth,
    });
  }

  return quads;
}

function parseBlockStateString(state) {
  if (!state || typeof state !== "string") return null;

  const match = state.match(/^([^[]+)(?:\[(.*)\])?$/);
  if (!match) return null;

  const name = match[1];
  const properties = {};

  if (match[2]) {
    for (const part of match[2].split(",")) {
      const [key, value] = part.split("=");
      if (key && value !== undefined) properties[key] = value;
    }
  }

  return { name, properties };
}

function getJigsawReplacement(block) {
  const nbtData = block.nbt;
  if (!nbtData || typeof nbtData !== "object") return null;

  const finalState =
    nbtData.final_state ??
    nbtData.finalState ??
    nbtData.FinalState;

  const parsed = parseBlockStateString(finalState);
  if (!parsed || parsed.name === "minecraft:air") return null;

  return parsed;
}

function collectBlocksFromStructure(structure) {
  const palette = getPalette(structure);
  const blocks = [];

  for (const block of structure.blocks ?? []) {
    const state = palette[block.state];
    let blockName = getBlockNameFromPaletteEntry(state);
    let properties = state?.Properties ?? state?.properties ?? {};

    if (blockName === "minecraft:jigsaw") {
      const replacement = getJigsawReplacement(block);
      if (!replacement) continue;

      blockName = replacement.name;
      properties = replacement.properties;
    }

    if (!blockName || IGNORED_BLOCKS.has(blockName)) continue;

    const pos = block.pos ?? block.position;
    if (!Array.isArray(pos) || pos.length < 3) continue;

    blocks.push({
      x: Number(pos[0]),
      y: Number(pos[1]),
      z: Number(pos[2]),
      name: blockName,
      properties
    });
  }

  return blocks;
}

function normalizeBlocks(blocks) {
  if (blocks.length === 0) return blocks;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;

  for (const block of blocks) {
    if (block.x < minX) minX = block.x;
    if (block.y < minY) minY = block.y;
    if (block.z < minZ) minZ = block.z;
  }

  return blocks.map(block => ({
    ...block,
    x: block.x - minX,
    y: block.y - minY,
    z: block.z - minZ
  }));
}

function isFullCubeOpaqueForConnect(name) {
  const s = shortBlockName(name);
  if (/glass|honey_block|slime_block|leaves|vine|lichen|vein|roots|grass$|fern|sapling|flower|torch|lantern|chain|rail|door|trapdoor|cobweb|seagrass|kelp|coral|mushroom$|dead_bush|bamboo|azalea|dripleaf|lily_pad|candle|campfire|sign|pane|bars/.test(s)) return false;
  if (/slab$|stair|_wall$|fence|gate|_plate|button|lever|piston|shulker_box|chest|_bed|banner|skull|_head$|conduit|bell|decorated_pot|anvil|scaffolding|stonecutter|cauldron|composter|hopper|repeater|comparator|daylight_detector|lightning_rod|tripwire|spore_blossom|pointed_dripstone|_carpet|snow$|^air$/.test(s)) return false;
  return true;
}

function computeConnectionProperties(blocks) {
  const posMap = new Map();
  for (const b of blocks) posMap.set(`${b.x},${b.y},${b.z}`, b);

  return blocks.map(block => {
    const s = shortBlockName(block.name);
    const isFence = /_fence$/.test(s) || s === "nether_brick_fence";
    const isWall = /_wall$/.test(s);
    const isPaneOrBar = /glass_pane$/.test(s) || s === "iron_bars";

    if (!isFence && !isWall && !isPaneOrBar) return block;

    const props = { ...(block.properties || {}) };

    for (const [key, dx, dz] of [["north", 0, -1], ["south", 0, 1], ["west", -1, 0], ["east", 1, 0]]) {
      const nb = posMap.get(`${block.x + dx},${block.y},${block.z + dz}`);
      let connects = false;
      if (nb) {
        const ns = shortBlockName(nb.name);
        if (isFence) {
          connects = /_fence$/.test(ns) || ns === "nether_brick_fence" ||
                     /_fence_gate$/.test(ns) || isFullCubeOpaqueForConnect(nb.name);
        } else if (isWall) {
          connects = /_wall$/.test(ns) || isFullCubeOpaqueForConnect(nb.name);
        } else {
          connects = /glass_pane$/.test(ns) || ns === "iron_bars" ||
                     isFullCubeOpaqueForConnect(nb.name);
        }
      }
      props[key] = isWall ? (connects ? "low" : "none") : (connects ? "true" : "false");
    }

    if (isWall) {
      const above = posMap.get(`${block.x},${block.y + 1},${block.z}`);
      const aboveConnects = above && (shortBlockName(above.name).endsWith("_wall") || isFullCubeOpaqueForConnect(above.name));
      const straightNS = props.north !== "none" && props.south !== "none" && props.east === "none" && props.west === "none";
      const straightEW = props.east !== "none" && props.west !== "none" && props.north === "none" && props.south === "none";
      props.up = (!straightNS && !straightEW || aboveConnects) ? "true" : "false";
    }

    return { ...block, properties: props };
  });
}

function computeBounds(blocks, scale = 1, rotation = null) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const update = point => {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  };

  for (const block of blocks) {
    update(projectPoint({ x: block.x, y: block.y, z: block.z }, 0, 0, scale, rotation));
    update(projectPoint({ x: block.x + 1, y: block.y, z: block.z }, 0, 0, scale, rotation));
    update(projectPoint({ x: block.x, y: block.y + 1, z: block.z }, 0, 0, scale, rotation));
    update(projectPoint({ x: block.x + 1, y: block.y + 1, z: block.z }, 0, 0, scale, rotation));
    update(projectPoint({ x: block.x, y: block.y, z: block.z + 1 }, 0, 0, scale, rotation));
    update(projectPoint({ x: block.x + 1, y: block.y, z: block.z + 1 }, 0, 0, scale, rotation));
    update(projectPoint({ x: block.x, y: block.y + 1, z: block.z + 1 }, 0, 0, scale, rotation));
    update(projectPoint({ x: block.x + 1, y: block.y + 1, z: block.z + 1 }, 0, 0, scale, rotation));
  }

  if (!Number.isFinite(minX)) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };

  return { minX, maxX, minY, maxY };
}

function fillBackground(png) {
  if (transparentBackground) return;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      blendPixel(png, x, y, { r: 16, g: 24, b: 32, a: 255 });
    }
  }
}

function getRotationCenter(blocks) {
  if (blocks.length === 0) return { x: 0, z: 0 };

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const block of blocks) {
    if (block.x < minX) minX = block.x;
    if (block.x + 1 > maxX) maxX = block.x + 1;
    if (block.z < minZ) minZ = block.z;
    if (block.z + 1 > maxZ) maxZ = block.z + 1;
  }

  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2
  };
}

function getScaledBounds(blocks, rotation) {
  const baseBounds = computeBounds(blocks, 1, rotation);
  const baseWidth = baseBounds.maxX - baseBounds.minX + padding * 2;
  const baseHeight = baseBounds.maxY - baseBounds.minY + padding * 2;
  const scale = Math.min(1, maxImageSize / Math.max(baseWidth, baseHeight));

  return {
    scale,
    bounds: computeBounds(blocks, scale, rotation)
  };
}

function renderBlocksToPngFrame(blocks, options = {}) {
  const rotation = options.rotation ?? null;
  const scale = options.scale ?? 1;
  const bounds = options.bounds ?? computeBounds(blocks, scale, rotation);
  const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX + padding * 2));
  const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY + padding * 2));

  const png = new PNG({ width, height });
  fillBackground(png);

  if (blocks.length === 0) return png;

  const offsetX = padding - bounds.minX;
  const offsetY = padding - bounds.minY;
  const quads = [];

  for (const block of blocks) {
    quads.push(...makeBlockQuads(block, offsetX, offsetY, scale, rotation));
  }

  quads.sort((a, b) => {
    const d = a.depth - b.depth;
    if (Math.abs(d) > 1e-6) return d;
    return (a.minVertexDepth ?? a.depth) - (b.minVertexDepth ?? b.depth);
  });

  for (const quad of quads) {
    drawTexturedQuad(png, quad);
  }

  return png;
}

function encodePng(png) {
  return PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    deflateLevel: pngCompressionLevel,
    filterType: 4
  });
}

function renderBlocksToPngViews(blocks) {
  blocks = normalizeBlocks(blocks);
  blocks = computeConnectionProperties(blocks);

  if (blocks.length === 0) {
    const blank = renderBlocksToPngFrame([], { bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, scale: 1 });
    return previewRotations.map(view => ({ ...view, buffer: encodePng(blank) }));
  }

  const center = getRotationCenter(blocks);

  return previewRotations.map(view => {
    const rotation = { degrees: view.degrees, center };
    const { bounds, scale } = getScaledBounds(blocks, rotation);
    const png = renderBlocksToPngFrame(blocks, { bounds, scale, rotation });

    return {
      ...view,
      buffer: encodePng(png)
    };
  });
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

  if (typeof element.location === "string") result.add(element.location);

  if (Array.isArray(element.elements)) {
    for (const nested of element.elements) {
      collectElementLocations(nested.element ?? nested, result);
    }
  }

  if (element.element) collectElementLocations(element.element, result);

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

  for (const nested of Object.values(value)) collectJigsawPoolsFromNbt(nested, result);

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

  stats.poolsRead++;

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
          stats.jigsawPoolsFollowed++;
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


function getFirstNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getStructureSize(structure) {
  const size = structure.size ?? structure.Size ?? [0, 0, 0];
  return {
    x: getFirstNumber(size[0]),
    y: getFirstNumber(size[1]),
    z: getFirstNumber(size[2])
  };
}

function unwrapNbtValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.prototype.hasOwnProperty.call(value, "value")) return unwrapNbtValue(value.value);
    if (Object.prototype.hasOwnProperty.call(value, "Value")) return unwrapNbtValue(value.Value);
  }
  return value;
}

function getJigsawNbtValue(nbtData, key) {
  if (!nbtData || typeof nbtData !== "object") return undefined;

  const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const pascalKey = camelKey.charAt(0).toUpperCase() + camelKey.slice(1);
  const candidates = [key, camelKey, pascalKey, key.toUpperCase()];

  function findIn(value, depth = 0) {
    value = unwrapNbtValue(value);
    if (!value || typeof value !== "object" || depth > 8) return undefined;
    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(value, candidate)) {
        return unwrapNbtValue(value[candidate]);
      }
    }
    for (const nested of Object.values(value)) {
      const found = findIn(nested, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  return findIn(nbtData);
}

function normalizeResourceLocationForCompare(value) {
  value = unwrapNbtValue(value);
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") value = String(value);
  value = value.trim().replace(/^['"]|['"]$/g, "");
  if (!value || value === "minecraft:empty") return null;
  return value.includes(":") ? value : `minecraft:${value}`;
}

function getJigsawInfo(block, state) {
  const blockName = getBlockNameFromPaletteEntry(state);
  if (blockName !== "minecraft:jigsaw") return null;

  const nbtData = block.nbt;
  const pos = block.pos ?? block.position;
  if (!nbtData || !Array.isArray(pos) || pos.length < 3) return null;

  const properties = state?.Properties ?? state?.properties ?? {};
  const orientation = properties.orientation ?? properties.Orientation ?? "north_up";
  const [front = "north", top = "up"] = String(orientation).split("_");

  return {
    x: getFirstNumber(pos[0]),
    y: getFirstNumber(pos[1]),
    z: getFirstNumber(pos[2]),
    name: normalizeResourceLocationForCompare(getJigsawNbtValue(nbtData, "name")),
    target: normalizeResourceLocationForCompare(getJigsawNbtValue(nbtData, "target")),
    // target_pool is the pool to draw the next piece from. pool is connector
    // metadata and is only used when matching to a child connector.
    targetPool: normalizeResourceLocationForCompare(getJigsawNbtValue(nbtData, "target_pool")),
    pool: normalizeResourceLocationForCompare(getJigsawNbtValue(nbtData, "pool")),
    finalState: getJigsawNbtValue(nbtData, "final_state"),
    orientation,
    front,
    top
  };
}

function getJigsawsFromStructure(structure) {
  const palette = getPalette(structure);
  const jigsaws = [];

  for (const block of structure.blocks ?? []) {
    const state = palette[block.state];
    const info = getJigsawInfo(block, state);
    if (info) jigsaws.push(info);
  }

  return jigsaws;
}

function directionToVector(direction) {
  switch (direction) {
    case "north": return { x: 0, y: 0, z: -1 };
    case "south": return { x: 0, y: 0, z: 1 };
    case "west": return { x: -1, y: 0, z: 0 };
    case "east": return { x: 1, y: 0, z: 0 };
    case "down": return { x: 0, y: -1, z: 0 };
    case "up":
    default: return { x: 0, y: 1, z: 0 };
  }
}

function rotateYVector(vector, quarterTurns) {
  let x = vector.x;
  let z = vector.z;
  const turns = ((quarterTurns % 4) + 4) % 4;

  for (let i = 0; i < turns; i++) {
    const nextX = -z;
    const nextZ = x;
    x = nextX;
    z = nextZ;
  }

  return { x, y: vector.y, z };
}

function vectorKey(vector) {
  return `${vector.x},${vector.y},${vector.z}`;
}

function rotateYPosition(pos, size, quarterTurns) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  let x = pos.x;
  let z = pos.z;
  let sx = size.x;
  let sz = size.z;

  for (let i = 0; i < turns; i++) {
    const nextX = sz - 1 - z;
    const nextZ = x;
    x = nextX;
    z = nextZ;
    const oldSx = sx;
    sx = sz;
    sz = oldSx;
  }

  return { x, y: pos.y, z };
}

function rotateYDirection(direction, quarterTurns) {
  const horizontal = ["north", "east", "south", "west"];
  const index = horizontal.indexOf(direction);
  if (index === -1) return direction;
  return horizontal[(index + quarterTurns + 400) % 4];
}

function rotateYProperties(properties, quarterTurns) {
  const rotated = { ...(properties ?? {}) };

  if (rotated.facing) rotated.facing = rotateYDirection(rotated.facing, quarterTurns);
  if (rotated.horizontal_facing) rotated.horizontal_facing = rotateYDirection(rotated.horizontal_facing, quarterTurns);
  if (rotated.orientation) {
    const [front, top = "up"] = String(rotated.orientation).split("_");
    rotated.orientation = `${rotateYDirection(front, quarterTurns)}_${rotateYDirection(top, quarterTurns)}`;
  }
  if (rotated.rotation !== undefined) {
    const value = Number(rotated.rotation);
    if (Number.isFinite(value)) rotated.rotation = String((value + quarterTurns * 4 + 1600) % 16);
  }

  if (rotated.axis === "x" || rotated.axis === "z") {
    if (quarterTurns % 2 !== 0) rotated.axis = rotated.axis === "x" ? "z" : "x";
  }

  if (rotated.shape) {
    const rotateShape = shape => {
      const map = {
        north_south: "east_west",
        east_west: "north_south",
        ascending_north: "ascending_east",
        ascending_east: "ascending_south",
        ascending_south: "ascending_west",
        ascending_west: "ascending_north",
        south_east: "south_west",
        south_west: "north_west",
        north_west: "north_east",
        north_east: "south_east"
      };
      return map[shape] ?? shape;
    };
    for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) rotated.shape = rotateShape(rotated.shape);
  }

  // Multipart side booleans (vines, glow lichen, sculk vein, walls, fences,
  // mushroom blocks, chorus plant, redstone wire, etc.). When the structure
  // rotates, a vine with east=true ends up at a position whose support is now
  // on a different cardinal direction — the property has to rotate too or the
  // vine plane gets placed on the wrong wall (looks "floating next to a block").
  const sideKeys = ["north", "east", "south", "west"];
  const sideValues = sideKeys.map(k => rotated[k]);
  if (sideValues.some(v => v !== undefined)) {
    for (let i = 0; i < sideKeys.length; i++) {
      const targetIndex = (i + quarterTurns + 400) % 4;
      rotated[sideKeys[targetIndex]] = sideValues[i];
    }
  }

  return rotated;
}

function transformStructureBlocks(structure, offset, quarterTurns = 0) {
  const size = getStructureSize(structure);

  return collectBlocksFromStructure(structure).map(block => {
    const rotated = rotateYPosition(block, size, quarterTurns);

    return {
      ...block,
      x: rotated.x + offset.x,
      y: rotated.y + offset.y,
      z: rotated.z + offset.z,
      properties: rotateYProperties(block.properties, quarterTurns)
    };
  });
}

function transformJigsaw(jigsaw, size, offset, quarterTurns = 0) {
  const rotated = rotateYPosition(jigsaw, size, quarterTurns);
  const frontVector = rotateYVector(directionToVector(jigsaw.front), quarterTurns);

  return {
    ...jigsaw,
    x: rotated.x + offset.x,
    y: rotated.y + offset.y,
    z: rotated.z + offset.z,
    frontVector
  };
}

function getTemplatePoolChoices(poolJson) {
  const choices = [];

  // Minecraft chooses one top-level template_pool element by weight. Some
  // elements contain nested data, but the weight belongs to the top-level
  // pool entry, so do not flatten locations before rolling or large nested
  // entries would be overrepresented.
  for (const element of poolJson?.elements ?? []) {
    const elementData = element.element ?? element;
    const weight = Math.max(0, Number(element.weight ?? elementData.weight ?? 1));
    const locations = Array.from(collectElementLocations(elementData))
      .filter(location => fs.existsSync(getStructureNbtFileFromLocation(location)));

    choices.push({
      locations,
      location: locations[0] ?? null,
      weight,
      element: elementData
    });
  }

  return choices;
}

function chooseTemplatePoolLocations(poolJson) {
  return getTemplatePoolChoices(poolJson)
    .flatMap(choice => choice.locations ?? (choice.location ? [choice.location] : []));
}

function hasTemplatePool(poolId) {
  return !!poolId && poolId !== "minecraft:empty" && fs.existsSync(getTemplatePoolFile(poolId));
}

function getJigsawExpansionPool(jigsaw) {
  // Dynamic schema support:
  // - New/custom exports may expose the outgoing template pool as `target_pool`.
  // - Vanilla structure-template NBT commonly stores that same outgoing pool in
  //   `pool`.  Only treat `pool` as an expansion source when it resolves to an
  //   actual template_pool JSON in the current repo, so connector-only values do
  //   not accidentally expand.
  if (hasTemplatePool(jigsaw.targetPool)) return jigsaw.targetPool;
  if (hasTemplatePool(jigsaw.pool)) return jigsaw.pool;
  return null;
}

function getJigsawConnectorPool(jigsaw, expansionPool = null) {
  // In some data sets `pool` is connector metadata; in vanilla-style NBT it is
  // the expansion pool.  Do not use it as connector metadata when it is the same
  // value we are expanding from.
  if (!jigsaw?.pool) return null;
  if (expansionPool && jigsaw.pool === expansionPool) return null;
  return jigsaw.pool;
}

function weightedPoolChoiceOrder(choices, seedText) {
  const remaining = choices.filter(choice => (choice.weight ?? 0) > 0);
  const ordered = [];
  let salt = 0;

  // Weighted without replacement: first choice is a correct weighted roll. If
  // that element cannot physically connect/fit, try the remaining elements in
  // weighted-random order instead of falling back to index 0 or rendering all.
  while (remaining.length > 0) {
    const choice = chooseWeightedEntry(remaining, `${seedText}|candidate|${salt++}`) ?? remaining[0];
    ordered.push(choice);
    const index = remaining.indexOf(choice);
    if (index >= 0) remaining.splice(index, 1);
    else break;
  }

  return ordered;
}

async function chooseStructuresFromTemplatePool(poolId, seenPools = new Set(), seedText = previewSeed) {
  if (!poolId || poolId === "minecraft:empty" || seenPools.has(poolId)) return [];
  seenPools.add(poolId);

  const poolJson = readJsonIfExists(getTemplatePoolFile(poolId));
  if (!poolJson) return [];
  stats.poolsRead++;

  const choices = getTemplatePoolChoices(poolJson);
  const ordered = weightedPoolChoiceOrder(choices, `${seedText}|pool|${poolId}`);
  const candidates = [];

  for (const choice of ordered) {
    // Preserve empty/non-structure entries as a valid no-child result when they
    // win the weighted roll. Later entries are only tried if a chosen structure
    // exists but cannot connect/fit.
    if (!choice?.location) {
      candidates.push({ empty: true, weight: choice?.weight ?? 0 });
      continue;
    }

    candidates.push({
      location: choice.location,
      structureFile: getStructureNbtFileFromLocation(choice.location),
      weight: choice.weight
    });
  }

  if (candidates.length > 0) return candidates;

  if (poolJson.fallback && poolJson.fallback !== "minecraft:empty") {
    return chooseStructuresFromTemplatePool(poolJson.fallback, seenPools, `${seedText}|fallback`);
  }

  return [];
}

function connectorCompatibilityScore(parent, child, expansionPool) {
  let score = 0;

  // Primary jigsaw connector rule: the parent asks for `target`, and the child
  // connector offers `name`. This is the rule that should drive attachment.
  if (parent.target && child.name && child.name === parent.target) score += 1000;

  // Mirrored metadata is common in generated structures and is safe as a
  // secondary signal, but it must never replace parent.target -> child.name.
  if (parent.name && child.target && child.target === parent.name) score += 100;

  // Some custom/exported jigsaws use `pool` as connector metadata. Use it only
  // as a weak tie-breaker/fallback, never as the expansion source and never as a
  // hard requirement.
  const parentConnectorPool = getJigsawConnectorPool(parent, expansionPool);
  const childConnectorPool = getJigsawConnectorPool(child, null);
  if (parentConnectorPool && childConnectorPool && childConnectorPool === parentConnectorPool) score += 25;

  // Named connectors should not attach to unrelated named connectors. Pool-only
  // matches are allowed only when no names are available.
  if ((parent.target || child.name) && score === 0) return -1;

  return score;
}

function findCompatibleChildConnectors(parent, childJigsaws, expansionPool, parentFrontVector = null) {
  const scored = [];

  for (const child of childJigsaws) {
    const score = connectorCompatibilityScore(parent, child, expansionPool);
    if (score < 0) continue;

    const orientationScore = parentFrontVector
      ? (getQuarterTurnsToFace(directionToVector(child.front), parentFrontVector) >= 0 ? 5 : 0)
      : 0;

    scored.push({ child, score: score + orientationScore });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0 && expansionPool) {
    // Some exported structures only store the outgoing target_pool and leave
    // connector names sparse or inconsistent. In that case, still try each
    // child jigsaw as an attachment candidate instead of dropping the whole
    // pool reference. The normal overlap/distance checks below still prevent
    // impossible placements.
    return [...childJigsaws];
  }
  return scored.map(entry => entry.child);
}

function findCompatibleChildConnector(parent, childJigsaws, expansionPool, parentFrontVector = null) {
  return findCompatibleChildConnectors(parent, childJigsaws, expansionPool, parentFrontVector)[0] ?? null;
}

async function chooseStructureFromTemplatePool(poolId, seenPools = new Set(), seedText = previewSeed) {
  if (!poolId || poolId === "minecraft:empty" || seenPools.has(poolId)) return null;
  seenPools.add(poolId);

  const poolJson = readJsonIfExists(getTemplatePoolFile(poolId));
  if (!poolJson) return null;
  stats.poolsRead++;

  const choices = getTemplatePoolChoices(poolJson);

  if (choices.length > 0) {
    const choice = chooseWeightedEntry(choices, `${seedText}|pool|${poolId}`) ?? choices[0];

    // The chosen pool element may be minecraft:empty or another non-structure
    // element. That means this jigsaw does not place a child here; do not
    // silently try the next pool entry, because that would no longer be a
    // weight-correct random choice.
    if (!choice?.location) return null;

    return {
      location: choice.location,
      structureFile: getStructureNbtFileFromLocation(choice.location),
      weight: choice.weight
    };
  }

  if (poolJson.fallback && poolJson.fallback !== "minecraft:empty") {
    return chooseStructureFromTemplatePool(poolJson.fallback, seenPools, `${seedText}|fallback`);
  }

  return null;
}

function getQuarterTurnsToFace(childFront, parentFront) {
  const desired = { x: -parentFront.x, y: -parentFront.y, z: -parentFront.z };

  for (let turns = 0; turns < 4; turns++) {
    if (vectorKey(rotateYVector(childFront, turns)) === vectorKey(desired)) return turns;
  }

  // No Y-axis rotation can align these directions (e.g. vertical vs horizontal).
  return -1;
}

function makeBlockKey(block) {
  return `${block.x},${block.y},${block.z}`;
}

async function assembleJigsawFromStartFile(startStructureFile, options = {}) {
  const maxDepth = options.maxDepth ?? 7;
  const maxDistanceFromCenter = options.maxDistanceFromCenter ?? null;

  if (!fs.existsSync(startStructureFile)) return { blocks: [], files: [], resolvedJigsaws: 0 };

  const blockMap = new Map();
  const queue = [{
    structureFile: startStructureFile,
    offset: { x: 0, y: 0, z: 0 },
    quarterTurns: 0,
    depth: 0,
    consumedConnector: null
  }];
  const placed = new Set();
  const placedFiles = new Set();
  let resolvedJigsaws = 0;
  let startBounds = null;

  while (queue.length > 0) {
    const item = queue.shift();
    const placedKey = `${item.structureFile}|${item.offset.x},${item.offset.y},${item.offset.z}|${item.quarterTurns}`;
    if (placed.has(placedKey)) continue;
    placed.add(placedKey);
    placedFiles.add(item.structureFile);

    const structure = await readNbtFile(item.structureFile);
    const size = getStructureSize(structure);
    const transformedBlocks = transformStructureBlocks(structure, item.offset, item.quarterTurns);
    if (item.depth === 0 && !startBounds) startBounds = getBlockBounds(transformedBlocks);

    for (const block of transformedBlocks) {
      blockMap.set(makeBlockKey(block), block);
    }

    if (item.depth >= maxDepth) continue;

    for (const parent of getJigsawsFromStructure(structure)) {
      // A jigsaw used as the incoming connector for this piece is already consumed.
      // Expanding it again makes the preview grow backwards and quickly creates the
      // "all pieces blob" that does not match jigsaw placement behavior.
      if (
        item.consumedConnector &&
        parent.x === item.consumedConnector.x &&
        parent.y === item.consumedConnector.y &&
        parent.z === item.consumedConnector.z
      ) {
        continue;
      }

      // Only actual jigsaw blocks inside the currently placed structure can extend
      // the assembly. Do not scan arbitrary worldgen JSON or all template-pool files.
      const expansionPool = getJigsawExpansionPool(parent);
      if (!expansionPool) continue;

      const worldParent = transformJigsaw(parent, size, item.offset, item.quarterTurns);
      const seedText = `${previewSeed}|${item.structureFile}|${item.offset.x},${item.offset.y},${item.offset.z}|${item.quarterTurns}|${parent.x},${parent.y},${parent.z}|${parent.name}|${parent.target}|${parent.targetPool}|${parent.pool}`;
      const childChoices = await chooseStructuresFromTemplatePool(expansionPool, new Set(), seedText);
      if (childChoices.length === 0) continue;

      let placedChild = false;
      for (const childChoice of childChoices) {
        if (childChoice.empty) break;

        if (!fs.existsSync(childChoice.structureFile)) continue;

        const childStructure = await readNbtFile(childChoice.structureFile);
        const childSize = getStructureSize(childStructure);
        const childJigsaws = getJigsawsFromStructure(childStructure);
        const parentFront = worldParent.frontVector ?? directionToVector(worldParent.front);
        const childConnectors = findCompatibleChildConnectors(parent, childJigsaws, expansionPool, parentFront);
        if (childConnectors.length === 0) continue;

        for (const childConnector of childConnectors) {
          const childFront = directionToVector(childConnector.front);
          const childTurns = getQuarterTurnsToFace(childFront, parentFront);
          // Skip connectors whose direction cannot be aligned via Y-axis rotation
          // (e.g. a horizontal child connector cannot attach to a vertical parent).
          if (childTurns < 0) continue;
          const rotatedChildConnector = rotateYPosition(childConnector, childSize, childTurns);
          const attach = {
            x: worldParent.x + parentFront.x,
            y: worldParent.y + parentFront.y,
            z: worldParent.z + parentFront.z
          };
          const childOffset = {
            x: attach.x - rotatedChildConnector.x,
            y: attach.y - rotatedChildConnector.y,
            z: attach.z - rotatedChildConnector.z
          };

          const childBlocks = transformStructureBlocks(childStructure, childOffset, childTurns);
          if (!isWithinMaxDistanceFromStart(childBlocks, startBounds, maxDistanceFromCenter)) continue;

          resolvedJigsaws++;
          stats.jigsawPoolsFollowed++;
          stats.jigsawBlocksResolved++;

          queue.push({
            structureFile: childChoice.structureFile,
            offset: childOffset,
            quarterTurns: childTurns,
            depth: item.depth + 1,
            consumedConnector: {
              x: childConnector.x,
              y: childConnector.y,
              z: childConnector.z
            }
          });
          placedChild = true;
          break;
        }

        if (placedChild) break;
      }

      if (!placedChild) continue;
    }
  }

  return { blocks: [...blockMap.values()], files: [...placedFiles].sort(), resolvedJigsaws };
}

async function assembleJigsawStructureFromPool(startPool, options = {}) {
  const start = await chooseStructureFromTemplatePool(startPool, new Set(), `${previewSeed}|${startPool}|start`);
  if (!start) return { blocks: [], files: [], resolvedJigsaws: 0 };
  return assembleJigsawFromStartFile(start.structureFile, options);
}

function findFirstValueForKey(value, wantedKey) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValueForKey(item, wantedKey);
      if (found !== null && found !== undefined) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (value[wantedKey] !== undefined) return value[wantedKey];
  for (const nested of Object.values(value)) {
    const found = findFirstValueForKey(nested, wantedKey);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}


function clampNumber(value, min, max, fallback = null) {
  const number = Number(unwrapNbtValue(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function getNestedFirstValue(value, ...keys) {
  for (const key of keys) {
    const found = findFirstValueForKey(value, key);
    if (found !== null && found !== undefined) return unwrapNbtValue(found);
  }
  return undefined;
}

function parseMaxDistanceFromCenter(value, terrainAdaptation = "none") {
  value = unwrapNbtValue(value);
  if (value === null || value === undefined) return null;

  const maxHorizontal = terrainAdaptation === "none" ? 128 : 116;

  if (typeof value === "number" || typeof value === "string") {
    const horizontal = clampNumber(value, 1, maxHorizontal, null);
    if (horizontal === null) return null;
    return { horizontal, vertical: horizontal };
  }

  if (typeof value === "object") {
    const horizontalValue = value.horizontal ?? value.Horizontal ?? getNestedFirstValue(value, "horizontal", "Horizontal");
    const verticalValue = value.vertical ?? value.Vertical ?? getNestedFirstValue(value, "vertical", "Vertical");
    const horizontal = clampNumber(horizontalValue, 1, maxHorizontal, null);
    if (horizontal === null) return null;
    const vertical = clampNumber(verticalValue ?? 4064, 1, 4064, 4064);
    return { horizontal, vertical };
  }

  return null;
}

function parseJigsawGenerationConstraints(json) {
  const sizeValue = json.size ?? json.Size ?? getNestedFirstValue(json, "size", "Size");
  const size = sizeValue === undefined ? null : clampNumber(sizeValue, 0, 20, null);
  const maxDistanceValue = json.max_distance_from_center
    ?? json.maxDistanceFromCenter
    ?? getNestedFirstValue(json, "max_distance_from_center", "maxDistanceFromCenter");
  const terrainAdaptation = String(json.terrain_adaptation ?? json.terrainAdaptation ?? "none");
  const maxDistanceFromCenter = parseMaxDistanceFromCenter(maxDistanceValue, terrainAdaptation);

  return {
    // Preserve the existing preview safety depth when the structure JSON omits
    // size. When size exists, follow Minecraft's 0..20 generation-depth limit.
    maxDepth: size === null ? 7 : size,
    maxDistanceFromCenter
  };
}

function getBlockBounds(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity
  };

  for (const block of blocks) {
    bounds.minX = Math.min(bounds.minX, block.x);
    bounds.minY = Math.min(bounds.minY, block.y);
    bounds.minZ = Math.min(bounds.minZ, block.z);
    bounds.maxX = Math.max(bounds.maxX, block.x);
    bounds.maxY = Math.max(bounds.maxY, block.y);
    bounds.maxZ = Math.max(bounds.maxZ, block.z);
  }

  return bounds;
}

function intervalGap(aMin, aMax, bMin, bMax) {
  if (aMax < bMin) return bMin - aMax;
  if (bMax < aMin) return aMin - bMax;
  return 0;
}

function isWithinMaxDistanceFromStart(candidateBlocks, startBounds, maxDistanceFromCenter) {
  if (!maxDistanceFromCenter || !startBounds) return true;
  const candidateBounds = getBlockBounds(candidateBlocks);
  if (!candidateBounds) return true;

  // Measure how far the candidate extends BEYOND each edge of the start structure.
  // A candidate that is entirely inside the start structure has extension 0.
  // This matches Minecraft's max_distance_from_center semantics: the limit caps the
  // total reach of any placed piece beyond the starting piece's bounding box, not
  // just the gap between nearest edges (which would allow unbounded chain extension).
  const extendX = Math.max(candidateBounds.maxX - startBounds.maxX, startBounds.minX - candidateBounds.minX, 0);
  const extendZ = Math.max(candidateBounds.maxZ - startBounds.maxZ, startBounds.minZ - candidateBounds.minZ, 0);
  const extendY = Math.max(candidateBounds.maxY - startBounds.maxY, startBounds.minY - candidateBounds.minY, 0);
  const horizontal = Math.max(extendX, extendZ);

  return horizontal <= maxDistanceFromCenter.horizontal && extendY <= maxDistanceFromCenter.vertical;
}

async function collectStructureFilesForWorldgenStructure(worldgenFile) {
  const info = getWorldgenStructureInfo(worldgenFile);
  const json = readJsonIfExists(worldgenFile);
  if (!info || !json) return null;

  const startPool = normalizeResourceLocationForCompare(
    json.start_pool ?? json.startPool ?? findFirstValueForKey(json, "start_pool") ?? findFirstValueForKey(json, "startPool")
  );

  if (!startPool) {
    console.warn(`No start_pool found for worldgen structure ${worldgenFile}`);
    return null;
  }

  const constraints = parseJigsawGenerationConstraints(json);

  // Collect every unique starting structure listed in the start pool, then run
  // full jigsaw expansion from each. This ensures every pool variant gets its
  // own output image, with all connected pieces resolved just as Minecraft does.
  const poolJson = readJsonIfExists(getTemplatePoolFile(startPool));
  const seen = new Set();
  const startLocations = [];
  for (const choice of getTemplatePoolChoices(poolJson)) {
    for (const location of choice.locations ?? (choice.location ? [choice.location] : [])) {
      if (!location || seen.has(location)) continue;
      const structureFile = getStructureNbtFileFromLocation(location);
      if (!fs.existsSync(structureFile)) continue;
      seen.add(location);
      startLocations.push({ location, structureFile });
    }
  }

  if (startLocations.length === 0) return null;

  if (startLocations.length === 1) {
    const assembled = await assembleJigsawFromStartFile(startLocations[0].structureFile, constraints);
    if (assembled.blocks.length === 0) return null;
    return {
      namespace: info.namespace,
      relativePath: info.relativePath,
      id: info.id,
      files: assembled.files,
      blocks: assembled.blocks,
      resolvedJigsaws: assembled.resolvedJigsaws,
      worldgen: true
    };
  }

  // Multiple starting structures: render each with full jigsaw expansion as a
  // separate group so every variant appears in the output.
  const groups = [];
  for (const entry of startLocations) {
    const assembled = await assembleJigsawFromStartFile(entry.structureFile, constraints);
    if (assembled.blocks.length === 0) continue;
    const [, locationPath] = splitResourceLocation(entry.location);
    groups.push({
      namespace: info.namespace,
      // Keep the original worldgen/structure id as the public/copyable id.
      // The pool element path makes the output folder/key unique per variant.
      relativePath: `${info.relativePath}/${locationPath}`.replace(/\/+/g, "/"),
      id: info.id,
      key: `${info.id}/${locationPath}`,
      files: assembled.files,
      blocks: assembled.blocks,
      resolvedJigsaws: assembled.resolvedJigsaws,
      worldgen: true,
      poolElement: true
    });
  }

  return groups.length > 0 ? groups : null;
}

function getDirectStructureGroups() {
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
        outputName: info.topFolder,
        files: []
      });
    }

    groups.get(key).files.push(file);
  }

  return groups;
}

async function getWorldgenStructureGroups() {
  const groups = new Map();

  if (!generateWorldgenStructurePreviews) return groups;

  const worldgenFiles = walk(inputRoot)
    .filter(file => file.endsWith(".json"))
    .filter(file => getWorldgenStructureInfo(file) !== null);

  for (const file of worldgenFiles) {
    const result = await collectStructureFilesForWorldgenStructure(file);
    const groupList = Array.isArray(result) ? result : (result ? [result] : []);

    if (groupList.length === 0) {
      console.warn(`Could not assemble jigsaw preview for worldgen structure ${file}`);
      continue;
    }

    for (const group of groupList) {
      if (!group || !Array.isArray(group.blocks) || group.blocks.length === 0) {
        console.warn(`Could not assemble jigsaw preview for worldgen structure ${file}`);
        continue;
      }

      groups.set(group.key || group.id, {
        namespace: group.namespace,
        outputName: group.relativePath,
        sourceId: group.id,
        files: group.files,
        blocks: group.blocks,
        resolvedJigsaws: group.resolvedJigsaws,
        worldgen: true
      });
    }
  }

  return groups;
}

async function loadBlocksForFiles(files) {
  const allBlocks = [];
  const occupied = new Set();

  for (const file of files) {
    // Use jigsaw assembly so intra-structure jigsaw connections (blocks that
    // reference a template pool pointing at sibling structure files) are resolved
    // to their actual child pieces rather than just replaced with final_state.
    const assembled = await assembleJigsawFromStartFile(file);
    for (const block of assembled.blocks) {
      const key = `${block.x},${block.y},${block.z}`;
      if (!occupied.has(key)) {
        occupied.add(key);
        allBlocks.push(block);
      }
    }
  }

  return allBlocks;
}

function removeStaleOutputFiles(validOutputFiles) {
  if (!fs.existsSync(outputRoot)) return;

  for (const file of walk(outputRoot).filter(file => file.endsWith(".png") || file.endsWith(".gif"))) {
    const normalized = path.normalize(file);

    if (!validOutputFiles.has(normalized)) {
      fs.rmSync(file);
      console.log(`Removed stale ${file}`);
    }
  }
}

async function main() {
  console.log(`Using STRUCTURE_PREVIEW_SEED=${previewSeed}`);
  const groups = await getWorldgenStructureGroups();

  if (groups.size === 0) {
    for (const [key, value] of getDirectStructureGroups()) {
      groups.set(key, value);
    }
  }

  console.log(`Found ${groups.size} rendered structure group(s).`);
  console.log(`Read ${stats.poolsRead} template pool(s), followed ${stats.jigsawPoolsFollowed} jigsaw pool reference(s).`);

  const validOutputFiles = new Set();

  for (const group of groups.values()) {
    group.files.sort();

    const blocks = group.worldgen
      ? group.blocks
      : (Array.isArray(group.blocks) && group.blocks.length > 0
        ? group.blocks
        : await loadBlocksForFiles(group.files));
    if (blocks.length <= 1) {
      console.log(`Skipping ${group.namespace}:${group.outputName}; only ${blocks.length} block(s) after structure assembly.`);
      continue;
    }

    const outputDir = path.join(outputRoot, group.namespace, group.outputName);
    const views = renderBlocksToPngViews(blocks);

    fs.mkdirSync(outputDir, { recursive: true });

    let totalSize = 0;
    for (const view of views) {
      const outputPath = path.join(outputDir, `${view.name}.png`);
      validOutputFiles.add(path.normalize(outputPath));
      fs.writeFileSync(outputPath, view.buffer);
      totalSize += fs.statSync(outputPath).size;
      stats.mainImages++;
    }

    const sourceDescription = group.worldgen
      ? `${group.resolvedJigsaws ?? 0} resolved jigsaw block(s)`
      : `${group.files.length} structure part(s)`;
    console.log(`Generated ${views.length} PNG preview(s) in ${outputDir} from ${sourceDescription}, ${blocks.length} block(s), ${totalSize} total bytes`);
  }

  if (groups.size === 0) console.warn("No structure groups were found.");

  console.log(`Generated ${stats.mainImages} static preview PNG(s).`);
  console.log(`Baked ${stats.bakedQuads} model quad(s), skipped ${stats.skippedMissingModels} block model(s) with no renderable elements.`);
  console.log(`Texture files loaded: ${stats.textureHits}; missing/fallback lookups: ${stats.textureMisses}.`);

  removeStaleOutputFiles(validOutputFiles);
}

function getFirstFrameBuffer(texture) {
  if (!texture || texture.height <= texture.width) return null;
  const frameH = texture.width;
  const out = new PNG({ width: texture.width, height: frameH });
  out.data.set(texture.data.slice(0, frameH * texture.width * 4));
  return PNG.sync.write(out);
}

module.exports = {
  getWorldgenStructureGroups,
  getDirectStructureGroups,
  loadBlocksForFiles,
  readAssetBuffer,
  readTextureAsset,
  getFirstFrameBuffer,
  bakeBlockModel,
  computeConnectionProperties,
  averageOpaqueTextureColor,
  applyBiomeTint,
  fallbackColorForBlock,
  shadeColor,
  getFaceUv,
  stats
};

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
