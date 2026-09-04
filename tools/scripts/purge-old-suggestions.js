#!/usr/bin/env node
// Runs daily (as a step in sync-translations.yml) to hard-delete suggestions
// that have sat as 'withdrawn' or 'declined' for over a week - unlike users
// (see purge-inactive-users.js), nothing else needs this history kept
// around once it's resolved. 'superseded' suggestions are left alone: those
// were once genuinely accepted and replaced by a better one, which is
// meaningful history rather than rejected/deleted content.
//
// translation_votes.suggestion_id has no ON DELETE CASCADE, so a
// suggestion's votes are deleted first in the same transaction.
const { Client } = require('pg');

const connectionString = process.env.TRANSLATIONS_DATABASE_URL || process.env.DATABASE_URL;
const PURGE_AFTER_DAYS = 7;

async function main() {
  if (!connectionString) {
    console.warn('TRANSLATIONS_DATABASE_URL / DATABASE_URL not set - skipping old suggestion purge.');
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const stale = await client.query(`
      SELECT id FROM translation_suggestions
      WHERE status IN ('withdrawn', 'declined')
        AND decided_at IS NOT NULL
        AND decided_at < now() - ($1 || ' days')::interval
    `, [PURGE_AFTER_DAYS]);

    if (!stale.rowCount) {
      console.log('No withdrawn/declined suggestions past the 1-week cutoff.');
      return;
    }

    const ids = stale.rows.map(r => r.id);

    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM translation_votes WHERE suggestion_id = ANY($1::bigint[])', [ids]);
      await client.query('DELETE FROM translation_suggestions WHERE id = ANY($1::bigint[])', [ids]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log(`Old suggestion cleanup: ${ids.length} withdrawn/declined suggestion(s) permanently deleted.`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
