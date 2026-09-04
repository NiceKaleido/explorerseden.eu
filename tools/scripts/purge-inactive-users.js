#!/usr/bin/env node
// Runs daily (as a step in sync-translations.yml) to clean up users who
// haven't logged in for over a year:
//   - no suggestions and no votes on record -> the row is deleted outright,
//     nothing references it
//   - has suggestions/votes on record -> the row is anonymized in place
//     (discord identity scrubbed) rather than deleted, since deleting it
//     would violate the FK those rows hold on users.id and would silently
//     change vote tallies / accept-decline outcomes for other people's
//     suggestions. Their contribution history stays intact, just without
//     any personally-identifying info attached to it.
// The synthetic system:crowdin-import user (last_login_at is always NULL,
// since it never goes through Discord OAuth) is never touched. Admins are
// also exempt regardless of how long they've been inactive.
const { Client } = require('pg');

const connectionString = process.env.TRANSLATIONS_DATABASE_URL || process.env.DATABASE_URL;
const INACTIVE_AFTER_DAYS = 365;

async function main() {
  if (!connectionString) {
    console.warn('TRANSLATIONS_DATABASE_URL / DATABASE_URL not set - skipping inactive user purge.');
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const candidates = await client.query(`
      SELECT id FROM users
      WHERE last_login_at IS NOT NULL
        AND last_login_at < now() - ($1 || ' days')::interval
        AND discord_id NOT LIKE 'deleted:%'
        AND role != 'admin'
    `, [INACTIVE_AFTER_DAYS]);

    if (!candidates.rowCount) {
      console.log('No inactive users past the 1-year cutoff.');
      return;
    }

    const ids = candidates.rows.map(r => r.id);

    const hasActivity = await client.query(`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM translation_suggestions WHERE user_id = ANY($1::bigint[])
        UNION
        SELECT user_id FROM translation_votes WHERE user_id = ANY($1::bigint[])
      ) t
    `, [ids]);
    const activeIds = new Set(hasActivity.rows.map(r => r.user_id));

    const toDelete = ids.filter(id => !activeIds.has(id));
    const toAnonymize = ids.filter(id => activeIds.has(id));

    if (toDelete.length) {
      await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [toDelete]);
    }
    if (toAnonymize.length) {
      await client.query(`
        UPDATE users
        SET discord_id = 'deleted:' || id,
            username = 'Deleted User',
            global_name = NULL,
            avatar_hash = NULL
        WHERE id = ANY($1::bigint[])
      `, [toAnonymize]);
    }

    console.log(`Inactive user cleanup: ${toDelete.length} deleted (no activity), ${toAnonymize.length} anonymized (had suggestions/votes).`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
