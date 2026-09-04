#!/usr/bin/env node
// Runs once per data pack repo (same per-repo invocation pattern as
// update-enchantments-json.py / generate-loot-tables.js), reading that repo's
// checked-out assets/*/lang/en_us.json files and upserting them into the
// translation_keys table. Also bootstrap-seeds already-translated locale
// files (from the prior Crowdin era) as accepted suggestions so the site
// doesn't start every locale at 0%.
//
// Batched: an earlier version issued one SELECT + one INSERT/UPDATE per KEY,
// and another SELECT + maybe an INSERT per key per locale file - tens of
// thousands of sequential round-trips for a large repo (e.g. Fabled Roots:
// 2,665 keys x up to 31 locales), each paying full network latency to a
// remote Postgres host. Everything here batches to one upsert per namespace
// (keys) and one lookup + one insert per locale file (suggestions), cutting
// round-trips from O(keys) to O(namespaces + locales).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const cwd = process.cwd(); // the repo checkout (cloneDir), set by the orchestrator
const slug = process.env.WIKI_DATAPACK_SLUG;
const displayName = process.env.WIKI_DATAPACK_NAME;
const repoUrl = process.env.WIKI_DATAPACK_URL || '';
const connectionString = process.env.TRANSLATIONS_DATABASE_URL || process.env.DATABASE_URL;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Display names for locale codes we know about from Minecraft's own resource
// pack conventions. Anything discovered that isn't listed here still gets
// registered - just with its raw code as the display name - so a repo adding
// a brand-new locale never gets silently dropped.
const LOCALE_METADATA = {
  af_za: ['Afrikaans', 'Afrikaans'],
  ar_sa: ['Arabic', 'العربية'],
  ca_es: ['Catalan', 'Català'],
  cs_cz: ['Czech', 'Čeština'],
  da_dk: ['Danish', 'Dansk'],
  de_de: ['German', 'Deutsch'],
  el_gr: ['Greek', 'Ελληνικά'],
  en_my: ['English (Malaysia)', 'English (Malaysia)'],
  es_es: ['Spanish', 'Español'],
  fi_fi: ['Finnish', 'Suomi'],
  fr_fr: ['French', 'Français'],
  he_il: ['Hebrew', 'עברית'],
  hu_hu: ['Hungarian', 'Magyar'],
  it_it: ['Italian', 'Italiano'],
  ja_jp: ['Japanese', '日本語'],
  ko_kr: ['Korean', '한국어'],
  ms_my: ['Malay', 'Bahasa Melayu'],
  nl_nl: ['Dutch', 'Nederlands'],
  no_no: ['Norwegian', 'Norsk'],
  pl_pl: ['Polish', 'Polski'],
  pt_br: ['Portuguese (Brazil)', 'Português (Brasil)'],
  pt_pt: ['Portuguese', 'Português'],
  ro_ro: ['Romanian', 'Română'],
  ru_ru: ['Russian', 'Русский'],
  sr_sp: ['Serbian', 'Српски'],
  sv_se: ['Swedish', 'Svenska'],
  tr_tr: ['Turkish', 'Türkçe'],
  uk_ua: ['Ukrainian', 'Українська'],
  vi_vn: ['Vietnamese', 'Tiếng Việt'],
  zh_cn: ['Chinese (Simplified)', '简体中文'],
  zh_tw: ['Chinese (Traditional)', '繁體中文'],
};

function localeDisplayNames(code) {
  return LOCALE_METADATA[code] || [code, code];
}

function parseGithubOwnerRepo(url) {
  const m = String(url).match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
  return m ? { owner: m[1], repo: m[2] } : { owner: 'Explorers-Eden', repo: slug };
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).toString().trim() || 'main';
  } catch {
    return 'main';
  }
}

function findNamespaces() {
  const assetsDir = path.join(cwd, 'assets');
  if (!fs.existsSync(assetsDir)) return [];
  return fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(assetsDir, e.name, 'lang', 'en_us.json')))
    .map(e => e.name);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`Could not parse ${file}: ${err.message}`);
    return null;
  }
}

async function main() {
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  if (!connectionString) {
    console.warn('TRANSLATIONS_DATABASE_URL / DATABASE_URL not set - skipping translation import.');
    return;
  }
  if (!slug || !displayName) {
    throw new Error('WIKI_DATAPACK_SLUG / WIKI_DATAPACK_NAME must be set by the orchestrator.');
  }

  const namespaces = findNamespaces();
  if (!namespaces.length) {
    console.log(`${displayName}: no lang/en_us.json found, nothing to import.`);
    return;
  }

  console.log(`[${elapsed()}] ${displayName}: connecting to Postgres...`);
  const client = new Client({ connectionString });
  await client.connect();
  console.log(`[${elapsed()}] ${displayName}: connected. ${namespaces.length} namespace(s): ${namespaces.join(', ')}`);

  let keysAdded = 0;
  let keysChanged = 0;
  let keysRemoved = 0;

  try {
    await client.query(`
      INSERT INTO users (discord_id, username, role)
      VALUES ('system:crowdin-import', 'Crowdin import (legacy)', 'admin')
      ON CONFLICT (discord_id) DO NOTHING
    `);
    const systemUserRes = await client.query(`SELECT id FROM users WHERE discord_id = 'system:crowdin-import'`);
    const systemUserId = systemUserRes.rows[0].id;

    const { owner, repo } = parseGithubOwnerRepo(repoUrl);
    const dpRes = await client.query(`
      INSERT INTO datapacks (slug, display_name, github_owner, github_repo, default_branch)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, default_branch = EXCLUDED.default_branch
      RETURNING id
    `, [slug, displayName, owner, repo, currentBranch()]);
    const datapackId = dpRes.rows[0].id;

    const activeLocalesRes = await client.query('SELECT code FROM locales WHERE active');
    const activeLocales = new Set(activeLocalesRes.rows.map(r => r.code));

    // Locales are discovered from the repos themselves, not hardcoded - a
    // locale seen in any single repo's lang/ directory becomes available
    // site-wide, even for other packs that don't have that locale file yet
    // (they just show 0% for it until someone translates it).
    async function ensureLocaleRegistered(code) {
      if (activeLocales.has(code)) return;
      const [englishName, nativeName] = localeDisplayNames(code);
      await client.query(`
        INSERT INTO locales (code, english_name, native_name) VALUES ($1, $2, $3)
        ON CONFLICT (code) DO NOTHING
      `, [code, englishName, nativeName]);
      activeLocales.add(code);
    }

    for (const namespace of namespaces) {
      const langDir = path.join(cwd, 'assets', namespace, 'lang');
      const enUs = readJson(path.join(langDir, 'en_us.json'));
      if (!enUs) continue;

      const entries = Object.entries(enUs).filter(([, v]) => typeof v === 'string');
      console.log(`[${elapsed()}] ${namespace}: upserting ${entries.length} key(s)...`);

      // Snapshot pre-upsert state once (for add/change counts), then apply
      // every key in this namespace as a single bulk upsert.
      const existingRes = await client.query(
        'SELECT key_path, source_text FROM translation_keys WHERE datapack_id = $1 AND namespace = $2',
        [datapackId, namespace]
      );
      const existingByPath = new Map(existingRes.rows.map(r => [r.key_path, r.source_text]));

      const keyPaths = entries.map(([k]) => k);
      const sourceTexts = entries.map(([, v]) => v);
      const hashes = sourceTexts.map(sha256);
      const hashByPath = new Map(keyPaths.map((k, i) => [k, hashes[i]]));

      const upsertRes = await client.query(`
        INSERT INTO translation_keys (datapack_id, namespace, key_path, source_text, source_hash, last_seen_at, removed_at)
        SELECT $1, $2, k, t, h, now(), NULL
        FROM unnest($3::text[], $4::text[], $5::text[]) AS u(k, t, h)
        ON CONFLICT (datapack_id, namespace, key_path) DO UPDATE
          SET source_text = EXCLUDED.source_text,
              source_hash = EXCLUDED.source_hash,
              last_seen_at = now(),
              removed_at = NULL
        RETURNING id, key_path
      `, [datapackId, namespace, keyPaths, sourceTexts, hashes]);

      const keyIdByPath = new Map(upsertRes.rows.map(r => [r.key_path, r.id]));
      for (const keyPath of keyPaths) {
        if (!existingByPath.has(keyPath)) keysAdded++;
        else if (existingByPath.get(keyPath) !== enUs[keyPath]) keysChanged++;
      }
      console.log(`[${elapsed()}] ${namespace}: keys upserted (running totals: +${keysAdded} added, ${keysChanged} changed)`);

      // Bootstrap-seed already-translated locale files (from the Crowdin era)
      // as accepted suggestions - only where no suggestion exists yet, so
      // this is safe to run on every import without ever clobbering real
      // activity. Batched per locale file: one lookup for which candidate
      // keys already have a suggestion, one bulk insert for the rest.
      const localeFiles = fs.readdirSync(langDir).filter(f => f.endsWith('.json') && f !== 'en_us.json');
      console.log(`[${elapsed()}] ${namespace}: seeding ${localeFiles.length} locale file(s)...`);
      let suggestionsSeeded = 0;

      for (const file of localeFiles) {
        const localeCode = file.replace(/\.json$/i, '').toLowerCase();
        await ensureLocaleRegistered(localeCode);
        const translated = readJson(path.join(langDir, file));
        if (!translated) continue;

        const candidates = [];
        for (const [keyPath, value] of Object.entries(translated)) {
          if (typeof value !== 'string' || value.trim() === '') continue;
          // Identical to the English source means untranslated - either
          // Crowdin never got to it, or (since export-translations.js fills
          // empty/missing managed keys with the English text rather than
          // shipping them blank) it's our own placeholder fill. Either way
          // it isn't a real translation and must not be seeded as one, or
          // this key/locale would wrongly stop looking "fresh" and lose the
          // auto-accept grace period for the first real suggestion.
          if (value === enUs[keyPath]) continue;
          const keyId = keyIdByPath.get(keyPath);
          if (!keyId) continue;
          candidates.push({ keyId, value, sourceHash: hashByPath.get(keyPath) });
        }
        if (!candidates.length) continue;

        const hasSuggestionRes = await client.query(
          'SELECT DISTINCT translation_key_id FROM translation_suggestions WHERE translation_key_id = ANY($1::bigint[]) AND locale_code = $2',
          [candidates.map(c => c.keyId), localeCode]
        );
        const alreadyHasSuggestion = new Set(hasSuggestionRes.rows.map(r => r.translation_key_id));
        const toInsert = candidates.filter(c => !alreadyHasSuggestion.has(c.keyId));
        if (!toInsert.length) continue;

        await client.query(`
          INSERT INTO translation_suggestions
            (translation_key_id, locale_code, user_id, body, status, source_hash_at_submission, decided_at)
          SELECT k, $1, $2, b, 'accepted', h, now()
          FROM unnest($3::bigint[], $4::text[], $5::text[]) AS u(k, b, h)
        `, [localeCode, systemUserId, toInsert.map(c => c.keyId), toInsert.map(c => c.value), toInsert.map(c => c.sourceHash)]);
        suggestionsSeeded += toInsert.length;
      }
      console.log(`[${elapsed()}] ${namespace}: seeded ${suggestionsSeeded} suggestion(s) across ${localeFiles.length} locale file(s)`);
    }

    // Soft-delete keys absent for at least one full prior run (grace period
    // tolerates a transient clone hiccup); reappearing keys already had
    // removed_at cleared above.
    const removedRes = await client.query(`
      UPDATE translation_keys SET removed_at = now()
      WHERE datapack_id = $1 AND removed_at IS NULL AND last_seen_at < now() - interval '2 days'
      RETURNING id
    `, [datapackId]);
    keysRemoved = removedRes.rowCount;

    await client.query(`
      INSERT INTO import_runs (finished_at, status, keys_added, keys_changed, keys_removed, notes)
      VALUES (now(), 'success', $1, $2, $3, $4)
    `, [keysAdded, keysChanged, keysRemoved, `${displayName} (${slug})`]);

    console.log(`[${elapsed()}] ${displayName}: done. +${keysAdded} added, ${keysChanged} changed, ${keysRemoved} removed across ${namespaces.length} namespace(s).`);
  } catch (err) {
    await client.query(`
      INSERT INTO import_runs (finished_at, status, notes) VALUES (now(), 'failed', $1)
    `, [`${displayName}: ${err.message}`]).catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
