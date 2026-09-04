#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const { PNG } = require('pngjs');

let DS = null;
try { DS = require('deepslate'); } catch { /* optional: deepslate gives 3D block rendering */ }

const repoRoot = process.env.SOURCE_REPO_ROOT || process.cwd();
const workflowRoot = process.env.WORKFLOW_ROOT || path.resolve(__dirname, '..', '..');
const outRoot = process.env.ITEM_RENDER_OUTPUT_ROOT ||
  path.join(process.env.WIKI_OUTPUT_ROOT || path.join(repoRoot, 'wiki'), 'images', 'items');
const vanillaRoot = process.env.VANILLA_ASSET_ROOT ||
  path.join(workflowRoot, '.cache', 'vanilla-assets', 'active');
const ICON_SIZE = Number(process.env.ITEM_RENDER_ICON_SIZE || 256);
const CELL = 32;
// Fixed atlas width — UV coordinates are stable regardless of registration order.
// Using a single-row atlas means V is always [0,1]; only U shifts per slot.
const ATLAS_COLS = 32;

// ---- utilities ----
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function stat(p) { try { return fs.statSync(p); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function s(v, fb = '') {
  if (v == null) return fb;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return s(v.id ?? v.value ?? v.item ?? v.tag ?? v.model ?? v.name, fb);
  return fb;
}
function idParts(id, def = 'minecraft') {
  const raw = s(id).replace(/^#/, '');
  const i = raw.indexOf(':');
  return i >= 0 ? [raw.slice(0, i), raw.slice(i + 1)] : [def, raw];
}
function clean(name, ext) {
  return s(name).replace(/\\/g, '/').replace(new RegExp(`${ext.replace('.', '\\.')}$`), '');
}
function findAsset(ns, kind, name, ext = '.json') {
  const c = clean(name, ext);
  const p1 = path.join(repoRoot, 'assets', ns, kind, `${c}${ext}`);
  if (exists(p1)) return p1;
  const p2 = path.join(vanillaRoot, 'assets', ns, kind, `${c}${ext}`);
  return exists(p2) ? p2 : null;
}
function textureFile(id) {
  let [ns, name] = idParts(id);
  name = name.replace(/^textures\//, '').replace(/\.png$/, '');
  return findAsset(ns, 'textures', name, '.png');
}
function walkFiles(dir, ext) {
  if (!exists(dir)) return [];
  const results = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(ext)) results.push(p);
    }
  }
  return results;
}


// ---- mcmeta / animation ----
function readMcmeta(texPath) {
  const p = texPath + '.mcmeta';
  if (!exists(p)) return null;
  const json = readJson(p);
  return json?.animation || null;
}
async function loadTextureTile(texFile) {
  // Load a texture as a CELL×CELL buffer, using only the first animation frame.
  const meta = readMcmeta(texFile);
  if (!meta) {
    return sharp(texFile).ensureAlpha().resize(CELL, CELL, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
  }
  const { width } = await sharp(texFile).metadata();
  const frameH = meta.height || meta.width || width;
  return sharp(texFile).ensureAlpha()
    .extract({ left: 0, top: 0, width, height: frameH })
    .resize(CELL, CELL, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
}

// ---- items definition discovery ----
function discoverItems() {
  const items = [];
  const assetsDir = path.join(repoRoot, 'assets');
  if (!exists(assetsDir)) return items;

  for (const ns of fs.readdirSync(assetsDir)) {
    if (!stat(path.join(assetsDir, ns))?.isDirectory()) continue;
    const itemsDir = path.join(assetsDir, ns, 'items');
    if (!exists(itemsDir)) continue;

    for (const file of walkFiles(itemsDir, '.json')) {
      const rel = path.relative(itemsDir, file).replace(/\.json$/, '').replace(/\\/g, '/');
      items.push({ id: `${ns}:${rel}`, ns, rel, outputName: rel.replace(/\//g, '_'), components: {} });
    }
  }
  return items;
}

// ---- APNG encoding ----
function crc32(buf) {
  let t = crc32._t;
  if (!t) { t = crc32._t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data = Buffer.alloc(0)) {
  const t = Buffer.from(type, 'ascii'), o = Buffer.alloc(12 + data.length);
  o.writeUInt32BE(data.length, 0); t.copy(o, 4); data.copy(o, 8);
  o.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return o;
}
function rawIdat(rgba, w, h) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  return zlib.deflateSync(raw, { level: 9 });
}
function encodeApng(frameBuffers, delayMs = 100) {
  const frames = frameBuffers.map(b => PNG.sync.read(b));
  const width = frames[0].width, height = frames[0].height;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunks = [sig, pngChunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4);
  chunks.push(pngChunk('acTL', actl));
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(seq++, 0); fc.writeUInt32BE(width, 4); fc.writeUInt32BE(height, 8);
    fc.writeUInt32BE(0, 12); fc.writeUInt32BE(0, 16);
    fc.writeUInt16BE(delayMs, 20); fc.writeUInt16BE(1000, 22); fc[24] = 0; fc[25] = 0;
    chunks.push(pngChunk('fcTL', fc));
    const comp = rawIdat(frames[i].data, width, height);
    if (i === 0) chunks.push(pngChunk('IDAT', comp));
    else { const fd = Buffer.alloc(4 + comp.length); fd.writeUInt32BE(seq++, 0); comp.copy(fd, 4); chunks.push(pngChunk('fdAT', fd)); }
  }
  chunks.push(pngChunk('IEND'));
  return Buffer.concat(chunks);
}

// Normalize Blockbench-exported block model JSON to standard Minecraft format.
// Blockbench (for MC 1.21.11+) emits multi-axis rotation {"x":0,"y":-90,"z":0,"origin":[…]}
// instead of the single-axis form {"angle":-90,"axis":"y","origin":[…]} that deepslate expects.
function normalizeBlockModelJson(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const m = Object.assign({}, obj);
  delete m.format_version; delete m.credit;
  if (Array.isArray(m.elements)) {
    m.elements = m.elements.map(el => {
      const e = Object.assign({}, el);
      const r = e.rotation;
      if (r && typeof r === 'object' && ('x' in r || 'y' in r || 'z' in r) && !('axis' in r)) {
        let axis = 'y', angle = 0;
        for (const a of ['x', 'y', 'z']) {
          if (r[a] != null && Math.abs(r[a]) > Math.abs(angle)) { axis = a; angle = r[a]; }
        }
        e.rotation = { angle, axis, origin: r.origin || [8, 8, 8] };
      }
      return e;
    });
  }
  return m;
}

// ---- deepslate Resources ----
class Resources {
  constructor() {
    this.blockModels = new Map(); this.itemModels = new Map();
    this.texMap = new Map(); this.texList = []; this.atlasPng = null;
  }
  getItemComponents(id) {
    return DS ? new Map([['minecraft:item_model', new DS.NbtString(id.toString())]]) : new Map();
  }
  getItemModel(id) {
    const key = id.toString();
    if (this.itemModels.has(key)) return this.itemModels.get(key);
    const [ns, name] = idParts(key);
    const file = findAsset(ns, 'items', name, '.json');
    const obj = file ? readJson(file) : null;
    let model;
    try { model = DS.ItemModel.fromJson(obj?.model ?? { type: 'minecraft:model', model: `${ns}:item/${name}` }); }
    catch {
      // fromJson failed (e.g. unsupported model type like minecraft:condition with block_state).
      // Extract the primary block model ref from the items JSON and fall back to a direct model reference.
      const blockRefs = obj?.model ? collectFlatModelRefs(obj.model, ns) : null;
      const blockModelRef = blockRefs?.[0]?.modelRef;
      try { model = DS.ItemModel.fromJson(blockModelRef
        ? { type: 'minecraft:model', model: blockModelRef }
        : { type: 'minecraft:model', model: `${ns}:item/${name}` }); }
      catch { model = DS.ItemModel.fromJson({ type: 'minecraft:model', model: `${ns}:item/${name}` }); }
    }
    this.itemModels.set(key, model);
    return model;
  }
  getBlockModel(id) {
    const key = id.toString();
    if (this.blockModels.has(key)) return this.blockModels.get(key);
    const [ns, name] = idParts(key);
    let obj = null;
    if (key === 'minecraft:item/generated') obj = { parent: 'builtin/generated' };
    else if (key === 'minecraft:item/handheld') obj = { parent: 'minecraft:item/generated' };
    else { const f = findAsset(ns, 'models', name, '.json'); obj = f ? normalizeBlockModelJson(readJson(f)) : null; }
    if (!obj) { this.blockModels.set(key, null); return null; }
    let m;
    try { m = DS.BlockModel.fromJson(obj); } catch { this.blockModels.set(key, null); return null; }
    this.blockModels.set(key, m);
    try { m.flatten(this); } catch { }
    return m;
  }
  getTextureUV(id) {
    const key = id.toString();
    if (!this.texMap.has(key)) {
      const file = textureFile(key);
      const idx = this.texList.length;
      this.texMap.set(key, { idx, file, key });
      this.texList.push({ idx, file, key });
    }
    const rec = this.texMap.get(key);
    return [rec.idx / ATLAS_COLS, 0, (rec.idx + 1) / ATLAS_COLS, 1];
  }
  getPixelSize() { return 1 / CELL; }
  async buildAtlas() {
    if (!this.texList.length) return null;
    const base = sharp({ create: { width: ATLAS_COLS * CELL, height: CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    const comps = [];
    for (const t of this.texList) {
      const input = (t.file && exists(t.file)) ? await loadTextureTile(t.file) : await missingTexture();
      comps.push({ input, left: t.idx * CELL, top: 0 });
    }
    this.atlasPng = PNG.sync.read(await base.composite(comps).png().toBuffer());
    return this.atlasPng;
  }
  getTextureAtlas() { return null; }
}

async function missingTexture() {
  return sharp({ create: { width: CELL, height: CELL, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 255 } } }).png().toBuffer();
}

// ---- software rasterizer ----
function sample(tex, u, v, tl) {
  if (tl) { u = Math.max(tl[0], Math.min(tl[2], u)); v = Math.max(tl[1], Math.min(tl[3], v)); }
  const x = Math.max(0, Math.min(tex.width - 1, Math.floor(u * tex.width)));
  const y = Math.max(0, Math.min(tex.height - 1, Math.floor(v * tex.height)));
  const i = (y * tex.width + x) * 4;
  return [tex.data[i], tex.data[i + 1], tex.data[i + 2], tex.data[i + 3]];
}
function blend(dst, zbuf, x, y, z, c) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= dst.width || y >= dst.height || c[3] <= 0) return;
  const zi = y * dst.width + x;
  if (z < zbuf[zi]) return;
  zbuf[zi] = z;
  const i = zi * 4, sa = c[3] / 255, da = dst.data[i + 3] / 255, oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  dst.data[i]     = Math.round((c[0] * sa + dst.data[i]     * da * (1 - sa)) / oa);
  dst.data[i + 1] = Math.round((c[1] * sa + dst.data[i + 1] * da * (1 - sa)) / oa);
  dst.data[i + 2] = Math.round((c[2] * sa + dst.data[i + 2] * da * (1 - sa)) / oa);
  dst.data[i + 3] = Math.round(oa * 255);
}
function triRaster(dst, zbuf, atlas, a, b, c, ta, tb, tc, tla, tlb, tlc, ca, cb, cc) {
  const minX = Math.floor(Math.min(a[0], b[0], c[0])), maxX = Math.ceil(Math.max(a[0], b[0], c[0]));
  const minY = Math.floor(Math.min(a[1], b[1], c[1])), maxY = Math.ceil(Math.max(a[1], b[1], c[1]));
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(den) < 1e-6) return;
  const tl = (tla && tlb && tlc)
    ? [(tla[0]+tlb[0]+tlc[0])/3, (tla[1]+tlb[1]+tlc[1])/3, (tla[2]+tlb[2]+tlc[2])/3, (tla[3]+tlb[3]+tlc[3])/3]
    : null;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const w1 = ((b[1]-c[1])*(x+.5-c[0])+(c[0]-b[0])*(y+.5-c[1]))/den;
    const w2 = ((c[1]-a[1])*(x+.5-c[0])+(a[0]-c[0])*(y+.5-c[1]))/den;
    const w3 = 1-w1-w2;
    if (w1 >= -0.001 && w2 >= -0.001 && w3 >= -0.001) {
      const u = w1*ta[0]+w2*tb[0]+w3*tc[0], v = w1*ta[1]+w2*tb[1]+w3*tc[1];
      const z = w1*a[2]+w2*b[2]+w3*c[2];
      const px = sample(atlas, u, v, tl);
      blend(dst, zbuf, x, y, z, [
        Math.round(px[0]*(w1*ca[0]+w2*cb[0]+w3*cc[0])),
        Math.round(px[1]*(w1*ca[1]+w2*cb[1]+w3*cc[1])),
        Math.round(px[2]*(w1*ca[2]+w2*cb[2]+w3*cc[2])),
        px[3]
      ]);
    }
  }
}
function rasterMesh(mesh, atlas, size = ICON_SIZE) {
  const dst = new PNG({ width: size, height: size });
  const zbuf = new Float32Array(size * size).fill(-1e9);
  let qi = 0;
  for (const q of mesh.quads) {
    const vs = q.vertices();
    // Tiny sequential Z bias prevents co-planar z-fighting between overlapping face sets
    // (e.g. inside/outside of a container block model).
    const bias = qi++ * 1e-5;
    const pts = vs.map(v => [v.pos.x * size / 16, (16 - v.pos.y) * size / 16, v.pos.z + bias]);
    const tex = vs.map(v => v.texture || [0, 0]);
    const tl  = vs.map(v => v.textureLimit || null);
    const col = vs.map(v => v.color || [1, 1, 1]);
    triRaster(dst, zbuf, atlas, pts[0], pts[1], pts[2], tex[0], tex[1], tex[2], tl[0], tl[1], tl[2], col[0], col[1], col[2]);
    triRaster(dst, zbuf, atlas, pts[0], pts[2], pts[3], tex[0], tex[2], tex[3], tl[0], tl[2], tl[3], col[0], col[2], col[3]);
  }
  return PNG.sync.write(dst);
}
async function normalize(buf, size = ICON_SIZE) {
  let trimmed = buf;
  try { trimmed = await sharp(buf).ensureAlpha().trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 }).png().toBuffer(); } catch { }
  const resized = await sharp(trimmed).resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, gravity: 'center' }]).png().toBuffer();
}

// ---- flat (2D sprite) renderer with animation support ----
function resolveTextureRef(ref, textures, ns) {
  let v = s(ref); let guard = 0;
  while (v.startsWith('#') && guard++ < 32) v = s(textures[v.slice(1)]);
  return v ? textureFile(v.includes(':') ? v : `${ns}:${v}`) : null;
}

// Walk a block model's resolved texture map and return the path to the first usable texture.
// Tries common semantic keys first (all → texture → side → …) before falling back to any key.
function extractFirstBlockTexture(modelId) {
  const chain = resolveModelChain(modelId);
  if (!chain) return null;
  const textures = chain.textures || {};
  const PREF = ['all', 'texture', 'side', 'top', 'front', 'bottom', 'back', 'north', 'east', 'south', 'west'];
  const order = [...PREF, ...Object.keys(textures).filter(k => !PREF.includes(k) && !/^layer\d+$/.test(k))];
  for (const k of order) {
    const v = s(textures[k]);
    if (!v || v.startsWith('#')) continue;
    const f = textureFile(v.includes(':') ? v : `${chain.__ns}:${v}`);
    if (f) return f;
  }
  return null;
}

// Resolve a model ID through the assets/models/ chain, accumulating parent textures.
// Returns the merged model object with __generated flag if item/generated ancestor was found.
function resolveModelChain(modelId, defaultNs = 'minecraft', seen = new Set()) {
  let [ns, name] = idParts(modelId, defaultNs);
  if (!name.startsWith('item/') && !name.startsWith('block/')) name = `item/${name}`;
  const key = `${ns}:${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const file = findAsset(ns, 'models', name, '.json');
  let m = file ? readJson(file) : null;
  if (!m) {
    if (key === 'minecraft:item/generated') return { __generated: true, textures: {}, __ns: ns };
    if (key === 'minecraft:item/handheld') return resolveModelChain('minecraft:item/generated', 'minecraft', seen);
    return null;
  }
  m = JSON.parse(JSON.stringify(m));
  if (m.parent) {
    const parent = s(m.parent);
    const pid = parent.includes(':') ? parent : `${ns}:${parent}`;
    const pm = resolveModelChain(pid, ns, seen);
    if (pm) { m = { ...pm, ...m, textures: { ...(pm.textures || {}), ...(m.textures || {}) } }; if (pm.__generated) m.__generated = true; }
  }
  m.__ns = ns;
  return m;
}

// Determine which assets/<ns>/items/<name>.json to read:
//   item_model component value  →  assets/<comp_ns>/items/<comp_name>.json
//   item ID fallback            →  assets/<item_ns>/items/<item_name>.json
function readItemsDef(item) {
  const ref = s(item?.components?.['minecraft:item_model'] || item?.components?.item_model ||
    item?.item || item?.id || item);
  const [ns, name] = idParts(ref);
  const file = findAsset(ns, 'items', name, '.json');
  return { def: file ? readJson(file) : null, ns, name };
}

// Resolve a tint entry from the items JSON tints array to an [r, g, b] tuple or null.
// Supports: dye, constant, grass, potion. Others return null (no tint applied).
function resolveTintColor(tintEntry, components) {
  if (!tintEntry) return null;
  const type = s(tintEntry.type).replace(/^minecraft:/, '');
  switch (type) {
    case 'dye': {
      const dc = components?.['minecraft:dyed_color'] || components?.dyed_color;
      const rgb = dc != null ? (typeof dc === 'number' ? dc : (dc?.rgb ?? -1)) : (tintEntry.default ?? -1);
      if (rgb < 0) return null;
      return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
    }
    case 'constant': {
      const val = tintEntry.value;
      if (typeof val === 'number') return [(val >> 16) & 255, (val >> 8) & 255, val & 255];
      if (Array.isArray(val)) return [Math.round(val[0] * 255), Math.round(val[1] * 255), Math.round(val[2] * 255)];
      return null;
    }
    case 'grass': return [124, 189, 107];
    case 'potion': {
      const pc = components?.['minecraft:potion_contents'] || components?.potion_contents;
      const rgb = pc?.custom_color != null ? Number(pc.custom_color) : (tintEntry.default ?? -1);
      if (rgb < 0) return null;
      return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
    }
    default: return null;
  }
}

// Recursively walk an items-JSON model node and collect all leaf model refs with their tints.
// Returns { modelRef: string, tints: any[] }[] or null if not flat-renderable.
function collectFlatModelRefs(node, fallbackNs) {
  if (!node) return null;
  const type = s(node.type).replace(/^minecraft:/, '');
  switch (type) {
    case 'model': {
      const m = s(node.model);
      return m ? [{ modelRef: m, tints: node.tints || [] }] : null;
    }
    case 'composite':
      return (node.models || []).reduce((acc, sub) => {
        if (acc === null) return null;
        const refs = collectFlatModelRefs(sub, fallbackNs);
        return refs === null ? null : [...acc, ...refs];
      }, []);
    case 'condition':
      return collectFlatModelRefs(node.on_true ?? node.on_false, fallbackNs);
    case 'select': {
      const first = node.fallback ?? (node.cases || [])[0]?.model;
      return first ? collectFlatModelRefs(first, fallbackNs) : null;
    }
    case 'range_dispatch': {
      const first = node.fallback ?? (node.entries || [])[0]?.model;
      return first ? collectFlatModelRefs(first, fallbackNs) : null;
    }
    default:
      // minecraft:special, minecraft:empty, etc. → not flat-renderable; caller uses deepslate.
      return null;
  }
}

async function renderFlatItem(item, size = ICON_SIZE) {
  // Step 1 — read the items JSON (using item_model component if present, else item ID).
  const { def, ns, name } = readItemsDef(item);

  let modelRefs;
  if (def?.model) {
    modelRefs = collectFlatModelRefs(def.model, ns);
    if (modelRefs === null) return null;
  } else {
    // No items JSON — try a direct item texture as pre-1.21 fallback.
    const [ins, iname] = idParts(item?.item || item?.id || item);
    const directTex = findAsset(ins, 'textures', `item/${iname}`, '.png');
    if (!directTex) return null;
    const meta = readMcmeta(directTex);
    if (!meta) {
      return { buf: await normalize(
        await sharp(directTex).ensureAlpha()
          .resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png().toBuffer(), size), animated: false };
    }
    const { width } = await sharp(directTex).metadata();
    const frameH = meta.height || meta.width || width;
    const frameCount = Math.floor((await sharp(directTex).metadata()).height / frameH);
    const indices = meta.frames
      ? meta.frames.map(fr => (typeof fr === 'object' ? fr.index : fr))
      : Array.from({ length: frameCount }, (_, k) => k);
    const frametime = (meta.frametime || 1) * 50;
    const frames = await Promise.all(indices.map(idx =>
      sharp(directTex).ensureAlpha()
        .extract({ left: 0, top: idx * frameH, width, height: frameH })
        .resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer()
    ));
    const normed = await Promise.all(frames.map(f => normalize(f, size)));
    return normed.length === 1
      ? { buf: normed[0], animated: false }
      : { buf: encodeApng(normed, frametime), animated: true };
  }

  // Step 2 — resolve each model ref through the models/ chain and collect texture layers.
  // Each layer carries its resolved tint color (or null for no tint).
  const allLayers = [];
  for (const { modelRef, tints } of modelRefs) {
    const chain = resolveModelChain(modelRef);
    if (!chain) continue;
    const textures = chain.textures || {};
    const layerKeys = Object.keys(textures)
      .filter(k => /^layer\d+$/.test(k))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));

    if (!chain.__generated && (chain.elements?.length || !layerKeys.length)) return null;

    for (let i = 0; i < layerKeys.length; i++) {
      const f = resolveTextureRef(`#${layerKeys[i]}`, textures, chain.__ns || 'minecraft');
      const tintRgb = resolveTintColor(tints?.[i] ?? null, item.components);
      if (f) allLayers.push({ texFile: f, tintRgb });
    }
  }
  if (!allLayers.length) return null;

  const hasMeta = allLayers.some(l => readMcmeta(l.texFile));

  if (!hasMeta) {
    const comps = [];
    for (const layer of allLayers) {
      let buf = await sharp(layer.texFile).ensureAlpha()
        .resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      if (layer.tintRgb) buf = await sharp(buf).tint({ r: layer.tintRgb[0], g: layer.tintRgb[1], b: layer.tintRgb[2] }).png().toBuffer();
      comps.push({ input: buf, left: 0, top: 0 });
    }
    if (!comps.length) return null;
    const composite = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(comps).png().toBuffer();
    return { buf: await normalize(composite, size), animated: false };
  }

  // Animated: build per-frame composites across all layers.
  const layerFrames = await Promise.all(allLayers.map(async ({ texFile: f, tintRgb }) => {
    const meta = readMcmeta(f);
    if (!meta) {
      let buf = await sharp(f).ensureAlpha()
        .resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      if (tintRgb) buf = await sharp(buf).tint({ r: tintRgb[0], g: tintRgb[1], b: tintRgb[2] }).png().toBuffer();
      return { frames: [buf], frametime: 100 };
    }
    const { width } = await sharp(f).metadata();
    const frameH = meta.height || meta.width || width;
    const frameCount = Math.floor((await sharp(f).metadata()).height / frameH);
    const indices = meta.frames
      ? meta.frames.map(fr => (typeof fr === 'object' ? fr.index : fr))
      : Array.from({ length: frameCount }, (_, k) => k);
    const frametime = (meta.frametime || 1) * 50;
    const frames = await Promise.all(indices.map(async idx => {
      let buf = await sharp(f).ensureAlpha()
        .extract({ left: 0, top: idx * frameH, width, height: frameH })
        .resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      if (tintRgb) buf = await sharp(buf).tint({ r: tintRgb[0], g: tintRgb[1], b: tintRgb[2] }).png().toBuffer();
      return buf;
    }));
    return { frames, frametime };
  }));

  const maxFrames = Math.max(...layerFrames.map(l => l.frames.length), 1);
  const frametime = layerFrames.reduce((best, l) => l.frametime > 0 ? Math.min(best, l.frametime) : best, 100);
  const outputFrames = [];
  for (let fi = 0; fi < maxFrames; fi++) {
    const comps = [];
    for (const layer of layerFrames) {
      if (!layer.frames.length) continue;
      comps.push({ input: layer.frames[fi % layer.frames.length], left: 0, top: 0 });
    }
    if (!comps.length) continue;
    const frame = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(comps).png().toBuffer();
    outputFrames.push(await normalize(frame, size));
  }
  if (!outputFrames.length) return null;
  if (outputFrames.length === 1) return { buf: outputFrames[0], animated: false };
  return { buf: encodeApng(outputFrames, frametime), animated: true };
}

// ---- components → deepslate NbtMap ----
function componentsToNbt(components) {
  if (!DS || !components) return new Map();
  const map = new Map();
  for (const [k, v] of Object.entries(components)) {
    const key = k.includes(':') ? k : `minecraft:${k}`;
    if (key === 'minecraft:item_model') {
      map.set(key, new DS.NbtString(s(v)));
    } else if (key === 'minecraft:dyed_color') {
      const rgb = typeof v === 'number' ? v : (v?.rgb ?? 0);
      const c = new DS.NbtCompound(); c.set('rgb', new DS.NbtInt(Number(rgb)));
      map.set(key, c);
    } else if (key === 'minecraft:potion_contents') {
      const c = new DS.NbtCompound();
      if (v?.custom_color != null) c.set('custom_color', new DS.NbtInt(Number(v.custom_color)));
      map.set(key, c);
    }
  }
  return map;
}

// ---- main render entry ----
async function renderItem(itemId, size, components) {
  const item = { item: itemId, components };

  const flat = await renderFlatItem(item, size);
  if (flat) return flat;

  if (DS) {
    try {
      const [ns, name] = idParts(itemId);
      const id = DS.Identifier.parse(`${ns}:${name}`);
      const nbtComponents = componentsToNbt({ 'minecraft:item_model': itemId, ...components });
      const stack = new DS.ItemStack(id, 1, nbtComponents);
      const res = new Resources();
      const mesh = DS.ItemRenderer.getItemMesh(stack, res, { display_context: 'gui' });
      if (mesh && !mesh.isEmpty()) {
        const atlas = await res.buildAtlas();
        if (atlas) return { buf: await normalize(rasterMesh(mesh, atlas, size), size), animated: false };
      }
    } catch { /* fall through */ }
  }

  // Texture fallback — try item_model component path first, then item ID
  const modelRef = s(components?.['minecraft:item_model'] || components?.item_model || '');
  const [mns, mname] = modelRef ? idParts(modelRef) : idParts(itemId);
  const [ins, iname] = idParts(itemId);
  const tex = findAsset(mns, 'textures', `item/${mname}`, '.png')
    || findAsset(mns, 'textures', `block/${mname}`, '.png')
    || findAsset(ins, 'textures', `item/${iname}`, '.png')
    || findAsset(ins, 'textures', `block/${iname}`, '.png');
  if (tex) {
    return { buf: await normalize(
      await sharp(tex).ensureAlpha()
        .resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer(), size), animated: false };
  }

  // Last-resort: extract any usable texture from the block model chain.
  // Handles blocks whose texture name differs from their model name (e.g. frog_feeder_side.png).
  const { def } = readItemsDef(item);
  if (def?.model) {
    const blockRefs = collectFlatModelRefs(def.model, ins);
    if (blockRefs) {
      for (const { modelRef: bref } of blockRefs) {
        const btex = extractFirstBlockTexture(bref);
        if (btex) {
          return { buf: await normalize(
            await sharp(btex).ensureAlpha()
              .resize(size, size, { fit: 'inside', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .png().toBuffer(), size), animated: false };
        }
      }
    }
  }
  return null;
}

function readItemIconManifest() {
  const manifestPath = path.join(outRoot, '.item-icon-requests.json');
  if (!exists(manifestPath)) return [];
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return []; }
}

async function main() {
  const items = discoverItems();

  // Merge in items requested by loot-table/structure generators (written before this phase runs)
  const manifestIds = readItemIconManifest();
  if (manifestIds.length) {
    const discoveredIds = new Set(items.map(i => i.outputName ? `${i.ns}:${i.rel}` : i.id));
    for (const iconId of manifestIds) {
      // iconId may be "ns:path" or "ns:path#RRGGBB" (tinted variant)
      const hashIdx = iconId.indexOf('#');
      const baseId = hashIdx >= 0 ? iconId.slice(0, hashIdx) : iconId;
      const colorHex = hashIdx >= 0 ? iconId.slice(hashIdx + 1) : null;
      if (discoveredIds.has(baseId) && !colorHex) continue;
      const [ns, rawName] = baseId.includes(':') ? baseId.split(':') : ['minecraft', baseId];
      const outputName = rawName.replace(/\//g, '_') + (colorHex ? `_${colorHex}` : '');
      const components = colorHex ? { 'minecraft:dyed_color': parseInt(colorHex, 16) } : {};
      items.push({ id: baseId, ns, rel: rawName, outputName, components });
    }
    console.log(`Added ${manifestIds.length} item(s) from loot-table/structure manifest.`);
    // Clean up so stale IDs don't accumulate across runs
    try { fs.rmSync(path.join(outRoot, '.item-icon-requests.json'), { force: true }); } catch { }
  }

  console.log(`Item render output root: ${outRoot}`);
  console.log(`Discovered ${items.length} item(s) from assets definitions.`);
  if (!items.length) return;
  if (DS) console.log('deepslate available: 3D block models will render in GUI/inventory style.');
  else console.log('deepslate not available: flat-texture fallback only.');

  let done = 0, animated = 0, errors = 0;
  for (const item of items) {
    const outFile = path.join(outRoot, item.ns, `${item.outputName}.png`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    try {
      const result = await renderItem(item.id, ICON_SIZE, item.components);
      if (result?.buf) {
        fs.writeFileSync(outFile, result.buf);
        done++;
        if (result.animated) animated++;
      } else {
        console.warn(`No renderable texture found for ${item.id} (${item.ns}/${item.rel}); skipping.`);
      }
    } catch (e) {
      errors++;
      console.warn(`Item render failed for ${item.id}: ${e.message}`);
    }
  }

  if (done) console.log(`Rendered ${done} item/block PNG(s) (${animated} animated) in ${outRoot}.`);
  if (errors) console.warn(`${errors} item/block render error(s).`);
  if (done === 0 && items.length > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
