#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const yaml = require('js-yaml');

const workflowRoot = process.cwd();
const reposFile = path.join(workflowRoot, 'tools', 'github_repositories.yml');
const sourceRoot = path.join(workflowRoot, '.cache', 'source-repos');
const wikiRoot = path.join(workflowRoot, 'wiki');
const structureSiteRoot = path.join(workflowRoot, 'structures');
const token = process.env.REPO_TOKEN || process.env.GITHUB_TOKEN || '';

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function rel(p) { return path.relative(workflowRoot, p).split(path.sep).join('/'); }
function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function authUrl(url) {
  if (!token || !/^https:\/\/github\.com\//i.test(url)) return url;
  return url.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(token)}@`);
}
function run(cmd, args, opts = {}) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function runWithRetry(cmd, args, opts = {}, maxAttempts = 3, delayMs = 10000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      run(cmd, args, opts);
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`Attempt ${attempt}/${maxAttempts} failed (${err.message.trim()}). Retrying in ${delayMs / 1000}s...`);
      sleepSync(delayMs);
    }
  }
}
function hasFiles(root, predicates) {
  if (!exists(root)) return false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && predicates.some(fn => fn(p.split(path.sep).join('/')))) return true;
    }
  }
  return false;
}
function runNode(script, cwd, env) {
  run(process.execPath, [path.join(workflowRoot, 'tools', 'scripts', script)], { cwd, env });
}
function runPython(script, cwd, env) {
  run(process.env.PYTHON || 'python3', [path.join(workflowRoot, 'tools', 'scripts', script)], { cwd, env });
}
function countOutputFiles(outputRoot) {
  function findCount(dir, ...args) {
    if (!exists(dir)) return 0;
    try { return Number(execFileSync('find', [dir, ...args]).toString().split('\n').filter(Boolean).length); } catch { return 0; }
  }
  const players = findCount(path.join(outputRoot, 'images', 'entity', 'npc'), '-type', 'f', '-name', '*.png');
  return {
    md: findCount(path.join(outputRoot, 'markdown'), '-type', 'f', '-name', '*.md'),
    structures: findCount(path.join(outputRoot, 'images', 'structures'), '-type', 'f', '-name', '*.png'),
    entities: Math.max(0, findCount(path.join(outputRoot, 'images', 'entity'), '-type', 'f', '-name', '*.png') - players),
    players,
    recipes: findCount(path.join(outputRoot, 'markdown'), '-type', 'f', '-path', '*/recipe/*.md'),
    items: findCount(path.join(outputRoot, 'images', 'items'), '-type', 'f', '-name', '*.png'),
  };
}
function writeSummaryTable(rows) {
  const fmt = (_b, a) => a === 0 ? '—' : String(a);
  const lines = [
    '## Generated Files Summary',
    '',
    '| Datapack | Markdown | Structures | Entities | Players | Recipes | Items |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.displayName} | ${fmt(r.before.md, r.after.md)} | ${fmt(r.before.structures, r.after.structures)} | ${fmt(r.before.entities, r.after.entities)} | ${fmt(r.before.players, r.after.players)} | ${fmt(r.before.recipes, r.after.recipes)} | ${fmt(r.before.items, r.after.items)} |`),
  ];
  const md = lines.join('\n');
  console.log('\n' + md);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try { fs.appendFileSync(summaryFile, md + '\n'); } catch (e) { console.warn('Could not write to GITHUB_STEP_SUMMARY:', e.message); }
  }
}

// Phase gating. PHASES env var is a comma-separated subset of:
//   clone, enchantments, loot-tables, structure-md, structure-previews,
//   structure-viewers, entity-renders, player-skins, recipes, item-renders,
//   overview, translations-import, finalize
// Default 'all' runs every phase, preserving the original behaviour. The
// workflow splits the generate step by passing individual phase names so
// each phase gets its own visible step + timing in the Actions UI.
const PHASES = (process.env.PHASES || 'all').split(',').map(s => s.trim()).filter(Boolean);
function shouldRun(phase) {
  return PHASES.includes('all') || PHASES.includes(phase);
}

function buildRepoEnv(displayName, slug, repoUrl, cloneDir, outputRoot) {
  return {
    ...process.env,
    WIKI_OUTPUT_ROOT: outputRoot,
    WIKI_DATAPACK_NAME: displayName,
    WIKI_DATAPACK_SLUG: slug,
    STRUCTURE_WEB_SITE_ROOT: structureSiteRoot,
    STRUCTURE_WEB_OUTPUT_ROOT: path.join(structureSiteRoot, 'structures', slug),
    WIKI_MARKDOWN_OUTPUT_ROOT: path.join(outputRoot, 'markdown'),
    STRUCTURE_PREVIEW_OUTPUT_ROOT: path.join(outputRoot, 'images', 'structures'),
    ENTITY_RENDER_OUTPUT_ROOT: path.join(outputRoot, 'images', 'entity'),
    PLAYER_SKIN_RENDER_OUTPUT_ROOT: path.join(outputRoot, 'images', 'entity', 'npc'),
    RECIPE_RENDER_OUTPUT_ROOT: path.join(outputRoot, 'images', 'recipe'),
    RECIPE_IMAGE_OUTPUT_ROOT: path.join(outputRoot, 'images', 'recipe'),
    ITEM_RENDER_OUTPUT_ROOT: path.join(outputRoot, 'images', 'items'),
    RECIPE_MARKDOWN_OUTPUT_ROOT: path.join(outputRoot, 'markdown'),
    ENTITY_MODEL_ROOT: path.join(workflowRoot, 'tools', 'entity_models'),
    WORKFLOW_ROOT: workflowRoot,
    VANILLA_ASSET_ROOT: path.join(workflowRoot, '.cache', 'vanilla-assets', 'active'),
    VANILLA_ASSET_CACHE_ROOT: path.join(workflowRoot, '.cache', 'vanilla-assets'),
    NODE_PATH: process.env.NODE_PATH || path.join(workflowRoot, '.cache', 'wiki-node-deps', 'node_modules'),
    ENCHANTMENT_SOURCE_ROOT: cloneDir,
    TARGET_ENCHANTMENTS_JSON: path.join(workflowRoot, 'enchantments', 'data', 'enchantments.json'),
    TARGET_ENCHANTMENTS_BOOTSTRAP: path.join(workflowRoot, 'enchantments', 'data', 'enchantments-data.js'),
    ENCHANTMENT_ITEM_ICON_BASE: '/enchantments/assets/items/',
    WIKI_DATAPACK_URL: String(repoUrl),
    STRUCTURE_PREVIEW_SEED: process.env.STRUCTURE_PREVIEW_SEED || crypto.randomBytes(8).toString('hex')
  };
}

function loadRepoEntries() {
  if (!exists(reposFile)) throw new Error(`Missing ${reposFile}`);
  const raw = yaml.load(fs.readFileSync(reposFile, 'utf8')) || {};
  const entries = Array.isArray(raw)
    ? raw.map((v, i) => typeof v === 'string' ? [`repo_${i + 1}`, v] : [v.name || `repo_${i + 1}`, v.url || v.repository])
    : Object.entries(raw);
  return entries.filter(([, url]) => Boolean(url)).map(([name, url]) => {
    const slug = slugify(name);
    if (!slug) return null;
    return {
      displayName: name,
      repoUrl: String(url),
      slug,
      cloneDir: path.join(sourceRoot, slug),
      outputRoot: path.join(wikiRoot, slug)
    };
  }).filter(Boolean);
}

function main() {
  const entries = loadRepoEntries();

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(wikiRoot, { recursive: true });
  fs.mkdirSync(structureSiteRoot, { recursive: true });

  if (shouldRun('clone')) {
    // Wipe any prior generated structure-site output. The per-repo wikis are
    // also wiped inside the clone loop. Doing this once up front keeps the
    // structure-site root clean of stale manifests/assets from prior runs.
    for (const generatedChild of ['generated', 'manifests', 'structure-viewers.manifest.json', 'assets']) {
      fs.rmSync(path.join(structureSiteRoot, generatedChild), { recursive: true, force: true });
    }
    fs.rmSync(path.join(structureSiteRoot, 'structures'), { recursive: true, force: true });

    fs.writeFileSync(
      path.join(structureSiteRoot, 'index.php'),
      "<?php $_GET['page'] = 'structures'; require __DIR__ . '/../index.php';\n"
    );
  }

  const tableRows = [];
  for (const repo of entries) {
    const { displayName, repoUrl, slug, cloneDir, outputRoot } = repo;
    console.log(`\n=== ${displayName} (phases: ${PHASES.join(',')}) → ${rel(outputRoot)} ===`);

    if (shouldRun('clone')) {
      const before = countOutputFiles(outputRoot);
      fs.rmSync(cloneDir, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
      fs.mkdirSync(outputRoot, { recursive: true });
      runWithRetry('git', ['clone', '--depth', '1', authUrl(repoUrl), cloneDir]);
      tableRows.push({ displayName, before, after: null, slug });
    }

    if (!exists(cloneDir)) {
      console.log(`No clone dir for ${displayName}; skipping non-clone phases. Run with PHASES=clone first.`);
      continue;
    }

    const env = buildRepoEnv(displayName, slug, repoUrl, cloneDir, outputRoot);

    // download-vanilla-assets is idempotent and very fast on cache-hit, so keep
    // it gated under 'clone' phase — by the time the other phases run the
    // workflow's prepare-assets job has already populated the cache.
    if (shouldRun('clone')) {
      runNode('download-vanilla-assets.js', cloneDir, env);
    }

    if (shouldRun('enchantments') &&
        hasFiles(path.join(cloneDir, 'data'), [p => p.includes('/enchantment/') && p.endsWith('.json')])) {
      runPython('update-enchantments-json.py', cloneDir, env);
    }

    if (shouldRun('loot-tables') &&
        hasFiles(path.join(cloneDir, 'data'), [p => p.includes('/loot_table/') && p.endsWith('.json')])) {
      runNode('generate-loot-tables.js', cloneDir, env);
    }

    const hasStructures = hasFiles(path.join(cloneDir, 'data'),
      [p => (p.includes('/worldgen/structure/') && p.endsWith('.json')) || (p.includes('/structure/') && p.endsWith('.nbt'))]);

    if (shouldRun('structure-md') && hasStructures) runNode('generate-structures.js', cloneDir, env);
    if (shouldRun('structure-previews') && hasStructures) runNode('generate-structure-previews.js', cloneDir, env);
    if (shouldRun('structure-viewers') && hasStructures) runNode('generate-structure-web-viewers.js', cloneDir, env);

    if (shouldRun('entity-renders') &&
        hasFiles(path.join(cloneDir, 'data'), [p => /\/(cat|chicken|frog|pig|cow|wolf|zombie_nautilus)_variant\/.+\.json$/.test(p)])) {
      runNode('generate-entity-renders.js', cloneDir, env);
    }

    if (shouldRun('player-skins') &&
        hasFiles(path.join(cloneDir, 'assets'), [p => /\/(textures\/)?entity\/(npc|mannequin)\/.+\.png$/i.test(p)])) {
      runNode('generate-player-skin-renders.js', cloneDir, env);
    }

    if (shouldRun('recipes') &&
        hasFiles(path.join(cloneDir, 'data'), [p => /\/(recipe|recipes)\/.+\.json$/i.test(p)])) {
      runNode('generate-recipe-markdown.js', cloneDir, env);
      runNode('generate-recipe-images.js', cloneDir, env);
    }

    if (shouldRun('item-renders') &&
        hasFiles(path.join(cloneDir, 'assets'), [p => /\/items\/[^/]+\.json$/.test(p)])) {
      runNode('generate-item-block-renders.js', cloneDir, env);
    }

    if (shouldRun('overview')) {
      runNode('generate-overview.js', cloneDir, env);
    }

    if (shouldRun('translations-import') &&
        hasFiles(path.join(cloneDir, 'assets'), [p => p.endsWith('/lang/en_us.json')])) {
      runNode('import-translation-keys.js', cloneDir, env);
    }

    const after = countOutputFiles(outputRoot);
    console.log(`${displayName}: ${after.md} markdown, ${after.structures} structure PNG(s), ${after.entities} entity PNG(s), ${after.players} player skin PNG(s), ${after.recipes} recipe markdown file(s), ${after.items} item/block PNG(s).`);
  }

  if (shouldRun('finalize')) {
    // Compute summary table using current on-disk counts as 'after'. We don't
    // have a stable 'before' across phase invocations, so just report current.
    const summaryRows = entries.map(repo => ({
      displayName: repo.displayName,
      before: { md: 0, structures: 0, entities: 0, players: 0, recipes: 0, items: 0 },
      after: countOutputFiles(repo.outputRoot)
    }));
    writeSummaryTable(summaryRows);

    runNode('write-enchantments-data-bootstrap.js', workflowRoot, {
      ...process.env,
      TARGET_ENCHANTMENTS_JSON: path.join(workflowRoot, 'enchantments', 'data', 'enchantments.json'),
      TARGET_ENCHANTMENTS_BOOTSTRAP: path.join(workflowRoot, 'enchantments', 'data', 'enchantments-data.js')
    });

    runNode('generate-recipes-manifest.js', workflowRoot, {
      ...process.env,
      WORKFLOW_ROOT: workflowRoot,
      WIKI_ROOT: wikiRoot,
      RECIPES_MANIFEST_OUTPUT: path.join(workflowRoot, 'recipes', 'data', 'recipes.manifest.json'),
      RECIPES_REPOS_FILE: reposFile
    });

    const hubEnv = {
      ...process.env,
      STRUCTURE_WEB_SITE_ROOT: structureSiteRoot,
      WORKFLOW_ROOT: workflowRoot,
      VANILLA_ASSET_ROOT: path.join(workflowRoot, '.cache', 'vanilla-assets', 'active'),
      VANILLA_ASSET_CACHE_ROOT: path.join(workflowRoot, '.cache', 'vanilla-assets'),
      NODE_PATH: process.env.NODE_PATH || path.join(workflowRoot, '.cache', 'wiki-node-deps', 'node_modules')
    };
    run(process.execPath, [path.join(workflowRoot, 'tools', 'scripts', 'generate-structure-web-viewers.js'), '--hub'], { cwd: workflowRoot, env: hubEnv });

    fs.writeFileSync(
      path.join(structureSiteRoot, 'index.php'),
      "<?php $_GET['page'] = 'structures'; require __DIR__ . '/../index.php';\n"
    );
  }
}

main();


// v20 patch: keep pale oak leaves untinted
const __v20_pale_oak_untinted = new Set([
  'minecraft:pale_oak_leaves'
]);
