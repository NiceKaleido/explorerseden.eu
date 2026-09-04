#!/usr/bin/env node
'use strict';

/**
 * Builds one profiles/data/<discordId>.json per SMP player who has linked
 * their Discord account (via the DiscordJustSync mod, which already requires
 * this before a player can even join) AND has actually played (has a
 * world/players/data/<uuid>.dat file).
 *
 * Sources (all fetched via SFTP in CI, or read from local directories for
 * testing - see SMP_LOCAL_WORLD_DIR / SMP_LOCAL_CONFIG_DIR below):
 *   config/discord-js/discord-justsync.player-links.json  - discordId <-> uuid map
 *   world/players/data/<uuid>.dat                          - race/class tags
 *   world/players/advancements/<uuid>.json                 - advancement progress
 *   world/players/stats/<uuid>.json                        - stats
 *   world/dimensions/<ns>/<dim>/data/cardinal-components/world.dat - goml land claims
 *   .cache/waypoint-hubs-by-owner.json                     - written by
 *     generate-waypoint-hubs.js in the same CI job (public+private hubs per owner)
 *
 * Run during CI after "Fetch waypoint hub data via SFTP" (needs its scratch file).
 */

const fs = require('fs');
const path = require('path');
const nbt = require('prismarine-nbt');
const { decodeBlockPosLong, decodeUuidIntArray } = require('./lib/mc-id-codec');
const { renderSkinBufferToPng, renderSkinFaceBufferToPng } = require('./lib/skin-render');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'profiles', 'data');
const SKINS_OUT_DIR = path.join(ROOT, 'assets', 'images', 'generated', 'player-skins');
const SKINS_URL_BASE = '/assets/images/generated/player-skins';
const HEADS_OUT_DIR = path.join(ROOT, 'assets', 'images', 'generated', 'player-heads');
const HEADS_URL_BASE = '/assets/images/generated/player-heads';
const BY_OWNER_SCRATCH_FILE = path.join(ROOT, '.cache', 'waypoint-hubs-by-owner.json');
const HTACCESS_FILE = path.join(OUT_DIR, '.htaccess');

const RACES = ['aetherian', 'dunesworn', 'endling', 'frostborne', 'moonshroud', 'netherian', 'oakhearted', 'orebringer', 'palehearted', 'turtlekin'];
const CLASSES = ['archer', 'bard', 'builder', 'cleric', 'fighter', 'hermit', 'miner', 'rancher', 'scout', 'survivor'];

const DIMENSION_FILES = [
  { rel: 'dimensions/minecraft/overworld/data/cardinal-components/world.dat', label: 'Overworld' },
  { rel: 'dimensions/minecraft/the_nether/data/cardinal-components/world.dat', label: 'The Nether' },
  { rel: 'dimensions/minecraft/the_end/data/cardinal-components/world.dat', label: 'The End' },
  { rel: 'dimensions/kattersstructures/deep_blue/data/cardinal-components/world.dat', label: 'Deep Blue' },
];

function log(msg) { console.log('[player-profiles]', msg); }
function warn(msg) { console.warn('[player-profiles] WARNING:', msg); }
function fail(msg) {
  console.error('[player-profiles] ERROR:', msg);
  process.exit(1);
}

// ── Data source: local override or SFTP ──────────────────────────────────────

async function prepareDataDirs() {
  if (process.env.SMP_LOCAL_WORLD_DIR && process.env.SMP_LOCAL_CONFIG_DIR) {
    log(`Using local directories (test mode, no SFTP): ${process.env.SMP_LOCAL_WORLD_DIR}, ${process.env.SMP_LOCAL_CONFIG_DIR}`);
    return { worldDir: process.env.SMP_LOCAL_WORLD_DIR, configDir: process.env.SMP_LOCAL_CONFIG_DIR };
  }

  const SftpClient = require('ssh2-sftp-client');
  const host = process.env.SFTP_HOST;
  const port = Number(process.env.SFTP_PORT || 22);
  const username = process.env.SFTP_USER;
  const password = process.env.SFTP_PASSWORD;
  const remoteWorld = process.env.SMP_WORLD_SFTP_REMOTE_PATH;
  const remoteConfig = process.env.SMP_CONFIG_SFTP_REMOTE_PATH;

  if (!host || !username || !password || !remoteWorld || !remoteConfig) {
    fail('Missing one or more required env vars: SFTP_HOST, SFTP_USER, SFTP_PASSWORD, SMP_WORLD_SFTP_REMOTE_PATH, SMP_CONFIG_SFTP_REMOTE_PATH.');
  }

  const worldDir = path.join(ROOT, '.cache', 'smp-players', 'world');
  const configDir = path.join(ROOT, '.cache', 'smp-players', 'config');

  // Explicitly pre-create every destination directory rather than relying on
  // downloadDir()'s own directory-creation step - observed a "not exist" race
  // from ssh2-sftp-client when it didn't run first for a large directory.
  async function downloadDirRobust(remoteDir, localDir, filter) {
    fs.mkdirSync(localDir, { recursive: true });
    try {
      await sftp.downloadDir(remoteDir, localDir, { filter });
    } catch (err) {
      warn(`downloadDir(${remoteDir}) failed (${err.message}), retrying once.`);
      fs.mkdirSync(localDir, { recursive: true });
      await sftp.downloadDir(remoteDir, localDir, { filter });
    }
  }

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host, port, username, password, readyTimeout: 15000 });
    log(`Connected to ${host}:${port}, downloading player data.`);

    // Skip .dat_old backups - only the live .dat/.json files are needed.
    const skipBackups = (filePath) => !filePath.endsWith('_old');

    await downloadDirRobust(`${remoteWorld}/players/data`, path.join(worldDir, 'players', 'data'), skipBackups);
    await downloadDirRobust(`${remoteWorld}/players/advancements`, path.join(worldDir, 'players', 'advancements'), skipBackups);
    await downloadDirRobust(`${remoteWorld}/players/stats`, path.join(worldDir, 'players', 'stats'), skipBackups);

    for (const dim of DIMENSION_FILES) {
      const localFile = path.join(worldDir, dim.rel);
      fs.mkdirSync(path.dirname(localFile), { recursive: true });
      try {
        await sftp.get(`${remoteWorld}/${dim.rel}`, localFile);
      } catch (err) {
        warn(`Could not fetch claims file for ${dim.label} (${err.message}) - skipping.`);
      }
    }

    const linksFile = path.join(configDir, 'discord-js', 'discord-justsync.player-links.json');
    fs.mkdirSync(path.dirname(linksFile), { recursive: true });
    await sftp.get(`${remoteConfig}/discord-js/discord-justsync.player-links.json`, linksFile);
  } finally {
    await sftp.end();
  }

  return { worldDir, configDir };
}

// ── NBT helpers ───────────────────────────────────────────────────────────────

async function readNbtFile(file) {
  const buffer = fs.readFileSync(file);
  const parsed = await nbt.parse(buffer);
  return nbt.simplify(parsed.parsed);
}

// ── Race / Class ──────────────────────────────────────────────────────────────

function extractRaceAndClass(tags) {
  const list = Array.isArray(tags) ? tags : [];
  let race = null;
  let playerClass = null;
  for (const tag of list) {
    if (typeof tag !== 'string' || !tag.startsWith('fabled_roots.')) continue;
    const value = tag.slice('fabled_roots.'.length);
    if (RACES.includes(value)) race = value;
    if (CLASSES.includes(value)) playerClass = value;
  }
  const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : null);
  return { race: titleCase(race), class: titleCase(playerClass) };
}

// ── Advancements / Stats ─────────────────────────────────────────────────────

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Discord snowflake IDs are 64-bit integers, well beyond JS's safe integer
// range (2^53) - plain JSON.parse silently rounds them (e.g.
// 432453958355779594 -> 432453958355779600), corrupting the very ID this
// whole feature keys everything off. Quote the digits before parsing so they
// come through as exact strings instead.
function readPlayerLinksSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/"discordId":\s*(\d+)/g, '"discordId": "$1"');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function humanize(str) {
  return String(str || '')
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function stripNamespace(id) {
  return id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
}

// Some data pack namespaces are a single concatenated word with no
// separators to humanize() from - map those known cases by hand.
const NAMESPACE_LABELS = {
  kattersstructures: 'Katters Structures',
};

function humanizeNamespace(namespace) {
  return NAMESPACE_LABELS[namespace] || humanize(namespace);
}

// Recipe-unlock advancements aren't meaningful "achievements" - every namespace
// on this server uses either "recipe/..." or "recipes/..." as the first path
// segment for these, so this filter generalizes past vanilla's "recipes/".
function isRecipeAdvancement(id) {
  const first = stripNamespace(id).split('/')[0] || '';
  return first.startsWith('recipe');
}

// ── Advancement definitions (only advancements with a "display" block are
// ever shown in the in-game advancement menu - everything else is a hidden
// datapack trigger). Data pack definitions come from the repo clones that
// persist on disk for the rest of this CI job (see run-generate-wiki-for-
// repositories.js's sourceRoot); vanilla ones are fetched on demand from the
// misode/mcmeta mirror (already used elsewhere in this codebase), cached per
// unique id/lang lookup so 32+ players sharing the same vanilla advancement
// only ever fetch it once. ─────────────────────────────────────────────────

const SOURCE_REPOS_DIR = path.join(ROOT, '.cache', 'source-repos');

// Resolves the exact Minecraft version (e.g. "26.2") a given save file's
// DataVersion int corresponds to, then pins all vanilla advancement
// definition/lang fetches for that file to that version's misode/mcmeta tag -
// never the "data"/"assets" branches, which track whatever the latest MC
// version is and would silently drift out of sync as the server updates.
// Different players' advancement files can carry different DataVersions
// (whichever version they last saved under), so this is cached per
// DataVersion, not once globally.
let mcVersionListPromise = null;
function getMcVersionList() {
  if (!mcVersionListPromise) {
    mcVersionListPromise = fetch('https://raw.githubusercontent.com/misode/mcmeta/summary/versions/data.json')
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return mcVersionListPromise;
}

const mcVersionTagCache = new Map();
async function resolveMcVersionTag(dataVersion) {
  if (!mcVersionTagCache.has(dataVersion)) {
    mcVersionTagCache.set(dataVersion, getMcVersionList().then((versions) => {
      const match = versions.find((v) => v.data_version === dataVersion);
      if (!match) {
        warn(`Could not find a misode/mcmeta version matching DataVersion ${dataVersion} - vanilla advancement titles/descriptions will be skipped for it.`);
        return null;
      }
      log(`Resolved DataVersion ${dataVersion} to Minecraft ${match.id} for vanilla advancement lookups.`);
      return match.id;
    }));
  }
  return mcVersionTagCache.get(dataVersion);
}

function walkFiles(dir, cb) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkFiles(p, cb);
    else cb(p);
  }
}

// id -> { def, lang } for every advancement definition found across all
// cloned data pack repos (built once, reused for every player).
function loadDatapackAdvancementIndex() {
  const index = new Map();
  if (!fs.existsSync(SOURCE_REPOS_DIR)) return index;
  for (const slug of fs.readdirSync(SOURCE_REPOS_DIR)) {
    const repoDir = path.join(SOURCE_REPOS_DIR, slug);
    const dataDir = path.join(repoDir, 'data');
    if (!fs.existsSync(dataDir)) continue;
    for (const namespace of fs.readdirSync(dataDir)) {
      const advDir = path.join(dataDir, namespace, 'advancement');
      if (!fs.existsSync(advDir)) continue;
      const langFile = path.join(repoDir, 'assets', namespace, 'lang', 'en_us.json');
      const lang = fs.existsSync(langFile) ? (readJsonSafe(langFile) || {}) : {};
      walkFiles(advDir, (file) => {
        if (!file.endsWith('.json')) return;
        const rel = path.relative(advDir, file).replace(/\.json$/, '').split(path.sep).join('/');
        const id = `${namespace}:${rel}`;
        const def = readJsonSafe(file);
        if (def) index.set(id, { def, lang });
      });
    }
  }
  return index;
}

const vanillaLangCache = new Map();
function getVanillaLang(dataVersion) {
  if (!vanillaLangCache.has(dataVersion)) {
    vanillaLangCache.set(dataVersion, resolveMcVersionTag(dataVersion).then((tag) => {
      if (!tag) return {};
      return fetch(`https://raw.githubusercontent.com/misode/mcmeta/${tag}-assets/assets/minecraft/lang/en_us.json`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }));
  }
  return vanillaLangCache.get(dataVersion);
}

const vanillaDefCache = new Map();
function getVanillaAdvancementDef(advPath, dataVersion) {
  const key = `${dataVersion}:${advPath}`;
  if (!vanillaDefCache.has(key)) {
    vanillaDefCache.set(key, resolveMcVersionTag(dataVersion).then((tag) => {
      if (!tag) return null;
      return fetch(`https://raw.githubusercontent.com/misode/mcmeta/${tag}-data/data/minecraft/advancement/${advPath}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }));
  }
  return vanillaDefCache.get(key);
}

async function getAdvancementDefinition(id, datapackIndex, dataVersion) {
  if (datapackIndex.has(id)) return datapackIndex.get(id);
  const [namespace, ...rest] = id.split(':');
  if (namespace !== 'minecraft') return null; // no local source and not vanilla - can't verify, exclude
  const def = await getVanillaAdvancementDef(rest.join(':'), dataVersion);
  if (!def) return null;
  const lang = await getVanillaLang(dataVersion);
  return { def, lang };
}

// Resolves a Minecraft text component: a plain string, {text}, {translate}
// (preferring an actual lang lookup, falling back to the JSON's own
// "fallback" field when present, e.g. data packs using modern translate
// syntax), or an array of components concatenated together.
function resolveText(component, langMap) {
  if (component == null) return '';
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map((c) => resolveText(c, langMap)).join('');
  if (component.text) return component.text;
  if (component.translate) return langMap[component.translate] || component.fallback || component.translate;
  if (component.fallback) return component.fallback;
  return '';
}

async function extractDetailedAdvancements(advancements, datapackIndex) {
  if (!advancements) return [];
  const dataVersion = advancements.DataVersion;
  const groups = new Map();
  for (const [id, value] of Object.entries(advancements)) {
    if (id === 'DataVersion' || isRecipeAdvancement(id)) continue;

    const resolved = await getAdvancementDefinition(id, datapackIndex, dataVersion);
    if (!resolved || !resolved.def?.display) continue; // not shown in the in-game advancement menu

    const [namespace, ...rest] = id.split(':');
    const advPath = rest.join(':');
    const parts = advPath.split('/');
    const category = parts.length > 1 ? parts[0] : 'general';
    const groupLabel = namespace === 'minecraft' ? humanize(category) : `${humanizeNamespace(namespace)} (${humanize(category)})`;

    const fallbackLabel = humanize((parts.length > 1 ? parts.slice(1) : parts).join(' '));
    const title = resolveText(resolved.def.display.title, resolved.lang) || fallbackLabel;
    const description = resolveText(resolved.def.display.description, resolved.lang);

    if (!groups.has(groupLabel)) groups.set(groupLabel, []);
    groups.get(groupLabel).push({ label: title, description, done: value?.done === true });
  }
  return [...groups.entries()]
    .map(([category, items]) => ({
      category,
      items: items.sort((a, b) => a.label.localeCompare(b.label)),
      doneCount: items.filter((i) => i.done).length,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function sumValues(obj) {
  return Object.values(obj || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

// Custom stat ids that are more meaningful shown as hours/minutes than raw ticks.
const TIME_STAT_IDS = new Set([
  'minecraft:play_time', 'minecraft:total_world_time', 'minecraft:time_since_death',
  'minecraft:time_since_rest', 'minecraft:sneak_time',
]);
// Custom stat ids stored in centimeters, more meaningful shown as blocks.
const DISTANCE_STAT_SUFFIX = '_one_cm';

function formatCustomStatValue(id, raw) {
  const value = Number(raw) || 0;
  if (TIME_STAT_IDS.has(id)) {
    const hours = value / 20 / 3600;
    return hours >= 1 ? `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h` : `${Math.round(value / 20 / 60)} min`;
  }
  if (id.endsWith(DISTANCE_STAT_SUFFIX)) {
    return `${Math.round(value / 100).toLocaleString()} blocks`;
  }
  return value.toLocaleString();
}

const STAT_CATEGORY_LABELS = {
  'minecraft:custom': 'General',
  'minecraft:mined': 'Blocks Mined',
  'minecraft:crafted': 'Items Crafted',
  'minecraft:used': 'Items Used',
  'minecraft:broken': 'Items Broken',
  'minecraft:picked_up': 'Items Picked Up',
  'minecraft:dropped': 'Items Dropped',
  'minecraft:killed': 'Mobs Killed',
  'minecraft:killed_by': 'Killed By',
};

function customStatLabel(id) {
  const bare = stripNamespace(id);
  const withoutDistanceSuffix = bare.endsWith(DISTANCE_STAT_SUFFIX) ? bare.slice(0, -DISTANCE_STAT_SUFFIX.length) : bare;
  return humanize(withoutDistanceSuffix);
}

function extractDetailedStats(statsJson) {
  const stats = statsJson?.stats || {};
  const groups = [];
  for (const [categoryId, label] of Object.entries(STAT_CATEGORY_LABELS)) {
    const entries = stats[categoryId];
    if (!entries) continue;
    const isCustom = categoryId === 'minecraft:custom';
    const items = Object.entries(entries)
      .map(([id, raw]) => ({
        label: isCustom ? customStatLabel(id) : humanize(stripNamespace(id)),
        value: isCustom ? formatCustomStatValue(id, raw) : Number(raw).toLocaleString(),
        raw: Number(raw) || 0,
      }))
      .filter((item) => item.raw > 0)
      .sort((a, b) => b.raw - a.raw);
    if (items.length) groups.push({ category: label, items });
  }
  return groups;
}

function extractStatsSummary(statsJson) {
  const stats = statsJson?.stats || {};
  const custom = stats['minecraft:custom'] || {};
  const playTicks = custom['minecraft:play_time'] ?? custom['minecraft:play_one_minute'] ?? 0;
  return {
    playtimeHours: Math.round((playTicks / 20 / 3600) * 10) / 10,
    deaths: custom['minecraft:deaths'] ?? 0,
    mobKillsTotal: sumValues(stats['minecraft:killed']),
    blocksMinedTotal: sumValues(stats['minecraft:mined']),
  };
}

// ── Claims ────────────────────────────────────────────────────────────────────

function formatAnchorType(type) {
  if (!type) return 'Unknown Anchor';
  const stripped = type.startsWith('goml:') ? type.slice('goml:'.length) : type;
  return stripped.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function loadAllClaims(worldDir) {
  const claims = [];
  for (const dim of DIMENSION_FILES) {
    const file = path.join(worldDir, dim.rel);
    if (!fs.existsSync(file)) continue;
    let simplified;
    try {
      simplified = await readNbtFile(file);
    } catch (err) {
      warn(`Could not parse claims file for ${dim.label} (${err.message}) - skipping.`);
      continue;
    }
    const list = simplified?.data?.cardinal_components?.['goml:claims']?.Claims || [];
    for (const claim of list) {
      claims.push({ ...claim, __dimension: dim.label });
    }
  }
  return claims;
}

function decodeClaimOwners(claim) {
  return (claim.Owners || [])
    .map((arr) => { try { return decodeUuidIntArray(arr); } catch { return null; } })
    .filter(Boolean);
}

function decodeClaimTrusted(claim) {
  return (claim.Trusted || [])
    .map((arr) => { try { return decodeUuidIntArray(arr); } catch { return null; } })
    .filter(Boolean);
}

// ── Mojang name/skin resolution (shared cache across the whole run) ─────────

const mojangCache = new Map();

async function resolveMojangProfile(uuid) {
  if (mojangCache.has(uuid)) return mojangCache.get(uuid);
  const promise = (async () => {
    try {
      const resp = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`);
      if (!resp.ok) return null;
      const json = await resp.json();
      const texturesProp = (json.properties || []).find((p) => p.name === 'textures');
      let skinUrl = null;
      if (texturesProp?.value) {
        try {
          skinUrl = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'))?.textures?.SKIN?.url || null;
        } catch { /* ignore */ }
      }
      return { name: json.name || null, skinUrl };
    } catch {
      return null;
    }
  })();
  mojangCache.set(uuid, promise);
  return promise;
}

async function resolveNamesFor(uuids) {
  const names = {};
  for (const uuid of uuids) {
    const profile = await resolveMojangProfile(uuid);
    names[uuid] = profile?.name || 'Unknown';
  }
  return names;
}

// ── Skin render ───────────────────────────────────────────────────────────────

async function renderAndSaveSkin(uuid, skinUrl) {
  const fileName = `${uuid}.png`;
  const filePath = path.join(SKINS_OUT_DIR, fileName);
  if (fs.existsSync(filePath)) return `${SKINS_URL_BASE}/${fileName}`;
  try {
    const resp = await fetch(skinUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const skinBuffer = Buffer.from(await resp.arrayBuffer());
    const model = skinUrl.includes('slim') ? 'slim' : 'wide'; // refined below via metadata if needed
    const png = renderSkinBufferToPng(skinBuffer, model);
    fs.mkdirSync(SKINS_OUT_DIR, { recursive: true });
    fs.writeFileSync(filePath, png);
    return `${SKINS_URL_BASE}/${fileName}`;
  } catch (err) {
    warn(`Could not render skin for ${uuid} (${err.message}).`);
    return null;
  }
}

// Flat front-facing face icon, used anywhere a compact player icon is wanted
// (e.g. statistics.js leaderboards) instead of the full-body render.
async function renderAndSaveHead(uuid, skinUrl) {
  const fileName = `${uuid}.png`;
  const filePath = path.join(HEADS_OUT_DIR, fileName);
  if (fs.existsSync(filePath)) return `${HEADS_URL_BASE}/${fileName}`;
  try {
    const resp = await fetch(skinUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const skinBuffer = Buffer.from(await resp.arrayBuffer());
    const png = renderSkinFaceBufferToPng(skinBuffer);
    fs.mkdirSync(HEADS_OUT_DIR, { recursive: true });
    fs.writeFileSync(filePath, png);
    return `${HEADS_URL_BASE}/${fileName}`;
  } catch (err) {
    warn(`Could not render head icon for ${uuid} (${err.message}).`);
    return null;
  }
}

// ── Privacy lockdown (self-healing across full profiles/data wipes) ─────────

function ensureHtaccess() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(HTACCESS_FILE, 'Require all denied\n', 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureHtaccess();

  const { worldDir, configDir } = await prepareDataDirs();

  const linksFile = path.join(configDir, 'discord-js', 'discord-justsync.player-links.json');
  const links = readPlayerLinksSafe(linksFile) || [];
  log(`Loaded ${links.length} Discord<->Minecraft link(s).`);

  const byOwnerHubs = readJsonSafe(BY_OWNER_SCRATCH_FILE) || {};

  const allClaims = await loadAllClaims(worldDir);
  log(`Loaded ${allClaims.length} claim(s) across ${DIMENSION_FILES.length} dimension file(s).`);

  const datapackAdvancementIndex = loadDatapackAdvancementIndex();
  log(`Loaded ${datapackAdvancementIndex.size} data pack advancement definition(s) from ${fs.existsSync(SOURCE_REPOS_DIR) ? 'cloned repos' : 'nowhere (no local clones found)'}.`);

  let written = 0;
  for (const link of links) {
    const uuid = link.playerId;
    const discordId = String(link.discordId);
    if (!uuid || !discordId) continue;

    const playerDatFile = path.join(worldDir, 'players', 'data', `${uuid}.dat`);
    if (!fs.existsSync(playerDatFile)) continue; // linked in Discord, never actually joined

    let playerNbt;
    try {
      playerNbt = await readNbtFile(playerDatFile);
    } catch (err) {
      warn(`Could not parse player data for ${uuid} (${err.message}) - skipping.`);
      continue;
    }

    const { race, class: playerClass } = extractRaceAndClass(playerNbt.Tags);

    const advancements = readJsonSafe(path.join(worldDir, 'players', 'advancements', `${uuid}.json`));
    const advancementsDetailed = await extractDetailedAdvancements(advancements, datapackAdvancementIndex);
    const advancementsCompleted = advancementsDetailed.reduce((sum, g) => sum + g.doneCount, 0);

    const statsJson = readJsonSafe(path.join(worldDir, 'players', 'stats', `${uuid}.json`));
    const stats = extractStatsSummary(statsJson);
    const statsDetailed = extractDetailedStats(statsJson);

    const mojangProfile = await resolveMojangProfile(uuid);
    const name = mojangProfile?.name || link.playerId;
    const skinIcon = mojangProfile?.skinUrl ? await renderAndSaveSkin(uuid, mojangProfile.skinUrl) : null;
    const headIcon = mojangProfile?.skinUrl ? await renderAndSaveHead(uuid, mojangProfile.skinUrl) : null;

    const ownedClaims = [];
    for (const claim of allClaims) {
      const owners = decodeClaimOwners(claim);
      if (!owners.includes(uuid)) continue;
      const trustedUuids = decodeClaimTrusted(claim);
      const trustedNames = Object.values(await resolveNamesFor(trustedUuids));
      const pos = Array.isArray(claim.Box?.OriginPos) && claim.Box.OriginPos.length === 2
        ? decodeBlockPosLong(claim.Box.OriginPos[0], claim.Box.OriginPos[1])
        : { x: 0, y: 0, z: 0 };
      ownedClaims.push({
        dimension: claim.__dimension,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        anchorType: formatAnchorType(claim.Type),
        trusted: trustedNames,
      });
    }

    const waypoints = byOwnerHubs[uuid] || [];

    const profile = {
      discordId,
      uuid,
      name,
      skinIcon,
      headIcon,
      race,
      class: playerClass,
      advancementsCompleted,
      advancementsDetailed,
      stats,
      statsDetailed,
      claims: ownedClaims,
      waypoints,
    };

    fs.writeFileSync(path.join(OUT_DIR, `${discordId}.json`), JSON.stringify(profile, null, 2), 'utf8');
    written++;
  }

  log(`Wrote ${written} player profile(s) to ${OUT_DIR}.`);
}

main().catch((err) => fail(err.stack || err.message));
