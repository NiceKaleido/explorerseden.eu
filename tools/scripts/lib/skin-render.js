/*
 * Shared Minecraft player-skin isometric renderer core.
 *
 * Extracted from generate-player-skin-renders.js so both that script (local
 * NPC/mannequin skin textures bundled in data-pack repos) and
 * generate-player-profiles.js (skins downloaded from the Mojang session API)
 * can render from the same pipeline - the only difference is where the
 * source PNG buffer comes from.
 */
'use strict';

const { PNG } = require('pngjs');

const RENDER_SIZE = Number(process.env.PLAYER_SKIN_RENDER_SIZE || 512);
const SUPERSAMPLE = Math.max(1, Math.min(6, Number(process.env.PLAYER_SKIN_RENDER_SUPERSAMPLE || 4)));
const INTERNAL_SIZE = RENDER_SIZE * SUPERSAMPLE;
const PADDING = Number(process.env.PLAYER_SKIN_RENDER_PADDING || 0.12);
const CAMERA = {
  x: Number(process.env.PLAYER_SKIN_RENDER_CAMERA_X || -1.0),
  y: Number(process.env.PLAYER_SKIN_RENDER_CAMERA_Y || 0.72),
  z: Number(process.env.PLAYER_SKIN_RENDER_CAMERA_Z || -1.0),
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function dot(a, b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross(a, b) { return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x }; }
function sub(a, b) { return { x: a.x-b.x, y: a.y-b.y, z: a.z-b.z }; }
function len(a) { return Math.sqrt(dot(a, a)) || 1; }
function norm(a) { const l = len(a); return { x: a.x/l, y: a.y/l, z: a.z/l }; }

function buildCamera() {
  const forward = norm(CAMERA);
  let right = cross({ x: 0, y: 1, z: 0 }, forward);
  if (len(right) < 1e-6) right = { x: 1, y: 0, z: 0 };
  right = norm(right);
  const up = norm(cross(forward, right));
  return { forward, right, up };
}

function faceVerts(box, face) {
  const { minX, maxX, minY, maxY, minZ, maxZ } = box;
  switch (face) {
    case 'front': return [{x:minX,y:minY,z:minZ},{x:maxX,y:minY,z:minZ},{x:maxX,y:maxY,z:minZ},{x:minX,y:maxY,z:minZ}];
    case 'back': return [{x:maxX,y:minY,z:maxZ},{x:minX,y:minY,z:maxZ},{x:minX,y:maxY,z:maxZ},{x:maxX,y:maxY,z:maxZ}];
    case 'left': return [{x:minX,y:minY,z:maxZ},{x:minX,y:minY,z:minZ},{x:minX,y:maxY,z:minZ},{x:minX,y:maxY,z:maxZ}];
    case 'right': return [{x:maxX,y:minY,z:minZ},{x:maxX,y:minY,z:maxZ},{x:maxX,y:maxY,z:maxZ},{x:maxX,y:maxY,z:minZ}];
    case 'top': return [{x:minX,y:maxY,z:minZ},{x:maxX,y:maxY,z:minZ},{x:maxX,y:maxY,z:maxZ},{x:minX,y:maxY,z:maxZ}];
    case 'bottom': return [{x:minX,y:minY,z:maxZ},{x:maxX,y:minY,z:maxZ},{x:maxX,y:minY,z:minZ},{x:minX,y:minY,z:minZ}];
    default: throw new Error(`Unknown face ${face}`);
  }
}

function uvQuad(rect) {
  const [x0, y0, x1, y1] = rect;
  return [{u:x0,v:y1},{u:x1,v:y1},{u:x1,v:y0},{u:x0,v:y0}];
}

function addBox(tris, box, uv, layer = false) {
  const faces = ['front','back','left','right','top','bottom'];
  for (const face of faces) {
    const rect = uv[face];
    if (!rect) continue;
    const v = faceVerts(box, face);
    const t = uvQuad(rect);
    const a = { ...v[0], ...t[0] }, b = { ...v[1], ...t[1] }, c = { ...v[2], ...t[2] }, d = { ...v[3], ...t[3] };
    tris.push(Object.assign([a, c, b], { layer }));
    tris.push(Object.assign([a, d, c], { layer }));
  }
}

function expandBox(b, n) {
  return { minX:b.minX-n, maxX:b.maxX+n, minY:b.minY-n, maxY:b.maxY+n, minZ:b.minZ-n, maxZ:b.maxZ+n };
}

function uvHead(x, y) { return { top:[x+8,y,x+16,y+8], bottom:[x+16,y,x+24,y+8], right:[x,y+8,x+8,y+16], front:[x+8,y+8,x+16,y+16], left:[x+16,y+8,x+24,y+16], back:[x+24,y+8,x+32,y+16] }; }
function uvBody(x, y) { return { top:[x+4,y,x+12,y+4], bottom:[x+12,y,x+20,y+4], right:[x,y+4,x+4,y+16], front:[x+4,y+4,x+12,y+16], left:[x+12,y+4,x+16,y+16], back:[x+16,y+4,x+24,y+16] }; }
function uvArm(x, y, slim) { const w = slim ? 3 : 4; return { top:[x+4,y,x+4+w,y+4], bottom:[x+4+w,y,x+4+w+w,y+4], right:[x,y+4,x+4,y+16], front:[x+4,y+4,x+4+w,y+16], left:[x+4+w,y+4,x+8+w,y+16], back:[x+8+w,y+4,x+8+w+w,y+16] }; }
function uvLeg(x, y) { return { top:[x+4,y,x+8,y+4], bottom:[x+8,y,x+12,y+4], right:[x,y+4,x+4,y+16], front:[x+4,y+4,x+8,y+16], left:[x+8,y+4,x+12,y+16], back:[x+12,y+4,x+16,y+16] }; }

function mirrorLimbUV(uv) {
  function flip([x0, y0, x1, y1]) { return [x1, y0, x0, y1]; }
  return {
    front:  flip(uv.front),
    back:   flip(uv.back),
    left:   flip(uv.right),
    right:  flip(uv.left),
    top:    flip(uv.top),
    bottom: flip(uv.bottom),
  };
}

function buildPlayerTriangles(model, texHeight) {
  const slim = model === 'slim';
  const legacy = texHeight <= 32;
  const armW = slim ? 3 : 4;
  const tris = [];
  const head = { minX:-4,maxX:4,minY:24,maxY:32,minZ:-4,maxZ:4 };
  const body = { minX:-4,maxX:4,minY:12,maxY:24,minZ:-2,maxZ:2 };
  const rightArm = { minX:-4-armW,maxX:-4,minY:12,maxY:24,minZ:-2,maxZ:2 };
  const leftArm = { minX:4,maxX:4+armW,minY:12,maxY:24,minZ:-2,maxZ:2 };
  const rightLeg = { minX:-4,maxX:0,minY:0,maxY:12,minZ:-2,maxZ:2 };
  const leftLeg = { minX:0,maxX:4,minY:0,maxY:12,minZ:-2,maxZ:2 };

  addBox(tris, head, uvHead(0, 0));
  addBox(tris, body, uvBody(16, 16));
  addBox(tris, rightArm, uvArm(40, 16, slim));
  addBox(tris, rightLeg, uvLeg(0, 16));

  if (legacy) {
    addBox(tris, leftLeg, mirrorLimbUV(uvLeg(0, 16)));
    addBox(tris, leftArm, mirrorLimbUV(uvArm(40, 16, slim)));
  } else {
    addBox(tris, leftLeg, uvLeg(16, 48));
    addBox(tris, leftArm, uvArm(32, 48, slim));
  }

  const o = 0.28;
  addBox(tris, expandBox(head, o), uvHead(32, 0), true);
  if (!legacy) {
    addBox(tris, expandBox(body, o), uvBody(16, 32), true);
    addBox(tris, expandBox(rightArm, o), uvArm(40, 32, slim), true);
    addBox(tris, expandBox(rightLeg, o), uvLeg(0, 32), true);
    addBox(tris, expandBox(leftLeg, o), uvLeg(0, 48), true);
    addBox(tris, expandBox(leftArm, o), uvArm(48, 48, slim), true);
  }
  return tris;
}

function transformTriangles(tris) {
  const camera = buildCamera();
  let minSX = Infinity, minSY = Infinity, maxSX = -Infinity, maxSY = -Infinity;
  const center = { x: 0, y: 16, z: 0 };
  const out = [];
  for (const tri of tris) {
    const world = tri.map(p => ({ x:p.x-center.x, y:p.y-center.y, z:p.z-center.z, u:p.u, v:p.v }));
    const n = norm(cross(sub(world[1], world[0]), sub(world[2], world[0])));
    const projected = world.map(p => {
      const sx = dot(p, camera.right);
      const sy = dot(p, camera.up);
      const depth = dot(p, camera.forward) + (tri.layer ? 1e-4 : 0);
      minSX = Math.min(minSX, sx); maxSX = Math.max(maxSX, sx);
      minSY = Math.min(minSY, sy); maxSY = Math.max(maxSY, sy);
      return { sx, sy, depth, u:p.u, v:p.v };
    });
    const light = clamp(0.72 + 0.28 * Math.max(0, dot(n, norm({x:-0.4,y:0.9,z:-0.6}))), 0.72, 1.0);
    out.push({ p: projected, light, layer: !!tri.layer });
  }
  const spanX = Math.max(0.001, maxSX - minSX);
  const spanY = Math.max(0.001, maxSY - minSY);
  const scale = INTERNAL_SIZE * (1 - PADDING * 2) / Math.max(spanX, spanY);
  const cx = (minSX + maxSX) / 2;
  const cy = (minSY + maxSY) / 2;
  for (const tri of out) for (const p of tri.p) {
    p.x = INTERNAL_SIZE / 2 + (p.sx - cx) * scale;
    p.y = INTERNAL_SIZE / 2 - (p.sy - cy) * scale;
  }
  return out;
}

function sampleTexture(tex, uPx, vPx) {
  const x = Math.floor(uPx);
  const y = Math.floor(vPx);
  if (x < 0 || y < 0 || x >= tex.width || y >= tex.height) return [0,0,0,0];
  const i = (y * tex.width + x) * 4;
  return [tex.data[i], tex.data[i+1], tex.data[i+2], tex.data[i+3]];
}

function edge(ax, ay, bx, by, cx, cy) { return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax); }

function rasterTriangle(color, depth, tri, tex) {
  const [a,b,c] = tri.p;
  const area = edge(a.x,a.y,b.x,b.y,c.x,c.y);
  if (Math.abs(area) < 1e-8) return 0;
  const minX = clamp(Math.floor(Math.min(a.x,b.x,c.x))-1, 0, INTERNAL_SIZE-1);
  const maxX = clamp(Math.ceil(Math.max(a.x,b.x,c.x))+1, 0, INTERNAL_SIZE-1);
  const minY = clamp(Math.floor(Math.min(a.y,b.y,c.y))-1, 0, INTERNAL_SIZE-1);
  const maxY = clamp(Math.ceil(Math.max(a.y,b.y,c.y))+1, 0, INTERNAL_SIZE-1);
  let painted = 0;
  for (let y=minY; y<=maxY; y++) for (let x=minX; x<=maxX; x++) {
    const px=x+0.5, py=y+0.5;
    const w0=edge(b.x,b.y,c.x,c.y,px,py)/area;
    const w1=edge(c.x,c.y,a.x,a.y,px,py)/area;
    const w2=edge(a.x,a.y,b.x,b.y,px,py)/area;
    if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;
    const z = w0*a.depth + w1*b.depth + w2*c.depth;
    const di = y * INTERNAL_SIZE + x;
    if (z <= depth[di] + 1e-7) continue;
    const u = w0*a.u + w1*b.u + w2*c.u;
    const v = w0*a.v + w1*b.v + w2*c.v;
    let [r,g,bl,alpha] = sampleTexture(tex, u, v);
    if (alpha <= 8) continue;
    r = clamp(Math.round(r * tri.light), 0, 255);
    g = clamp(Math.round(g * tri.light), 0, 255);
    bl = clamp(Math.round(bl * tri.light), 0, 255);
    const oi = di * 4;
    if (tri.layer && alpha < 248 && color[oi+3] > 8) {
      const a2 = alpha / 255;
      const ea = color[oi+3] / 255;
      const oa = 1 - a2;
      const outA = a2 + ea * oa;
      color[oi]   = clamp(Math.round((r * a2 + color[oi]   * ea * oa) / outA), 0, 255);
      color[oi+1] = clamp(Math.round((g * a2 + color[oi+1] * ea * oa) / outA), 0, 255);
      color[oi+2] = clamp(Math.round((bl* a2 + color[oi+2] * ea * oa) / outA), 0, 255);
      color[oi+3] = clamp(Math.round(outA * 255), 0, 255);
    } else {
      color[oi]=r; color[oi+1]=g; color[oi+2]=bl; color[oi+3]=alpha;
    }
    depth[di]=z;
    painted++;
  }
  return painted;
}

function visiblePixels(data) { let n=0; for (let i=3;i<data.length;i+=4) if (data[i] > 8) n++; return n; }

function downsampleBox(src, sw, sh, factor) {
  if (factor <= 1) return { width: sw, height: sh, data: src };
  const dw = Math.floor(sw / factor), dh = Math.floor(sh / factor);
  const out = Buffer.alloc(dw * dh * 4, 0);
  for (let y=0; y<dh; y++) for (let x=0; x<dw; x++) {
    let r=0,g=0,b=0,a=0;
    for (let yy=0; yy<factor; yy++) for (let xx=0; xx<factor; xx++) {
      const si = ((y*factor+yy)*sw + (x*factor+xx))*4;
      const alpha = src[si+3] / 255;
      r += src[si] * alpha; g += src[si+1] * alpha; b += src[si+2] * alpha; a += alpha;
    }
    const samples = factor * factor;
    const oi = (y*dw+x)*4;
    if (a > 0) { out[oi]=Math.round(r/a); out[oi+1]=Math.round(g/a); out[oi+2]=Math.round(b/a); out[oi+3]=Math.round(clamp(a/samples,0,1)*255); }
  }
  return { width: dw, height: dh, data: out };
}

function trimTransparent(img, pad) {
  const { width, height, data } = img;
  let minX=width, minY=height, maxX=-1, maxY=-1;
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) if (data[(y*width+x)*4+3] > 8) {
    minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
  }
  if (maxX < minX) return img;
  minX=clamp(minX-pad,0,width-1); minY=clamp(minY-pad,0,height-1); maxX=clamp(maxX+pad,0,width-1); maxY=clamp(maxY+pad,0,height-1);
  const tw=maxX-minX+1, th=maxY-minY+1;
  const out=Buffer.alloc(tw*th*4,0);
  for (let y=0; y<th; y++) for (let x=0; x<tw; x++) {
    const si=((minY+y)*width+(minX+x))*4, oi=(y*tw+x)*4;
    data.copy(out, oi, si, si+4);
  }
  return { width:tw, height:th, data:out };
}

function containToSquare(img, size) {
  const scale = Math.min(size / img.width, size / img.height);
  const nw = Math.max(1, Math.round(img.width * scale));
  const nh = Math.max(1, Math.round(img.height * scale));
  const resized = Buffer.alloc(nw * nh * 4, 0);
  for (let y=0; y<nh; y++) for (let x=0; x<nw; x++) {
    const sx = Math.min(img.width - 1, Math.floor(x / scale));
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    const si = (sy * img.width + sx) * 4;
    const oi = (y * nw + x) * 4;
    img.data.copy(resized, oi, si, si+4);
  }
  const out = Buffer.alloc(size * size * 4, 0);
  const ox = Math.floor((size - nw) / 2), oy = Math.floor((size - nh) / 2);
  for (let y=0; y<nh; y++) for (let x=0; x<nw; x++) {
    const si=(y*nw+x)*4, oi=((oy+y)*size+(ox+x))*4;
    resized.copy(out, oi, si, si+4);
  }
  return { width:size, height:size, data:out };
}

function readTexture(textureBuffer) {
  const png = PNG.sync.read(textureBuffer);
  const texture = { width: png.width, height: png.height, data: png.data };
  if (texture.width < 64 || texture.height < 32) {
    throw new Error(`Expected a Minecraft skin texture at least 64x32, got ${texture.width}x${texture.height}`);
  }
  return texture;
}

// Renders an in-memory skin PNG buffer to a final composited/trimmed PNG buffer.
function renderSkinBufferToPng(textureBuffer, model) {
  const texture = readTexture(textureBuffer);
  const tris = transformTriangles(buildPlayerTriangles(model, texture.height));
  const color = Buffer.alloc(INTERNAL_SIZE * INTERNAL_SIZE * 4, 0);
  const depth = new Float32Array(INTERNAL_SIZE * INTERNAL_SIZE);
  depth.fill(-Infinity);
  let painted = 0;
  for (const tri of tris) painted += rasterTriangle(color, depth, tri, texture);
  if (painted < 20 || visiblePixels(color) < 20) {
    throw new Error('Player skin render produced no visible pixels');
  }
  const low = downsampleBox(color, INTERNAL_SIZE, INTERNAL_SIZE, SUPERSAMPLE);
  const trimmed = trimTransparent(low, Math.round(RENDER_SIZE * 0.035));
  const finalImg = containToSquare(trimmed, RENDER_SIZE);
  const outPng = new PNG({ width: finalImg.width, height: finalImg.height });
  finalImg.data.copy(outPng.data);
  return PNG.sync.write(outPng);
}

// ── Flat front-facing face icon (no 3D perspective) ──────────────────────────
// Straight pixel crop of the head's front face (base layer) with the hat
// overlay's front face composited on top, then nearest-neighbor upscaled -
// the classic Minecraft "face avatar" look, not a rendered/lit 3D box.

function cropRegion(texture, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    const si = ((y0 + y) * texture.width + x0) * 4;
    const oi = (y * w) * 4;
    texture.data.copy(out, oi, si, si + w * 4);
  }
  return { width: w, height: h, data: out };
}

function compositeOver(base, overlay) {
  const out = Buffer.from(base.data);
  for (let i = 0; i < out.length; i += 4) {
    const oa = overlay.data[i + 3] / 255;
    if (oa <= 0) continue;
    const ea = out[i + 3] / 255;
    const outA = oa + ea * (1 - oa);
    if (outA <= 0) continue;
    out[i]   = clamp(Math.round((overlay.data[i]   * oa + out[i]   * ea * (1 - oa)) / outA), 0, 255);
    out[i+1] = clamp(Math.round((overlay.data[i+1] * oa + out[i+1] * ea * (1 - oa)) / outA), 0, 255);
    out[i+2] = clamp(Math.round((overlay.data[i+2] * oa + out[i+2] * ea * (1 - oa)) / outA), 0, 255);
    out[i+3] = clamp(Math.round(outA * 255), 0, 255);
  }
  return { width: base.width, height: base.height, data: out };
}

function nearestUpscale(img, size) {
  const scale = size / img.width;
  const out = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4;
      const oi = (y * size + x) * 4;
      img.data.copy(out, oi, si, si + 4);
    }
  }
  return { width: size, height: size, data: out };
}

function renderSkinFaceBufferToPng(textureBuffer, size = 128) {
  const texture = readTexture(textureBuffer);
  const base = cropRegion(texture, 8, 8, 8, 8);
  const overlay = cropRegion(texture, 40, 8, 8, 8);
  const composited = compositeOver(base, overlay);
  const upscaled = nearestUpscale(composited, size);
  const outPng = new PNG({ width: size, height: size });
  upscaled.data.copy(outPng.data);
  return PNG.sync.write(outPng);
}

module.exports = {
  renderSkinBufferToPng,
  renderSkinFaceBufferToPng,
  buildPlayerTriangles,
  transformTriangles,
  rasterTriangle,
};
