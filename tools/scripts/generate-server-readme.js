#!/usr/bin/env node
'use strict';

/**
 * Fetches the README.md from the A Realm Recrafted GitHub repo and converts it
 * to a static HTML fragment, one <section class="overview-box"> per heading,
 * for the /overview/ page to include at request time via readfile().
 *
 * Run during CI after the generate phase (global generator, not per-datapack-repo).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'overview', 'data');
const OUT_FILE = path.join(OUT_DIR, 'readme.html');

const REPO_OWNER = 'Explorers-Eden';
const REPO_NAME = 'A-Realm-Recrafted';
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const README_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}`;
const USER_AGENT = 'ExplorersEdenWebsite/1.0 (github.com/Explorers-Eden)';

function log(msg) { console.log('[server-readme]', msg); }
function warn(msg) { console.warn('[server-readme] WARNING:', msg); }

async function resolveDefaultBranch() {
  const token = process.env.REPO_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `token ${token}`;

  const resp = await fetch(GITHUB_API, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} resolving default branch`);
  const json = await resp.json();
  return json.default_branch || 'main';
}

async function fetchReadme(branch) {
  const resp = await fetch(`${README_BASE}/${branch}/README.md`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching README.md`);
  return resp.text();
}

function buildBoxedHtml(markdown) {
  const { marked } = require('marked');
  const tokens = marked.lexer(markdown);

  const groups = [];
  let current = null;
  for (const token of tokens) {
    if (token.type === 'heading') {
      current = { headingToken: token, body: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { headingToken: null, body: [] };
        groups.push(current);
      }
      current.body.push(token);
    }
  }

  return groups
    .map((group) => {
      const headingHtml = group.headingToken ? marked.parser([group.headingToken]) : '';
      const bodyHtml = group.body.length ? marked.parser(group.body) : '';
      return `<section class="overview-box">\n${headingHtml}${bodyHtml}\n</section>`;
    })
    .join('\n');
}

async function main() {
  let branch;
  try {
    branch = await resolveDefaultBranch();
  } catch (err) {
    warn(`Could not resolve default branch (${err.message}), falling back to "main".`);
    branch = 'main';
  }

  let markdown;
  try {
    markdown = await fetchReadme(branch);
  } catch (err) {
    warn(`README fetch failed (${err.message}); leaving existing output untouched.`);
    return;
  }

  const html = buildBoxedHtml(markdown);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html, 'utf8');
  log(`Wrote ${OUT_FILE} (${html.length} bytes) from branch "${branch}".`);
}

main().catch((err) => {
  warn(`Unexpected failure: ${err.message}`);
  process.exitCode = 0; // Never fail the wider CI run over a transient README fetch issue.
});
