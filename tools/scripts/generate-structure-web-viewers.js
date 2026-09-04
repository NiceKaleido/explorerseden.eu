#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const preview = require('./generate-structure-previews.js');

const outputRoot = process.env.STRUCTURE_WEB_OUTPUT_ROOT
  || path.join(process.env.STRUCTURE_WEB_SITE_ROOT || path.join(process.cwd(), 'structure-viewer-site'), 'structures');
const siteRoot = process.env.STRUCTURE_WEB_SITE_ROOT || path.resolve(outputRoot, '..', '..');
const wikiOutputRoot = process.env.WIKI_OUTPUT_ROOT || path.join(process.cwd(), 'wiki');
const dataPackName = process.env.WIKI_DATAPACK_NAME || path.basename(wikiOutputRoot);
const dataPackSlug = process.env.WIKI_DATAPACK_SLUG || dataPackName;
const logoPath='/assets/images/branding/ee_title_default.png';
const hubTitlePath = 'assets/images/branding/structures_title.png';
const faviconPath = 'assets/images/icons/favicon.ico';

// data-pack slug → Modrinth project slug. Most are 1:1 after underscore→dash,
// but Nice Things is published as 'nice-things-eden' because 'nice-things' was
// taken on Modrinth. Used to put a "View on Modrinth" link in the structure
// viewer sidebar so visitors can jump straight to the data pack page.
const MODRINTH_PROJECT_SLUGS = {
  a_realm_recrafted: 'a-realm-recrafted',
  enchantments_encore: 'enchantments-encore',
  fabled_roots: 'fabled-roots',
  katters_structures: 'katters-structures',
  nice_actions: 'nice-actions',
  nice_admin_tools: 'nice-admin-tools',
  nice_keep_inventory: 'nice-keep-inventory',
  nice_mob_manager: 'nice-mob-manager',
  nice_mob_variants: 'nice-mob-variants',
  nice_name_tags: 'nice-name-tags',
  nice_things: 'nice-things-eden',
  warping_wonders: 'warping-wonders'
};
function modrinthUrlForCurrentPack() {
  const slug = MODRINTH_PROJECT_SLUGS[dataPackSlug];
  return slug ? `https://modrinth.com/datapack/${slug}` : null;
}
function siteAsset(rel, fromDir = siteRoot) { return relFrom(fromDir, path.join(siteRoot, rel)); }

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toAbsoluteStructureUrl(raw, fallback = '') {
  if (!raw) return fallback;
  if (raw.startsWith('/')) return raw;
  return '/structures/' + raw;
}

function structureUrl(item) {
  return toAbsoluteStructureUrl(String(item && item.url ? item.url : ''), '#');
}

function structurePreviewUrl(src) {
  return toAbsoluteStructureUrl(String(src || ''));
}

function colorToHex(color) { const c = color || {r:136,g:136,b:136}; return '#' + [c.r,c.g,c.b].map(v => Math.max(0, Math.min(255, Number(v)||0)).toString(16).padStart(2,'0')).join(''); }
function textureKey(texture) { return texture?.__assetPath || null; }
function textureDataUrl(texture) {
  if (!texture) return null;
  // Animated textures (height > width) must be cropped to their first frame
  // before passing to WebGL — otherwise the UV coordinates [0,1] sample across
  // all animation frames and produce a vertically-stretched, wrong-coloured texture.
  if (texture.height > texture.width) {
    const buf = preview.getFirstFrameBuffer(texture);
    if (buf) return `data:image/png;base64,${buf.toString('base64')}`;
  }
  const assetPath = textureKey(texture);
  if (!assetPath) return null;
  const buf = preview.readAssetBuffer(assetPath);
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
}
function addTri(arr, a,b,c) { arr.push(a.x,a.y,a.z,b.x,b.y,b.z,c.x,c.y,c.z); }
function addUv(arr, a,b,c) { arr.push(a.u,a.v,b.u,b.v,c.u,c.v); }
function relFrom(fromDir, toFile) { return path.relative(fromDir, toFile).split(path.sep).join('/'); }
function titleCaseWords(value) {
  return String(value || '')
    .replace(/^minecraft:/, '')
    .replace(/^#/, '')
    .split(/[\s_/-]+/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
function blockDisplayName(id) { return titleCaseWords(String(id).split(':').pop()); }
function structureDisplayName(outputName) {
  const parts = String(outputName || '').split('/').filter(Boolean);
  const last = parts.pop() || outputName || 'Structure';
  const match = String(last).match(/^(.*?)[_-]?(\d+)$/);
  if (match && match[1]) return `${titleCaseWords(match[1])} (${match[2]})`;
  return titleCaseWords(last);
}
function sourceStructureId(group) {
  if (group.sourceId) return group.sourceId;
  if (group.id) return group.id;
  return `${group.namespace}:${group.outputName}`;
}
function sourcePathFromId(id) {
  return String(id || '').split(':').slice(1).join(':') || String(id || '');
}
function structureDisplayNameForGroup(group) {
  return structureDisplayName(group.outputName);
}
function copyButtonLabel(structureId) {
  const id = String(structureId || '');
  return id.length > 34 ? 'Copy Structure ID' : id;
}
function shortName(name) { return String(name || '').replace(/^minecraft:/, ''); }
function shouldSkipRenderedBlock(name) {
  // Water is intentionally invisible. All other blocks attempt to bake.
  return shortName(String(name || '')) === 'water';
}
function isBlendTransparentBlock(name) {
  const s = shortName(name);
  return s.includes('glass') || s === 'honey_block' || s === 'slime_block';
}
function textureHasAlpha(texture) {
  if (!texture || !texture.data) return false;
  const data = texture.data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}
function isCutoutBlock(name) {
  const s = shortName(name);
  if (isBlendTransparentBlock(s)) return false;
  // Catch the common partial-geometry / alpha-textured blocks. The trailing
  // explicit-flower list is because flower block IDs like "poppy" or "allium"
  // contain none of the descriptive substrings above.
  return /leaves|vine|lichen|sculk_vein|roots|grass$|tall_grass|fern|sapling|flower|petals|torch|lantern|chain|rail|door|trapdoor|cobweb|web$|seagrass|kelp|coral|mushroom|dead_bush|bamboo|azalea|dripleaf|lily_pad|candle|campfire|sign|hanging_sign|pane|bars|spore_blossom|hanging_roots|pitcher_plant|pitcher_crop|sweet_berry_bush|nether_wart|crops|stem$|wheat|carrots|potatoes|beetroots|cocoa|sea_pickle|cactus|sugar_cane|sniffer_egg|frogspawn|turtle_egg|amethyst|end_rod|lightning_rod|tripwire|pointed_dripstone|brewing_stand|cauldron|lectern|grindstone|cake|composter|bell$|conduit|decorated_pot|stonecutter|flower_pot|^fire$|^soul_fire$|trial_spawner|vault|^water$|^lava$|^poppy$|^dandelion$|^blue_orchid$|^allium$|^azure_bluet$|^red_tulip$|^orange_tulip$|^white_tulip$|^pink_tulip$|^oxeye_daisy$|^cornflower$|^lily_of_the_valley$|^wither_rose$|^torchflower$|^closed_eyeblossom$|^open_eyeblossom$|^sunflower$|^lilac$|^rose_bush$|^peony$|^pitcher_plant$|^pink_petals$|^big_dripleaf$|^small_dripleaf$|^short_grass$|^tall_grass$|^large_fern$|^crimson_roots$|^warped_roots$|^crimson_fungus$|^warped_fungus$|^nether_sprouts$|^chorus_plant$|^chorus_flower$|^twisting_vines$|^weeping_vines$|^twisting_vines_plant$|^weeping_vines_plant$|^hanging_roots$|^moss_carpet$|^pale_moss_carpet$/.test(s);
}
function renderModeForBlock(name) {
  if (isBlendTransparentBlock(name)) return 'blend';
  if (isCutoutBlock(name)) return 'cutout';
  return 'opaque';
}
function isBarrelLike(name) { return /(^|:)barrel$/.test(String(name)); }
// Returns true only for blocks whose baked model is a solid full-cube, making
// them safe to use as face-occlusion neighbours.  Partial-geometry blocks
// (stairs, slabs, levers, doors, fences, …) must be excluded so their
// neighbouring faces are never incorrectly culled.
function isFullCubeOpaqueBlock(name) {
  if (renderModeForBlock(name) !== 'opaque') return false;
  const s = shortName(name);
  // Exclude every block that isn't a complete 1×1×1 solid cube — otherwise a
  // neighbour's face touching this block gets incorrectly culled (e.g. a log
  // adjacent to cocoa loses its log face, a stone block next to a dirt_path
  // shows a gap where the path is 1/16 short).
  return !/slab|stair|wall$|fence|gate|_plate|trapdoor|_door|button|lever|torch|lantern|chain|piston|shulker_box|chest|_bed|banner|sign|skull|_head$|conduit|bell|decorated_pot|candle|anvil|scaffolding|stonecutter|cauldron|composter|hopper|repeater|comparator|daylight_detector|lightning_rod|tripwire|spore_blossom|pointed_dripstone|_carpet|snow$|cocoa|_path$|farmland|cake|end_portal_frame|end_rod|lectern|brewing_stand|sea_pickle|sniffer_egg|^vault$|bamboo$|dripleaf|amethyst|flower_pot|^potted_|^ladder$|^fire$|soul_fire|cobweb|web$|frogspawn|turtle_egg|pink_petals|spore_blossom|grindstone|bell$|trial_spawner|^vault$|pitcher_crop|pitcher_pod|sweet_berry_bush|cactus|sugar_cane|kelp|seagrass|coral|sapling|wheat|carrots|potatoes|beetroots|^water$|^lava$|crops|stem$/.test(s);
}

function textureFor(asset) {
  const tex = preview.readTextureAsset(asset);
  return tex || null;
}

function cubeQuadsWithTextures(blockName, textures = {}) {
  const side = textures.side || textures.all || textureFor('assets/minecraft/textures/block/oak_planks.png');
  const top = textures.top || side;
  const bottom = textures.bottom || side;
  const uv=[0,0,16,16];
  const faces={
    up:{texture:top, faceName:'up', uv, points:[{x:0,y:1,z:0},{x:1,y:1,z:0},{x:1,y:1,z:1},{x:0,y:1,z:1}]},
    down:{texture:bottom, faceName:'down', uv, points:[{x:0,y:0,z:1},{x:1,y:0,z:1},{x:1,y:0,z:0},{x:0,y:0,z:0}]},
    north:{texture:side, faceName:'north', uv, points:[{x:1,y:1,z:0},{x:0,y:1,z:0},{x:0,y:0,z:0},{x:1,y:0,z:0}]},
    south:{texture:side, faceName:'south', uv, points:[{x:0,y:1,z:1},{x:1,y:1,z:1},{x:1,y:0,z:1},{x:0,y:0,z:1}]},
    west:{texture:side, faceName:'west', uv, points:[{x:0,y:1,z:0},{x:0,y:1,z:1},{x:0,y:0,z:1},{x:0,y:0,z:0}]},
    east:{texture:side, faceName:'east', uv, points:[{x:1,y:1,z:1},{x:1,y:1,z:0},{x:1,y:0,z:0},{x:1,y:0,z:1}]}
  };
  return Object.values(faces).map(q => ({...q, blockName}));
}


function solidColorTextureKey(color) {
  const c = color || { r: 255, g: 255, b: 255, a: 255 };
  return `solid:${c.r},${c.g},${c.b},${c.a ?? 255}`;
}

function fallbackCubeQuads(blockName) {
  const short = blockName.replace(/^minecraft:/, '');
  let side = textureFor('assets/minecraft/textures/block/oak_planks.png');
  let top = side;
  if (short === 'barrel') {
    side = textureFor('assets/minecraft/textures/block/barrel_side.png') || side;
    top = textureFor('assets/minecraft/textures/block/barrel_top.png') || side;
  }
  return cubeQuadsWithTextures(blockName, { side, top, bottom: side });
}

function quadsForBlock(block) {
  if (shouldSkipRenderedBlock(block.name)) return [];

  const quads = preview.bakeBlockModel(block.name, block.properties || {}) || [];
  if (quads.length > 0 && quads.some(q => q.texture)) return quads;
  if (quads.length > 0) return quads;

  // Barrel has a normal cube-like model in some asset sets, but if missing, a
  // texture-correct cube is still acceptable. Everything else is skipped.
  if (isBarrelLike(block.name)) return fallbackCubeQuads(block.name);
  return [];
}

// Returns the [dx,dy,dz] neighbor offset for the direction a quad's face is
// pointing, or null if the face isn't flush with the block boundary.
// Uses the quad's block-local points (0–1 space) to detect axis and side.
function neighborOffset(quad) {
  const pts = quad.points;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y), zs = pts.map(p => p.z);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const spanZ = Math.max(...zs) - Math.min(...zs);
  const avgX = xs.reduce((a,b)=>a+b,0)/xs.length;
  const avgY = ys.reduce((a,b)=>a+b,0)/ys.length;
  const avgZ = zs.reduce((a,b)=>a+b,0)/zs.length;
  if (spanX <= spanY && spanX <= spanZ) {
    if (avgX > 0.98) return [1,0,0]; if (avgX < 0.02) return [-1,0,0];
  } else if (spanY <= spanX && spanY <= spanZ) {
    if (avgY > 0.98) return [0,1,0]; if (avgY < 0.02) return [0,-1,0];
  } else {
    if (avgZ > 0.98) return [0,0,1]; if (avgZ < 0.02) return [0,0,-1];
  }
  return null;
}

function createGeometryPayload(blocks) {
  blocks = preview.computeConnectionProperties(blocks);
  const materialMap = new Map();
  const blockCounts = new Map();
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  // Set of positions occupied by full-cube opaque blocks, used for face culling.
  // Any opaque quad (whether from a full-cube or partial-geometry block) whose
  // outward normal points into one of these positions is skipped — it is either
  // fully occluded (full-cube case) or coplanar with the neighbour's face and
  // would z-fight (partial-geometry case, e.g. button against a stone wall).
  const opaquePositions = new Set();
  for (const block of blocks) {
    if (isFullCubeOpaqueBlock(block.name)) opaquePositions.add(`${block.x},${block.y},${block.z}`);
  }
  for (const block of blocks) {
    blockCounts.set(block.name, (blockCounts.get(block.name) || 0) + 1);
    bounds.minX = Math.min(bounds.minX, block.x); bounds.maxX = Math.max(bounds.maxX, block.x + 1);
    bounds.minY = Math.min(bounds.minY, block.y); bounds.maxY = Math.max(bounds.maxY, block.y + 1);
    bounds.minZ = Math.min(bounds.minZ, block.z); bounds.maxZ = Math.max(bounds.maxZ, block.z + 1);
    for (const quad of quadsForBlock(block)) {
      const texKey = textureKey(quad.texture);
      let renderMode = renderModeForBlock(block.name);
      if (renderMode === 'opaque' && textureHasAlpha(quad.texture)) renderMode = 'cutout';
      // Cull only truly opaque axis-aligned faces whose outward direction points
      // into an adjacent full-cube opaque block. Cutout faces (trial_spawner
      // cage, leaves, iron_bars, etc.) are NOT culled — their inside back is
      // visible through their own transparent pixels, and culling them creates
      // visible holes (trial_spawner bottom missing when stone sits below).
      // Wall-cling blocks (vine, lichen, sculk_vein) are also excluded — their
      // faces point at the wall they cling to which IS in opaquePositions, but
      // those faces are the vine surface and must remain visible.
      const isWallCling = /^(vine|glow_lichen|sculk_vein)$/.test(shortName(block.name));
      if (!isWallCling && renderMode === 'opaque') {
        const off = neighborOffset(quad);
        if (off) {
          const nk = `${block.x+off[0]},${block.y+off[1]},${block.z+off[2]}`;
          if (opaquePositions.has(nk)) continue;
        }
      }
      // Promote diagonal cross-model quads to 'cross' BEFORE the key is
      // computed so the material bucket gets the correct renderMode.
      if (renderMode === 'cutout' && !neighborOffset(quad)) {
        const pts = quad.points;
        const spanX = Math.max(...pts.map(p=>p.x)) - Math.min(...pts.map(p=>p.x));
        const spanY = Math.max(...pts.map(p=>p.y)) - Math.min(...pts.map(p=>p.y));
        const spanZ = Math.max(...pts.map(p=>p.z)) - Math.min(...pts.map(p=>p.z));
        if (Math.min(spanX, spanY, spanZ) > 0.4) renderMode = 'cross';
      }
      const solidKey = quad.solidColor ? solidColorTextureKey(quad.solidColor) : null;
      const tintKey = quad.colorTint
        ? `tint:${quad.colorTint.r},${quad.colorTint.g},${quad.colorTint.b}`
        : (quad.tintIndex ?? 'no-tint');
      const key = `${renderMode}:${texKey || solidKey || block.name + ':' + quad.faceName}:${tintKey}`;
      if (!materialMap.has(key)) {
        const avg = quad.texture ? preview.averageOpaqueTextureColor(quad.texture) : null;
        const base = quad.solidColor || avg || preview.fallbackColorForBlock(block.name);
        const texPath = quad.texture?.__assetPath;
        const shouldTint = shortName(block.name) !== 'pale_oak_leaves' && (quad.tintIndex !== undefined && quad.tintIndex !== null);
        const tinted = shouldTint ? preview.applyBiomeTint(base, block.name, quad.faceName, texPath) : base;
        const blend = renderMode === 'blend';
        const alpha = blend ? Math.min(tinted.a ?? 255, 170) : 255;
        // For textured quads, materialColor must be the tint applied to white so
        // THREE.js (texture × materialColor) produces the correct result.
        // Using avg_color × tint caused double-multiplication that was too dark.
        const tintWhite = shouldTint ? preview.applyBiomeTint({ r: 255, g: 255, b: 255, a: 255 }, block.name, quad.faceName, texPath) : null;
        // colorTint comes from deepslate's per-vertex setColor (banners, etc.).
        // Apply it as the material color so texture × tint produces the dyed result.
        const materialColor = quad.colorTint
          ? { ...quad.colorTint, a: alpha }
          : quad.texture
            ? (shouldTint ? tintWhite : { r: 255, g: 255, b: 255, a: 255 })
            : tinted;
        materialMap.set(key, { key, texture: texKey ? textureDataUrl(quad.texture) : null, source: texKey, color: colorToHex(materialColor), renderMode, transparent: blend, cutout: renderMode === 'cutout', hasAlphaTexture: !!texKey, opacity: blend ? Math.max(0.22, Math.min(0.67, alpha / 255)) : 1, positions: [], uvs: [] });
      }
      const mat = materialMap.get(key);
      // Prevent coplanar z-fighting for cutout geometry:
      // • Axis-aligned boundary faces: nudge 0.001 inward (away from boundary)
      //   so they clear the adjacent opaque face. Wall-cling blocks (vine, lichen)
      //   are already positioned at ±0.001 by snapWallClingFaces and must not be
      //   nudged further — leave them untouched.
      // • Diagonal quads (cross models: plants, azalea, …): push 0.002 along the
      //   face normal so the ±45° panels physically separate at their intersection.
      let quadPoints = quad.points;
      if (renderMode === 'cutout' || renderMode === 'cross') {
        const off = neighborOffset(quad);
        if (off && renderMode === 'cutout' && !isWallCling) {
          const [dx, dy, dz] = off;
          quadPoints = quad.points.map(p => ({
            x: p.x - dx * 0.001,
            y: p.y - dy * 0.001,
            z: p.z - dz * 0.001
          }));
        } else if (!off) {
          // Quad isn't axis-aligned with a block boundary. Two distinct cases:
          //   (1) Truly diagonal panels (cross-model plants, chains, iron bars
          //       with rotated elements): push 0.008 along the face normal to
          //       physically separate the two intersecting ±45° panels and stop
          //       camera-drag depth flicker.
          //   (2) Interior axis-aligned faces (bell body, bed mattress, chest
          //       lid, etc. — entity-renderer geometry where elements live
          //       fully inside the block): DO NOT push. They abut other element
          //       faces exactly (bell body bottom meets crown top at y=0.375)
          //       and any push opens a visible gap between the pieces.
          const pts = quad.points;
          const spanX = Math.max(...pts.map(p=>p.x)) - Math.min(...pts.map(p=>p.x));
          const spanY = Math.max(...pts.map(p=>p.y)) - Math.min(...pts.map(p=>p.y));
          const spanZ = Math.max(...pts.map(p=>p.z)) - Math.min(...pts.map(p=>p.z));
          if (Math.min(spanX, spanY, spanZ) > 0.05) {
            const [p0, p1, p2] = quad.points;
            const e1x=p1.x-p0.x, e1y=p1.y-p0.y, e1z=p1.z-p0.z;
            const e2x=p2.x-p0.x, e2y=p2.y-p0.y, e2z=p2.z-p0.z;
            let nx=e1y*e2z-e1z*e2y, ny=e1z*e2x-e1x*e2z, nz=e1x*e2y-e1y*e2x;
            const nl=Math.sqrt(nx*nx+ny*ny+nz*nz);
            if (nl > 0.0001) {
              nx/=nl; ny/=nl; nz/=nl;
              quadPoints = quad.points.map(p => ({
                x: p.x + nx*0.008, y: p.y + ny*0.008, z: p.z + nz*0.008
              }));
            }
          }
        }
      }
      const pts = quadPoints.map(p => ({ x:block.x+p.x, y:block.y+p.y, z:block.z+p.z }));
      // Per-vertex UVs path: special-renderer quads (bell body, bed, chest, etc.)
      // come from deepslate with already-computed per-vertex UVs that encode
      // arbitrary rotations/mirrors the face.uv + rotation scheme can't represent.
      // Use them directly; otherwise fall back to face.uv + getFaceUv corners.
      let uv00, uv10, uv11, uv01;
      if (quad.uvVertices && quad.uvVertices.length === 4) {
        const t = quad.uvVertices;
        uv00 = { u: t[0].u/16, v: t[0].v/16 };
        uv10 = { u: t[1].u/16, v: t[1].v/16 };
        uv11 = { u: t[2].u/16, v: t[2].v/16 };
        uv01 = { u: t[3].u/16, v: t[3].v/16 };
      } else {
        uv00 = preview.getFaceUv(quad, 0, 0); uv10 = preview.getFaceUv(quad, 1, 0); uv11 = preview.getFaceUv(quad, 1, 1); uv01 = preview.getFaceUv(quad, 0, 1);
      }
      addTri(mat.positions, pts[0], pts[1], pts[2]); addTri(mat.positions, pts[0], pts[2], pts[3]);
      addUv(mat.uvs, uv00, uv10, uv11); addUv(mat.uvs, uv00, uv11, uv01);
    }
  }
  if (!Number.isFinite(bounds.minX)) Object.assign(bounds, { minX:0,minY:0,minZ:0,maxX:1,maxY:1,maxZ:1 });
  const materials = Array.from(materialMap.values()).filter(m => m.positions.length > 0);
  const counts = Array.from(blockCounts.entries()).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
  return { materials, counts, bounds, totalBlocks: blocks.length };
}

function splitMaterialForChunks(material, maxTriangles = 12000) {
  const result=[]; const n=Math.floor(material.positions.length/9);
  for(let tri=0;tri<n;tri+=maxTriangles){const end=Math.min(n,tri+maxTriangles);result.push({texture:material.texture,source:material.source,color:material.color,renderMode:material.renderMode,transparent:material.transparent,cutout:material.cutout,hasAlphaTexture:material.hasAlphaTexture,opacity:material.opacity,positions:material.positions.slice(tri*9,end*9),uvs:material.uvs.slice(tri*6,end*6)});}
  return result;
}
function writeViewerChunks(outputDir,payload){const dataDir=path.join(outputDir,'data');fs.rmSync(dataDir,{recursive:true,force:true});fs.mkdirSync(dataDir,{recursive:true});const chunks=[];let cur=[],size=0,idx=0;const max=4_000_000;function flush(){if(!cur.length)return;const file=`chunk-${String(idx++).padStart(4,'0')}.js`;fs.writeFileSync(path.join(dataDir,file),`window.__STRUCTURE_VIEWER_CHUNKS__=window.__STRUCTURE_VIEWER_CHUNKS__||[];window.__STRUCTURE_VIEWER_CHUNKS__.push(${JSON.stringify({materials:cur})});\n`);chunks.push(`data/${file}`);cur=[];size=0;}for(const m of payload.materials){for(const part of splitMaterialForChunks(m)){const s=JSON.stringify(part).length;if(cur.length&&size+s>max)flush();cur.push(part);size+=s;if(size>max)flush();}}flush();return chunks;}

// Returns absolute /wiki/... URLs for the four preview PNGs that exist on disk
// (no copy) so the structure-hub site reuses the images already generated under
// wiki/. Also wipes any stale previews/ subdir left behind by older builds that
// did copy. Returns [] if no faces exist on disk.
function wikiPreviewUrls(outputDir, pngDir) {
  const stalePreviewsDir = path.join(outputDir, 'previews');
  if (fs.existsSync(stalePreviewsDir)) {
    fs.rmSync(stalePreviewsDir, { recursive: true, force: true });
  }
  const relFromWiki = path.relative(wikiOutputRoot, pngDir).split(path.sep).join('/');
  const urls = [];
  for (const name of ['north', 'east', 'south', 'west']) {
    if (fs.existsSync(path.join(pngDir, `${name}.png`))) {
      urls.push(`/wiki/${dataPackSlug}/${relFromWiki}/${name}.png`);
    }
  }
  return urls;
}


function blockListHtml(counts) {
  const visible = (counts || []).slice(0, 120);
  if (!visible.length) return '';
  const hidden = Math.max(0, (counts || []).length - visible.length);
  return `<div class="section-title">Blocks used</div><ul class="blocks">${visible.map(([name,count])=>`<li><span class="block-name">${esc(blockDisplayName(name))}</span><span class="block-count">${count}</span></li>`).join('')}${hidden ? `<li><span class="block-name">+ ${hidden} more</span><span class="block-count"></span></li>` : ''}</ul>`;
}

function viewerHtml({namespace, outputName, displayName, structureId, payload, previewImages, chunkFiles, outputDir}) {
 const title=displayName || structureDisplayName(outputName); const meta={bounds:payload.bounds,totalBlocks:payload.totalBlocks,uniqueBlocks:payload.counts.length,chunkFiles};
 const viewerLogoPath = '/assets/images/branding/ee_title_default.png';
 const homePath = '/structures/';
 const copyLabel = copyButtonLabel(structureId);
 const modrinthUrl = modrinthUrlForCurrentPack();
 const modrinthHtml = modrinthUrl
   ? `<a class="modrinth-link" href="${esc(modrinthUrl)}" target="_blank" rel="noreferrer">${esc(dataPackName)} on Modrinth</a>`
   : '';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="/assets/images/icons/favicon.ico"><style>
 :root{color-scheme:dark;--bg:#0b1018;--text:#f7fbff;--muted:#cfd7e6;--line:rgba(255,255,255,.14);--accent:#b6c8ff;--accent-2:#ffd18b;--card-a:rgba(10,12,22,.68);--card-b:rgba(3,5,10,.74);--glass:rgba(5,7,13,.58)}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.site-bg{position:fixed;inset:0;z-index:-3;background:var(--bg) center/cover no-repeat}.site-bg:before{content:"";position:absolute;inset:0;opacity:.62;background-image:radial-gradient(circle,rgba(255,255,255,.86) 0 1px,transparent 1.8px),radial-gradient(circle,rgba(182,200,255,.74) 0 1px,transparent 1.9px),radial-gradient(circle,rgba(255,209,139,.52) 0 1px,transparent 1.8px);background-size:190px 190px,270px 270px,340px 340px;background-position:22px 38px,110px 78px,190px 24px;animation:twinkle-stars 5.4s ease-in-out infinite alternate}.site-bg:after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(4,7,13,.18) 0%,rgba(4,7,13,.50) 52%,rgba(0,0,0,.88) 100%),linear-gradient(180deg,rgba(4,7,13,.55),rgba(4,7,13,.78) 46%,rgba(2,3,6,.94)),radial-gradient(circle at 50% 16%,rgba(182,200,255,.15),transparent 35%)}@keyframes twinkle-stars{0%{opacity:.36;transform:translate3d(0,0,0);filter:brightness(.88)}45%{opacity:.72;filter:brightness(1.24)}100%{opacity:.48;transform:translate3d(10px,-8px,0);filter:brightness(1)}}#viewer{position:fixed;inset:0 0 0 360px}aside{position:fixed;inset:0 auto 0 0;width:360px;background:linear-gradient(135deg,var(--card-a),var(--card-b)),var(--glass);border-right:1px solid var(--line);padding:18px;overflow:auto;box-shadow:18px 0 50px rgba(0,0,0,.35);backdrop-filter:blur(14px) saturate(1.08)}.brand{display:block;max-width:245px;margin:0 auto 16px;filter:drop-shadow(0 10px 18px rgba(0,0,0,.55))}.viewer-actions{display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 14px;flex-wrap:wrap}.back{display:inline-flex;align-items:center;gap:7px;margin:0;padding:9px 13px;border-radius:16px;background:rgba(5,7,13,.58);border:1px solid rgba(255,255,255,.16);box-shadow:0 10px 24px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.12);color:rgba(255,255,255,.94);font-size:13px;font-weight:800;text-decoration:none}.back:hover{transform:translateY(-2px);background:color-mix(in srgb,var(--accent) 18%,rgba(10,28,40,.68));border-color:color-mix(in srgb,var(--accent) 48%,transparent)}.modrinth-link{display:flex;align-items:center;justify-content:center;margin:0 auto 12px;padding:8px 14px;border-radius:14px;background:rgba(0,175,80,.10);border:1px solid rgba(29,201,86,.45);color:#5be58b;font-size:12px;font-weight:800;text-decoration:none;letter-spacing:.02em;width:fit-content;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.modrinth-link:hover{background:rgba(29,201,86,.18);border-color:rgba(29,201,86,.75);color:#7fffac;transform:translateY(-1px)}.pill{display:inline-flex;padding:5px 9px;border:1px solid var(--line);border-radius:999px;color:var(--accent);font-size:12px;margin-bottom:10px}h1{font-size:16px;line-height:1.2;margin:0 0 6px;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:13px;margin-bottom:16px}.copy-id{display:inline-flex;max-width:100%;margin:0;padding:7px 10px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.055);color:var(--accent);font-weight:850;font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy-id:hover{background:rgba(182,200,255,.14);border-color:rgba(182,200,255,.42)}.preview{position:relative;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:rgba(15,23,42,.72);margin-bottom:16px;aspect-ratio:16/10}.preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .7s ease}.preview img.active{opacity:1}.section-title{margin:16px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}.blocks{list-style:none;padding:0;margin:0;display:grid;gap:6px}.blocks li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 9px;border-radius:10px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07)}.block-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.block-count{font-weight:800;color:var(--accent)}.hint{position:fixed;right:14px;bottom:14px;padding:10px 14px;border-radius:12px;background:rgba(5,7,13,.78);border:1px solid var(--line);color:var(--muted);font-size:12px;pointer-events:none;display:flex;flex-direction:column;gap:4px;min-width:200px}.hint-title{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:2px}.hint-row{display:flex;align-items:center;gap:8px}.hint kbd{display:inline-flex;align-items:center;justify-content:center;min-width:28px;padding:2px 6px;border:1px solid rgba(255,255,255,.18);border-radius:5px;background:rgba(255,255,255,.06);font:600 10.5px ui-monospace,monospace;color:var(--text)}#speedReadout{color:var(--accent);font-weight:800;margin-left:auto}.status{position:fixed;left:calc(360px + 24px);top:24px;padding:10px 12px;border-radius:14px;background:rgba(5,7,13,.74);border:1px solid var(--line);color:var(--muted)}@media(max-width:820px){#viewer{inset:310px 0 0 0}aside{inset:0 0 auto 0;width:auto;height:310px;border-right:0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:160px 1fr;gap:12px}.brand{max-width:150px}.preview{display:none}.blocks{max-height:115px;overflow:auto}.hint{display:none}}
 .navbar{padding:6px 14px!important}.navbar-inner{width:min(1780px,100%)!important;flex-direction:row!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;min-width:0}.navbar .brand{flex:0 0 auto!important}.navbar .brand img{width:clamp(150px,13vw,230px)!important;max-height:44px!important}.navbar .nav-links{flex:1 1 auto!important;min-width:0;flex-wrap:nowrap!important;justify-content:flex-end!important;gap:7px!important;font-size:clamp(10px,.66vw,12px)!important}.navbar .nav-links a{white-space:nowrap!important;padding:8px 10px!important;border-radius:15px!important;gap:6px!important}.navbar .nav-counter-text{white-space:nowrap!important}@media(max-width:1180px){.navbar .brand img{width:clamp(130px,18vw,200px)!important}.navbar .nav-links{gap:5px!important;font-size:11px!important}.navbar .nav-links a{padding:7px 8px!important}}@media(max-width:820px){.navbar-inner{flex-direction:column!important;justify-content:center!important}.navbar .nav-links{flex-wrap:wrap!important;justify-content:center!important}}.navbar{justify-content:center!important}.navbar-inner{width:min(1780px,100%)!important;justify-content:center!important;gap:26px!important;margin:0 auto!important}.navbar .brand{margin-right:8px!important}.navbar .nav-links{flex:0 1 auto!important;justify-content:flex-start!important}@media(max-width:820px){.navbar-inner{gap:12px!important}.navbar .brand{margin-right:0!important}.navbar .nav-links{justify-content:center!important}}body .navbar{justify-content:center!important;padding-left:14px!important;padding-right:14px!important}body .navbar>.navbar-inner{width:min(1780px,100%)!important;max-width:1780px!important;margin-left:auto!important;margin-right:auto!important;display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:center!important;gap:26px!important}body .navbar .brand{flex:0 0 auto!important;margin-right:8px!important}body .navbar .nav-links{flex:0 1 auto!important;min-width:0!important;justify-content:flex-start!important;flex-wrap:nowrap!important}@media(max-width:820px){body .navbar>.navbar-inner{flex-direction:column!important;gap:12px!important}body .navbar .brand{margin-right:0!important}body .navbar .nav-links{justify-content:center!important;flex-wrap:wrap!important}}body .navbar{position:sticky!important;top:0!important;z-index:20!important;width:100%!important;padding:6px 14px!important;display:flex!important;align-items:center!important;justify-content:center!important;background:linear-gradient(180deg,rgba(8,10,18,.92),rgba(5,7,13,.84))!important;border-bottom:1px solid rgba(255,255,255,.10)!important;box-shadow:0 10px 30px rgba(0,0,0,.28)!important;backdrop-filter:blur(14px) saturate(1.06)!important}body .navbar .navbar-inner{width:min(1540px,100%)!important;margin:0 auto!important;display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:center!important;gap:28px!important;min-width:0!important}body .navbar .brand{flex:0 0 auto!important;margin:0!important;padding:0!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;background:transparent!important;border:0!important;box-shadow:none!important}body .navbar .brand img{width:clamp(150px,13vw,225px)!important;max-height:44px!important;height:auto!important;display:block!important;object-fit:contain!important}body .navbar .nav-links{flex:0 1 auto!important;min-width:0!important;display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-start!important;flex-wrap:nowrap!important;gap:7px!important;font-size:clamp(10px,.66vw,12px)!important;font-weight:800!important}body .navbar .nav-links a{white-space:nowrap!important;display:inline-flex!important;align-items:center!important;gap:6px!important;padding:8px 10px!important;border-radius:15px!important}@media(max-width:900px){body .navbar .navbar-inner{width:100%!important;flex-direction:column!important;gap:12px!important}body .navbar .nav-links{justify-content:center!important;flex-wrap:wrap!important}}.is-embed aside{display:none!important}.is-embed #viewer{inset:0!important}.is-embed .status{left:24px!important}</style><script>if(new URLSearchParams(location.search).has('embed'))document.documentElement.classList.add('is-embed')</script></head><body><div class="site-bg"></div><aside><div><a href="/structures/"><img class="brand" src="/assets/images/branding/ee_title_default.png" alt="Explorer's Eden"></a>${modrinthHtml}<div class="viewer-actions"><a class="back" href="/structures/">← Back</a><button class="copy-id" type="button" data-copy="${esc(structureId)}" title="Copy structure ID">${esc(copyLabel)}</button></div><h1>${esc(title)}</h1></div><div><div class="preview">${previewImages.map((p,i)=>`<img class="${i===0?'active':''}" src="${esc(p)}" alt="${esc(title)} ${i+1}">`).join('')}</div>${blockListHtml(payload.counts)}</div></aside><div id="viewer"></div><div class="status" id="status">Loading 3D model…</div><div class="hint"><div class="hint-title">Controls</div><div class="hint-row"><kbd>Left-drag</kbd>look around</div><div class="hint-row"><kbd>WASD</kbd>/<kbd>↑↓←→</kbd>fly</div><div class="hint-row"><kbd>Space</kbd>up · <kbd>Shift</kbd>down</div><div class="hint-row"><kbd>Scroll</kbd>fly speed (<span id="speedReadout">1.0×</span>)</div></div><script type="module">
 import * as THREE from 'https://esm.sh/three@0.161.0';
 const meta=${JSON.stringify(meta)}; const root=document.getElementById('viewer'); const statusBox=document.getElementById('status');
 function fail(err){console.error(err);statusBox.textContent='Viewer failed to load. Open the browser console for details.'}
 async function loadParts(){window.__STRUCTURE_VIEWER_CHUNKS__=[];for(const file of meta.chunkFiles){await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=file;s.onload=resolve;s.onerror=()=>reject(new Error('Failed to load '+file));document.head.appendChild(s);});}return window.__STRUCTURE_VIEWER_CHUNKS__.flatMap(c=>c.materials||[])}
 try{const parts=await loadParts();statusBox.textContent='Building textured 3D model…';const scene=new THREE.Scene();scene.background=new THREE.Color(0x0b1018);const camera=new THREE.PerspectiveCamera(70,Math.max(1,root.clientWidth)/Math.max(1,root.clientHeight),.05,20000);const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.setSize(Math.max(1,root.clientWidth),Math.max(1,root.clientHeight));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;root.appendChild(renderer.domElement);const loader=new THREE.TextureLoader();const opaque=[],alpha=[];for(const part of parts){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(part.positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(part.uvs,2));let map=null;if(part.texture){map=loader.load(part.texture);map.flipY=false;map.colorSpace=THREE.SRGBColorSpace;map.magFilter=THREE.NearestFilter;map.minFilter=THREE.NearestFilter;map.generateMipmaps=false;map.wrapS=THREE.ClampToEdgeWrapping;map.wrapT=THREE.ClampToEdgeWrapping}const mode=part.renderMode||(part.transparent?'blend':part.cutout?'cutout':'opaque');const isBlend=mode==='blend';const isCutout=mode==='cutout';const isCross=mode==='cross';const hasAlpha=!!part.hasAlphaTexture||isCutout||isCross||isBlend;const mat=new THREE.MeshBasicMaterial({color:new THREE.Color(part.color||'#fff'),map,side:THREE.DoubleSide,transparent:isBlend,opacity:isBlend?(part.opacity??0.50):1,alphaTest:(isCutout||isCross||hasAlpha&&!isBlend)?0.1:0,depthWrite:!isBlend,depthTest:true,premultipliedAlpha:false});mat.toneMapped=false;mat.polygonOffset=true;mat.polygonOffsetFactor=0;mat.polygonOffsetUnits=isCutout?-2.0:0;mat.alphaToCoverage=false;const mesh=new THREE.Mesh(g,mat);mesh.renderOrder=isBlend?10:1;(isBlend?alpha:opaque).push(mesh)}for(const m of opaque)scene.add(m);for(const m of alpha)scene.add(m);const b=meta.bounds,center=new THREE.Vector3((b.minX+b.maxX)/2,(b.minY+b.maxY)/2,(b.minZ+b.maxZ)/2),size=new THREE.Vector3(b.maxX-b.minX,b.maxY-b.minY,b.maxZ-b.minZ),maxDim=Math.max(size.x,size.y,size.z,8);camera.position.set(center.x+maxDim*1.18,center.y+maxDim*.86,center.z+maxDim*1.18);camera.near=Math.max(.05,maxDim/600);camera.far=Math.max(1000,maxDim*20);camera.updateProjectionMatrix();let yaw=0,pitch=0;{const d=new THREE.Vector3().subVectors(center,camera.position).normalize();yaw=Math.atan2(-d.x,-d.z);pitch=Math.asin(Math.max(-1,Math.min(1,d.y)));}let isDragging=false,lastMx=0,lastMy=0;const canvas=renderer.domElement;canvas.style.cursor='grab';canvas.addEventListener('mousedown',e=>{if(e.button!==0)return;isDragging=true;lastMx=e.clientX;lastMy=e.clientY;canvas.style.cursor='grabbing';e.preventDefault();});window.addEventListener('mouseup',e=>{if(e.button===0){isDragging=false;canvas.style.cursor='grab';}});window.addEventListener('mousemove',e=>{if(!isDragging)return;const dx=e.clientX-lastMx,dy=e.clientY-lastMy;lastMx=e.clientX;lastMy=e.clientY;yaw-=dx*0.004;pitch-=dy*0.004;const lim=Math.PI/2-0.001;pitch=Math.max(-lim,Math.min(lim,pitch));});let speedMult=1;const speedEl=document.getElementById('speedReadout');function updateSpeedReadout(){if(speedEl)speedEl.textContent=speedMult.toFixed(2)+'×';}updateSpeedReadout();canvas.addEventListener('wheel',e=>{e.preventDefault();const factor=e.deltaY<0?1.15:1/1.15;speedMult=Math.max(0.1,Math.min(20,speedMult*factor));updateSpeedReadout();},{passive:false});function resize(){camera.aspect=Math.max(1,root.clientWidth)/Math.max(1,root.clientHeight);camera.updateProjectionMatrix();renderer.setSize(Math.max(1,root.clientWidth),Math.max(1,root.clientHeight))}window.addEventListener('resize',resize);const keysDown=new Set();window.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON')return;keysDown.add(e.code);if(e.code.startsWith('Arrow')||e.code==='Space')e.preventDefault();});window.addEventListener('keyup',e=>keysDown.delete(e.code));function animate(){requestAnimationFrame(animate);const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);camera.lookAt(camera.position.x+(-sy*cp),camera.position.y+sp,camera.position.z+(-cy*cp));if(keysDown.size){const ms=maxDim*0.008*speedMult;const fwdX=-sy,fwdZ=-cy,rgtX=cy,rgtZ=-sy;if(keysDown.has('KeyW')||keysDown.has('ArrowUp')){camera.position.x+=fwdX*ms;camera.position.z+=fwdZ*ms;}if(keysDown.has('KeyS')||keysDown.has('ArrowDown')){camera.position.x-=fwdX*ms;camera.position.z-=fwdZ*ms;}if(keysDown.has('KeyA')||keysDown.has('ArrowLeft')){camera.position.x-=rgtX*ms;camera.position.z-=rgtZ*ms;}if(keysDown.has('KeyD')||keysDown.has('ArrowRight')){camera.position.x+=rgtX*ms;camera.position.z+=rgtZ*ms;}if(keysDown.has('Space'))camera.position.y+=ms;if(keysDown.has('ShiftLeft')||keysDown.has('ShiftRight'))camera.position.y-=ms;}renderer.render(scene,camera)}statusBox.style.display='none';animate()}catch(e){fail(e)} const slides=[...document.querySelectorAll('.preview img')];let si=0;if(slides.length>1)setInterval(()=>{slides[si]?.classList.remove('active');si=(si+1)%slides.length;slides[si]?.classList.add('active')},3500);document.querySelectorAll('[data-copy]').forEach(btn=>btn.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(btn.dataset.copy||'');const old=btn.textContent;btn.textContent='Copied!';setTimeout(()=>btn.textContent=old,1100)}catch{}}));
 </script></body></html>`;
}

async function collectGroups(){const groups=await preview.getWorldgenStructureGroups();if(groups.size===0){for(const [k,v] of preview.getDirectStructureGroups())groups.set(k,v)}return groups;}
async function generateViewers(){const groups=await collectGroups();fs.mkdirSync(outputRoot,{recursive:true});const manifest=[];for(const group of groups.values()){group.files.sort();const blocks=group.worldgen?group.blocks:(Array.isArray(group.blocks)&&group.blocks.length?group.blocks:await preview.loadBlocksForFiles(group.files));if(blocks.length<=1){console.log(`Skipping interactive web viewer for ${group.namespace}:${group.outputName}; only ${blocks.length} block(s).`);continue;}const payload=createGeometryPayload(blocks);const outputDir=path.join(outputRoot,group.namespace,group.outputName);fs.mkdirSync(outputDir,{recursive:true});const pngDir=path.join(wikiOutputRoot,'images','structures',group.namespace,group.outputName);const previewImages=wikiPreviewUrls(outputDir,pngDir);const chunkFiles=writeViewerChunks(outputDir,payload);const displayName=structureDisplayNameForGroup(group);const structureId=sourceStructureId(group);fs.writeFileSync(path.join(outputDir,'index.html'),viewerHtml({namespace:group.namespace,outputName:group.outputName,displayName,structureId,payload,previewImages,chunkFiles,outputDir}));manifest.push({datapack:dataPackName,datapackSlug:dataPackSlug,namespace:group.namespace,structure:group.outputName,id:`${group.namespace}:${group.outputName}`,displayName,structureId,blocks:payload.totalBlocks,uniqueBlocks:payload.counts.length,url:relFrom(siteRoot,path.join(outputDir,'index.html')),previews:previewImages});console.log(`Generated interactive web viewer ${path.join(outputDir,'index.html')} (${payload.totalBlocks} block(s), ${payload.materials.length} material group(s))`);}const mf=path.join(siteRoot,'manifests',`${dataPackSlug}.json`);fs.mkdirSync(path.dirname(mf),{recursive:true});fs.writeFileSync(mf,JSON.stringify(manifest,null,2));console.log(`Generated ${manifest.length} interactive structure web viewer(s).`);}
function allManifests(){const dir=path.join(siteRoot,'manifests');let out=[];if(!fs.existsSync(dir))return out;for(const f of fs.readdirSync(dir)){if(f.endsWith('.json')){try{out.push(...JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')))}catch{}}}return out;}
function cardHtml(item){
  const previews=(item.previews||[]).slice(0,4).filter(Boolean);
  const name=item.displayName||structureDisplayName(item.structure||item.id);
  const sid=item.structureId||item.id;
  const slideDuration=(6.5+Math.random()*8.5).toFixed(2)+'s';
  const slideOffset=(Math.random()*previews.length*(parseFloat(slideDuration)||3)).toFixed(2)+'s';
  const imgs=previews.length
    ? `<div class="preview-stack" style="--slide-count:${previews.length};--slide-duration:${slideDuration};--slide-offset:${slideOffset}">${previews.map((src,i)=>`<img src="${esc(structurePreviewUrl(src))}" alt="${esc(name)} preview ${i+1}" loading="lazy" style="--slide-index:${i}">`).join('')}</div>`
    : '';
  return `<article class="card structure-card" data-pack="${esc(item.datapack||item.datapackSlug||'Unknown')}" data-name="${esc(name)}" data-id="${esc(sid)}"><a class="card-link" href="${esc(structureUrl(item))}" aria-label="Open ${esc(name)}"></a>${imgs}<div class="info"><div class="name">${esc(name)}</div><button class="meta copy-structure-id" type="button" data-copy="${esc(sid)}" title="Copy structure ID">${esc(sid)}</button></div></article>`
}
function starSpans(){return Array.from({length:44},()=>'<span></span>').join('')}
function navHtml(){return `<header class="navbar">
  <div class="navbar-inner">
    <a class="brand" href="/" aria-label="Explorer's Eden home">
      <img src="/assets/images/branding/ee_title_default.png" alt="Explorer\'s Eden">
    </a>
    <nav class="nav-links" aria-label="Main navigation">
      <a target="_blank" rel="noreferrer" href="https://discord.gg/f2pMggfgVv"><i class="bi bi-discord"></i> Discord</a>
      <a target="_blank" rel="noreferrer" href="https://modrinth.com/server/a-realm-recrafted"><i class="bi bi-dpad-fill"></i><span class="nav-counter-text">Java SMP • <span class="sip animated-counter" data-ip="play.explorerseden.eu" data-port="25569">0</span> Playing</span></a>
      <a target="_blank" rel="noreferrer" href="https://wiki.explorerseden.eu"><i class="bi bi-journal-bookmark-fill"></i> Wiki</a>
      <a href="/enchantments/"><i class="bi bi-magic"></i> Enchantments</a>
      <a href="/structures/"><i class="bi bi-boxes"></i> Structures</a>
      <a target="_blank" rel="noreferrer" href="https://modrinth.com/organization/explorers-eden"><i class="bi bi-gear-fill"></i> Modrinth</a>
      <a target="_blank" rel="noreferrer" href="https://github.com/Explorers-Eden"><i class="bi bi-github"></i> Github</a>
    </nav>
  </div>
</header>`}
function footerHtml(){return `<footer class="site-footer">Explorer's Eden is in no way affiliated with Minecraft, Mojang AB and/or Notch Development AB.</footer>`}

function partialCardHtml(item){
  const previews=(item.previews||[]).slice(0,4).filter(Boolean);
  const name=item.displayName||structureDisplayName(item.structure||item.id);
  const sid=item.structureId||item.id;
  const slideDuration=(6.5+Math.random()*8.5).toFixed(2)+'s';
  const slideOffset=(Math.random()*Math.max(1,previews.length)*(parseFloat(slideDuration)||8.75)).toFixed(2)+'s';
  const imgs=previews.length
    ? `<div class="structure-preview-stack" style="--slide-count:${previews.length};--slide-duration:${slideDuration};--slide-offset:${slideOffset}">${previews.map((src,i)=>`<img src="${esc(structurePreviewUrl(src))}" alt="${esc(name)} preview ${i+1}" loading="lazy" style="--slide-index:${i}">`).join('')}</div>`
    : '';
  return `<article class="structure-card" data-pack="${esc(item.datapack||item.datapackSlug||'Unknown')}" data-name="${esc(name)}" data-id="${esc(sid)}"><a class="structure-card-link" href="${esc(structureUrl(item))}" aria-label="Open ${esc(name)}"></a>${imgs}<div class="structure-info"><div class="structure-name">${esc(name)}</div><button class="structure-id" type="button" data-copy="${esc(sid)}" title="Copy structure ID">${esc(sid)}</button></div></article>`;
}

function hubPartialHtml(items){
  const groups=new Map();
  for(const it of items){
    const k=it.datapack||it.datapackSlug||'Unknown';
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(it);
  }

  return [...groups.entries()]
    .sort(([a],[b])=>a.localeCompare(b))
    .map(([pack,entries])=>`<section class="structure-section" data-pack-section="${esc(pack)}"><h2>${esc(pack.replace(/_/g,' '))}</h2><div class="structures-grid">${entries.sort((a,b)=>a.id.localeCompare(b.id)).map(partialCardHtml).join('')}</div></section>`)
    .join('');
}

async function generateHub(){
  fs.mkdirSync(siteRoot,{recursive:true});
  const items=allManifests();
  fs.writeFileSync(path.join(siteRoot,'structure-viewers.manifest.json'),JSON.stringify(items,null,2));
  console.log(`Generated structure-viewers.manifest.json with ${items.length} item(s).`);
}

if(process.argv.includes('--hub')) generateHub().catch(e=>{console.error(e);process.exit(1)}); else generateViewers().catch(e=>{console.error(e);process.exit(1)});
