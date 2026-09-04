#!/usr/bin/env node
/*
 * Minecraft player/npc skin preview renderer.
 *
 * Renders standard 64x64 player skins found in:
 *   assets/<namespace>/entity/npc/{wide|regular|slim}/<files>.png
 *   assets/<namespace>/entity/mannequin/{wide|regular|slim}/<files>.png
 * Also accepts the same paths below assets/<namespace>/textures/entity/ for packs
 * that keep textures in the usual Minecraft resource location.
 *
 * The actual rendering pipeline lives in tools/scripts/lib/skin-render.js,
 * shared with generate-player-profiles.js (which renders skins downloaded
 * from the Mojang session API instead of local files).
 */
const fs = require('fs');
const path = require('path');
const { renderSkinBufferToPng } = require('./lib/skin-render');

const OUTPUT_ROOT = process.env.PLAYER_SKIN_RENDER_OUTPUT_ROOT || path.join(process.env.WIKI_OUTPUT_ROOT || 'wiki', 'images', 'entity', 'npc');

function exists(file) { try { return fs.existsSync(file); } catch { return false; } }
function sanitizeName(name) { return String(name || '').replace(/\.png$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '_').toLowerCase(); }
function relPosix(p) { return p.split(path.sep).join('/'); }

function discoverSkinTextures() {
  if (!exists('assets')) return [];
  const out = [];
  for (const namespace of fs.readdirSync('assets').sort()) {
    const nsDir = path.join('assets', namespace);
    if (!fs.statSync(nsDir).isDirectory()) continue;
    const bases = [
      path.join(nsDir, 'entity'),
      path.join(nsDir, 'textures', 'entity')
    ];
    for (const base of bases) {
      for (const source of ['npc', 'mannequin']) {
        const root = path.join(base, source);
        if (!exists(root)) continue;
        walkSkins(root, file => {
          const rel = path.relative(root, file);
          const parts = rel.split(path.sep);
          const first = (parts[0] || '').toLowerCase();
          const model = first === 'slim' ? 'slim' : 'wide';
          const hasModelDir = ['slim', 'wide', 'regular'].includes(first);
          const nameParts = hasModelDir ? parts.slice(1) : parts;
          const subDirParts = nameParts.slice(0, -1).map(sanitizeName).filter(Boolean);
          const stem = sanitizeName(path.basename(file, path.extname(file))) || sanitizeName(path.basename(file));
          out.push({ namespace, source, model, file, subDirParts, outputStem: stem });
        });
      }
    }
  }
  return out;
}

function walkSkins(dir, cb) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkSkins(p, cb);
    else if (/\.png$/i.test(name)) cb(p);
  }
}

async function renderPlayerSkin(textureFile, outputFile, model) {
  const buffer = fs.readFileSync(textureFile);
  const png = renderSkinBufferToPng(buffer, model);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, png);
}

async function main() {
  const skins = discoverSkinTextures();
  if (!skins.length) return;
  const renderedByDir = new Map();
  let errors = 0;
  for (const skin of skins) {
    const outputDir = path.join(OUTPUT_ROOT, skin.model === 'slim' ? 'slim' : 'wide', ...(skin.subDirParts || []));
    const outputFile = path.join(outputDir, `${skin.outputStem}.png`);
    try {
      await renderPlayerSkin(skin.file, outputFile, skin.model);
      const rec = renderedByDir.get(outputDir) || { count: 0 };
      rec.count++;
      renderedByDir.set(outputDir, rec);
    } catch (e) {
      errors++;
      console.error(`Failed ${relPosix(skin.file)}: ${e.message || e}`);
    }
  }
  for (const [dir, rec] of renderedByDir) {
    console.log(`Rendered ${rec.count} PNG preview(s) in ${relPosix(dir)} for ${path.basename(dir)} player skin previews.`);
  }
  if (errors) {
    console.error(`${errors} player skin render error(s).`);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
