CREATE TABLE IF NOT EXISTS schema_migrations (
  version    varchar PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_config (
  key   varchar PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO app_config (key, value) VALUES
  ('auto_accept_threshold', '5'),
  ('auto_decline_threshold', '-3'),
  ('pending_ttl_days', '31'),
  ('min_net_score_for_time_accept', '0');

CREATE TABLE datapacks (
  id             bigserial PRIMARY KEY,
  slug           varchar UNIQUE NOT NULL,
  display_name   varchar NOT NULL,
  github_owner   varchar NOT NULL DEFAULT 'Explorers-Eden',
  github_repo    varchar NOT NULL,
  default_branch varchar NOT NULL DEFAULT 'main',
  active         boolean NOT NULL DEFAULT true
);

-- No seed rows here on purpose: locales are discovered dynamically from
-- each repo's assets/<namespace>/lang/*.json files by
-- tools/scripts/import-translation-keys.js (see ensureLocaleRegistered),
-- unioned across all repos so a locale present in even one data pack is
-- available site-wide - not just for the pack(s) that happen to have it.
CREATE TABLE locales (
  code         varchar(5) PRIMARY KEY,
  english_name varchar NOT NULL,
  native_name  varchar NOT NULL,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  discord_id    varchar UNIQUE NOT NULL,
  username      varchar NOT NULL,
  global_name   varchar,
  avatar_hash   varchar,
  role          varchar NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  banned_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE translation_keys (
  id            bigserial PRIMARY KEY,
  datapack_id   bigint NOT NULL REFERENCES datapacks(id),
  namespace     varchar NOT NULL,
  key_path      varchar NOT NULL,
  source_text   text NOT NULL,
  source_hash   char(64) NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  UNIQUE (datapack_id, namespace, key_path)
);

CREATE INDEX ix_translation_keys_datapack ON translation_keys (datapack_id) WHERE removed_at IS NULL;

CREATE TABLE translation_suggestions (
  id                        bigserial PRIMARY KEY,
  translation_key_id        bigint NOT NULL REFERENCES translation_keys(id),
  locale_code               varchar(5) NOT NULL REFERENCES locales(code),
  user_id                   bigint NOT NULL REFERENCES users(id),
  body                      text NOT NULL,
  status                    varchar NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'superseded')),
  source_hash_at_submission char(64) NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  decided_at                timestamptz
);

CREATE INDEX ix_suggestions_key_locale_status ON translation_suggestions (translation_key_id, locale_code, status);

-- At most one PENDING suggestion per (key, locale, user) - stop repeat re-submits
-- for the same string while still allowing many different keys to be pending at once.
CREATE UNIQUE INDEX ux_suggestion_pending_per_user
  ON translation_suggestions (translation_key_id, locale_code, user_id) WHERE status = 'pending';

-- At most one ACCEPTED suggestion per (key, locale) - this is "the current translation".
CREATE UNIQUE INDEX ux_suggestion_accepted
  ON translation_suggestions (translation_key_id, locale_code) WHERE status = 'accepted';

CREATE TABLE translation_votes (
  id            bigserial PRIMARY KEY,
  suggestion_id bigint NOT NULL REFERENCES translation_suggestions(id),
  user_id       bigint NOT NULL REFERENCES users(id),
  value         smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (suggestion_id, user_id)
);

CREATE TABLE import_runs (
  id           bigserial PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       varchar NOT NULL DEFAULT 'running',
  keys_added   int,
  keys_changed int,
  keys_removed int,
  notes        text
);

CREATE TABLE sync_runs (
  id             bigserial PRIMARY KEY,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         varchar NOT NULL DEFAULT 'running',
  repos_updated  jsonb,
  keys_exported  int,
  error_message  text
);
