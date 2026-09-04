#!/usr/bin/env node
/*
 * Bedrock-style Minecraft entity variant renderer backed by checked-in OBJ geometry.
 *
 * This is intentionally independent from Mojang model baking, Fabric Loom,
 * Three.js, headless-gl, or browser/WebGL APIs. It loads checked-in OBJ models
 * from tools/entity_models/<type>/<adult|baby>_<model>.obj and rasterizes them
 * in pure Node using pngjs. Zero-thickness cuboids are treated like Bedrock
 * voxel planes instead of generic meshes, which preserves frog feet and other
 * flat entity parts without z-fighting.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { PNG } = require('pngjs');

const ENTITY_TYPES = ['cat', 'chicken', 'frog', 'pig', 'cow', 'wolf', 'zombie_nautilus'];
const HAS_BABY_MODEL = new Set(['cat', 'chicken', 'pig', 'cow', 'wolf']);
const OUTPUT_ROOT = process.env.ENTITY_RENDER_OUTPUT_ROOT || path.join(process.env.WIKI_OUTPUT_ROOT || 'wiki', 'images', 'entity');
const ENTITY_MODEL_ROOT = process.env.ENTITY_MODEL_ROOT || path.join('tools', 'entity_models');
const DEBUG = process.env.ENTITY_RENDER_DEBUG === '1';
const VERBOSE = process.env.ENTITY_RENDER_VERBOSE === '1';

const RENDER_SIZE = Number(process.env.ENTITY_RENDER_SIZE || 512);
const SUPERSAMPLE = Math.max(1, Math.min(6, Number(process.env.ENTITY_RENDER_SUPERSAMPLE || 4)));
const INTERNAL_SIZE = RENDER_SIZE * SUPERSAMPLE;
const PADDING = Number(process.env.ENTITY_RENDER_PADDING || 0.12);
const SHEET_CELL_SIZE = Number(process.env.ENTITY_RENDER_SHEET_CELL_SIZE || 256);
const SHEET_GAP = Number(process.env.ENTITY_RENDER_SHEET_GAP || 24);

// Camera is object-space position relative to the model center.
// Minecraft/Blockbench OBJs use Y-up. For these exported models, the front is
// the negative Z side. This camera views from above + front + left, matching the
// reference style: a clean isometric render with the face readable and angled
// toward the lower-left side of the final image.
const DEFAULT_CAMERA = {
  x: Number(process.env.ENTITY_RENDER_CAMERA_X || -1.0),
  y: Number(process.env.ENTITY_RENDER_CAMERA_Y || 0.72),
  z: Number(process.env.ENTITY_RENDER_CAMERA_Z || -1.0)
};

const ENTITY_SCALE = {
  cat: 0.92,
  chicken: 0.86,
  frog: 0.90,
  pig: 0.92,
  cow: 0.94,
  wolf: 0.92,
  zombie_nautilus: 0.88
};

function logDebug(msg) { if (DEBUG) console.log(`[entity-render-debug] ${msg}`); }
function logVerbose(msg) { if (VERBOSE) console.log(msg); }
function exists(file) { try { return fs.existsSync(file); } catch { return false; } }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function normalizeId(id) { return String(id || '').replace(/^#/, '').trim(); }
function idNamespace(id) { const s = normalizeId(id); return s.includes(':') ? s.split(':')[0] : 'minecraft'; }
function idPath(id) { const s = normalizeId(id); return s.includes(':') ? s.split(':').slice(1).join(':') : s; }
function stripNamespace(id) { return idPath(id).split('/').pop(); }
function variantNameFromFile(file) { return path.basename(file, '.json').replace(/[^a-zA-Z0-9._-]+/g, '_').toLowerCase(); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function dot(a, b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross(a, b) { return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x }; }
function sub(a, b) { return { x: a.x-b.x, y: a.y-b.y, z: a.z-b.z }; }
function add(a, b) { return { x: a.x+b.x, y: a.y+b.y, z: a.z+b.z }; }
function mul(a, s) { return { x: a.x*s, y: a.y*s, z: a.z*s }; }
function len(a) { return Math.sqrt(dot(a, a)) || 1; }
function norm(a) { const l = len(a); return { x: a.x/l, y: a.y/l, z: a.z/l }; }
function snapToGrid(n, grid = 16) { return Math.round(n * grid) / grid; }
function triNormal3D(tri) { return norm(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))); }
function triArea3D(tri) { return len(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))) / 2; }

function resolveMinecraftVersion() {
  const releaseFile = 'release_infos.yml';
  if (!exists(releaseFile)) return process.env.MINECRAFT_VERSION || '26.1.2';
  const raw = yaml.load(fs.readFileSync(releaseFile, 'utf8'));
  const candidates = [];
  function walk(v) {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v);
      if (/^\d+\.\d+(\.\d+)?([-.]pre\d+|[-.]rc\d+)?$/.test(s)) candidates.push(s);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') Object.values(v).forEach(walk);
  }
  walk(raw);
  const preferred = candidates.filter(v => /^\d{2}\.\d+(\.\d+)?/.test(v));
  const vMappings = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', 'version-mappings.yml'), 'utf8'));
  const result = process.env.MINECRAFT_VERSION || preferred.at(-1) || candidates.at(-1) || vMappings.latest;
  console.log(`Using Minecraft ${result} from release_infos.yml`);
  return result;
}

function firstPresent(obj, keys) {
  for (const key of keys) if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  return null;
}

function extractModelKey(json, type) {
  const value = firstPresent(json, ['model', 'model_id', 'variant_model']) || 'default';
  return String(value).replace(/^minecraft:/, '').replace(`${type}/`, '') || 'default';
}

function extractAdultAssetId(json, type) {
  if (type === 'wolf') {
    return firstPresent(json?.assets, ['wild', 'tame', 'angry']) || firstPresent(json, [
      'asset_id', 'texture', 'texture_id', 'wild_texture', 'wild_asset_id', 'wild_texture_id',
      'tame_texture', 'tame_asset_id', 'tame_texture_id', 'angry_texture', 'angry_asset_id', 'angry_texture_id'
    ]);
  }
  return firstPresent(json, ['asset_id', 'texture', 'texture_id', 'adult_asset_id', 'adult_texture', 'adult_texture_id']);
}

function extractBabyAssetId(json, type) {
  if (type === 'wolf') {
    return firstPresent(json?.baby_assets, ['wild', 'tame', 'angry']) || firstPresent(json, [
      'baby_asset_id', 'baby_texture', 'baby_texture_id', 'baby_wild_texture', 'baby_wild_asset_id',
      'baby_wild_texture_id', 'wild_baby_texture', 'wild_baby_asset_id', 'wild_baby_texture_id'
    ]);
  }
  return firstPresent(json, ['baby_asset_id', 'baby_texture', 'baby_texture_id']);
}

function findVariantFiles(entityType) {
  const out = [];
  if (!exists('data')) return out;
  for (const ns of fs.readdirSync('data')) {
    const dir = path.join('data', ns, `${entityType}_variant`);
    if (!exists(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) out.push({ namespace: ns, file: path.join(dir, name) });
  }
  return out;
}

function textureCandidatesFromAssetId(assetId, entityType, age) {
  const ns = idNamespace(assetId);
  const p = idPath(assetId);
  const base = path.join('assets', ns, 'textures');
  const leaf = stripNamespace(assetId).replace(/\.png$/, '');
  return [...new Set([
    path.join(base, 'entity', `${p}.png`),
    path.join(base, 'entity', entityType, `${leaf}.png`),
    path.join(base, 'entity', entityType, `${leaf}_${age}.png`),
    path.join(base, 'entity', entityType, `${entityType}_${leaf}.png`),
    path.join(base, 'entity', entityType, `${entityType}_${leaf}_${age}.png`)
  ])];
}

function resolveTexture(assetId, entityType, age) {
  if (!assetId) return null;
  for (const candidate of textureCandidatesFromAssetId(assetId, entityType, age)) if (exists(candidate)) return candidate;
  const ns = idNamespace(assetId);
  const leaf = stripNamespace(assetId).replace(/\.png$/, '');
  const root = path.join('assets', ns, 'textures', 'entity');
  if (!exists(root)) return null;
  const found = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.png') && (name === `${leaf}.png` || name.includes(leaf))) found.push(p);
    }
  }
  walk(root);
  const exactAge = found.find(p => age === 'baby' ? /baby/.test(path.basename(p)) : !/baby/.test(path.basename(p)));
  return exactAge || found[0] || null;
}

function discoverVariants() {
  const variants = [];
  for (const type of ENTITY_TYPES) {
    for (const { namespace, file } of findVariantFiles(type)) {
      const json = readJson(file);
      const variant = variantNameFromFile(file);
      const model = extractModelKey(json, type);
      const assetId = extractAdultAssetId(json, type);
      const babyAssetId = extractBabyAssetId(json, type);
      const adultTexture = resolveTexture(assetId, type, 'adult');
      const babyTexture = babyAssetId ? resolveTexture(babyAssetId, type, 'baby') : (HAS_BABY_MODEL.has(type) ? adultTexture : null);
      variants.push({ namespace, type, variant, file, model, assetId, babyAssetId, adultTexture, babyTexture });
    }
  }
  return variants;
}

function objModelKey(model) {
  const key = String(model || 'regular').replace(/^minecraft:/, '').split('/').pop();
  return (!key || key === 'default') ? 'regular' : key;
}

function resolveObjModel(type, model, age) {
  const dir = path.join(ENTITY_MODEL_ROOT, type);
  const key = objModelKey(model);
  const candidates = [path.join(dir, `${age}_${key}.obj`), path.join(dir, `${age}_regular.obj`)];
  if (age === 'baby') candidates.push(path.join(dir, `adult_${key}.obj`), path.join(dir, 'adult_regular.obj'));
  for (const candidate of [...new Set(candidates)]) if (exists(candidate)) return { file: candidate, requested: key, resolved: path.basename(candidate, '.obj') };
  return { file: null, requested: key, resolved: null, candidates: [...new Set(candidates)] };
}

function ensureObjModelsReady() {
  if (!exists(ENTITY_MODEL_ROOT)) throw new Error(`OBJ model folder not found: ${ENTITY_MODEL_ROOT}`);
  for (const type of ENTITY_TYPES) {
    const regular = path.join(ENTITY_MODEL_ROOT, type, 'adult_regular.obj');
    if (!exists(regular)) throw new Error(`Missing required fallback OBJ model: ${regular}`);
  }
  console.log(`Using checked-in OBJ entity models from ${ENTITY_MODEL_ROOT}`);
}

function loadPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

function parseObjFile(objFile, entityType) {
  const lines = fs.readFileSync(objFile, 'utf8').split(/\r?\n/);
  const pos = [null];
  const uv = [null];
  const tris = [];
  let objectIndex = 0;
  let currentObject = `0:root`;
  const objectBounds = new Map();
  // Bedrock-style flat planes are valid geometry, not helper meshes.
  // They are handled face-by-face so both triangles of the visible face survive.
  function touchObject(name) {
    if (!objectBounds.has(name)) objectBounds.set(name, { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity, verts: 0 });
    return objectBounds.get(name);
  }
  function rememberVertex(obj, v) {
    const b = touchObject(obj);
    b.minX = Math.min(b.minX, v.x); b.maxX = Math.max(b.maxX, v.x);
    b.minY = Math.min(b.minY, v.y); b.maxY = Math.max(b.maxY, v.y);
    b.minZ = Math.min(b.minZ, v.z); b.maxZ = Math.max(b.maxZ, v.z);
    b.verts++;
  }
  function objectBaseName(obj) {
    return String(obj || '').replace(/^\d+:/, '');
  }
  function flatObjectInfo(obj) {
    const b = objectBounds.get(obj);
    if (!b || b.verts < 3) return null;
    const spans = [b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ];
    const minSpan = Math.min(...spans);
    const axis = spans.indexOf(minSpan);
    if (minSpan > 1e-5) return null;
    // Require meaningful area in the other two axes. This catches Blockbench's
    // zero-thickness voxel planes while ignoring degenerate OBJ side faces.
    const other = spans.filter((_, i) => i !== axis);
    if (other[0] < 1e-5 || other[1] < 1e-5) return null;
    return { axis, spans };
  }

  function shouldSkipHelperObject(obj) {
    // Some entity exports contain alternate animation/helper parts. They are
    // not part of the default pose and should never be drawn.
    if (entityType === 'frog') {
      const baseName = objectBaseName(obj);
      if (baseName === 'croaking_body' || baseName === 'tongue') return true;
    }
    return false;
  }

  function frogLimbFootPlaneInfo(tri, obj) {
    if (entityType !== 'frog') return null;
    const baseName = objectBaseName(obj);
    if (!['left_arm', 'right_arm', 'left_leg', 'right_leg'].includes(baseName)) return null;

    const xs = tri.map(v => v.x), ys = tri.map(v => v.y), zs = tri.map(v => v.z);
    const spans = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)];

    // Frog OBJ limb objects contain two pieces: a normal small cuboid and a
    // zero-height webbed foot pad. Object-level flat detection misses these
    // because both pieces are stored under the same object name. Detect the
    // large horizontal zero-height pad per triangle instead.
    if (spans[1] > 1e-5) return null;
    if (spans[0] < 0.35 || spans[2] < 0.35) return null;
    if (triArea3D(tri) < 1e-10) return { keep: false };

    const n = triNormal3D(tri);
    if (Math.abs(n.y) < 0.9) return null;

    // The zero-height pad exports both coincident sides. Keep only the side
    // facing the preview camera, otherwise the two UV sheets blend into the
    // orange/brown "melted cheese" artifact under every frog variant.
    const camera = buildCamera();
    if (dot(n, camera.forward) < -1e-6) return { keep: false };

    for (const v of tri) {
      v.x = snapToGrid(v.x); v.y = snapToGrid(v.y); v.z = snapToGrid(v.z);
    }
    return { keep: true, voxelPlane: true, flatAxis: 1, frogFootPlane: true };
  }

  function prepareFlatVoxelPlaneTriangle(tri, obj) {
    const info = flatObjectInfo(obj);
    if (!info) return { keep: true, voxelPlane: false };

    // Frog OBJ exports include flat body/head sheets in addition to the real
    // cuboids. Those are texture-layout/helper sheets, not feet, and they are
    // what create the orange/green "carpet" under the frog. Keep only the
    // intentional flat limb pads.
    if (entityType === 'frog') {
      const baseName = objectBaseName(obj);
      if (baseName === 'body' || baseName === 'head') return { keep: false, voxelPlane: true };
    }

    const area = triArea3D(tri);
    if (area < 1e-10) return { keep: false, voxelPlane: true };

    const n = triNormal3D(tri);
    const axisValue = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)][info.axis];
    if (axisValue < 0.9) return { keep: false, voxelPlane: true };

    // Bedrock-style zero-thickness cubes export a front and a back face on the
    // same plane. Do not dedupe the whole object: each visible face still needs
    // both triangles, and the two sides can legitimately use different UVs.
    // Render only the camera-facing side to avoid z-fighting/texture carpets.
    const camera = buildCamera();
    if (dot(n, camera.forward) < -1e-6) return { keep: false, voxelPlane: true };

    for (const v of tri) {
      v.x = snapToGrid(v.x); v.y = snapToGrid(v.y); v.z = snapToGrid(v.z);
    }
    return { keep: true, voxelPlane: true, flatAxis: info.axis };
  }
  function parseIndex(token, len) {
    const n = Number(token);
    if (!Number.isFinite(n) || n === 0) return null;
    return n < 0 ? len + n : n;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split(/\s+/);
    if (p[0] === 'o') {
      currentObject = `${++objectIndex}:${p.slice(1).join(' ') || 'object'}`;
      touchObject(currentObject);
    }
    else if (p[0] === 'v' && p.length >= 4) {
      const v = { x: Number(p[1]), y: Number(p[2]), z: Number(p[3]), object: currentObject };
      pos.push(v);
      rememberVertex(currentObject, v);
    }
    else if (p[0] === 'vt' && p.length >= 3) uv.push({ u: Number(p[1]), v: Number(p[2]) });
    else if (p[0] === 'f' && p.length >= 4) {
      const verts = p.slice(1).map(tok => {
        const [viRaw, vtiRaw] = tok.split('/');
        const vi = parseIndex(viRaw, pos.length);
        const vti = vtiRaw ? parseIndex(vtiRaw, uv.length) : null;
        if (vi == null || !pos[vi]) return null;
        const t = vti != null && uv[vti] ? uv[vti] : { u: 0, v: 0 };
        return { ...pos[vi], u: t.u, v: t.v, object: pos[vi].object || currentObject };
      }).filter(Boolean);
      for (let i = 1; i < verts.length - 1; i++) {
        const tri = [verts[0], verts[i], verts[i + 1]];
        const obj = tri[0].object;
        if (obj && tri.every(v => v.object === obj) && shouldSkipHelperObject(obj)) continue;
        if (obj && tri.every(v => v.object === obj)) {
          // Frog foot pads are zero-height planes embedded inside the arm/leg
          // objects, so they need to be detected before the generic object-level
          // flat-plane handling. Otherwise they inherit the wrong UV mode or get
          // treated like regular cuboid side faces.
          const frogFoot = frogLimbFootPlaneInfo(tri, obj);
          const prepared = frogFoot || prepareFlatVoxelPlaneTriangle(tri, obj);
          if (!prepared.keep) continue;
          tri.voxelPlane = prepared.voxelPlane;
          tri.flatAxis = prepared.flatAxis;
          tri.frogFootPlane = !!prepared.frogFootPlane;
        }
        if (triArea3D(tri) < 1e-10) continue;
        tri.object = obj || currentObject;
        tris.push(tri);
      }
    }
  }
  if (!tris.length) throw new Error(`OBJ model has no renderable faces: ${objFile}`);
  return tris;
}


function uvStatsOfTriangles(tris) {
  const s = { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity };
  for (const tri of tris) for (const p of tri) {
    s.minU = Math.min(s.minU, p.u); s.maxU = Math.max(s.maxU, p.u);
    s.minV = Math.min(s.minV, p.v); s.maxV = Math.max(s.maxV, p.v);
  }
  return s;
}

function normalizeUvForTexture(u, v, options, tex) {
  // Some checked-in OBJ files are exported against a smaller UV canvas than
  // the actual PNG size used by the resource pack. Frogs are authored on the
  // vanilla 48x48 frog UV sheet, while variant textures may be padded/larger.
  // Convert OBJ UV-canvas coordinates into the real texture's normalized space
  // before applying the OBJ(bottom-left) -> PNG(top-left) V flip.
  if (options.textureUvWidth && tex?.width) u *= options.textureUvWidth / tex.width;
  if (options.textureUvHeight && tex?.height) v *= options.textureUvHeight / tex.height;

  if (options.flipU) u = 1 - u;
  let effectiveFlipV = options.voxelPlane && options.voxelPlaneFlipV !== undefined ? options.voxelPlaneFlipV : options.flipV;
  if (options.frogFootPlane && options.frogFootPlaneFlipV !== undefined) effectiveFlipV = options.frogFootPlaneFlipV;
  if (effectiveFlipV) v = 1 - v;

  // Most models tolerate wrapping small out-of-range OBJ UVs. Frogs do not:
  // wrapping their padded vanilla-sheet UVs pulls colors from the opposite side
  // of the skin and creates the orange 'texture floor' artifact.
  if (options.wrapOutOfRange !== false) {
    if (u < 0 || u > 1) u = ((u % 1) + 1) % 1;
    if (v < 0 || v > 1) v = ((v % 1) + 1) % 1;
  }
  return { u: clamp(u, 0, 1), v: clamp(v, 0, 1) };
}

function boundsOfTriangles(tris) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const tri of tris) for (const p of tri) {
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
    b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
  }
  return b;
}

function buildCamera() {
  const forward = norm(DEFAULT_CAMERA); // object -> camera
  let right = cross({ x: 0, y: 1, z: 0 }, forward);
  if (len(right) < 1e-6) right = { x: 1, y: 0, z: 0 };
  right = norm(right);
  const up = norm(cross(forward, right));
  return { forward, right, up };
}

function transformTriangles(tris, type) {
  const b = boundsOfTriangles(tris);
  const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
  const camera = buildCamera();
  const out = [];
  let minSX = Infinity, minSY = Infinity, maxSX = -Infinity, maxSY = -Infinity;
  for (const tri of tris) {
    const world = tri.map(p => ({ x: p.x - center.x, y: p.y - center.y, z: p.z - center.z, u: p.u, v: p.v }));
    const e1 = sub(world[1], world[0]);
    const e2 = sub(world[2], world[0]);
    let n = norm(cross(e1, e2));
    // If winding is inverted for a face, keep it; z-buffer will resolve. The
    // normal is only used for subtle lighting, not culling, so all OBJ exports
    // remain visible even if their winding differs.
    const projected = world.map(p => {
      const sx = dot(p, camera.right);
      const sy = dot(p, camera.up);
      const depth = dot(p, camera.forward);
      minSX = Math.min(minSX, sx); maxSX = Math.max(maxSX, sx);
      minSY = Math.min(minSY, sy); maxSY = Math.max(maxSY, sy);
      return { sx, sy, depth, u: p.u, v: p.v, world: p };
    });
    const light = clamp(0.72 + 0.28 * Math.max(0, dot(n, norm({ x: -0.4, y: 0.9, z: -0.6 }))), 0.72, 1.0);
    out.push({ p: projected, light, object: tri.object || '', voxelPlane: !!tri.voxelPlane, frogFootPlane: !!tri.frogFootPlane });
  }
  const spanX = Math.max(0.001, maxSX - minSX);
  const spanY = Math.max(0.001, maxSY - minSY);
  const entityScale = ENTITY_SCALE[type] || 0.9;
  const scale = INTERNAL_SIZE * (1 - PADDING * 2) * entityScale / Math.max(spanX, spanY);
  const cx = (minSX + maxSX) / 2;
  const cy = (minSY + maxSY) / 2;
  for (const tri of out) for (const p of tri.p) {
    p.x = INTERNAL_SIZE / 2 + (p.sx - cx) * scale;
    p.y = INTERNAL_SIZE / 2 - (p.sy - cy) * scale;
  }
  return out;
}

function sampleTexture(tex, uNorm, vNorm, options) {
  const uv = normalizeUvForTexture(uNorm, vNorm, options, tex);
  const x = clamp(Math.floor(uv.u * tex.width), 0, tex.width - 1);
  const y = clamp(Math.floor(uv.v * tex.height), 0, tex.height - 1);
  const read = (px, py) => {
    const i = (py * tex.width + px) * 4;
    return [tex.data[i], tex.data[i + 1], tex.data[i + 2], tex.data[i + 3]];
  };
  let c = read(x, y);
  if (c[3] > 8 || !options?.transparentSearchRadius) return c;

  // Preserve alpha exactly. Frog foot pads intentionally map to rectangular
  // UV regions with transparent pixels inside them; filling nearby opaque
  // pixels turns those pads into smeared solid rectangles.
  const radius = Math.max(1, Math.min(6, options.transparentSearchRadius));
  let best = null;
  let bestD = Infinity;
  for (let r = 1; r <= radius; r++) {
    for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
      if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
      const px = clamp(x + ox, 0, tex.width - 1);
      const py = clamp(y + oy, 0, tex.height - 1);
      const cc = read(px, py);
      if (cc[3] <= 8) continue;
      const d = ox * ox + oy * oy;
      if (d < bestD) { best = cc; bestD = d; }
    }
    if (best) return best;
  }
  return c;
}

function edge(ax, ay, bx, by, cx, cy) { return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax); }

function rasterTriangle(color, depth, tri, tex, uvOptions) {
  const [a, b, c] = tri.p;
  const area = edge(a.x, a.y, b.x, b.y, c.x, c.y);
  if (Math.abs(area) < 1e-8) return 0;
  const minX = clamp(Math.floor(Math.min(a.x, b.x, c.x)) - 1, 0, INTERNAL_SIZE - 1);
  const maxX = clamp(Math.ceil(Math.max(a.x, b.x, c.x)) + 1, 0, INTERNAL_SIZE - 1);
  const minY = clamp(Math.floor(Math.min(a.y, b.y, c.y)) - 1, 0, INTERNAL_SIZE - 1);
  const maxY = clamp(Math.ceil(Math.max(a.y, b.y, c.y)) + 1, 0, INTERNAL_SIZE - 1);
  let painted = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = edge(b.x, b.y, c.x, c.y, px, py) / area;
      const w1 = edge(c.x, c.y, a.x, a.y, px, py) / area;
      const w2 = edge(a.x, a.y, b.x, b.y, px, py) / area;
      if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;
      const z = w0 * a.depth + w1 * b.depth + w2 * c.depth;
      const di = y * INTERNAL_SIZE + x;
      const zBiased = z + (tri.voxelPlane ? 1e-5 : 0);
      if (zBiased <= depth[di] + 1e-7) continue;
      const u = w0 * a.u + w1 * b.u + w2 * c.u;
      const v = w0 * a.v + w1 * b.v + w2 * c.v;
      let [r, g, bl, alpha] = sampleTexture(tex, u, v, { ...uvOptions, object: tri.object || '', voxelPlane: !!tri.voxelPlane, frogFootPlane: !!tri.frogFootPlane });
      if (alpha <= 8) continue;
      const shade = tri.voxelPlane ? Math.max(0.86, tri.light) : tri.light;
      r = clamp(Math.round(r * shade), 0, 255);
      g = clamp(Math.round(g * shade), 0, 255);
      bl = clamp(Math.round(bl * shade), 0, 255);
      const oi = di * 4;
      color[oi] = r; color[oi + 1] = g; color[oi + 2] = bl; color[oi + 3] = alpha;
      depth[di] = zBiased;
      painted++;
    }
  }
  return painted;
}

function visiblePixels(data) {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n++;
  return n;
}

function downsampleBox(src, sw, sh, factor) {
  if (factor <= 1) return { width: sw, height: sh, data: src };
  const dw = Math.floor(sw / factor), dh = Math.floor(sh / factor);
  const out = Buffer.alloc(dw * dh * 4, 0);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = 0; yy < factor; yy++) for (let xx = 0; xx < factor; xx++) {
        const si = ((y * factor + yy) * sw + (x * factor + xx)) * 4;
        const alpha = src[si + 3] / 255;
        r += src[si] * alpha; g += src[si + 1] * alpha; b += src[si + 2] * alpha; a += alpha;
      }
      const samples = factor * factor;
      const oi = (y * dw + x) * 4;
      if (a > 0) {
        out[oi] = Math.round(r / a);
        out[oi + 1] = Math.round(g / a);
        out[oi + 2] = Math.round(b / a);
        out[oi + 3] = Math.round(clamp(a / samples, 0, 1) * 255);
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

function trimTransparent(img, pad) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 8) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return img;
  minX = clamp(minX - pad, 0, width - 1); minY = clamp(minY - pad, 0, height - 1);
  maxX = clamp(maxX + pad, 0, width - 1); maxY = clamp(maxY + pad, 0, height - 1);
  const tw = maxX - minX + 1, th = maxY - minY + 1;
  const out = Buffer.alloc(tw * th * 4, 0);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const si = ((minY + y) * width + (minX + x)) * 4;
    const oi = (y * tw + x) * 4;
    data.copy(out, oi, si, si + 4);
  }
  return { width: tw, height: th, data: out };
}

function containToSquare(img, size) {
  const scale = Math.min(size / img.width, size / img.height);
  const nw = Math.max(1, Math.round(img.width * scale));
  const nh = Math.max(1, Math.round(img.height * scale));
  const resized = Buffer.alloc(nw * nh * 4, 0);
  // Bilinear resize for antialiased silhouette; source is already downsampled.
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const sy = (y + 0.5) / scale - 0.5;
      const x0 = clamp(Math.floor(sx), 0, img.width - 1), y0 = clamp(Math.floor(sy), 0, img.height - 1);
      const x1 = clamp(x0 + 1, 0, img.width - 1), y1 = clamp(y0 + 1, 0, img.height - 1);
      const tx = sx - x0, ty = sy - y0;
      const acc = [0, 0, 0, 0];
      for (const [ix, iy, w] of [[x0,y0,(1-tx)*(1-ty)], [x1,y0,tx*(1-ty)], [x0,y1,(1-tx)*ty], [x1,y1,tx*ty]]) {
        const si = (iy * img.width + ix) * 4;
        for (let c = 0; c < 4; c++) acc[c] += img.data[si + c] * w;
      }
      const oi = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) resized[oi + c] = Math.round(acc[c]);
    }
  }
  const out = Buffer.alloc(size * size * 4, 0);
  const ox = Math.floor((size - nw) / 2);
  const oy = Math.floor((size - nh) / 2);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const si = (y * nw + x) * 4;
    const oi = ((oy + y) * size + (ox + x)) * 4;
    resized.copy(out, oi, si, si + 4);
  }
  return { width: size, height: size, data: out };
}


function resizeImageBilinear(img, nw, nh) {
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  const out = Buffer.alloc(nw * nh * 4, 0);
  const sxRatio = img.width / nw;
  const syRatio = img.height / nh;
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * syRatio - 0.5;
    const y0 = clamp(Math.floor(sy), 0, img.height - 1);
    const y1 = clamp(y0 + 1, 0, img.height - 1);
    const ty = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * sxRatio - 0.5;
      const x0 = clamp(Math.floor(sx), 0, img.width - 1);
      const x1 = clamp(x0 + 1, 0, img.width - 1);
      const tx = sx - x0;
      const acc = [0, 0, 0, 0];
      for (const [ix, iy, w] of [[x0,y0,(1-tx)*(1-ty)], [x1,y0,tx*(1-ty)], [x0,y1,(1-tx)*ty], [x1,y1,tx*ty]]) {
        const si = (iy * img.width + ix) * 4;
        for (let c = 0; c < 4; c++) acc[c] += img.data[si + c] * w;
      }
      const oi = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) out[oi + c] = Math.round(acc[c]);
    }
  }
  return { width: nw, height: nh, data: out };
}

function writeVariantSheet(type, age, entries) {
  const valid = entries
    .filter(e => e && e.output && exists(e.output))
    .sort((a, b) => a.variant.localeCompare(b.variant));
  if (!valid.length) return false;

  const cell = Math.max(32, SHEET_CELL_SIZE);
  const gap = Math.max(0, SHEET_GAP);
  const maxPerRow = 10;
  const columns = Math.min(valid.length, maxPerRow);
  const rows = Math.ceil(valid.length / maxPerRow);
  const width = columns * cell + Math.max(0, columns - 1) * gap;
  const height = rows * cell + Math.max(0, rows - 1) * gap;
  const canvas = Buffer.alloc(width * height * 4, 0);

  valid.forEach((entry, index) => {
    const src = loadPng(entry.output);
    const trimmed = trimTransparent(src, Math.round(src.width * 0.035));
    const contained = containToSquare(trimmed, cell);
    const img = contained.width === cell && contained.height === cell ? contained : resizeImageBilinear(contained, cell, cell);
    const col = index % maxPerRow;
    const row = Math.floor(index / maxPerRow);
    const ox = col * (cell + gap);
    const oy = row * (cell + gap);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4;
        const oi = ((oy + y) * width + ox + x) * 4;
        img.data.copy(canvas, oi, si, si + 4);
      }
    }
  });

  const output = path.join(OUTPUT_ROOT, type, `${age}_variants.png`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const png = new PNG({ width, height });
  canvas.copy(png.data);
  fs.writeFileSync(output, PNG.sync.write(png));
  console.log(`Rendered ${valid.length} ${type} ${age} variant(s) into ${output} (${columns} per row max).`);
  return true;
}

function writeVariantSheets(renderedEntries) {
  const byTypeAge = new Map();
  for (const entry of renderedEntries) {
    const key = `${entry.type}\u0000${entry.age}`;
    if (!byTypeAge.has(key)) byTypeAge.set(key, []);
    byTypeAge.get(key).push(entry);
  }
  let count = 0;
  for (const [key, entries] of byTypeAge) {
    const [type, age] = key.split('\u0000');
    if (writeVariantSheet(type, age, entries)) count++;
  }
  if (count) console.log(`Rendered ${count} entity variant overview sheet(s).`);
}

async function renderObjEntity(objFile, textureFile, outputFile, type) {
  const texture = loadPng(textureFile);
  const tris = parseObjFile(objFile, type);
  const projected = transformTriangles(tris, type);
  const uvStats = uvStatsOfTriangles(tris);
  const frogUvOptions = type === 'frog' ? { textureUvWidth: 48, textureUvHeight: 48, wrapOutOfRange: false } : {};
  // Frog helper sheets are filtered out in parseObjFile(), but the real
  // frog foot pads should use the same OBJ(bottom-left) -> PNG(top-left) V flip
  // as the solid limb cuboids. The chicken baby feet need the generic voxel-plane
  // path, so do not apply any entity-wide flat-plane UV override here.
  const voxelPlaneUvOptions = {};
  const preferredFlipV = true;
  const modes = [
    { flipU: false, flipV: preferredFlipV, ...frogUvOptions, ...voxelPlaneUvOptions },
    { flipU: false, flipV: !preferredFlipV, ...frogUvOptions, ...voxelPlaneUvOptions },
    { flipU: true, flipV: preferredFlipV, ...frogUvOptions, ...voxelPlaneUvOptions },
    { flipU: true, flipV: !preferredFlipV, ...frogUvOptions, ...voxelPlaneUvOptions }
  ];
  let best = null;
  for (const mode of modes) {
    const color = Buffer.alloc(INTERNAL_SIZE * INTERNAL_SIZE * 4, 0);
    const depth = new Float32Array(INTERNAL_SIZE * INTERNAL_SIZE);
    depth.fill(-Infinity);
    let painted = 0;
    for (const tri of projected) painted += rasterTriangle(color, depth, tri, texture, mode);
    const visible = visiblePixels(color);
    // Prefer the first mode for ties. Visible-pixel counts are often identical
    // for opaque mob skins, so this avoids random-looking UV flips.
    logDebug(`${path.basename(objFile)} ${path.basename(textureFile)} uv=${JSON.stringify(mode)} uvStats=${JSON.stringify(uvStats)} painted=${painted} visible=${visible}`);
    if (!best || visible > best.visible + 16) best = { color, visible, mode };
  }
  if (!best || best.visible < 20) throw new Error(`OBJ render produced ${best ? best.visible : 0} visible pixels: ${outputFile} model=${objFile} texture=${textureFile}`);

  const low = downsampleBox(best.color, INTERNAL_SIZE, INTERNAL_SIZE, SUPERSAMPLE);
  const trimmed = trimTransparent(low, Math.round(RENDER_SIZE * 0.035));
  const finalImg = containToSquare(trimmed, RENDER_SIZE);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const png = new PNG({ width: finalImg.width, height: finalImg.height });
  finalImg.data.copy(png.data);
  fs.writeFileSync(outputFile, PNG.sync.write(png));
  if (visiblePixels(finalImg.data) < 20) throw new Error(`Rendered PNG is blank/transparent after write: ${outputFile}`);
}

async function main() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  resolveMinecraftVersion();
  const variants = discoverVariants();
  console.log(`Entity render output root: ${OUTPUT_ROOT}`);
  console.log(`Discovered ${variants.length} entity variant JSON file(s).`);
  if (!variants.length) return;
  try { ensureObjModelsReady(); } catch (e) { console.error(e.stack || e); process.exitCode = 1; return; }

  let done = 0;
  let skipped = 0;
  let errors = 0;
  const renderedByDir = new Map();
  const renderedEntries = [];
  for (const v of variants) {
    if (!v.adultTexture) {
      skipped++;
      logVerbose(`Skipping ${v.type}/${v.variant}/adult: no adult texture found for asset_id=${v.assetId || ''}`);
      continue;
    }
    for (const age of ['adult', 'baby']) {
      const texture = age === 'adult' ? v.adultTexture : v.babyTexture;
      if (age === 'baby' && !texture) {
        skipped++;
        logVerbose(`Skipping ${v.type}/${v.variant}/${age}: ${HAS_BABY_MODEL.has(v.type) ? 'no baby/adult fallback texture resolved' : 'entity type has no baby render'}`);
        continue;
      }
      const obj = resolveObjModel(v.type, v.model, age);
      if (!obj.file) {
        errors++;
        console.error(`Failed ${v.type}/${v.variant}/${age}: no OBJ model found; tried ${(obj.candidates || []).join(', ')}`);
        continue;
      }
      const output = path.join(OUTPUT_ROOT, v.type, v.variant, `${age}.png`);
      try {
        logVerbose(`Rendering ${v.type}/${v.variant}/${age} with ${obj.resolved}`);
        await renderObjEntity(obj.file, texture, output, v.type);
        renderedEntries.push({ type: v.type, variant: v.variant, age, output });
        done++;
        const outputDir = path.dirname(output);
        const rec = renderedByDir.get(outputDir) || { count: 0, variant: v.variant };
        rec.count++;
        rec.variant = v.variant;
        renderedByDir.set(outputDir, rec);
      } catch (e) {
        errors++;
        console.error(`Failed ${v.type}/${v.variant}/${age}: ${e.message || e}`);
      }
    }
  }
  writeVariantSheets(renderedEntries);
  for (const [dir, rec] of renderedByDir) {
    console.log(`Rendered ${rec.count} PNG preview(s) in ${dir} for ${rec.variant} variant.`);
  }
  if (!renderedByDir.size) console.log('Rendered 0 PNG preview(s).');
  if (skipped) console.log(`Skipped ${skipped} preview(s).`);
  if (done === 0 || errors) {
    if (errors) console.error(`${errors} entity render error(s).`);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
