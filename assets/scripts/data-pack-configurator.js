/* global JSZip */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  const PACK_DATA_URL = '/data-pack-configurator/data/pack-data.json';

  // Last-resort fallback used only before CI has run (first deploy).
  // Source of truth is tools/version-mappings.yml — keep these in sync when adding versions.
  // At runtime the client reads packFormatToVersion from pack-data.json (built by CI from the YAML).
  const PACK_FORMAT_FALLBACK = {
    '48':  '1.21.1',   // 1.21, 1.21.1
    '57':  '1.21.3',   // 1.21.2, 1.21.3
    '61':  '1.21.4',
    '71':  '1.21.5',
    '80':  '1.21.6',
    '81':  '1.21.8',   // 1.21.7, 1.21.8
    '88':  '1.21.10',  // 1.21.9, 1.21.10
    '94':  '1.21.11',
    '101': '26.1.2',   // 26.1, 26.1.1, 26.1.2
  };

  const LOOT_SOURCES = [
    { key: 'in_enchanting_table',    label: 'Ench. Table',    path: 'data/minecraft/tags/enchantment/in_enchanting_table.json' },
    { key: 'on_mob_spawn_equipment', label: 'Mob Equip.',     path: 'data/minecraft/tags/enchantment/on_mob_spawn_equipment.json' },
    { key: 'on_random_loot',         label: 'Random Loot',    path: 'data/minecraft/tags/enchantment/on_random_loot.json' },
    { key: 'on_traded_equipment',    label: 'Traded Equip.',  path: 'data/minecraft/tags/enchantment/on_traded_equipment.json' },
    { key: 'tradeable',              label: 'Tradeable',      path: 'data/minecraft/tags/enchantment/tradeable.json' },
    { key: 'treasure',               label: 'Treasure',       path: 'data/minecraft/tags/enchantment/treasure.json' },
  ];

  const VILLAGER_PROFESSIONS = [
    'armorer', 'butcher', 'cartographer', 'cleric', 'farmer',
    'fisherman', 'fletcher', 'leatherworker', 'librarian',
    'mason', 'shepherd', 'toolsmith', 'weaponsmith',
    'wandering_trader',
  ];

  const VILLAGER_LEVELS = ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'];

  const WANDERING_TRADER_LISTS = ['buying', 'common', 'uncommon'];

  const VILLAGER_VARIANTS = [
    'minecraft:plains', 'minecraft:desert', 'minecraft:savanna',
    'minecraft:snowy',  'minecraft:taiga',  'minecraft:swamp',
    'minecraft:jungle', 'minecraft:badlands',
  ];

  // ── State ──────────────────────────────────────────────────────────────────

  const state = {
    originalBuffer: null,
    zip: null,
    packMeta: null,
    mcVersion: null,
    packData: null,
    originalFileName: '',
    enchantments: new Map(),  // zipPath → { id, ns, name, json }
    tagFiles: new Map(),      // zipPath → { values: string[] }  (mutable)
    resolvedTags: new Map(),  // zipPath → Set<string>  (cache)
    mobVariants: new Map(),    // entityType → Map<variantId, { zipPath, json }>
    structures: new Map(),     // zipPath → { id, ns, localId, name, json }
    structureSets: new Map(),    // zipPath → { id, ns, localId, name, json }
    customBiomes: new Set(),     // biome IDs defined in the uploaded pack
    villagerTrades: new Map(),   // zipPath → { id, ns, localId, name, json, assignments: [{profession,level}], disabled: bool }
    villagerTradeTags: new Map(), // tagZipPath → { profession, level, originalValues: string[] }
    langMap: new Map(),          // translate key → display string (from pack's lang files)
    activeTab: 'enchantments',
    zipRoot: '',  // prefix stripped when a zip wraps everything in a subfolder
  };

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  function toDisplayName(id) {
    const local = id.includes(':') ? id.split(':')[1] : id;
    return local.replace(/[/_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function entityTypeLabel(dir) {
    return dir.replace(/_variant$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Resolves a human-readable name for a trade's output item.
  // Priority: 1) lang file lookup, 2) component.fallback, 3) prettified translate key, 4) item ID
  function resolveItemName(tradeJson) {
    const comp = tradeJson.gives?.components;
    if (comp) {
      const n = comp['minecraft:item_name'];
      if (typeof n === 'string') return n;
      if (n && typeof n === 'object') {
        if (n.text) return String(n.text);
        if (n.translate) {
          if (state.langMap.has(n.translate)) return state.langMap.get(n.translate);
          if (n.fallback) return String(n.fallback);
          const parts = n.translate.split('.');
          return toDisplayName(parts[parts.length - 1]);
        }
      }
    }
    return toDisplayName(tradeJson.gives?.id ?? '');
  }

  // Extracts the villager variant string from a merchant_predicate if it uses
  // the entity_properties / villager/variant pattern; returns null otherwise.
  function getVillagerVariant(tradeJson) {
    const v = tradeJson.merchant_predicate?.predicate?.components?.['minecraft:villager/variant'];
    return typeof v === 'string' ? v : null;
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  const el = {
    uploadZone: $('cfg-upload-zone'),
    fileInput:  $('cfg-file-input'),
    status:     $('cfg-status'),
    loading:    $('cfg-loading'),
    loadingMsg: $('cfg-loading-msg'),
    error:      $('cfg-error'),
    errorMsg:   $('cfg-error-msg'),
    editor:     $('cfg-editor'),
    packName:   $('cfg-pack-name'),
    packVer:    $('cfg-pack-version'),
    resetBtn:   $('cfg-reset-btn'),
    dlBtn:      $('cfg-download-btn'),
    enchTbody:  $('cfg-ench-tbody'),
    mobBody:    $('cfg-mob-body'),
    structBody:    $('cfg-struct-body'),
    structSetBody: $('cfg-struct-set-body'),
    tradesBody:    $('cfg-trades-body'),
    privacyNote:   document.querySelector('.prof-privacy-note'),
    picker:     $('cfg-picker'),
    pickerSearch: $('cfg-picker-search'),
    pickerList: $('cfg-picker-list'),
  };

  // ── Status helpers ─────────────────────────────────────────────────────────

  function showLoading(msg) {
    el.status.hidden = false;
    el.loading.hidden = false;
    el.error.hidden = true;
    el.loadingMsg.textContent = msg || 'Parsing ZIP…';
    el.editor.hidden = true;
    el.uploadZone.hidden = true;
  }

  function showError(msg) {
    el.status.hidden = false;
    el.error.hidden = false;
    el.loading.hidden = true;
    el.errorMsg.textContent = msg;
    el.uploadZone.hidden = false;
  }

  function showEditor() {
    el.status.hidden = true;
    el.uploadZone.hidden = true;
    el.editor.hidden = false;
    if (el.privacyNote) el.privacyNote.hidden = true;
  }

  function resetUI() {
    el.editor.hidden = true;
    el.status.hidden = true;
    el.uploadZone.hidden = false;
    if (el.privacyNote) el.privacyNote.hidden = false;
    el.fileInput.value = '';
    Object.assign(state, {
      originalBuffer: null, zip: null, packMeta: null, mcVersion: null,
      originalFileName: '',
      enchantments: new Map(), tagFiles: new Map(), resolvedTags: new Map(),
      mobVariants: new Map(), structures: new Map(), structureSets: new Map(),
      customBiomes: new Set(), _worldgenTagFiles: new Map(), zipRoot: '',
      villagerTrades: new Map(), villagerTradeTags: new Map(), langMap: new Map(),
    });
  }

  // ── Tag resolution ─────────────────────────────────────────────────────────

  // Minecraft 1.21+ tag values can be strings OR {"id":"...","required":false} objects.
  function tagEntryId(rawEntry) {
    if (typeof rawEntry === 'string') return rawEntry;
    if (rawEntry && typeof rawEntry === 'object') return rawEntry.id ?? rawEntry.value ?? null;
    return null;
  }

  // tagPath is a full zip path (includes zipRoot prefix).
  function resolveTag(tagPath, visited = new Set()) {
    if (visited.has(tagPath)) return new Set();
    if (state.resolvedTags.has(tagPath)) return state.resolvedTags.get(tagPath);
    visited.add(tagPath);
    const raw = state.tagFiles.get(tagPath);
    if (!raw) return new Set();
    const result = new Set();
    for (const rawEntry of (raw.values || [])) {
      const entry = tagEntryId(rawEntry);
      if (!entry) continue;
      if (entry.startsWith('#')) {
        const ref = entry.slice(1);
        const [ns, name] = ref.includes(':') ? ref.split(':') : ['minecraft', ref];
        const nested = state.zipRoot + `data/${ns}/tags/enchantment/${name}.json`;
        resolveTag(nested, new Set(visited)).forEach(id => result.add(id));
      } else {
        result.add(entry);
      }
    }
    state.resolvedTags.set(tagPath, result);
    return result;
  }

  // allTagFiles keys are full zip paths.
  function resolveTagGeneric(tagPath, allTagFiles, visited = new Set()) {
    if (visited.has(tagPath)) return new Set();
    visited.add(tagPath);
    const raw = allTagFiles.get(tagPath);
    if (!raw) {
      // Fall back to pre-resolved vanilla tags shipped in pack-data.json
      const vt = state.packData?.vanillaTags;
      if (vt) {
        const typePath = tagPath.includes('/tags/worldgen/biome/') ? 'biome' : 'structure';
        const m = tagPath.match(/data\/([^/]+)\/tags\/worldgen\/(?:biome|structure)\/(.+)\.json$/);
        if (m) {
          const tagRef = `#${m[1]}:${m[2]}`;
          const resolved = vt[typePath]?.[tagRef];
          if (resolved?.length) return new Set(resolved);
        }
      }
      return new Set();
    }
    const result = new Set();
    const typePath = tagPath.includes('/tags/worldgen/biome/') ? 'biome' : 'structure';
    for (const rawEntry of (raw.values || [])) {
      const entry = tagEntryId(rawEntry);
      if (!entry) continue;
      if (entry.startsWith('#')) {
        const ref = entry.slice(1);
        const [ns, name] = ref.includes(':') ? ref.split(':') : ['minecraft', ref];
        const nested = state.zipRoot + `data/${ns}/tags/worldgen/${typePath}/${name}.json`;
        const nestedResult = resolveTagGeneric(nested, allTagFiles, new Set(visited));
        if (nestedResult.size) {
          nestedResult.forEach(id => result.add(id));
        } else {
          result.add(entry); // nested tag unresolvable — keep the ref so it stays visible
        }
      } else {
        result.add(entry);
      }
    }
    return result;
  }

  function invalidateTag(tagPath) {
    state.resolvedTags.delete(tagPath);
  }

  // ── ZIP parsing ────────────────────────────────────────────────────────────

  async function parseZip(file) {
    showLoading('Reading ZIP…');
    state.originalBuffer = await file.arrayBuffer();
    state.zip = await JSZip.loadAsync(state.originalBuffer);

    // Some distributions wrap everything in a subfolder — detect and strip it.
    const allEntries = Object.keys(state.zip.files);
    let metaFile = state.zip.file('pack.mcmeta');
    state.zipRoot = '';
    if (!metaFile) {
      const metaPath = allEntries.find(p => p.endsWith('/pack.mcmeta') && !state.zip.files[p].dir);
      if (metaPath) {
        metaFile = state.zip.file(metaPath);
        state.zipRoot = metaPath.slice(0, metaPath.length - 'pack.mcmeta'.length);
      }
    }
    if (!metaFile) throw new Error('This ZIP does not appear to be a valid Minecraft data pack (pack.mcmeta not found).');

    try { state.packMeta = JSON.parse(await metaFile.async('string')); } catch { state.packMeta = {}; }

    // pack_format is optional since 1.21.9 — fall back to max_format then min_format.
    // Normalise to integer string: arrays use first element, floats are floored.
    const packSection = state.packMeta?.pack ?? {};
    const extractFmt = v => {
      if (v == null) return null;
      if (Array.isArray(v)) return String(v[0]);
      const n = Number(v);
      return String(isNaN(n) ? v : Math.floor(n));
    };
    const fmt = extractFmt(packSection.pack_format)
      ?? extractFmt(packSection.max_format)
      ?? extractFmt(packSection.min_format)
      ?? null;
    state.mcVersion = fmt
      ? (state.packData?.packFormatToVersion?.[fmt] ?? PACK_FORMAT_FALLBACK[fmt] ?? null)
      : null;

    showLoading('Scanning files…');

    const root = state.zipRoot;
    // fullPath = actual path in zip; relPath = path relative to the data pack root
    const pathList = allEntries
      .filter(p => !state.zip.files[p].dir && (!root || p.startsWith(root)))
      .map(fullPath => ({ fullPath, relPath: root ? fullPath.slice(root.length) : fullPath }));

    const worldgenTagFiles = new Map();

    for (const { fullPath, relPath } of pathList) {
      // Enchantment definition files — allow subdirectories (e.g. data/ns/enchantment/tier1/fire.json)
      if (/^data\/[^/]+\/enchantment\/.+\.json$/.test(relPath)) {
        try {
          const json = JSON.parse(await state.zip.file(fullPath).async('string'));
          const parts = relPath.split('/');
          const ns = parts[1];
          const localId = parts.slice(3).join('/').replace(/\.json$/, '');
          const id = `${ns}:${localId}`;
          state.enchantments.set(fullPath, { id, ns, localId, name: toDisplayName(id), json });
        } catch { }
        continue;
      }
      // Enchantment tag files — allow subdirectories (e.g. tags/enchantment/has_structure/grassland.json)
      if (/^data\/[^/]+\/tags\/enchantment\/.+\.json$/.test(relPath)) {
        try {
          state.tagFiles.set(fullPath, JSON.parse(await state.zip.file(fullPath).async('string')));
        } catch { }
        continue;
      }
      // Mob variant files (skip any sound-related variant type; allow subdirectory variant IDs)
      const mobMatch = relPath.match(/^data\/([^/]+)\/([a-z_]+_variant)\/(.+)\.json$/);
      if (mobMatch && !mobMatch[2].includes('sound') && mobMatch[2] !== 'painting_variant') {
        try {
          const [, ns, entityType, variantId] = mobMatch;
          const json = JSON.parse(await state.zip.file(fullPath).async('string'));
          if (!state.mobVariants.has(entityType)) state.mobVariants.set(entityType, new Map());
          state.mobVariants.get(entityType).set(`${ns}:${variantId}`, { zipPath: fullPath, json });
        } catch { }
        continue;
      }
      // Worldgen structure definitions
      if (/^data\/[^/]+\/worldgen\/structure\/.+\.json$/.test(relPath)) {
        try {
          const json = JSON.parse(await state.zip.file(fullPath).async('string'));
          const parts = relPath.split('/');
          const ns = parts[1];
          const localId = parts.slice(4).join('/').replace(/\.json$/, '');
          const id = `${ns}:${localId}`;
          state.structures.set(fullPath, { id, ns, localId, name: toDisplayName(id), json });
        } catch { }
        continue;
      }
      // Worldgen structure set definitions
      if (/^data\/[^/]+\/worldgen\/structure_set\/.+\.json$/.test(relPath)) {
        try {
          const json = JSON.parse(await state.zip.file(fullPath).async('string'));
          const parts = relPath.split('/');
          const ns = parts[1];
          const localId = parts.slice(4).join('/').replace(/\.json$/, '');
          const id = `${ns}:${localId}`;
          state.structureSets.set(fullPath, { id, ns, localId, name: toDisplayName(id), json });
        } catch { }
        continue;
      }
      // Worldgen biome and structure tag files — allow subdirectories
      if (/^data\/[^/]+\/tags\/worldgen\/(biome|structure)\/.+\.json$/.test(relPath)) {
        try {
          worldgenTagFiles.set(fullPath, JSON.parse(await state.zip.file(fullPath).async('string')));
        } catch { }
        continue;
      }
      // Custom biome definitions
      if (/^data\/[^/]+\/worldgen\/biome\/.+\.json$/.test(relPath)) {
        const parts = relPath.split('/');
        const ns = parts[1];
        const localId = parts.slice(4).join('/').replace(/\.json$/, '');
        state.customBiomes.add(`${ns}:${localId}`);
        continue;
      }
      // Villager trade definition files
      if (/^data\/[^/]+\/villager_trade\/.+\.json$/.test(relPath)) {
        try {
          const json = JSON.parse(await state.zip.file(fullPath).async('string'));
          const parts = relPath.split('/');
          const ns = parts[1];
          const localId = parts.slice(3).join('/').replace(/\.json$/, '');
          const id = `${ns}:${localId}`;
          state.villagerTrades.set(fullPath, { id, ns, localId, name: '', json, assignments: [], disabled: false });
        } catch { }
        continue;
      }
      // Pack lang files — used to resolve translate keys to display names
      if (/^assets\/[^/]+\/lang\/en_us\.json$/i.test(relPath)) {
        try {
          const lang = JSON.parse(await state.zip.file(fullPath).async('string'));
          for (const [k, v] of Object.entries(lang)) {
            if (typeof v === 'string') state.langMap.set(k, v);
          }
        } catch { }
        continue;
      }
      // Villager trade tag files — profession/level_<N>.json or wandering_trader/<list>.json
      const vTagMatch = relPath.match(/^data\/minecraft\/tags\/villager_trade\/([^/]+)\/level_(\d+)\.json$/);
      if (vTagMatch) {
        try {
          const [, profession, levelStr] = vTagMatch;
          const raw = JSON.parse(await state.zip.file(fullPath).async('string'));
          state.villagerTradeTags.set(fullPath, {
            profession,
            level: parseInt(levelStr, 10),
            originalValues: [...(raw.values ?? [])],
          });
        } catch { }
        continue;
      }
      const wtMatch = relPath.match(/^data\/minecraft\/tags\/villager_trade\/wandering_trader\/(buying|common|uncommon)\.json$/);
      if (wtMatch) {
        try {
          const raw = JSON.parse(await state.zip.file(fullPath).async('string'));
          state.villagerTradeTags.set(fullPath, {
            profession: 'wandering_trader',
            tradeList: wtMatch[1],
            originalValues: [...(raw.values ?? [])],
          });
        } catch { }
        continue;
      }
    }

    // Build trade assignments from tag files (reverse lookup: tradeId → assignments)
    const assignLookup = new Map();
    for (const tag of state.villagerTradeTags.values()) {
      for (const v of tag.originalValues) {
        const id = typeof v === 'object' ? v.id : v;
        if (!assignLookup.has(id)) assignLookup.set(id, []);
        if (tag.tradeList) {
          assignLookup.get(id).push({ profession: 'wandering_trader', tradeList: tag.tradeList });
        } else {
          assignLookup.get(id).push({ profession: tag.profession, level: tag.level });
        }
      }
    }
    for (const trade of state.villagerTrades.values()) {
      trade.assignments = assignLookup.get(trade.id) ?? [];
      // Resolve name now that langMap is fully populated
      trade.name = resolveItemName(trade.json) || toDisplayName(trade.localId.split('/').pop());
      trade._jsonSnapshot = JSON.stringify(trade.json);
      trade._assignmentsSnapshot = JSON.stringify(trade.assignments);
    }

    state._worldgenTagFiles = worldgenTagFiles;
    for (const path of state.tagFiles.keys()) resolveTag(path);
    showLoading('Rendering UI…');
  }

  // ── Pack info bar ──────────────────────────────────────────────────────────

  function resolveTextComp(comp) {
    if (!comp) return '';
    if (typeof comp === 'string') return comp;
    if (Array.isArray(comp)) return comp.map(resolveTextComp).join('');
    if (typeof comp === 'object') return String(comp.text ?? comp.translate ?? '');
    return '';
  }

  function renderPackBar() {
    const packSection = state.packMeta?.pack ?? {};
    const desc = packSection.description ?? '';
    const fmtRaw = packSection.pack_format ?? packSection.max_format ?? packSection.min_format;
    const fmtNum = Array.isArray(fmtRaw) ? fmtRaw[0] : fmtRaw;
    const fmtN = Number(fmtNum);
    const fmt = fmtNum != null ? String(isNaN(fmtN) ? fmtNum : Math.floor(fmtN)) : '?';
    const displayDesc = resolveTextComp(desc) || String(desc);
    el.packName.textContent = displayDesc || 'Unknown pack';
    el.packVer.textContent = state.mcVersion ? `MC ${state.mcVersion}` : `pack_format ${fmt}`;
    // Tab counts
    $('cfg-count-enchantments').textContent = state.enchantments.size;
    $('cfg-count-mob-variants').textContent = [...state.mobVariants.values()].reduce((n, m) => n + m.size, 0);
    $('cfg-count-structures').textContent = state.structures.size;
    $('cfg-count-structure-sets').textContent = state.structureSets.size;
    $('cfg-count-villager-trades').textContent = state.villagerTrades.size;
  }

  // ── Tab switching ──────────────────────────────────────────────────────────

  function switchTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.cfg-tab-btn').forEach(btn => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.cfg-tab-panel').forEach(panel => {
      panel.hidden = panel.dataset.tab !== name;
    });
  }

  // ── Enchantments tab ───────────────────────────────────────────────────────

  function renderEnchantments() {
    const rows = [...state.enchantments.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name));

    if (!rows.length) {
      el.enchTbody.innerHTML = '<tr class="cfg-empty-row"><td colspan="8">No enchantments found in this pack.</td></tr>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const [zipPath, ench] of rows) {
      const tr = document.createElement('tr');

      // Name
      const tdName = document.createElement('td');
      tdName.textContent = ench.name;
      tdName.title = ench.id;
      tr.appendChild(tdName);

      // Weight
      const tdWeight = document.createElement('td');
      const weightInput = document.createElement('input');
      weightInput.type = 'number';
      weightInput.className = 'cfg-weight-input';
      weightInput.min = '0';
      weightInput.value = ench.json.weight ?? '';
      weightInput.title = 'Loot weight — higher = more common';
      weightInput.addEventListener('change', () => {
        const v = parseInt(weightInput.value, 10);
        ench.json.weight = isNaN(v) ? 0 : Math.max(0, v);
        weightInput.value = ench.json.weight;
      });
      tdWeight.appendChild(weightInput);
      tr.appendChild(tdWeight);

      // Loot source checkboxes
      for (const src of LOOT_SOURCES) {
        const td = document.createElement('td');
        const fullTagPath = state.zipRoot + src.path;
        const tagSet = resolveTag(fullTagPath);
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = tagSet.has(ench.id);
        cb.title = src.path;
        cb.addEventListener('change', () => {
          if (!state.tagFiles.has(fullTagPath)) {
            state.tagFiles.set(fullTagPath, { values: [], replace: false });
          }
          const raw = state.tagFiles.get(fullTagPath);
          if (cb.checked) {
            if (!raw.values.some(v => tagEntryId(v) === ench.id)) raw.values.push(ench.id);
          } else {
            raw.values = raw.values.filter(v => tagEntryId(v) !== ench.id);
          }
          invalidateTag(fullTagPath);
        });
        td.appendChild(cb);
        tr.appendChild(td);
      }

      frag.appendChild(tr);
    }

    el.enchTbody.innerHTML = '';
    el.enchTbody.appendChild(frag);
  }

  // ── Option builders (structures + biomes) ──────────────────────────────────

  function buildOptions(type) {
    const groups = [];
    const mcVer = state.mcVersion;
    const pd = state.packData;

    // This pack's own structures / biomes
    if (type === 'structures') {
      const ids = [...state.structures.values()].map(s => s.id);
      if (ids.length) groups.push({ label: 'This Pack', items: ids });
    } else if (type === 'biomes' && state.customBiomes.size) {
      groups.push({ label: 'This Pack', items: [...state.customBiomes].sort() });
    }

    if (!pd) return groups;

    // Vanilla: exact version match, or fall back to first available version
    const vanillaVersions = pd.vanillaByVersion ?? {};
    const vData = (mcVer && vanillaVersions[mcVer]) ?? Object.values(vanillaVersions)[0] ?? {};
    const vItems = vData[type] || [];
    if (vItems.length) groups.push({ label: 'Vanilla Minecraft', items: vItems });

    // External packs: exact → 'all' → first available version
    for (const pack of (pd.externalPacks || [])) {
      const byVer = pack.byVersion ?? {};
      const vEntry = (mcVer && byVer[mcVer])
        ?? byVer['all']
        ?? Object.values(byVer)[0]
        ?? null;
      if (!vEntry) continue;
      const items = vEntry[type] || [];
      if (items.length) groups.push({ label: pack.displayName, items });
    }

    return groups;
  }

  // ── Picker ─────────────────────────────────────────────────────────────────

  let pickerCallback = null;
  let pickerSelected = null;

  function openPicker(anchorEl, type, currentValues, onSelect) {
    pickerCallback = onSelect;
    pickerSelected = new Set(currentValues);
    const groups = buildOptions(type);
    renderPickerList(groups, '');

    el.pickerSearch.value = '';
    el.picker.hidden = false;

    // Position below/above anchor — picker is position:fixed so coordinates
    // are already in viewport space; do NOT add scrollY.
    const rect = anchorEl.getBoundingClientRect();
    const ph = 360; // max-height from CSS
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = (spaceBelow < ph + 8 && rect.top > ph)
      ? rect.top - ph - 4
      : rect.bottom + 4;
    const left = Math.min(rect.left, window.innerWidth - (parseInt(getComputedStyle(el.picker).width) || 360) - 8);
    el.picker.style.top = `${Math.max(8, top)}px`;
    el.picker.style.left = `${Math.max(8, left)}px`;

    el.pickerSearch.focus();

    el.pickerSearch.oninput = () => renderPickerList(groups, el.pickerSearch.value.toLowerCase());
  }

  function renderPickerList(groups, q) {
    const flat = groups.flatMap(g => g.items.filter(id =>
      !q || id.toLowerCase().includes(q) || toDisplayName(id).toLowerCase().includes(q)
    ).map(id => ({ id, group: g.label })));

    // Custom namespaced ID: show "Add: ns:id" when the raw search value looks like one
    const rawQ = el.pickerSearch.value.trim();
    const isNamespacedId = rawQ.includes(':') && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(rawQ);
    const alreadyInList = isNamespacedId && flat.some(({ id }) => id.toLowerCase() === rawQ.toLowerCase());

    const frag = document.createDocumentFragment();

    if (isNamespacedId && !alreadyInList) {
      const li = document.createElement('li');
      const sel = pickerSelected?.has(rawQ);
      li.className = 'cfg-picker__item cfg-picker__item--custom' + (sel ? ' is-selected' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', sel ? 'true' : 'false');
      li.innerHTML = `<span class="cfg-picker__custom-prefix">Add: </span>${escapeHtml(rawQ)}`;
      li.title = rawQ;
      li.addEventListener('click', () => {
        const nowSel = pickerSelected?.has(rawQ);
        if (nowSel) { pickerSelected.delete(rawQ); li.classList.remove('is-selected'); li.setAttribute('aria-selected', 'false'); }
        else { pickerSelected.add(rawQ); li.classList.add('is-selected'); li.setAttribute('aria-selected', 'true'); }
        if (pickerCallback) pickerCallback(rawQ, pickerSelected.has(rawQ));
      });
      frag.appendChild(li);
    }

    if (!flat.length) {
      if (!isNamespacedId || alreadyInList) {
        el.pickerList.innerHTML = `<li class="cfg-picker__empty">No options match. Type namespace:id to add a custom entry.</li>`;
        return;
      }
      el.pickerList.innerHTML = '';
      el.pickerList.appendChild(frag);
      return;
    }

    let lastGroup = null;
    for (const { id, group } of flat) {
      if (group !== lastGroup) {
        const li = document.createElement('li');
        li.className = 'cfg-picker__group-label';
        li.textContent = group;
        frag.appendChild(li);
        lastGroup = group;
      }
      const li = document.createElement('li');
      li.className = 'cfg-picker__item' + (pickerSelected.has(id) ? ' is-selected' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', pickerSelected.has(id) ? 'true' : 'false');
      li.textContent = id;
      li.title = toDisplayName(id);
      li.addEventListener('click', () => {
        if (pickerSelected.has(id)) {
          pickerSelected.delete(id);
          li.classList.remove('is-selected');
          li.setAttribute('aria-selected', 'false');
        } else {
          pickerSelected.add(id);
          li.classList.add('is-selected');
          li.setAttribute('aria-selected', 'true');
        }
        if (pickerCallback) pickerCallback(id, pickerSelected.has(id));
      });
      frag.appendChild(li);
    }
    el.pickerList.innerHTML = '';
    el.pickerList.appendChild(frag);
  }

  function closePicker() {
    el.picker.hidden = true;
    pickerCallback = null;
    pickerSelected = null;
  }

  // ── Token list helper ──────────────────────────────────────────────────────
  // `values` must be a long-lived array reference — mutations are in-place via splice.

  function makeTokenList(values, pickerType) {
    const wrap = document.createElement('div');
    wrap.className = 'cfg-token-list';
    const update = () => {
      wrap.innerHTML = '';
      for (const v of [...values]) {
        const span = document.createElement('span');
        span.className = 'cfg-token';
        span.title = v;
        const labelEl = document.createElement('span');
        labelEl.className = 'cfg-token__label';
        labelEl.textContent = v;
        span.appendChild(labelEl);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cfg-token__remove';
        btn.title = 'Remove';
        btn.textContent = '×';
        btn.addEventListener('click', () => {
          const i = values.indexOf(v);
          if (i >= 0) values.splice(i, 1);
          update();
        });
        span.appendChild(btn);
        wrap.appendChild(span);
      }
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'cfg-add-token-btn';
      addBtn.title = 'Add…';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', () => {
        openPicker(addBtn, pickerType, values, (id, added) => {
          if (added && !values.includes(id)) { values.push(id); update(); }
          else if (!added) { const i = values.indexOf(id); if (i >= 0) { values.splice(i, 1); update(); } }
        });
      });
      wrap.appendChild(addBtn);
    };
    update();
    return wrap;
  }

  // ── Mob Variants tab ───────────────────────────────────────────────────────

  function parseBiomesValue(val) {
    if (!val) return [];
    const toId = v => {
      if (!v) return null;
      if (typeof v === 'string') return v;
      if (typeof v === 'object') return v.id ?? v.value ?? null;
      return null;
    };
    if (Array.isArray(val)) return val.map(toId).filter(Boolean);
    const id = toId(val);
    return id ? [id] : [];
  }

  // Normalise a raw biome/structure field value to a flat array of string IDs.
  // Tag refs (#namespace:name) are kept as single tokens; makeTokenList renders
  // them with a hover popup showing the resolved contents.
  function resolveConditionField(raw) {
    return parseBiomesValue(raw);
  }

  function renderMobVariants() {
    el.mobBody.innerHTML = '';
    if (!state.mobVariants.size) {
      el.mobBody.innerHTML = '<p class="cfg-empty-msg">No mob variants found in this pack.</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const [entityType, variants] of [...state.mobVariants.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const details = document.createElement('details');
      details.className = 'cfg-mob-group';

      const summary = document.createElement('summary');
      summary.innerHTML = `${escapeHtml(entityTypeLabel(entityType))}<span class="cfg-mob-group-count">${variants.size}</span>`;
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'cfg-mob-group-body';

      for (const [fullId, { zipPath, json }] of [...variants.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const card = document.createElement('div');
        card.className = 'cfg-variant-card';

        const hdr = document.createElement('div');
        hdr.className = 'cfg-variant-header';
        hdr.textContent = toDisplayName(fullId);
        card.appendChild(hdr);

        const condList = document.createElement('div');
        condList.className = 'cfg-conditions-list';

        if (!Array.isArray(json.spawn_conditions)) json.spawn_conditions = [];
        const conditions = json.spawn_conditions;

        // Resolve + normalise editable condition fields on first load
        for (const cond of conditions) {
          if (!cond.condition) cond.condition = { type: 'unknown' };
          const t = cond.condition.type;
          if (t === 'minecraft:structure' && !Array.isArray(cond.condition.structures))
            cond.condition.structures = resolveConditionField(cond.condition.structures);
          if (t === 'minecraft:biome' && !Array.isArray(cond.condition.biomes))
            cond.condition.biomes = resolveConditionField(cond.condition.biomes);
        }

        const renderConditions = () => {
          condList.innerHTML = '';
          conditions.forEach((cond, i) => {
            const condType = cond.condition?.type ?? 'unknown';
            // Only show structure/biome conditions — other types are preserved in output but not shown
            if (condType !== 'minecraft:structure' && condType !== 'minecraft:biome') return;

            const row = document.createElement('div');
            row.className = 'cfg-condition-row';

            // Type selector (allows switching between structure / biome)
            const typeSelect = document.createElement('select');
            typeSelect.className = 'cfg-condition-type-select';
            for (const t of ['minecraft:structure', 'minecraft:biome']) {
              const opt = document.createElement('option');
              opt.value = t;
              opt.textContent = t.replace('minecraft:', '');
              if (t === condType) opt.selected = true;
              typeSelect.appendChild(opt);
            }
            typeSelect.addEventListener('change', () => {
              const newType = typeSelect.value;
              cond.condition.type = newType;
              delete cond.condition.structures;
              delete cond.condition.biomes;
              if (newType === 'minecraft:structure') cond.condition.structures = [];
              else cond.condition.biomes = [];
              renderConditions();
            });
            row.appendChild(typeSelect);

            // Priority
            const prioCol = document.createElement('div');
            const prioLabel = document.createElement('div');
            prioLabel.className = 'cfg-condition-label';
            prioLabel.textContent = 'Priority';
            const prioInput = document.createElement('input');
            prioInput.type = 'number';
            prioInput.className = 'cfg-priority-input';
            prioInput.value = cond.priority ?? 0;
            prioInput.title = 'Lower number = higher priority';
            prioInput.addEventListener('change', () => { cond.priority = parseInt(prioInput.value, 10) || 0; });
            prioCol.appendChild(prioLabel);
            prioCol.appendChild(prioInput);
            row.appendChild(prioCol);

            // Editable field
            if (condType === 'minecraft:structure') {
              if (!Array.isArray(cond.condition.structures)) cond.condition.structures = [];
              const col = document.createElement('div');
              const lbl = document.createElement('div');
              lbl.className = 'cfg-condition-label';
              lbl.textContent = 'Structures';
              col.appendChild(lbl);
              col.appendChild(makeTokenList(cond.condition.structures, 'structures'));
              row.appendChild(col);
            } else {
              if (!Array.isArray(cond.condition.biomes)) cond.condition.biomes = [];
              const col = document.createElement('div');
              const lbl = document.createElement('div');
              lbl.className = 'cfg-condition-label';
              lbl.textContent = 'Biomes';
              col.appendChild(lbl);
              col.appendChild(makeTokenList(cond.condition.biomes, 'biomes'));
              row.appendChild(col);
            }

            // Remove condition
            const rmBtn = document.createElement('button');
            rmBtn.type = 'button';
            rmBtn.className = 'cfg-condition-remove';
            rmBtn.title = 'Remove condition';
            rmBtn.textContent = '×';
            rmBtn.addEventListener('click', () => { conditions.splice(i, 1); renderConditions(); });
            row.appendChild(rmBtn);

            condList.appendChild(row);
          });

          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'cfg-add-condition-btn';
          addBtn.innerHTML = '<i class="bi bi-plus-circle" aria-hidden="true"></i> Add spawn condition';
          addBtn.addEventListener('click', () => {
            conditions.push({ condition: { type: 'minecraft:biome', biomes: [] }, priority: 0 });
            renderConditions();
          });
          condList.appendChild(addBtn);
        };

        renderConditions();
        card.appendChild(condList);
        body.appendChild(card);
      }

      details.appendChild(body);
      frag.appendChild(details);
    }

    el.mobBody.appendChild(frag);
  }

  // ── Structures tab ─────────────────────────────────────────────────────────

  function resolveOneBiomeEntry(entry) {
    const s = typeof entry === 'object' ? (entry?.id ?? entry?.value ?? '') : String(entry ?? '');
    return s ? [s] : [];
  }

  function parseBiomesField(json) {
    const raw = json.biomes;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.flatMap(resolveOneBiomeEntry);
    return resolveOneBiomeEntry(raw);
  }

  function renderStructures() {
    const cards = [...state.structures.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name));

    el.structBody.innerHTML = '';
    if (!cards.length) {
      el.structBody.innerHTML = '<p class="cfg-empty-msg">No worldgen structures found in this pack.</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const [zipPath, struct] of cards) {
      const card = document.createElement('details');
      card.className = 'cfg-struct-card';

      const hdr = document.createElement('summary');
      hdr.className = 'cfg-struct-header';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'cfg-struct-name';
      nameSpan.textContent = struct.name;
      const idSpan = document.createElement('span');
      idSpan.className = 'cfg-struct-id';
      idSpan.textContent = struct.id;
      const chevron = document.createElement('i');
      chevron.className = 'bi bi-chevron-down cfg-struct-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      hdr.appendChild(nameSpan);
      hdr.appendChild(idSpan);
      hdr.appendChild(chevron);
      card.appendChild(hdr);

      const biomeLabel = document.createElement('div');
      biomeLabel.className = 'cfg-section-label';
      biomeLabel.textContent = 'Biomes';
      card.appendChild(biomeLabel);

      // Build mutable biomes array from current JSON
      const currentBiomes = parseBiomesField(struct.json);
      // Store back as mutable array so edits work consistently
      struct.json.biomes = currentBiomes;

      card.appendChild(makeTokenList(currentBiomes, 'biomes'));

      frag.appendChild(card);
    }

    el.structBody.appendChild(frag);
  }

  // ── Structure Sets tab ─────────────────────────────────────────────────────

  // Renders a mutable list of { structure, weight } entries with a picker-backed
  // add button. `entries` is the live json.structures array — mutations are in-place.
  function makeStructureWeightList(entries) {
    const wrap = document.createElement('div');
    wrap.className = 'cfg-sw-list';

    const update = () => {
      wrap.innerHTML = '';

      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'cfg-sw-row';

        const idEl = document.createElement('span');
        idEl.className = 'cfg-sw-id';
        idEl.textContent = entry.structure;
        idEl.title = entry.structure;
        row.appendChild(idEl);

        const weightLabel = document.createElement('label');
        weightLabel.className = 'cfg-sw-weight-wrap';

        const weightLbl = document.createElement('span');
        weightLbl.className = 'cfg-placement-label';
        weightLbl.textContent = 'Weight';

        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.className = 'cfg-placement-input cfg-sw-weight-input';
        weightInput.min = '1';
        weightInput.value = entry.weight ?? 1;
        weightInput.addEventListener('change', () => {
          const val = Math.max(1, Math.round(Number(weightInput.value)));
          weightInput.value = val;
          entry.weight = val;
        });

        weightLabel.appendChild(weightLbl);
        weightLabel.appendChild(weightInput);
        row.appendChild(weightLabel);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'cfg-token__remove cfg-sw-remove';
        removeBtn.title = 'Remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          const i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          update();
        });
        row.appendChild(removeBtn);

        wrap.appendChild(row);
      }

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'cfg-add-token-btn';
      addBtn.title = 'Add structure…';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', () => {
        const currentIds = entries.map(e => e.structure);
        openPicker(addBtn, 'structures', currentIds, (id, added) => {
          if (added && !entries.some(e => e.structure === id)) {
            entries.push({ structure: id, weight: 1 });
            update();
          } else if (!added) {
            const i = entries.findIndex(e => e.structure === id);
            if (i >= 0) { entries.splice(i, 1); update(); }
          }
        });
      });
      wrap.appendChild(addBtn);
    };

    update();
    return wrap;
  }

  function renderStructureSets() {
    const cards = [...state.structureSets.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name));

    el.structSetBody.innerHTML = '';
    if (!cards.length) {
      el.structSetBody.innerHTML = '<p class="cfg-empty-msg">No worldgen structure sets found in this pack.</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const [, entry] of cards) {
      const card = document.createElement('details');
      card.className = 'cfg-struct-card';

      const hdr = document.createElement('summary');
      hdr.className = 'cfg-struct-header';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'cfg-struct-name';
      nameSpan.textContent = entry.name;
      const idSpan = document.createElement('span');
      idSpan.className = 'cfg-struct-id';
      idSpan.textContent = entry.id;
      const chevron = document.createElement('i');
      chevron.className = 'bi bi-chevron-down cfg-struct-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      hdr.appendChild(nameSpan);
      hdr.appendChild(idSpan);
      hdr.appendChild(chevron);
      card.appendChild(hdr);

      const placement = entry.json.placement ?? {};

      const row = document.createElement('div');
      row.className = 'cfg-placement-row';

      for (const field of ['spacing', 'separation', 'salt']) {
        const wrap = document.createElement('label');
        wrap.className = 'cfg-placement-field';

        const lbl = document.createElement('span');
        lbl.className = 'cfg-placement-label';
        lbl.textContent = field.charAt(0).toUpperCase() + field.slice(1);

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'cfg-placement-input';
        input.min = '0';
        input.value = placement[field] ?? 0;
        input.addEventListener('change', () => {
          const val = Math.max(0, Math.round(Number(input.value)));
          input.value = val;
          if (!entry.json.placement) entry.json.placement = {};
          entry.json.placement[field] = val;
        });

        wrap.appendChild(lbl);

        if (field === 'salt') {
          const inputRow = document.createElement('div');
          inputRow.className = 'cfg-placement-input-row';

          const randBtn = document.createElement('button');
          randBtn.type = 'button';
          randBtn.className = 'cfg-placement-random';
          randBtn.title = 'Randomize salt';
          randBtn.innerHTML = '<i class="bi bi-shuffle" aria-hidden="true"></i>';
          randBtn.addEventListener('click', () => {
            const val = Math.floor(Math.random() * 2_147_483_647);
            input.value = val;
            if (!entry.json.placement) entry.json.placement = {};
            entry.json.placement.salt = val;
          });

          inputRow.appendChild(input);
          inputRow.appendChild(randBtn);
          wrap.appendChild(inputRow);
        } else {
          wrap.appendChild(input);
        }

        row.appendChild(wrap);
      }

      card.appendChild(row);

      // Structures list
      const structLabel = document.createElement('div');
      structLabel.className = 'cfg-section-label cfg-section-label--top-gap';
      structLabel.textContent = 'Structures';
      card.appendChild(structLabel);

      if (!Array.isArray(entry.json.structures)) entry.json.structures = [];
      card.appendChild(makeStructureWeightList(entry.json.structures));

      frag.appendChild(card);
    }

    el.structSetBody.appendChild(frag);
  }

  // ── Villager Trades tab ────────────────────────────────────────────────────

  function parseCountRange(v) {
    if (typeof v === 'number') return { min: v, max: v };
    if (typeof v === 'object' && v !== null) {
      const min = v.min_inclusive ?? v.min ?? v.value ?? 1;
      const max = v.max_inclusive ?? v.max ?? min;
      return { min, max };
    }
    return { min: 1, max: 1 };
  }

  function makeItemRow(labelText, itemObj, opts = {}) {
    const row = document.createElement('div');
    row.className = 'cfg-trade-item-row';

    const label = document.createElement('span');
    label.className = 'cfg-trade-item-label';
    label.textContent = labelText;
    row.appendChild(label);

    if (opts.toggleable) {
      const hasItem = itemObj.ref !== null;

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'cfg-trade-item-toggle';
      toggle.checked = hasItem;
      toggle.title = 'Add second payment item';

      const fieldWrap = document.createElement('span');
      fieldWrap.className = 'cfg-trade-item-fields';
      if (!hasItem) fieldWrap.hidden = true;

      const buildFields = () => {
        fieldWrap.innerHTML = '';
        if (itemObj.ref === null) return;
        fieldWrap.appendChild(makeItemFields(itemObj.ref));
      };

      toggle.addEventListener('change', () => {
        if (toggle.checked) {
          itemObj.ref = { id: 'minecraft:emerald', count: 1 };
          fieldWrap.hidden = false;
          buildFields();
        } else {
          itemObj.ref = null;
          fieldWrap.hidden = true;
          fieldWrap.innerHTML = '';
        }
      });

      buildFields();
      row.appendChild(toggle);
      row.appendChild(fieldWrap);
    } else {
      row.appendChild(makeItemFields(itemObj));
    }

    return row;
  }

  function makeItemFields(itemObj) {
    const wrap = document.createElement('span');
    wrap.className = 'cfg-trade-item-fields';

    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.className = 'cfg-trade-item-input';
    idInput.placeholder = 'minecraft:emerald';
    idInput.value = itemObj.id ?? '';
    idInput.spellcheck = false;
    idInput.setAttribute('list', 'cfg-item-datalist');
    idInput.addEventListener('change', () => {
      itemObj.id = idInput.value.trim() || 'minecraft:emerald';
      idInput.value = itemObj.id;
    });

    const { min: initMin, max: initMax } = parseCountRange(itemObj.count ?? 1);

    const minLabel = document.createElement('span');
    minLabel.className = 'cfg-trade-item-sep';
    minLabel.textContent = 'Min';
    minLabel.setAttribute('aria-hidden', 'true');

    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.className = 'cfg-trade-count-input';
    minInput.min = '1';
    minInput.value = initMin;
    minInput.title = 'Minimum count';

    const maxLabel = document.createElement('span');
    maxLabel.className = 'cfg-trade-item-sep';
    maxLabel.textContent = 'Max';
    maxLabel.setAttribute('aria-hidden', 'true');

    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.className = 'cfg-trade-count-input';
    maxInput.min = '1';
    maxInput.value = initMax;
    maxInput.title = 'Maximum count';

    const syncCount = () => {
      const min = Math.max(1, Math.round(Number(minInput.value)));
      let max = Math.max(1, Math.round(Number(maxInput.value)));
      if (max < min) { max = min; maxInput.value = max; }
      minInput.value = min;
      itemObj.count = min === max ? min : { min_inclusive: min, max_inclusive: max };
    };

    minInput.addEventListener('change', syncCount);
    maxInput.addEventListener('change', syncCount);

    wrap.appendChild(idInput);
    wrap.appendChild(minLabel);
    wrap.appendChild(minInput);
    wrap.appendChild(maxLabel);
    wrap.appendChild(maxInput);
    return wrap;
  }

  function makeAssignmentList(trade) {
    const wrap = document.createElement('div');
    wrap.className = 'cfg-trade-assignment-list';

    const update = () => {
      wrap.innerHTML = '';

      for (let i = 0; i < trade.assignments.length; i++) {
        const asgn = trade.assignments[i];
        const row = document.createElement('div');
        row.className = 'cfg-trade-assignment-row';

        const profSel = document.createElement('select');
        profSel.className = 'cfg-trade-select';
        for (const p of VILLAGER_PROFESSIONS) {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = toDisplayName(p);
          opt.selected = p === asgn.profession;
          profSel.appendChild(opt);
        }
        profSel.addEventListener('change', () => {
          asgn.profession = profSel.value;
          if (profSel.value === 'wandering_trader') {
            asgn.tradeList = asgn.tradeList ?? 'common';
            delete asgn.level;
          } else {
            asgn.level = asgn.level ?? 1;
            delete asgn.tradeList;
          }
          update();
        });

        // Second select — level for villagers, trade list for wandering trader
        if (asgn.profession === 'wandering_trader') {
          const listSel = document.createElement('select');
          listSel.className = 'cfg-trade-select';
          for (const list of WANDERING_TRADER_LISTS) {
            const opt = document.createElement('option');
            opt.value = list;
            opt.textContent = toDisplayName(list); // "Buying", "Common", "Uncommon"
            opt.selected = list === (asgn.tradeList ?? 'common');
            listSel.appendChild(opt);
          }
          listSel.addEventListener('change', () => { asgn.tradeList = listSel.value; });
          row.appendChild(profSel);
          row.appendChild(listSel);
        } else {
          const lvlSel = document.createElement('select');
          lvlSel.className = 'cfg-trade-select';
          VILLAGER_LEVELS.forEach((lbl, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx + 1);
            opt.textContent = `${idx + 1} - ${lbl}`;
            opt.selected = (idx + 1) === (asgn.level ?? 1);
            lvlSel.appendChild(opt);
          });
          lvlSel.addEventListener('change', () => { asgn.level = parseInt(lvlSel.value, 10); });
          row.appendChild(profSel);
          row.appendChild(lvlSel);
        }

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'cfg-token__remove cfg-trade-assignment-remove';
        removeBtn.title = 'Remove assignment';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          trade.assignments.splice(i, 1);
          update();
        });
        row.appendChild(removeBtn);
        wrap.appendChild(row);
      }

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'cfg-trade-add-btn';
      addBtn.textContent = '+ Add assignment';
      addBtn.addEventListener('click', () => {
        trade.assignments.push({ profession: 'farmer', level: 1 });
        update();
      });
      wrap.appendChild(addBtn);
    };

    update();
    return wrap;
  }

  function renderVillagerTrades() {
    const trades = [...state.villagerTrades.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name));

    el.tradesBody.innerHTML = '';
    if (!trades.length) {
      el.tradesBody.innerHTML = '<p class="cfg-empty-msg">No villager trades found in this pack.</p>';
      return;
    }

    const frag = document.createDocumentFragment();

    for (const [zipPath, trade] of trades) {
      const card = document.createElement('details');
      card.className = 'cfg-struct-card cfg-trade-card';

      // ── Header row: enabled checkbox + name + id ──
      const hdr = document.createElement('summary');
      hdr.className = 'cfg-trade-header';

      const enabledCb = document.createElement('input');
      enabledCb.type = 'checkbox';
      enabledCb.className = 'cfg-trade-enabled-cb';
      enabledCb.checked = !trade.disabled;
      enabledCb.title = 'Enable trade (uncheck to remove from all villager tag lists)';
      enabledCb.addEventListener('click', e => e.stopPropagation()); // prevent summary toggle
      enabledCb.addEventListener('change', () => {
        trade.disabled = !enabledCb.checked;
        card.classList.toggle('cfg-trade-card--disabled', trade.disabled);
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'cfg-struct-name';
      nameSpan.textContent = trade.name;

      const idSpan = document.createElement('span');
      idSpan.className = 'cfg-struct-id';
      idSpan.textContent = trade.id;

      const tradeChevron = document.createElement('i');
      tradeChevron.className = 'bi bi-chevron-down cfg-struct-chevron';
      tradeChevron.setAttribute('aria-hidden', 'true');
      hdr.appendChild(enabledCb);
      hdr.appendChild(nameSpan);
      hdr.appendChild(idSpan);
      hdr.appendChild(tradeChevron);
      card.appendChild(hdr);

      // ── Payment items ──
      const payLabel = document.createElement('div');
      payLabel.className = 'cfg-section-label';
      payLabel.textContent = 'Payment';
      card.appendChild(payLabel);

      if (!trade.json.wants) trade.json.wants = { id: 'minecraft:emerald', count: 1 };
      card.appendChild(makeItemRow('A', trade.json.wants));

      // Payment B is optional — wrap in a ref so the toggle can null it without
      // touching trade.json until download
      const wantsBRef = { ref: trade.json.additional_wants ?? null };
      trade._wantsBRef = wantsBRef;
      card.appendChild(makeItemRow('B', wantsBRef, { toggleable: true }));

      // ── Villager assignments ──
      const asgnLabel = document.createElement('div');
      asgnLabel.className = 'cfg-section-label cfg-section-label--top-gap';
      asgnLabel.textContent = 'Villager Type & Level';
      card.appendChild(asgnLabel);

      card.appendChild(makeAssignmentList(trade));

      // ── Villager variant (merchant_predicate) ──
      const variantLabel = document.createElement('div');
      variantLabel.className = 'cfg-section-label cfg-section-label--top-gap';
      variantLabel.textContent = 'Villager Variant';
      card.appendChild(variantLabel);

      const variantRow = document.createElement('div');
      variantRow.className = 'cfg-trade-variant-row';

      const currentVariant = getVillagerVariant(trade.json);

      const variantCb = document.createElement('input');
      variantCb.type = 'checkbox';
      variantCb.className = 'cfg-trade-item-toggle';
      variantCb.checked = currentVariant !== null;
      variantCb.title = 'Restrict trade to a specific villager village type';

      const variantNote = document.createElement('span');
      variantNote.className = 'cfg-trade-variant-note';
      variantNote.textContent = 'Restrict to:';

      const variantSel = document.createElement('select');
      variantSel.className = 'cfg-trade-select';
      variantSel.disabled = currentVariant === null;
      for (const v of VILLAGER_VARIANTS) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = toDisplayName(v.split(':')[1]); // "Plains", "Desert", etc.
        opt.selected = v === (currentVariant ?? 'minecraft:plains');
        variantSel.appendChild(opt);
      }

      const applyVariant = () => {
        if (variantCb.checked) {
          trade.json.merchant_predicate = {
            condition: 'minecraft:entity_properties',
            entity: 'this',
            predicate: { components: { 'minecraft:villager/variant': variantSel.value } },
          };
        } else {
          delete trade.json.merchant_predicate;
        }
      };

      variantCb.addEventListener('change', () => {
        variantSel.disabled = !variantCb.checked;
        applyVariant();
      });
      variantSel.addEventListener('change', applyVariant);

      variantRow.appendChild(variantCb);
      variantRow.appendChild(variantNote);
      variantRow.appendChild(variantSel);
      card.appendChild(variantRow);

      frag.appendChild(card);
    }

    el.tradesBody.appendChild(frag);
  }

  // Expand #tag refs in an ID array to their constituent IDs, but only when
  // the array mixes tag refs with plain IDs — a pure tag array is valid
  // Minecraft JSON and should be left untouched.
  // In a mixed array, tags that resolve to nothing are dropped (keeping a
  // #tag:ref alongside plain IDs would produce invalid output JSON).
  function expandTagRefs(ids, fieldType) {
    const hasTags  = ids.some(id => typeof id === 'string' && id.startsWith('#'));
    const hasPlain = ids.some(id => typeof id === 'string' && !id.startsWith('#'));
    if (!hasTags || !hasPlain) return ids; // pure tag array or plain array — no change needed

    const tagFiles = state._worldgenTagFiles || new Map();
    const out = [];
    for (const id of ids) {
      if (typeof id === 'string' && id.startsWith('#')) {
        const ref = id.slice(1);
        const [ns, name] = ref.includes(':') ? ref.split(':') : ['minecraft', ref];
        const tagPath = state.zipRoot + `data/${ns}/tags/worldgen/${fieldType}/${name}.json`;
        const resolved = resolveTagGeneric(tagPath, tagFiles);
        resolved.forEach(r => out.push(r)); // drop unresolvable tags — they're invalid here
      } else {
        out.push(id);
      }
    }
    return [...new Set(out)];
  }

  // ── Mob variant serialisation ──────────────────────────────────────────────
  // Produces clean JSON: condition.structures/biomes normalised to single string
  // when one item (matching vanilla format), removed when empty; empty top-level
  // structures/biomes arrays stripped.

  function serializeMobVariant(json) {
    if (!Array.isArray(json.spawn_conditions)) return JSON.stringify(json, null, 2);
    const normaliseField = arr => {
      if (!Array.isArray(arr) || arr.length === 0) return undefined;
      return arr.length === 1 ? arr[0] : arr;
    };
    const cleanedConditions = json.spawn_conditions
      .filter(cond => {
        const t = cond.condition?.type;
        if (!t || t === 'unknown') return false; // drop placeholder conditions
        // Drop structure/biome conditions with no entries — user cleared them
        if (t === 'minecraft:structure')
          return Array.isArray(cond.condition.structures) && cond.condition.structures.length > 0;
        if (t === 'minecraft:biome')
          return Array.isArray(cond.condition.biomes) && cond.condition.biomes.length > 0;
        return true; // always keep other condition types (moon_brightness, etc.)
      })
      .map(cond => {
        const out = {};
        if (cond.condition) {
          out.condition = { ...cond.condition };
          if (Array.isArray(out.condition.structures))
            out.condition.structures = expandTagRefs(out.condition.structures, 'structure');
          if (Array.isArray(out.condition.biomes))
            out.condition.biomes = expandTagRefs(out.condition.biomes, 'biome');
          const s = normaliseField(out.condition.structures);
          if (s === undefined) delete out.condition.structures; else out.condition.structures = s;
          const b = normaliseField(out.condition.biomes);
          if (b === undefined) delete out.condition.biomes; else out.condition.biomes = b;
        }
        out.priority = cond.priority ?? 0;
        for (const [k, v] of Object.entries(cond)) {
          if (k === 'condition' || k === 'priority') continue;
          if ((k === 'structures' || k === 'biomes') && Array.isArray(v) && v.length === 0) continue;
          out[k] = v;
        }
        return out;
      });
    return JSON.stringify({ ...json, spawn_conditions: cleanedConditions }, null, 2);
  }

  // ── Download ───────────────────────────────────────────────────────────────

  async function downloadModifiedZip() {
    el.dlBtn.disabled = true;
    el.dlBtn.innerHTML = '<span class="cfg-spinner" aria-hidden="true"></span> Building ZIP…';
    try {
      const clone = await JSZip.loadAsync(state.originalBuffer);

      for (const [path, { json }] of state.enchantments)
        clone.file(path, JSON.stringify(json, null, 2));

      for (const [path, raw] of state.tagFiles)
        clone.file(path, JSON.stringify(raw, null, 2));

      for (const variants of state.mobVariants.values())
        for (const { zipPath, json } of variants.values())
          clone.file(zipPath, serializeMobVariant(json));

      for (const [path, { json }] of state.structureSets)
        clone.file(path, JSON.stringify(json, null, 2));

      for (const [path, { json }] of state.structures) {
        const out = { ...json };
        if (Array.isArray(out.biomes)) {
          out.biomes = expandTagRefs(out.biomes, 'biome');
          if (Array.isArray(out.biomes) && out.biomes.length === 1) out.biomes = out.biomes[0];
        }
        clone.file(path, JSON.stringify(out, null, 2));
      }

      // Villager trades — rebuild tag files from current UI state
      const tradeTagOutput = new Map(); // fullPath → values[]
      // Seed with all original tag paths so we always overwrite them (even if they become empty)
      for (const path of state.villagerTradeTags.keys()) tradeTagOutput.set(path, []);
      // Populate from live trade assignments (skip disabled trades)
      for (const trade of state.villagerTrades.values()) {
        if (trade.disabled) continue;
        for (const asgn of trade.assignments) {
          const relPath = asgn.profession === 'wandering_trader' && asgn.tradeList
            ? `data/minecraft/tags/villager_trade/wandering_trader/${asgn.tradeList}.json`
            : `data/minecraft/tags/villager_trade/${asgn.profession}/level_${asgn.level}.json`;
          const fullPath = state.zipRoot + relPath;
          if (!tradeTagOutput.has(fullPath)) tradeTagOutput.set(fullPath, []);
          tradeTagOutput.get(fullPath).push(trade.id);
        }
      }
      // Write trade definition JSONs — only when actually changed
      for (const [path, trade] of state.villagerTrades) {
        // Build output without mutating trade.json (merge _wantsBRef separately)
        const out = { ...trade.json };
        if (trade._wantsBRef) {
          if (trade._wantsBRef.ref !== null) out.additional_wants = trade._wantsBRef.ref;
          else delete out.additional_wants;
        }
        if (JSON.stringify(out) !== trade._jsonSnapshot)
          clone.file(path, JSON.stringify(out, null, 2));
      }
      // Write tag files — only when values changed vs original
      for (const [path, values] of tradeTagOutput) {
        const orig = state.villagerTradeTags.get(path);
        const origStr = [...(orig?.originalValues ?? [])].sort().join('\0');
        const newStr  = [...values].sort().join('\0');
        if (origStr !== newStr || !orig)
          clone.file(path, JSON.stringify({ values }, null, 2));
      }

      const blob = await clone.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = (state.originalFileName || 'pack').replace(/\.zip$/i, '');
      a.download = `${baseName}_modified.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      showError('Failed to build ZIP: ' + err.message);
    } finally {
      el.dlBtn.disabled = false;
      el.dlBtn.innerHTML = '<i class="bi bi-download" aria-hidden="true"></i> Download configured pack';
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async function handleFile(file) {
    if (!file || !file.name.endsWith('.zip')) {
      showError('Please select a valid .zip file.');
      return;
    }
    // Clear any previously loaded pack before parsing the new one
    Object.assign(state, {
      originalBuffer: null, zip: null, packMeta: null, mcVersion: null,
      originalFileName: file.name,
      enchantments: new Map(), tagFiles: new Map(), resolvedTags: new Map(),
      mobVariants: new Map(), structures: new Map(), structureSets: new Map(),
      customBiomes: new Set(), _worldgenTagFiles: new Map(), zipRoot: '',
      villagerTrades: new Map(), villagerTradeTags: new Map(), langMap: new Map(),
    });
    try {
      await parseZip(file);
      renderPackBar();
      renderEnchantments();
      renderMobVariants();
      renderStructures();
      renderStructureSets();
      renderVillagerTrades();
      showEditor();
      switchTab('enchantments');
    } catch (err) {
      showError(err.message || 'Failed to parse the ZIP file.');
      el.uploadZone.hidden = false;
    }
  }

  function buildItemDatalist() {
    const dl = $('cfg-item-datalist');
    if (!dl || !state.packData?.vanillaItems?.length) return;
    const frag = document.createDocumentFragment();
    for (const id of state.packData.vanillaItems) {
      const opt = document.createElement('option');
      opt.value = id;
      frag.appendChild(opt);
    }
    dl.appendChild(frag);
  }

  async function init() {
    // Load pack data (non-fatal if missing)
    try {
      const resp = await fetch(PACK_DATA_URL);
      if (resp.ok) {
        state.packData = await resp.json();
        buildItemDatalist();
      }
    } catch { /* serve gracefully without external data */ }

    // Upload zone click
    el.uploadZone.addEventListener('click', () => el.fileInput.click());

    // File input
    el.fileInput.addEventListener('change', () => {
      const f = el.fileInput.files[0];
      if (f) handleFile(f);
    });

    // Drag-and-drop
    el.uploadZone.addEventListener('dragover', e => { e.preventDefault(); el.uploadZone.classList.add('is-dragover'); });
    el.uploadZone.addEventListener('dragleave', () => el.uploadZone.classList.remove('is-dragover'));
    el.uploadZone.addEventListener('drop', e => {
      e.preventDefault();
      el.uploadZone.classList.remove('is-dragover');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    });

    // Tabs
    document.querySelectorAll('.cfg-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Reset
    el.resetBtn.addEventListener('click', resetUI);

    // Download
    el.dlBtn.addEventListener('click', downloadModifiedZip);

    // Close picker on outside click / Escape
    document.addEventListener('click', e => {
      if (!el.picker.hidden && !el.picker.contains(e.target) && !e.target.classList.contains('cfg-add-token-btn')) {
        closePicker();
      }
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePicker(); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
