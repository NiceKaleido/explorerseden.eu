#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const sharp = require('sharp');
const { PNG } = require('pngjs');

let DS = null;
try { DS = require('deepslate'); } catch { /* optional */ }

const repoRoot     = process.env.SOURCE_REPO_ROOT   || process.cwd();
const workflowRoot = process.env.WORKFLOW_ROOT       || path.resolve(__dirname, '..', '..');
const vanillaRoot  = process.env.VANILLA_ASSET_ROOT  || path.join(workflowRoot, '.cache', 'vanilla-assets', 'active');
const gridsRoot    = path.join(workflowRoot, 'tools', 'crafting_grids');
const outRoot      = process.env.RECIPE_IMAGE_OUTPUT_ROOT
  || path.join(process.env.WIKI_OUTPUT_ROOT || path.join(repoRoot, 'wiki'), 'images', 'recipe');

const SCALE     = 4;   // output at 4× source resolution
const ITEM_1X   = 16;  // slot content size at 1×
const ITEM_SIZE = ITEM_1X * SCALE;  // 64px per item in output
const BG_W = 176, BG_H = 81;

// ── utilities ──────────────────────────────────────────────────────────────
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
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
function findAsset(ns, kind, name, ext = '.json') {
  const c = s(name).replace(/\\/g, '/').replace(new RegExp(`${ext.replace('.', '\\.')}$`), '');
  const p1 = path.join(repoRoot,    'assets', ns, kind, `${c}${ext}`);
  if (exists(p1)) return p1;
  const p2 = path.join(vanillaRoot, 'assets', ns, kind, `${c}${ext}`);
  return exists(p2) ? p2 : null;
}
function findData(ns, folder, name) {
  const c = s(name).replace(/\\/g, '/').replace(/\.json$/, '');
  for (const root of [repoRoot, vanillaRoot]) {
    const p = path.join(root, 'data', ns, folder, `${c}.json`);
    if (exists(p)) return p;
  }
  return null;
}
function textureFile(id) {
  let [ns, name] = idParts(id);
  name = name.replace(/^textures\//, '').replace(/\.png$/, '');
  return findAsset(ns, 'textures', name, '.png');
}

// ── tag resolution ─────────────────────────────────────────────────────────
function resolveTag(tagId, seen = new Set()) {
  const [ns, raw] = idParts(tagId);
  const clean = raw.replace(/^#/, '').replace(/^tags\/items?\//, '').replace(/^items?\//, '');
  const key = `${ns}:${clean}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const p = [
    findData(ns, 'tags/item',  clean),
    findData(ns, 'tags/items', clean),
    findData(ns, 'tags',       `item/${clean}`),
    findData(ns, 'tags',       `items/${clean}`),
  ].find(Boolean);
  const json = p ? readJson(p) : null;
  const out = [];
  for (const entry of (json?.values ?? [])) {
    let v = entry;
    if (v && typeof v === 'object') v = v.id ?? v.value ?? v.item ?? v.tag;
    v = s(v);
    if (!v) continue;
    if (v.startsWith('#')) out.push(...resolveTag(v.slice(1), seen));
    else out.push(v);
  }
  return [...new Set(out)];
}

// Normalize a recipe ingredient to [{itemId, components?}]
function resolveIngredient(ing) {
  if (!ing) return [];
  if (Array.isArray(ing)) return ing.flatMap(x => resolveIngredient(x));
  if (typeof ing === 'string') {
    if (ing.startsWith('#')) return resolveTag(ing.slice(1)).map(id => ({ itemId: id }));
    return ing ? [{ itemId: ing }] : [];
  }
  if (typeof ing === 'object') {
    const item  = s(ing.item ?? ing.id);
    const tag   = s(ing.tag);
    const comps = ing.components || ing.components_patch || null;
    if (item) return [{ itemId: item, components: comps ?? undefined }];
    if (tag)  return resolveTag(tag).map(id => ({ itemId: id }));
  }
  return [];
}
function resolveResult(result) {
  if (!result) return null;
  if (typeof result === 'string') return { itemId: result };
  if (typeof result === 'object') {
    const item  = s(result.item ?? result.id);
    const comps = result.components || result.components_patch || null;
    if (item) return { itemId: item, components: comps ?? undefined };
  }
  return null;
}

// ── slot layout ────────────────────────────────────────────────────────────
// All coordinates are 1× content-area top-left (multiply by SCALE when compositing).
// Slot borders confirmed from pixel analysis of the 176×81 PNG backgrounds:
//   crafting_table: 3×3 grid borders at x=29+col×18, y=16+row×18 → content +1
//   furnace:        input border (55,16), output border (111,30) → content +1
//   smithing:       slots border y=47, x=7/25/43/97 → content +1
//   stonecutter:    input border (19,32), output border (138,28) → content +1
const GRID = (col, row) => ({ x: 30 + col * 18, y: 17 + row * 18 });

function getLayout(recipe) {
  const type   = s(recipe.type).replace(/^minecraft:/, '');
  const result = resolveResult(recipe.result ?? recipe.output ?? recipe.results);

  if (type === 'crafting_shaped') {
    const key  = recipe.key || {};
    const slots = [];
    for (let row = 0; row < 3; row++) {
      const line = s((recipe.pattern || [])[row]);
      for (let col = 0; col < 3; col++) {
        const ch = line[col] || ' ';
        if (ch !== ' ' && key[ch]) {
          const items = resolveIngredient(key[ch]);
          if (items.length) slots.push({ pos: GRID(col, row), items });
        }
      }
    }
    if (result) slots.push({ pos: { x: 120, y: 31 }, interior: 24, items: [result] });
    return { bg: 'crafting_table', slots };
  }

  if (type === 'crafting_shapeless') {
    const slots = [];
    let idx = 0;
    for (const ing of (recipe.ingredients || [])) {
      const items = resolveIngredient(ing);
      if (items.length && idx < 9) {
        slots.push({ pos: GRID(idx % 3, Math.floor(idx / 3)), items });
        idx++;
      }
    }
    if (result) slots.push({ pos: { x: 120, y: 31 }, interior: 24, items: [result] });
    return { bg: 'crafting_table', slots };
  }

  if (['smelting', 'blasting', 'smoking', 'campfire_cooking'].includes(type)) {
    const slots = [];
    const input = resolveIngredient(recipe.ingredient ?? recipe.input);
    if (input.length) slots.push({ pos: { x: 56,  y: 17 }, items: input });
    if (result)       slots.push({ pos: { x: 112, y: 31 }, interior: 24, items: [result] });
    return { bg: 'furnace', slots };
  }

  if (type === 'stonecutting') {
    const slots = [];
    const input = resolveIngredient(recipe.ingredient ?? recipe.input);
    if (input.length) slots.push({ pos: { x: 20,  y: 33 }, items: input });
    if (result)       slots.push({ pos: { x: 139, y: 29 }, interior: 24, items: [result] });
    return { bg: 'stonecutter', slots };
  }

  if (type === 'smithing_transform' || type === 'smithing_trim') {
    const slots = [];
    const template = resolveIngredient(recipe.template);
    const base     = resolveIngredient(recipe.base);
    const addition = resolveIngredient(recipe.addition);
    if (template.length) slots.push({ pos: { x: 8,  y: 48 }, items: template });
    if (base.length)     slots.push({ pos: { x: 26, y: 48 }, items: base });
    if (addition.length) slots.push({ pos: { x: 44, y: 48 }, items: addition });
    if (result)          slots.push({ pos: { x: 98, y: 48 }, items: [result] });
    return { bg: 'smithing', slots };
  }

  // Fallback: show result alone on crafting_table background
  if (result) return { bg: 'crafting_table', slots: [{ pos: { x: 120, y: 31 }, interior: 24, items: [result] }] };
  return null;
}

// ── APNG encoder ───────────────────────────────────────────────────────────
function crc32(buf) {
  let t = crc32._t;
  if (!t) {
    t = crc32._t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
  }
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
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return zlib.deflateSync(raw, { level: 9 });
}
function encodeApng(frameBuffers, delayMs = 800) {
  const frames = frameBuffers.map(b => PNG.sync.read(b));
  const { width, height } = frames[0];
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunks = [sig, pngChunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4);
  chunks.push(pngChunk('acTL', actl));
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(seq++, 0); fc.writeUInt32BE(width, 4); fc.writeUInt32BE(height, 8);
    fc.writeUInt32BE(0, 12); fc.writeUInt32BE(0, 16);
    fc.writeUInt16BE(delayMs, 20); fc.writeUInt16BE(1000, 22); fc[24] = 0; fc[25] = 0;
    chunks.push(pngChunk('fcTL', fc));
    const comp = rawIdat(frames[i].data, width, height);
    if (i === 0) {
      chunks.push(pngChunk('IDAT', comp));
    } else {
      const fd = Buffer.alloc(4 + comp.length);
      fd.writeUInt32BE(seq++, 0); comp.copy(fd, 4);
      chunks.push(pngChunk('fdAT', fd));
    }
  }
  chunks.push(pngChunk('IEND'));
  return Buffer.concat(chunks);
}

// ── item rendering (adapted from generate-item-block-renders.js) ───────────
const CELL = 32, ATLAS_COLS = 32;

function readMcmeta(texPath) {
  const p = texPath + '.mcmeta';
  if (!exists(p)) return null;
  return readJson(p)?.animation || null;
}
async function loadTextureTile(f) {
  const meta = readMcmeta(f);
  if (!meta) return sharp(f).ensureAlpha().resize(CELL, CELL, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
  const { width } = await sharp(f).metadata();
  const fh = meta.height || meta.width || width;
  return sharp(f).ensureAlpha().extract({ left: 0, top: 0, width, height: fh })
    .resize(CELL, CELL, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
}
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

class Resources {
  constructor() {
    this.blockModels = new Map(); this.itemModels = new Map();
    this.texMap = new Map(); this.texList = []; this.atlasPng = null;
  }
  getItemComponents(id) { return DS ? new Map([['minecraft:item_model', new DS.NbtString(id.toString())]]) : new Map(); }
  getItemModel(id) {
    const key = id.toString();
    if (this.itemModels.has(key)) return this.itemModels.get(key);
    const [ns, name] = idParts(key);
    const file = findAsset(ns, 'items', name, '.json');
    const obj  = file ? readJson(file) : null;
    let model;
    try { model = DS.ItemModel.fromJson(obj?.model ?? { type: 'minecraft:model', model: `${ns}:item/${name}` }); }
    catch {
      const refs = obj?.model ? collectFlatModelRefs(obj.model, ns) : null;
      const ref  = refs?.[0]?.modelRef;
      try { model = DS.ItemModel.fromJson(ref ? { type: 'minecraft:model', model: ref } : { type: 'minecraft:model', model: `${ns}:item/${name}` }); }
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
      const idx = this.texList.length;
      this.texMap.set(key, { idx, file: textureFile(key), key });
      this.texList.push(this.texMap.get(key));
    }
    const { idx } = this.texMap.get(key);
    return [idx / ATLAS_COLS, 0, (idx + 1) / ATLAS_COLS, 1];
  }
  getPixelSize() { return 1 / CELL; }
  async buildAtlas() {
    if (!this.texList.length) return null;
    const base = sharp({ create: { width: ATLAS_COLS * CELL, height: CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    const comps = [];
    for (const t of this.texList) {
      const input = t.file && exists(t.file) ? await loadTextureTile(t.file)
        : await sharp({ create: { width: CELL, height: CELL, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 255 } } }).png().toBuffer();
      comps.push({ input, left: t.idx * CELL, top: 0 });
    }
    this.atlasPng = PNG.sync.read(await base.composite(comps).png().toBuffer());
    return this.atlasPng;
  }
  getTextureAtlas() { return null; }
}

function sample(tex, u, v, tl) {
  if (tl) { u = Math.max(tl[0], Math.min(tl[2], u)); v = Math.max(tl[1], Math.min(tl[3], v)); }
  const x = Math.max(0, Math.min(tex.width  - 1, Math.floor(u * tex.width)));
  const y = Math.max(0, Math.min(tex.height - 1, Math.floor(v * tex.height)));
  const i = (y * tex.width + x) * 4;
  return [tex.data[i], tex.data[i+1], tex.data[i+2], tex.data[i+3]];
}
function blend(dst, zbuf, x, y, z, c) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= dst.width || y >= dst.height || c[3] <= 0) return;
  const zi = y * dst.width + x;
  if (z < zbuf[zi]) return;
  zbuf[zi] = z;
  const i = zi * 4, sa = c[3]/255, da = dst.data[i+3]/255, oa = sa + da*(1-sa);
  if (oa <= 0) return;
  dst.data[i]   = Math.round((c[0]*sa + dst.data[i]  *da*(1-sa))/oa);
  dst.data[i+1] = Math.round((c[1]*sa + dst.data[i+1]*da*(1-sa))/oa);
  dst.data[i+2] = Math.round((c[2]*sa + dst.data[i+2]*da*(1-sa))/oa);
  dst.data[i+3] = Math.round(oa*255);
}
function triRaster(dst, zbuf, atlas, a, b, c, ta, tb, tc, tla, tlb, tlc, ca, cb, cc) {
  const minX = Math.floor(Math.min(a[0],b[0],c[0])), maxX = Math.ceil(Math.max(a[0],b[0],c[0]));
  const minY = Math.floor(Math.min(a[1],b[1],c[1])), maxY = Math.ceil(Math.max(a[1],b[1],c[1]));
  const den = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1]);
  if (Math.abs(den) < 1e-6) return;
  const tl = (tla && tlb && tlc) ? [(tla[0]+tlb[0]+tlc[0])/3,(tla[1]+tlb[1]+tlc[1])/3,(tla[2]+tlb[2]+tlc[2])/3,(tla[3]+tlb[3]+tlc[3])/3] : null;
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
function rasterMesh(mesh, atlas, size) {
  const dst = new PNG({ width: size, height: size });
  const zbuf = new Float32Array(size * size).fill(-1e9);
  let qi = 0;
  for (const q of mesh.quads) {
    const vs = q.vertices(), bias = qi++ * 1e-5;
    const pts = vs.map(v => [v.pos.x*size/16, (16-v.pos.y)*size/16, v.pos.z+bias]);
    const tex = vs.map(v => v.texture || [0,0]);
    const tl  = vs.map(v => v.textureLimit || null);
    const col = vs.map(v => v.color || [1,1,1]);
    triRaster(dst,zbuf,atlas,pts[0],pts[1],pts[2],tex[0],tex[1],tex[2],tl[0],tl[1],tl[2],col[0],col[1],col[2]);
    triRaster(dst,zbuf,atlas,pts[0],pts[2],pts[3],tex[0],tex[2],tex[3],tl[0],tl[2],tl[3],col[0],col[2],col[3]);
  }
  return PNG.sync.write(dst);
}
async function normItem(buf, size) {
  let t = buf;
  try { t = await sharp(buf).ensureAlpha().trim({ background:{r:0,g:0,b:0,alpha:0}, threshold:1 }).png().toBuffer(); } catch { }
  const r = await sharp(t).resize(size, size, { fit:'inside', kernel:'nearest', background:{r:0,g:0,b:0,alpha:0} }).png().toBuffer();
  return sharp({ create:{width:size,height:size,channels:4,background:{r:0,g:0,b:0,alpha:0}} })
    .composite([{input:r,gravity:'center'}]).png().toBuffer();
}
function resolveTextureRef(ref, textures, ns) {
  let v = s(ref); let g = 0;
  while (v.startsWith('#') && g++ < 32) v = s(textures[v.slice(1)]);
  return v ? textureFile(v.includes(':') ? v : `${ns}:${v}`) : null;
}
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
    if (key === 'minecraft:item/handheld')  return resolveModelChain('minecraft:item/generated', 'minecraft', seen);
    return null;
  }
  m = JSON.parse(JSON.stringify(m));
  if (m.parent) {
    const pid = s(m.parent).includes(':') ? s(m.parent) : `${ns}:${s(m.parent)}`;
    const pm  = resolveModelChain(pid, ns, seen);
    if (pm) { m = { ...pm, ...m, textures: { ...(pm.textures||{}), ...(m.textures||{}) } }; if (pm.__generated) m.__generated = true; }
  }
  m.__ns = ns;
  return m;
}
function extractFirstBlockTexture(modelId) {
  const chain = resolveModelChain(modelId);
  if (!chain) return null;
  const textures = chain.textures || {};
  const PREF = ['all','texture','side','top','front','bottom','back','north','east','south','west'];
  for (const k of [...PREF, ...Object.keys(textures).filter(k => !PREF.includes(k) && !/^layer\d+$/.test(k))]) {
    const v = s(textures[k]);
    if (!v || v.startsWith('#')) continue;
    const f = textureFile(v.includes(':') ? v : `${chain.__ns}:${v}`);
    if (f) return f;
  }
  return null;
}
function collectFlatModelRefs(node, fallbackNs) {
  if (!node) return null;
  const type = s(node.type).replace(/^minecraft:/, '');
  if (type === 'model') { const m = s(node.model); return m ? [{ modelRef: m, tints: node.tints||[] }] : null; }
  if (type === 'composite') return (node.models||[]).reduce((acc,sub) => {
    if (acc === null) return null;
    const refs = collectFlatModelRefs(sub, fallbackNs);
    return refs === null ? null : [...acc, ...refs];
  }, []);
  if (type === 'condition') return collectFlatModelRefs(node.on_true ?? node.on_false, fallbackNs);
  if (type === 'select') { const first = node.fallback ?? (node.cases||[])[0]?.model; return first ? collectFlatModelRefs(first, fallbackNs) : null; }
  if (type === 'range_dispatch') { const first = node.fallback ?? (node.entries||[])[0]?.model; return first ? collectFlatModelRefs(first, fallbackNs) : null; }
  return null;
}
function readItemsDef(item) {
  const ref = s(item?.components?.['minecraft:item_model'] || item?.components?.item_model || item?.item || item?.id || item);
  const [ns, name] = idParts(ref);
  return { def: readJson(findAsset(ns, 'items', name, '.json') ?? '') ?? null, ns, name };
}
function resolveTintColor(tintEntry, components) {
  if (!tintEntry) return null;
  const type = s(tintEntry.type).replace(/^minecraft:/, '');
  if (type === 'dye') {
    const dc = components?.['minecraft:dyed_color'] || components?.dyed_color;
    const rgb = dc != null ? (typeof dc === 'number' ? dc : (dc?.rgb ?? -1)) : (tintEntry.default ?? -1);
    return rgb < 0 ? null : [(rgb>>16)&255,(rgb>>8)&255,rgb&255];
  }
  if (type === 'constant') {
    const val = tintEntry.value;
    if (typeof val === 'number') return [(val>>16)&255,(val>>8)&255,val&255];
    if (Array.isArray(val)) return [Math.round(val[0]*255),Math.round(val[1]*255),Math.round(val[2]*255)];
    return null;
  }
  if (type === 'grass') return [124,189,107];
  if (type === 'potion') {
    const pc = components?.['minecraft:potion_contents'] || components?.potion_contents;
    const rgb = pc?.custom_color != null ? Number(pc.custom_color) : (tintEntry.default ?? -1);
    return rgb < 0 ? null : [(rgb>>16)&255,(rgb>>8)&255,rgb&255];
  }
  return null;
}

async function renderFlatItem(item, size) {
  const { def, ns } = readItemsDef(item);
  let modelRefs;
  if (def?.model) {
    modelRefs = collectFlatModelRefs(def.model, ns);
    if (modelRefs === null) return null;
  } else {
    const [ins, iname] = idParts(item?.item || item?.id || item);
    const directTex = findAsset(ins, 'textures', `item/${iname}`, '.png');
    if (!directTex) return null;
    const meta = readMcmeta(directTex);
    const src  = meta
      ? await (async () => {
          const { width } = await sharp(directTex).metadata();
          const fh = meta.height || meta.width || width;
          return sharp(directTex).ensureAlpha().extract({ left:0, top:0, width, height:fh }).resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
        })()
      : await sharp(directTex).ensureAlpha().resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    return { buf: await normItem(src, size), animated: false };
  }
  const allLayers = [];
  for (const { modelRef, tints } of modelRefs) {
    const chain = resolveModelChain(modelRef);
    if (!chain) continue;
    const textures = chain.textures || {};
    const layerKeys = Object.keys(textures).filter(k => /^layer\d+$/.test(k)).sort((a,b) => Number(a.slice(5))-Number(b.slice(5)));
    if (!chain.__generated && (chain.elements?.length || !layerKeys.length)) return null;
    for (let i = 0; i < layerKeys.length; i++) {
      const f = resolveTextureRef(`#${layerKeys[i]}`, textures, chain.__ns || 'minecraft');
      if (f) allLayers.push({ texFile: f, tintRgb: resolveTintColor(tints?.[i] ?? null, item.components) });
    }
  }
  if (!allLayers.length) return null;
  const comps = [];
  for (const { texFile: f, tintRgb } of allLayers) {
    let buf = await sharp(f).ensureAlpha().resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    if (tintRgb) buf = await sharp(buf).tint({ r:tintRgb[0], g:tintRgb[1], b:tintRgb[2] }).png().toBuffer();
    comps.push({ input:buf, left:0, top:0 });
  }
  if (!comps.length) return null;
  const composite = await sharp({ create:{width:size,height:size,channels:4,background:{r:0,g:0,b:0,alpha:0}} }).composite(comps).png().toBuffer();
  return { buf: await normItem(composite, size), animated: false };
}

function componentsToNbt(components) {
  if (!DS || !components) return new Map();
  const map = new Map();
  for (const [k, v] of Object.entries(components)) {
    const key = k.includes(':') ? k : `minecraft:${k}`;
    if (key === 'minecraft:item_model') { map.set(key, new DS.NbtString(s(v))); }
    else if (key === 'minecraft:dyed_color') {
      const rgb = typeof v === 'number' ? v : (v?.rgb ?? 0);
      const c = new DS.NbtCompound(); c.set('rgb', new DS.NbtInt(Number(rgb))); map.set(key, c);
    } else if (key === 'minecraft:potion_contents') {
      const c = new DS.NbtCompound();
      if (v?.custom_color != null) c.set('custom_color', new DS.NbtInt(Number(v.custom_color)));
      map.set(key, c);
    }
  }
  return map;
}

// Cache for downloaded player-head skin textures — keyed by Mojang texture hash
// so identical custom heads share a single download. Lives across recipes in a
// single workflow run.
const skinTextureCache = new Map();
const skinDiskCache = path.join(workflowRoot, '.cache', 'player-skins');

function decodeProfileSkinUrl(profile) {
  if (!profile) return null;
  // Modern form: properties[0].value is a base64-encoded GameProfile JSON.
  const props = Array.isArray(profile.properties) ? profile.properties : [];
  for (const p of props) {
    const value = s(p?.value || p);
    if (!value) continue;
    try {
      const json = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
      const url = s(json?.textures?.SKIN?.url);
      if (url) return url;
    } catch { /* not a valid base64 GameProfile, skip */ }
  }
  // Direct-URL form some packs use: { "url": "http://..." }.
  if (typeof profile.url === 'string') return profile.url;
  return null;
}

async function fetchSkinTexture(url) {
  if (!url) return null;
  if (skinTextureCache.has(url)) return skinTextureCache.get(url);
  // Mojang texture URLs always end in a hex hash — derive a cache filename
  // from it so a build re-using the same skin doesn't re-download.
  const hash = url.match(/[a-f0-9]{32,}/i)?.[0] || crypto.createHash('sha1').update(url).digest('hex');
  const diskPath = path.join(skinDiskCache, `${hash}.png`);
  if (exists(diskPath)) {
    const buf = fs.readFileSync(diskPath);
    skinTextureCache.set(url, buf);
    return buf;
  }
  try {
    const safeUrl = url.replace(/^http:/, 'https:');
    const res = await fetch(safeUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(skinDiskCache, { recursive: true });
    fs.writeFileSync(diskPath, buf);
    skinTextureCache.set(url, buf);
    return buf;
  } catch (err) {
    console.warn(`Could not fetch player-head skin ${url}: ${err.message}`);
    skinTextureCache.set(url, null);
    return null;
  }
}

// For a player_head with a profile component, fetch the custom skin and
// temporarily overwrite the on-disk default skin so the existing 3D-head
// renderer (deepslate's SkullRenderers.headRenderer + builtin/entity model)
// reads our texture. Returns a restore callback the caller MUST invoke after
// rendering. Returns null if there's no profile / network failed — the caller
// then renders with the default skin as usual. Renders are serial inside
// renderItem so this can't race.
async function installCustomPlayerSkin(itemId, components) {
  if (s(itemId).replace(/^minecraft:/, '') !== 'player_head') return null;
  const profile = components?.['minecraft:profile'] || components?.profile;
  if (!profile) return null;
  const url = decodeProfileSkinUrl(profile);
  if (!url) return null;
  const skinBuf = await fetchSkinTexture(url);
  if (!skinBuf) return null;

  const skinPath = path.join(vanillaRoot, 'assets', 'minecraft', 'textures', 'entity', 'player', 'wide', 'steve.png');
  if (!exists(skinPath)) return null;
  let backup;
  try { backup = fs.readFileSync(skinPath); }
  catch (err) { console.warn(`Cannot back up default skin: ${err.message}`); return null; }
  try {
    fs.writeFileSync(skinPath, skinBuf);
  } catch (err) {
    console.warn(`Cannot overwrite default skin: ${err.message}`);
    return null;
  }
  return () => {
    try { fs.writeFileSync(skinPath, backup); } catch (err) { console.warn(`Failed to restore default skin: ${err.message}`); }
  };
}

async function renderItem(itemId, size, components) {
  const restoreSkin = await installCustomPlayerSkin(itemId, components);
  try {
    return await renderItemInner(itemId, size, components);
  } finally {
    if (restoreSkin) restoreSkin();
  }
}

async function renderItemInner(itemId, size, components) {
  const item = { item: itemId, components };
  const flat = await renderFlatItem(item, size);
  if (flat) return flat;
  if (DS) {
    try {
      const [ns, name] = idParts(itemId);
      const id   = DS.Identifier.parse(`${ns}:${name}`);
      const nbt  = componentsToNbt({ 'minecraft:item_model': itemId, ...components });
      const stack = new DS.ItemStack(id, 1, nbt);
      const res   = new Resources();
      const mesh  = DS.ItemRenderer.getItemMesh(stack, res, { display_context: 'gui' });
      if (mesh && !mesh.isEmpty()) {
        const atlas = await res.buildAtlas();
        if (atlas) return { buf: await normItem(rasterMesh(mesh, atlas, size), size), animated: false };
      }
    } catch { }
  }
  // Texture fallback chain
  const modelRef = s(components?.['minecraft:item_model'] || components?.item_model || '');
  const [mns, mname] = modelRef ? idParts(modelRef) : idParts(itemId);
  const [ins, iname] = idParts(itemId);
  const tex = findAsset(mns,'textures',`item/${mname}`,'.png') || findAsset(mns,'textures',`block/${mname}`,'.png')
    || findAsset(ins,'textures',`item/${iname}`,'.png') || findAsset(ins,'textures',`block/${iname}`,'.png');
  if (tex) return { buf: await normItem(await sharp(tex).ensureAlpha().resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(), size), animated: false };
  const { def } = readItemsDef(item);
  if (def?.model) {
    const blockRefs = collectFlatModelRefs(def.model, ins);
    if (blockRefs) for (const { modelRef: bref } of blockRefs) {
      const btex = extractFirstBlockTexture(bref);
      if (btex) return { buf: await normItem(await sharp(btex).ensureAlpha().resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(), size), animated: false };
    }
  }
  return null;
}

// ── background loader ──────────────────────────────────────────────────────
const bgCache = new Map();
const BG_FOR  = { crafting_table:'crafting_table.png', furnace:'furnace.png', smithing:'smithing.png', stonecutter:'stonecutter.png' };

async function loadBg(bgKey) {
  const file = BG_FOR[bgKey] ?? 'crafting_table.png';
  if (bgCache.has(file)) return bgCache.get(file);
  const buf = await sharp(path.join(gridsRoot, file)).ensureAlpha()
    .resize(BG_W * SCALE, BG_H * SCALE, { kernel: 'nearest' }).png().toBuffer();
  bgCache.set(file, buf);
  return buf;
}

// ── recipe collection ──────────────────────────────────────────────────────
function collectRecipes() {
  const out = [], dataRoot = path.join(repoRoot, 'data');
  if (!exists(dataRoot)) return out;
  for (const ns of fs.readdirSync(dataRoot)) {
    const nsDir = path.join(dataRoot, ns);
    try { if (!fs.statSync(nsDir).isDirectory()) continue; } catch { continue; }
    for (const folder of ['recipe', 'recipes']) {
      const root = path.join(nsDir, folder);
      if (!exists(root)) continue;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { stack.push(p); continue; }
          if (!e.name.endsWith('.json')) continue;
          const json = readJson(p);
          if (!json?.type) continue;
          const rel = path.relative(root, p).split(path.sep).join('/');
          out.push({ ns, file: p, rel, id: `${ns}:${rel.replace(/\.json$/, '')}`, json });
        }
      }
    }
  }
  return out;
}

// ── render one recipe ──────────────────────────────────────────────────────
async function renderRecipeImage(recipe) {
  const layout = getLayout(recipe);
  if (!layout || !layout.slots.length) return null;

  const bg = await loadBg(layout.bg);

  // Render each unique item once
  const itemCache = new Map();
  for (const slot of layout.slots) {
    for (const { itemId, components } of slot.items) {
      const key = `${itemId}|${JSON.stringify(components ?? {})}`;
      if (!itemCache.has(key)) {
        try {
          const r = await renderItem(itemId, ITEM_SIZE, components ?? {});
          itemCache.set(key, r?.buf ?? null);
        } catch { itemCache.set(key, null); }
      }
    }
  }

  const maxFrames = Math.max(...layout.slots.map(sl => sl.items.length), 1);
  const frames = [];
  for (let f = 0; f < maxFrames; f++) {
    const composites = [{ input: bg, left: 0, top: 0 }];
    for (const slot of layout.slots) {
      const ingr = slot.items[f % slot.items.length];
      const key  = `${ingr.itemId}|${JSON.stringify(ingr.components ?? {})}`;
      const buf  = itemCache.get(key);
      if (buf) {
        const inset = Math.round((((slot.interior ?? ITEM_1X) - ITEM_1X) / 2) * SCALE);
        composites.push({ input: buf, left: slot.pos.x * SCALE + inset, top: slot.pos.y * SCALE + inset });
      }
    }
    const frame = await sharp({ create: { width: BG_W*SCALE, height: BG_H*SCALE, channels: 4, background: {r:0,g:0,b:0,alpha:0} } })
      .composite(composites).png().toBuffer();
    frames.push(frame);
  }

  if (!frames.length) return null;
  if (frames.length === 1) return frames[0];
  return encodeApng(frames, 800);
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const recipes = collectRecipes();
  if (!recipes.length) { console.log('No recipe JSON files found; skipping recipe image generation.'); return; }
  console.log(`Recipe image output: ${outRoot}`);
  console.log(`Rendering ${recipes.length} recipe image(s)…`);

  let done = 0, animated = 0, errors = 0;
  for (const r of recipes) {
    const outDir  = path.join(outRoot, r.ns, 'recipe', path.dirname(r.rel));
    const outFile = path.join(outDir,  path.basename(r.rel, '.json') + '.png');
    fs.mkdirSync(outDir, { recursive: true });
    try {
      const buf = await renderRecipeImage(r.json);
      if (buf) {
        fs.writeFileSync(outFile, buf);
        done++;
        if (buf.slice(8, 60).includes(Buffer.from('acTL'))) animated++;
      }
    } catch (e) {
      errors++;
      console.warn(`Recipe image failed for ${r.id}: ${e.message}`);
    }
  }
  if (done)   console.log(`Generated ${done} recipe image(s) (${animated} animated) in ${outRoot}.`);
  if (errors) console.warn(`${errors} recipe image error(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
