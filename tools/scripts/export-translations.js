#!/usr/bin/env node
// Daily sync: Postgres (accepted translations) -> each data pack repo's
// assets/<namespace>/lang/<locale>.json. Direct commit as a bot, no PR -
// voting is the review gate, mirroring the pre-existing Crowdin job's own
// direct-commit precedent in these repos.
//
// Env:
//   TRANSLATIONS_DATABASE_URL (or DATABASE_URL) - required
//   REPO_TOKEN / GITHUB_TOKEN                   - required for push access
//   DRY_RUN=true                                - compute + log the diff, don't push
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const workflowRoot = process.cwd();
const cloneRoot = path.join(workflowRoot, '.cache', 'translation-sync-repos');
const connectionString = process.env.TRANSLATIONS_DATABASE_URL || process.env.DATABASE_URL;
const token = process.env.REPO_TOKEN || process.env.GITHUB_TOKEN || '';
const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

function run(cmd, args, opts = {}) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString();
}

function authUrl(owner, repo) {
  const url = `https://github.com/${owner}/${repo}.git`;
  if (!token) return url;
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

async function getConfig(client, key, fallback) {
  const res = await client.query('SELECT value FROM app_config WHERE key = $1', [key]);
  return res.rowCount ? res.rows[0].value : fallback;
}

// Resolves any suggestion that's been pending longer than pending_ttl_days.
// Grouped per (key, locale) rather than resolved one-by-one: if several
// suggestions for the same string are all still pending past the TTL, the
// winner is the one with the highest net score, and ties go to whichever was
// submitted first. Resolving them independently in arbitrary row order would
// let two simultaneously-eligible suggestions both get accepted in sequence
// (the second silently superseding the first), which isn't a deterministic
// "first posted wins" outcome.
//
// The time-based grace period only applies to a "fresh" key/locale that has
// no accepted translation yet - there, a suggestion with zero downvotes wins
// on time alone (no need to chase 5 upvotes for a language nobody's looked at
// yet). A key/locale that already HAS an accepted translation never gets a
// time-based acceptance for a challenger: replacing an existing translation
// always requires actually crossing auto_accept_threshold via real votes
// (handled instantly in vote.php) - if it hasn't happened by the time this
// runs, the challenger is just declined, not defaulted into place.
//
// Runs before export so today's sync reflects it.
async function resolveExpiredPending(client) {
  const pendingTtlDays = Number(await getConfig(client, 'pending_ttl_days', '31'));

  const expired = await client.query(`
    SELECT ts.id, ts.translation_key_id, ts.locale_code, ts.created_at,
           COALESCE(SUM(tv.value), 0) AS net,
           COUNT(*) FILTER (WHERE tv.value = -1) AS downvotes
    FROM translation_suggestions ts
    LEFT JOIN translation_votes tv ON tv.suggestion_id = ts.id
    WHERE ts.status = 'pending' AND ts.created_at < now() - ($1 || ' days')::interval
    GROUP BY ts.id
  `, [pendingTtlDays]);

  const acceptedPairs = await client.query(`
    SELECT DISTINCT translation_key_id, locale_code FROM translation_suggestions WHERE status = 'accepted'
  `);
  const hasExistingTranslation = new Set(acceptedPairs.rows.map(r => `${r.translation_key_id}:${r.locale_code}`));

  const groups = new Map();
  for (const row of expired.rows) {
    const groupKey = `${row.translation_key_id}:${row.locale_code}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({
      id: row.id,
      net: Number(row.net),
      downvotes: Number(row.downvotes),
      createdAt: row.created_at,
      translationKeyId: row.translation_key_id,
      localeCode: row.locale_code,
    });
  }

  let accepted = 0;
  let declined = 0;

  for (const [groupKey, members] of groups) {
    await client.query('BEGIN');
    try {
      const isFreshKey = !hasExistingTranslation.has(groupKey);

      // Existing translations are never displaced by the timer - only a real
      // vote-threshold crossing (vote.php) can do that, so every expired
      // challenger here just gets declined.
      const eligible = isFreshKey ? members.filter(m => m.downvotes === 0) : [];
      const winner = eligible.length
        ? eligible.reduce((best, m) => {
            if (m.net !== best.net) return m.net > best.net ? m : best;
            return new Date(m.createdAt) < new Date(best.createdAt) ? m : best;
          })
        : null;

      if (winner) {
        await client.query(`UPDATE translation_suggestions SET status = 'accepted', decided_at = now() WHERE id = $1`, [winner.id]);
        accepted++;
      }

      for (const m of members) {
        if (winner && m.id === winner.id) continue;
        await client.query(`UPDATE translation_suggestions SET status = 'declined', decided_at = now() WHERE id = $1`, [m.id]);
        declined++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.warn(`Failed to resolve an expired suggestion group: ${err.message}`);
    }
  }

  console.log(`Time-based fallback: ${accepted} accepted, ${declined} declined (of ${expired.rowCount} expired-pending across ${groups.size} key/locale group(s)).`);
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Merges accepted translations into the existing lang file: managed keys with
// an accepted value get overwritten; managed keys without one yet - whether
// present as an empty string or missing outright - get filled with the
// English source text rather than shipped blank; anything outside the
// managed set is left completely untouched. New keys are appended, not
// re-sorted, so diffs stay reviewable.
//
// This fallback fill is output-only: it never creates a translation_suggestions
// row, so it must never be mistaken for a real translation on a later import
// (see the identical-to-source guard in import-translation-keys.js's
// bootstrap-seed step) - otherwise a key's first real community suggestion
// would wrongly stop counting as "fresh" for the auto-accept grace period.
function mergeLangFile(existing, managedKeys, acceptedByKeyPath) {
  const merged = {};
  for (const [key, value] of Object.entries(existing)) {
    if (acceptedByKeyPath.has(key)) {
      merged[key] = acceptedByKeyPath.get(key);
    } else if (managedKeys.has(key) && (typeof value !== 'string' || value.trim() === '')) {
      merged[key] = managedKeys.get(key);
    } else {
      merged[key] = value;
    }
  }
  for (const [key, sourceText] of managedKeys) {
    if (key in merged) continue;
    merged[key] = acceptedByKeyPath.has(key) ? acceptedByKeyPath.get(key) : sourceText;
  }
  return merged;
}

async function main() {
  if (!connectionString) throw new Error('Set TRANSLATIONS_DATABASE_URL (or DATABASE_URL).');

  fs.mkdirSync(cloneRoot, { recursive: true });

  const client = new Client({ connectionString });
  await client.connect();

  const reposUpdated = {};
  let keysExported = 0;

  try {
    await resolveExpiredPending(client);

    const datapacks = (await client.query('SELECT id, slug, display_name, github_owner, github_repo, default_branch FROM datapacks WHERE active')).rows;
    const locales = (await client.query('SELECT code FROM locales WHERE active')).rows.map(r => r.code);

    for (const dp of datapacks) {
      const namespacesRes = await client.query(
        'SELECT DISTINCT namespace FROM translation_keys WHERE datapack_id = $1 AND removed_at IS NULL',
        [dp.id]
      );
      const namespaces = namespacesRes.rows.map(r => r.namespace);
      if (!namespaces.length) continue;

      const cloneDir = path.join(cloneRoot, dp.slug);
      fs.rmSync(cloneDir, { recursive: true, force: true });
      run('git', ['clone', '--depth', '1', authUrl(dp.github_owner, dp.github_repo), cloneDir]);

      let repoChanged = false;
      const changedLocales = [];

      for (const namespace of namespaces) {
        const keysRes = await client.query(
          'SELECT id, key_path, source_text FROM translation_keys WHERE datapack_id = $1 AND namespace = $2 AND removed_at IS NULL',
          [dp.id, namespace]
        );
        const managedKeys = new Map(keysRes.rows.map(r => [r.key_path, r.source_text]));
        const keyIdToPath = new Map(keysRes.rows.map(r => [r.id, r.key_path]));

        for (const locale of locales) {
          const acceptedRes = await client.query(`
            SELECT ts.translation_key_id, ts.body
            FROM translation_suggestions ts
            JOIN translation_keys tk ON tk.id = ts.translation_key_id
            WHERE tk.datapack_id = $1 AND tk.namespace = $2 AND ts.locale_code = $3
              AND ts.status = 'accepted' AND tk.removed_at IS NULL
          `, [dp.id, namespace, locale]);

          const langFile = path.join(cloneDir, 'assets', namespace, 'lang', `${locale}.json`);
          const fileExists = fs.existsSync(langFile);
          if (!acceptedRes.rowCount && !fileExists) continue; // nothing to write, nothing to preserve

          const acceptedByKeyPath = new Map(
            acceptedRes.rows.map(r => [keyIdToPath.get(r.translation_key_id), r.body]).filter(([k]) => k)
          );

          const existing = readJsonSafe(langFile);
          const merged = mergeLangFile(existing, managedKeys, acceptedByKeyPath);

          const nextContent = JSON.stringify(merged, null, 4) + '\n';
          const prevContent = fileExists ? fs.readFileSync(langFile, 'utf8') : null;
          if (nextContent === prevContent) continue;

          keysExported += acceptedByKeyPath.size;
          repoChanged = true;
          if (!changedLocales.includes(locale)) changedLocales.push(locale);

          if (!dryRun) {
            fs.mkdirSync(path.dirname(langFile), { recursive: true });
            fs.writeFileSync(langFile, nextContent);
          } else {
            console.log(`[dry-run] Would update ${path.relative(cloneDir, langFile)} (${acceptedByKeyPath.size} managed key(s))`);
          }
        }
      }

      if (repoChanged) {
        reposUpdated[dp.slug] = changedLocales;
        if (!dryRun) {
          run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: cloneDir });
          run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: cloneDir });
          run('git', ['add', 'assets'], { cwd: cloneDir });
          const status = run('git', ['status', '--porcelain'], { cwd: cloneDir });
          if (status.trim()) {
            run('git', ['commit', '-m', `Update translations (${changedLocales.join(', ')})`], { cwd: cloneDir });
            run('git', ['push'], { cwd: cloneDir });
            console.log(`${dp.display_name}: pushed updates for ${changedLocales.join(', ')}`);
          }
        } else {
          console.log(`[dry-run] ${dp.display_name}: would update ${changedLocales.join(', ')}`);
        }
      }
    }

    await client.query(`
      INSERT INTO sync_runs (finished_at, status, repos_updated, keys_exported)
      VALUES (now(), $1, $2, $3)
    `, [dryRun ? 'dry-run' : 'success', JSON.stringify(reposUpdated), keysExported]);

    console.log(`\nDone. ${Object.keys(reposUpdated).length} repo(s) ${dryRun ? 'would be' : ''} updated, ${keysExported} managed key write(s).`);
  } catch (err) {
    await client.query(`
      INSERT INTO sync_runs (finished_at, status, error_message) VALUES (now(), 'failed', $1)
    `, [err.message]).catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
