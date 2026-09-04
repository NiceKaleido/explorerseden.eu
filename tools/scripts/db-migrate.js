#!/usr/bin/env node
// Applies db/migrations/*.sql in filename order against DATABASE_URL (or
// TRANSLATIONS_DATABASE_URL as a fallback, used by CI's import/export jobs),
// tracking applied versions in schema_migrations so re-runs are a no-op.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
const connectionString = process.env.DATABASE_URL || process.env.TRANSLATIONS_DATABASE_URL;

async function main() {
  if (!connectionString) {
    throw new Error('Set DATABASE_URL (or TRANSLATIONS_DATABASE_URL) before running db-migrate.js');
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    varchar PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    console.log('Migrations up to date.');
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
