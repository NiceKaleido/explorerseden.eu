#!/usr/bin/env node
// Scans wiki/<pack>/markdown/<ns>/recipe/**/*.md, pairs each with the matching
// PNG under wiki/<pack>/images/recipe/<ns>/recipe/**/, and writes a flat
// JSON manifest the /recipes page consumes. Lightweight — only ~50KB across
// 700 recipes since recipe MD content is fetched lazily on click.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const workflowRoot = process.env.WORKFLOW_ROOT || process.cwd();
const wikiRoot = process.env.WIKI_ROOT || path.join(workflowRoot, 'wiki');
const reposFile = process.env.RECIPES_REPOS_FILE || path.join(workflowRoot, 'tools', 'github_repositories.yml');
const outputFile = process.env.RECIPES_MANIFEST_OUTPUT || path.join(workflowRoot, 'recipes', 'data', 'recipes.manifest.json');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function loadDatapackDisplayNames() {
  // slug → "Display Name" lookup from github_repositories.yml so the sidebar
  // header reads "Nice Things" rather than "nice_things".
  const out = new Map();
  if (!exists(reposFile)) return out;
  try {
    const raw = yaml.load(fs.readFileSync(reposFile, 'utf8')) || {};
    const entries = Array.isArray(raw)
      ? raw.map((v, i) => typeof v === 'string' ? [`repo_${i + 1}`, v] : [v.name || `repo_${i + 1}`, v.url || v.repository])
      : Object.entries(raw);
    for (const [name] of entries) {
      const slug = slugify(name);
      if (slug) out.set(slug, name);
    }
  } catch (err) {
    console.warn(`Could not load datapack display names from ${reposFile}: ${err.message}`);
  }
  return out;
}

function walkFiles(dir, predicate, results = []) {
  if (!exists(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, predicate, results);
    else if (entry.isFile() && predicate(p)) results.push(p);
  }
  return results;
}

function isRecipeMarkdown(p) {
  // Restrict to files under <something>/recipe/... so we don't accidentally
  // pick up other markdown that happens to contain the substring.
  const norm = p.split(path.sep).join('/');
  return norm.endsWith('.md') && /\/recipe\/[^/]+\/[^/]+\.md$/.test(norm) === false
    ? /\/recipe\/.+\.md$/.test(norm)
    : true;
}

function parseRecipeMd(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const nameMatch = text.match(/^#\s+(.+?)\s*$/m);
  const typeMatch = text.match(/\*\*Type:\*\*\s+(.+?)\s*$/m);
  const idMatch = text.match(/\*\*Recipe ID:\*\*\s+`([^`]+)`/);
  const resultMatch = text.match(/\*\*Result:\*\*\s+(.+?)\s*$/m);
  return {
    name: (nameMatch && nameMatch[1]) || null,
    type: (typeMatch && typeMatch[1]) || null,
    id: (idMatch && idMatch[1]) || null,
    result: (resultMatch && resultMatch[1]) || null
  };
}

function urlFromRepoPath(absPath) {
  // wiki/foo/markdown/bar/recipe/baz.md  →  /wiki/foo/markdown/bar/recipe/baz.md
  return '/' + path.relative(workflowRoot, absPath).split(path.sep).join('/');
}

function main() {
  if (!exists(wikiRoot)) {
    console.warn(`Wiki root ${wikiRoot} does not exist; writing empty manifest.`);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, '[]\n');
    return;
  }

  const displayNames = loadDatapackDisplayNames();
  const entries = [];

  for (const dp of fs.readdirSync(wikiRoot, { withFileTypes: true })) {
    if (!dp.isDirectory()) continue;
    const datapackSlug = dp.name;
    const datapack = displayNames.get(datapackSlug) || datapackSlug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const mdRoot = path.join(wikiRoot, datapackSlug, 'markdown');
    if (!exists(mdRoot)) continue;

    const recipeMds = walkFiles(mdRoot, isRecipeMarkdown);
    if (recipeMds.length === 0) continue;

    for (const mdPath of recipeMds) {
      const relFromMd = path.relative(mdRoot, mdPath); // e.g. minecraft/recipe/campfire.md
      const parts = relFromMd.split(path.sep);
      // Expect at least <ns>/recipe/<...>.md
      if (parts.length < 3 || parts[1] !== 'recipe') continue;
      const namespace = parts[0];
      // Recipe path after `<ns>/recipe/`, without the .md extension.
      const recipePath = parts.slice(2).join('/').replace(/\.md$/, '');

      const parsed = parseRecipeMd(mdPath) || {};
      const imageAbs = path.join(wikiRoot, datapackSlug, 'images', 'recipe', namespace, 'recipe', recipePath + '.png');

      entries.push({
        datapack,
        datapackSlug,
        namespace,
        recipePath,
        id: parsed.id || `${namespace}:${recipePath}`,
        name: parsed.name || recipePath.split('/').pop(),
        type: parsed.type || null,
        result: parsed.result || null,
        mdUrl: urlFromRepoPath(mdPath),
        imageUrl: exists(imageAbs) ? urlFromRepoPath(imageAbs) : null
      });
    }
  }

  entries.sort((a, b) =>
    (a.datapack || '').localeCompare(b.datapack || '') ||
    (a.name || '').localeCompare(b.name || '') ||
    (a.id || '').localeCompare(b.id || '')
  );

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(entries, null, 2) + '\n');
  console.log(`Wrote ${entries.length} recipe entries → ${path.relative(workflowRoot, outputFile)}`);
}

main();
