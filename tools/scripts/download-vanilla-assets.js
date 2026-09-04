#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const repoRoot = process.env.SOURCE_REPO_ROOT || process.cwd();
const workflowRoot = process.env.WORKFLOW_ROOT || path.resolve(__dirname, '..', '..');
const cacheRoot = path.join(workflowRoot, '.cache', 'vanilla-assets');
const activeRoot = path.join(cacheRoot, 'active');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function versionFromReleaseInfos() {
  for (const name of ['release_infos.yml', 'release_info.yml', 'release_infos.yaml', 'release_info.yaml']) {
    const p = path.join(repoRoot, name);
    if (!exists(p)) continue;
    const y = yaml.load(fs.readFileSync(p, 'utf8')) || {};
    const raw =
      y.minecraft_version ||
      y.minecraft ||
      y.version ||
      y.game_version ||
      y.minecraftVersion ||
      y.release?.minecraft_version ||
      y.release?.minecraft;
    if (raw) return String(Array.isArray(raw) ? raw[0] : raw);
  }
  const vMappings = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', 'version-mappings.yml'), 'utf8'));
  return process.env.MINECRAFT_VERSION || vMappings.latest;
}

function requestBuffer(url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        requestBuffer(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on('error', reject);
  });
}

async function download(url, dest, label) {
  if (exists(dest) && fs.statSync(dest).size > 0) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const buf = await requestBuffer(url, 60000);
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`Download failed (${attempt}/5) for ${label}: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

function copyDir(src, dst) {
  if (!exists(src)) return false;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  return true;
}

function activeLooksUsable() {
  return exists(path.join(activeRoot, 'assets', 'minecraft')) &&
    (exists(path.join(activeRoot, 'assets', 'minecraft', 'models')) ||
     exists(path.join(activeRoot, 'assets', 'minecraft', 'items')) ||
     exists(path.join(activeRoot, 'assets', 'minecraft', 'textures')));
}

// Texture files we depend on. If extraction silently drops any of these,
// chains, banners, and dragon heads end up rendered as the brown/blue
// hashColor fallback in chunks. Verify them after extraction so a poisoned
// cache fails the build loudly instead of shipping broken visuals.
const CRITICAL_TEXTURES = [
  'assets/minecraft/textures/block/chain.png',
  'assets/minecraft/textures/entity/banner_base.png',
  'assets/minecraft/textures/entity/enderdragon/dragon.png'
];

function missingCriticalTextures(root) {
  return CRITICAL_TEXTURES.filter(p => !exists(path.join(root, p)));
}

async function main() {
  const version = versionFromReleaseInfos();
  const versionRoot = path.join(cacheRoot, version);
  const extractedRoot = path.join(versionRoot, 'extracted');

  if (exists(extractedRoot) && exists(path.join(extractedRoot, 'assets', 'minecraft'))) {
    const missing = missingCriticalTextures(extractedRoot);
    if (missing.length === 0) {
      copyDir(extractedRoot, activeRoot);
      console.log(`Vanilla assets ready for Minecraft ${version}.`);
      return;
    }
    console.warn(`Cached vanilla extraction for ${version} is missing critical files (${missing.join(', ')}); re-downloading client jar.`);
    fs.rmSync(extractedRoot, { recursive: true, force: true });
  }

  const manifestPath = path.join(cacheRoot, 'version_manifest_v2.json');
  try {
    await download('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', manifestPath, 'version manifest');
    const manifest = readJson(manifestPath);
    const entry = (manifest.versions || []).find(v => v.id === version);
    if (!entry) throw new Error(`Minecraft version ${version} not found in manifest.`);

    const versionJsonPath = path.join(versionRoot, `${version}.json`);
    await download(entry.url, versionJsonPath, `${version}.json`);
    const versionJson = readJson(versionJsonPath);
    const clientUrl = versionJson.downloads?.client?.url;
    if (!clientUrl) throw new Error(`Client jar URL missing for Minecraft ${version}.`);

    const jarPath = path.join(versionRoot, 'client.jar');
    await download(clientUrl, jarPath, `${version} client jar`);

    fs.rmSync(extractedRoot, { recursive: true, force: true });
    fs.mkdirSync(extractedRoot, { recursive: true });

    // Extract only assets. unzip exists on GitHub runners; jar also works, but unzip is faster.
    try {
      execFileSync('unzip', ['-q', jarPath, 'assets/*', 'data/*', '-d', extractedRoot], { stdio: 'ignore' });
    } catch {
      execFileSync('jar', ['xf', jarPath], { cwd: extractedRoot, stdio: 'ignore' });
    }

    if (!exists(path.join(extractedRoot, 'assets', 'minecraft'))) {
      throw new Error(`Minecraft ${version} assets were not extracted.`);
    }
    // data/minecraft contains vanilla tags needed for recipe ingredient tag expansion.
    if (!exists(path.join(extractedRoot, 'data', 'minecraft'))) {
      console.warn(`Minecraft ${version} data folder was not extracted; vanilla tag fallback may be incomplete.`);
    }
    const missing = missingCriticalTextures(extractedRoot);
    if (missing.length > 0) {
      // Wipe so the next run re-downloads from scratch instead of using this partial extraction.
      fs.rmSync(extractedRoot, { recursive: true, force: true });
      throw new Error(`Minecraft ${version} extraction missing critical textures: ${missing.join(', ')}`);
    }

    copyDir(extractedRoot, activeRoot);
    console.log(`Vanilla assets ready for Minecraft ${version}.`);
  } catch (err) {
    // Network failure should not kill the entire wiki run if an older active cache is present.
    if (activeLooksUsable()) {
      console.warn(`Could not refresh vanilla assets for Minecraft ${version}; reusing existing active cache. ${err.message}`);
      return;
    }
    if (exists(extractedRoot) && exists(path.join(extractedRoot, 'assets', 'minecraft'))) {
      copyDir(extractedRoot, activeRoot);
      console.warn(`Could not refresh vanilla assets for Minecraft ${version}; reusing cached ${version} assets. ${err.message}`);
      return;
    }
    console.warn(`Vanilla assets unavailable for Minecraft ${version}; continuing without vanilla fallback. ${err.message}`);
    fs.rmSync(activeRoot, { recursive: true, force: true });
    fs.mkdirSync(activeRoot, { recursive: true });
    // Do not fail the whole workflow. Custom repo assets and non-recipe generation can still work.
  }
}

main().catch(err => {
  console.warn(`Vanilla asset preparation skipped: ${err.message}`);
  process.exit(0);
});
