(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────────────────

  const uploadSection = document.getElementById('log-upload-section');
  const uploadZone    = document.getElementById('log-upload-zone');
  const fileInput     = document.getElementById('log-file-input');
  const resultsEl     = document.getElementById('log-results');

  // ── Upload handling ──────────────────────────────────────────────────────

  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('is-dragover'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('is-dragover'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('is-dragover');
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) processFile(fileInput.files[0]);
  });

  async function processFile(file) {
    const label = uploadZone.querySelector('.log-upload-label');
    const origText = label.textContent;
    label.textContent = 'Reading...';
    uploadZone.style.opacity = '.5';
    uploadZone.style.pointerEvents = 'none';

    try {
      const text   = await readFile(file);
      const groups = parseGroups(text);
      render(file.name, text, groups);
      uploadSection.hidden = true;
      resultsEl.hidden = false;
    } catch (err) {
      console.error(err);
      label.textContent = 'Could not read the file. Is this a valid Minecraft log?';
    } finally {
      uploadZone.style.opacity = '';
      uploadZone.style.pointerEvents = '';
      if (label.textContent === 'Reading...') label.textContent = origText;
    }
  }

  // ── File reader ───────────────────────────────────────────────────────────

  async function readFile(file) {
    if (file.name.endsWith('.gz')) {
      const ds = new DecompressionStream('gzip');
      const stream = file.stream().pipeThrough(ds);
      return new Response(stream).text();
    }
    return file.text();
  }

  // ── Line classification ───────────────────────────────────────────────────

  const CRASH_PATTERNS = [
    /----\s*Minecraft Crash Report/i,
    /\[FATAL\]/,
    /java\.lang\.OutOfMemoryError/,
    /java\.lang\.StackOverflowError/,
    /FATAL ERROR/i,
    /The game crashed whilst/i,
    /A fatal error has been detected/i,
    /Failed to load level data or datapacks/,
    /Failed to load registries due to errors/,
  ];

  const ERROR_PATTERNS = [
    /\[ERROR\]/,
    /\bException\b/,
    /\bError\b:/,
    /java\.\w+\.\w*Error\b/,
    /Caused by:/,
    /net\.minecraft\..*Exception/,
    /^>> Errors in element\b/,
    /^> Errors in registry\b/,
    /Registry loading errors:/,
    /Couldn't load tag\b/,
  ];

  const WARN_PATTERNS = [
    /\[WARN(?:ING)?\]/i,
    /\bWARN\b/,
  ];

  const STACK_TRACE_RE = /^\s+at |\s+\.\.\. \d+ more|^Caused by:/;

  function classifyLine(line) {
    for (const p of CRASH_PATTERNS) if (p.test(line)) return 'crash';
    for (const p of ERROR_PATTERNS) if (p.test(line)) return 'error';
    for (const p of WARN_PATTERNS)  if (p.test(line)) return 'warn';
    return 'info';
  }

  // ── Parser ────────────────────────────────────────────────────────────────

  function parseGroups(text) {
    const rawLines = text.split('\n');
    const groups   = [];
    let   cur      = null;

    for (let i = 0; i < rawLines.length; i++) {
      const line    = rawLines[i];
      const trimmed = line.trimEnd();
      if (!trimmed) continue;

      if (cur && (STACK_TRACE_RE.test(line) || /^Caused by:/.test(line))) {
        cur.stack.push(trimmed);
        if (cur.level !== 'crash') {
          for (const p of CRASH_PATTERNS) if (p.test(line)) { cur.level = 'crash'; break; }
        }
        continue;
      }

      if (/^Caused by:/.test(trimmed)) {
        cur = { level: 'error', text: trimmed, stack: [], lineNo: i + 1 };
        groups.push(cur);
        continue;
      }

      const level = classifyLine(trimmed);
      cur = { level, text: trimmed, stack: [], lineNo: i + 1 };
      groups.push(cur);
    }

    return groups;
  }

  // ── Crash report analysis ─────────────────────────────────────────────────
  // Parses the structured sections of a Minecraft crash report (.txt format)
  // to extract human-readable metadata: description, which mod crashed, etc.

  function analyzeCrashReport(text) {
    // "Description: X" - what the game was doing when it crashed
    const descM = text.match(/^Description: (.+)$/m);

    // First exception line
    const excM  = text.match(/^(java\.\S+Exception[^\n]*)/m);

    // Parse the Fabric/Forge/NeoForge mod list into a Map(modId -> friendlyName)
    const modsMap = new Map();
    const modsSection = text.match(/(?:Fabric|Forge|NeoForge) Mods:\s*([\s\S]+?)(?=\n\t(?:Loaded Shaderpack:|Launched Version:|Backend library:|Window size:|Is Modded:|Universe:|Type:|GPU |Render |Resource Packs:|Current Language:|Locale:|System encoding:|File encoding:|CPU:))/);
    if (modsSection) {
      // Lines are indented two tabs for top-level mods: "\t\tmodid: Friendly Name version"
      const modLineRe = /^\t\t([a-z][a-z0-9_-]+):\s+(.+?)\s+[\d]+\./gm;
      let mm;
      while ((mm = modLineRe.exec(modsSection[1])) !== null) {
        modsMap.set(mm[1], mm[2].trim());
      }
    }

    // Find the crashing mod via Mixin method name patterns like $modid$methodname
    // e.g. "modifyExpressionValue$beg000$goml$preventPlacingInClaim"
    let crashingModId   = null;
    let crashingModName = null;

    const mixinRe = /\$([a-z][a-z0-9_]+)\$/g;
    let mixinM;
    // Prefer a candidate that appears in the known mod list
    const mixinCandidates = [];
    while ((mixinM = mixinRe.exec(text)) !== null) mixinCandidates.push(mixinM[1]);
    for (const candidate of mixinCandidates) {
      if (modsMap.has(candidate)) { crashingModId = candidate; break; }
    }
    // Fallback: first alphabetic-only candidate (not hex-like) as the mod id
    if (!crashingModId) {
      for (const candidate of mixinCandidates) {
        if (/^[a-z][a-z_]+$/.test(candidate) && candidate.length >= 3) {
          crashingModId = candidate;
          break;
        }
      }
    }

    // If still nothing, look for the first non-vanilla package in the stack
    if (!crashingModId) {
      const skipPkg = /^(net\.minecraft|java\.|com\.mojang|net\.fabricmc\.loader|org\.lwjgl|jdk\.|sun\.|com\.sun\.|knot\/\/net\.minecraft)/;
      const frameRe = /^\s+at (?:knot\/\/)?([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]+){2,})\./gm;
      let   fm;
      while ((fm = frameRe.exec(text)) !== null) {
        const pkg = fm[1];
        if (!skipPkg.test(pkg)) {
          // Extract a likely mod-id segment from the package
          const parts = pkg.split('.');
          const skip  = new Set(['net', 'com', 'dev', 'me', 'io', 'org', 'java', 'mod']);
          const meaningful = parts.filter(p => !skip.has(p) && p.length >= 3 && /^[a-z]/.test(p));
          if (meaningful.length > 0) {
            crashingModId = meaningful[0];
            break;
          }
        }
      }
    }

    crashingModName = crashingModId
      ? (modsMap.get(crashingModId) || null)
      : null;

    // Incompatible resource packs (marked "(incompatible)" in crash report)
    const incompatiblePacks = [];
    const rpLine = text.match(/Resource Packs: ([^\n]+)/);
    if (rpLine) {
      const irRe = /file\/([^\s,]+)\s*\(incompatible\)/g;
      let   im;
      while ((im = irRe.exec(rpLine[1])) !== null) {
        incompatiblePacks.push(im[1]);
      }
    }

    // Max allocated memory
    const memM      = text.match(/up to (\d+) bytes \((\d+) MiB\)/);
    const maxMemMiB = memM ? parseInt(memM[2]) : null;

    return {
      description:     descM ? descM[1].trim() : null,
      exception:       excM  ? excM[1].trim()  : null,
      crashingModId,
      crashingModName,
      modsMap,
      incompatiblePacks,
      maxMemMiB,
      lowMemory: maxMemMiB !== null && maxMemMiB < 2048,
    };
  }

  // ── Structural analysis ───────────────────────────────────────────────────

  function analyzeStructure(text) {
    // Data pack element failures
    const packMap = new Map();
    const failedParseRe = /Failed to parse ([^\s]+) from pack ([^\n\r]+)/g;
    let m;
    while ((m = failedParseRe.exec(text)) !== null) {
      const element  = m[1];
      const packName = m[2].trim().replace(/^file\//, '');
      if (!packMap.has(packName)) packMap.set(packName, []);
      packMap.get(packName).push(element);
    }

    // Resource pack model failures
    const rpMap = new Map();
    const rpModelRe = /Couldn't parse item model '([^']+)' from pack '([^']+)'/g;
    while ((m = rpModelRe.exec(text)) !== null) {
      const model    = m[1];
      const packName = m[2].trim().replace(/^file\//, '');
      if (!rpMap.has(packName)) rpMap.set(packName, []);
      rpMap.get(packName).push(model);
    }

    // Tag failures
    const tagPackMap = new Map();
    const tagRe = /Couldn't load tag ([\w:]+) as it is missing following references: ([^\n\r]+)/g;
    while ((m = tagRe.exec(text)) !== null) {
      const refsStr = m[2];
      const fromRe  = /\(from (?:file\/)?([^)]+)\)/g;
      let   fm;
      while ((fm = fromRe.exec(refsStr)) !== null) {
        const packName = fm[1].trim();
        if (!tagPackMap.has(packName)) tagPackMap.set(packName, { tags: new Set(), missingItems: new Set() });
        tagPackMap.get(packName).tags.add(m[1]);
      }
      const itemRe = /(?:^|,\s*)([\w:]+)\s+\(from/g;
      let   im;
      while ((im = itemRe.exec(refsStr)) !== null) {
        for (const entry of tagPackMap.values()) entry.missingItems.add(im[1]);
      }
    }

    const hasVersionMismatch = /Unknown registry key in ResourceKey/.test(text);
    const hasFormatMismatch  = /No key (?:biomes|angry_texture|tame_texture|wild_texture) in MapLike/.test(text);
    const hasTagMissingItems = /missing following references/.test(text);
    const worldLoadFailed    = /Failed to load level data or datapacks|can't proceed with server load/.test(text);
    const isCrashReport      = /---- Minecraft Crash Report ----/.test(text);

    return {
      packFailures:        [...packMap.entries()].map(([pack, elements]) => ({ pack, elements })),
      resourcePackFailures:[...rpMap.entries()].map(([pack, models]) => ({ pack, models })),
      tagFailures:         [...tagPackMap.entries()].map(([pack, data]) => ({
        pack,
        tags:         [...data.tags],
        missingItems: [...data.missingItems],
      })),
      hasVersionMismatch,
      hasFormatMismatch,
      hasTagMissingItems,
      worldLoadFailed,
      isCrashReport,
      crashReport: isCrashReport ? analyzeCrashReport(text) : null,
    };
  }

  // ── Context extractors for tips ───────────────────────────────────────────

  function extractPackFromPackPhrase(text) {
    const names = new Set();
    let m;
    const re1 = /from pack '([^']+)'/g;
    while ((m = re1.exec(text)) !== null) names.add(m[1].replace(/^file\//, ''));
    const re2 = /from pack file\/([^\s\n\r,]+)/g;
    while ((m = re2.exec(text)) !== null) names.add(m[1].trim());
    return [...names];
  }

  function extractPackFromFromParens(text) {
    const names = new Set();
    const re = /\(from (?:file\/)?([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) names.add(m[1].trim());
    return [...names];
  }

  // ── Tip database ─────────────────────────────────────────────────────────

  const TIPS = [
    // ── Crash report ─────────────────────────────────────────────────────

    {
      id: 'nullpointer', severity: 'crash',
      patterns: ['NullPointerException'],
      title: 'A mod or the game encountered an unexpected crash',
      what: 'Something the game expected to exist was missing at the wrong moment. This is almost always a bug in a mod - often because a mod is incompatible with another mod, or was made for a different Minecraft version.',
      how:  'Check the "Crash Summary" at the top of the results - it identifies which mod was responsible. Update or temporarily remove that mod, then test if the crash happens again.',
    },
    {
      id: 'illegalstate', severity: 'crash',
      patterns: ['IllegalStateException'],
      title: 'A mod ran into an illegal state',
      what: 'A mod tried to do something it wasn\'t allowed to do at that point - usually because of a version mismatch or interaction with another mod.',
      how:  'Check the "Crash Summary" for which mod was involved. Update that mod, or temporarily disable it to confirm it\'s the source.',
    },
    {
      id: 'renderingcrash', severity: 'crash',
      patterns: ['Rendering entity in world', 'Rendering screen', 'Rendering overlay'],
      title: 'Game crashed while drawing something on screen',
      what: 'The crash happened while Minecraft was trying to display an entity, screen, or visual effect. A mod that changes how things look is the most likely cause.',
      how:  'Check the "Crash Summary" to see which mod was rendering when the crash happened, then update or remove it.',
    },

    // ── Registry / data pack loading ─────────────────────────────────────

    {
      id: 'worldnotopen', severity: 'crash',
      patterns: ['Failed to load level data or datapacks', "can't proceed with server load"],
      title: 'World could not be opened',
      what: 'Minecraft stopped trying to open the world because one or more data packs had critical errors.',
      how:  'Fix the data pack errors shown below. As a quick workaround, move the broken data pack files out of the world\'s "datapacks" folder - the world will open without them.',
    },
    {
      id: 'registryloading', severity: 'crash',
      patterns: ['Registry loading errors', 'Failed to load registries'],
      title: 'Data packs failed to load',
      what: 'One or more data packs ran into critical errors while Minecraft was loading them.',
      how:  'Check the "Data Pack Failures" section below to see which packs are affected and what to do.',
    },
    {
      id: 'registrykey', severity: 'error',
      patterns: ['Unknown registry key in ResourceKey', 'entity_sub_predicate_type'],
      title: 'Data pack is not compatible with your Minecraft version',
      what: 'A data pack uses game features that your current version of Minecraft does not support yet.',
      how:  'Update Minecraft to a newer version. If you cannot update, look for an older release of the data pack made for your current version.',
      contextExtract: extractPackFromPackPhrase,
    },
    {
      id: 'failedparse', severity: 'error',
      patterns: ['Failed to parse', 'from pack'],
      title: 'Data pack content could not be loaded',
      what: 'One or more files inside a data pack could not be understood by Minecraft - usually because the pack was built for a different version.',
      how:  'Check the "Data Pack Failures" section below for the exact pack name, then download the version that matches your Minecraft version.',
      contextExtract: extractPackFromPackPhrase,
    },
    {
      id: 'wolfformat', severity: 'error',
      patterns: ['No key biomes in MapLike', 'No key angry_texture in MapLike', 'No key wild_texture in MapLike', 'No key tame_texture in MapLike'],
      title: 'Data pack uses a file format from a newer Minecraft version',
      what: 'A data pack file is written in a format that was introduced in a newer Minecraft version and your game cannot read it. This commonly happens with wolf variants, entity types, or mob definitions when a pack targets 1.21.5+ but the game is older.',
      how:  'Update Minecraft to match what the data pack requires, or download an older release of the pack made for your current version.',
      contextExtract: extractPackFromPackPhrase,
    },
    {
      id: 'tagmissing', severity: 'error',
      patterns: ["Couldn't load tag", 'is missing following references', 'missing following references'],
      title: 'Data pack references blocks or items that do not exist in your Minecraft version',
      what: 'A data pack is trying to use blocks or items (like new plants, bushes, or other content) that were added in a newer version of Minecraft than you are running.',
      how:  'Update Minecraft to the version the pack was designed for, or find an older release of that pack made for your current version.',
      contextExtract: extractPackFromFromParens,
    },
    {
      id: 'unboundregistry', severity: 'error',
      patterns: ['Unbound values in registry'],
      title: 'A data pack item was completely rejected',
      what: 'A specific piece of content failed so badly that Minecraft refused to register it at all.',
      how:  'This is a side effect of the other errors in this log. Fix those first - this will go away once the data pack is compatible with your version.',
    },
    {
      id: 'componentmodel', severity: 'error',
      patterns: ['Unknown element id: minecraft:component'],
      title: 'Resource pack uses a model format from a newer Minecraft version',
      what: 'This resource pack\'s item model files use a format that was introduced in Minecraft 1.21.5. If you are on an older version, Minecraft cannot read them.',
      how:  'Update Minecraft to 1.21.5 or newer to match this resource pack, or download an older version of the resource pack made for your current game version.',
      contextExtract: extractPackFromPackPhrase,
    },

    // ── Memory ────────────────────────────────────────────────────────────

    {
      id: 'oom', severity: 'crash',
      patterns: ['OutOfMemoryError'],
      title: 'Minecraft ran out of memory',
      what: 'Minecraft needed more RAM than you have allocated and had to stop.',
      how:  'Open your launcher settings and increase the RAM allocation to at least 4 GB. Most launchers have a simple slider for this.',
    },
    {
      id: 'stackoverflow', severity: 'crash',
      patterns: ['StackOverflowError'],
      title: 'Something got stuck in an infinite loop',
      what: 'A piece of code kept repeating itself endlessly until the game crashed.',
      how:  'This is usually a mod or data pack bug. Try removing things you added recently, or search the mod\'s issue tracker.',
    },

    // ── Mod / version conflicts ───────────────────────────────────────────

    {
      id: 'nosuchmethod', severity: 'error',
      patterns: ['NoSuchMethodError', 'NoSuchFieldError'],
      title: 'Mod version mismatch',
      what: 'A mod is trying to use something that doesn\'t exist in the version you\'re running.',
      how:  'Make sure all your mods are built for the exact same Minecraft version and mod loader version. Update everything at the same time.',
    },
    {
      id: 'classnotfound', severity: 'error',
      patterns: ['ClassNotFoundException'],
      title: 'A required mod or library is missing',
      what: 'Something was expected to be installed, but Minecraft can\'t find it.',
      how:  'Check if the mod requires another mod (a "dependency") and make sure that mod is also in your mods folder.',
    },
    {
      id: 'classcast', severity: 'error',
      patterns: ['ClassCastException'],
      title: 'Two mods have incompatible versions',
      what: 'A mod received data in a format it doesn\'t understand, usually because versions don\'t match.',
      how:  'Update all your mods and the mod loader at the same time - mixing old and new versions causes this.',
    },
    {
      id: 'abstractmethod', severity: 'error',
      patterns: ['AbstractMethodError', 'IncompatibleClassChangeError'],
      title: 'Mod API changed between versions',
      what: 'A mod was built against an older version of another mod it depends on.',
      how:  'Update the affected mod to its latest version, or check the mod page for known compatibility issues.',
    },
    {
      id: 'concurrentmod', severity: 'error',
      patterns: ['ConcurrentModificationException'],
      title: 'Two mods clashing at the same time',
      what: 'Two mods tried to change the same game data at exactly the same moment.',
      how:  'This is usually a bug in one of the mods. Remove recently added mods one at a time to find the culprit, then report it to the author.',
    },
    {
      id: 'initexception', severity: 'error',
      patterns: ['ExceptionInInitializerError'],
      title: 'A mod failed during startup',
      what: 'Something went wrong while a mod was setting itself up when the game launched.',
      how:  'Look at the detail lines shown in the error - they describe what actually failed.',
    },
    {
      id: 'linkageerror', severity: 'error',
      patterns: ['LinkageError'],
      title: 'Two mods include the same library at different versions',
      what: 'Multiple mods are bundling the same code but in conflicting versions.',
      how:  'Check if either mod has a newer version that fixes this. If not, report it to both mod authors.',
    },
    {
      id: 'fmlload', severity: 'crash',
      patterns: ['ModLoadingException', 'FMLLoadingException', 'fml.loading'],
      title: 'A Forge mod failed to load',
      what: 'One of your Forge mods crashed during the game\'s startup process.',
      how:  'The error usually names the mod causing the problem. Try removing that mod and check if it\'s compatible with your Forge version.',
    },
    {
      id: 'fabricload', severity: 'crash',
      patterns: ['fabric.loader', 'net.fabricmc'],
      title: 'A Fabric mod failed to load',
      what: 'One of your Fabric mods couldn\'t start correctly.',
      how:  'Check that all mods match your Fabric Loader version and that Fabric API is installed and up to date.',
    },
    {
      id: 'neoforgeload', severity: 'crash',
      patterns: ['neoforge.fml', 'net.neoforged'],
      title: 'A NeoForge mod failed to load',
      what: 'One of your NeoForge mods crashed during startup.',
      how:  'The error usually names the problem mod. Remove it and verify it supports your NeoForge version.',
    },

    // ── Fabric / loader warnings ──────────────────────────────────────────

    {
      id: 'mixintarget', severity: 'warn',
      patterns: ['@Mixin target', 'was not found'],
      title: 'Client-only mod loaded on a server',
      what: 'A mod tried to patch a class that only exists in the game client (e.g. a rendering or GUI class). Fabric warns about this but skips the patch safely - it does not cause a crash.',
      how: 'No action needed if the server runs normally. To clean up the log, remove client-only mods (rendering mods, HUD mods, etc.) from the server\'s mods folder.',
    },
    {
      id: 'mixinconflict', severity: 'warn',
      patterns: ['Method overwrite conflict', 'Skipping method'],
      title: 'Two mods conflict over the same game code',
      what: 'Two mods both tried to replace the same piece of game logic, and only one could win. The losing mod\'s change was silently dropped, which can cause that mod\'s feature to stop working correctly.',
      how: 'Check which mods are named in the warning. Update both to their latest versions - authors sometimes coordinate fixes for known conflicts. If it persists, report it to both mod authors.',
    },
    {
      id: 'cancelledmixin', severity: 'warn',
      patterns: ['Cancelled mixin'],
      title: 'A mod patch was cancelled at startup',
      what: 'A mixin (code patch) from a mod was cancelled during startup, usually because it conflicts with another mod or targets a class that changed in this Minecraft version.',
      how: 'Update the mod shown in the message. If the problem persists after updating, check if a recently added mod is conflicting with it and report the issue to the mod author.',
    },
    {
      id: 'invalidmodjson', severity: 'warn',
      patterns: ['contains invalid entries in its mod json', 'Unsupported root entry'],
      title: 'Mod has an unrecognised entry in its descriptor',
      what: 'A mod\'s mod.json contains fields that Fabric Loader does not recognise, often because the mod was originally written for a different mod loader format (like Forge). The mod will still load.',
      how: 'No action needed in most cases. If this mod causes issues, check if there is a Fabric-native version available or a newer release.',
    },
    {
      id: 'semverwarn', severity: 'warn',
      patterns: ["isn't compatible with Loader's extended semantic version format", 'Could not parse version number component'],
      title: 'Mod version number cannot be parsed',
      what: 'A mod uses a version string that does not follow semantic versioning (e.g. "2.5.5e" instead of "2.5.5"). Fabric Loader cannot reliably compare this version against requirements from other mods.',
      how: 'This is usually harmless and the mod will still load. If another mod reports this one as missing or outdated, try updating to the newest release.',
    },
    {
      id: 'softdep', severity: 'warn',
      patterns: ['recommends version', 'which is missing!'],
      title: 'Optional mod dependency not installed',
      what: 'A mod recommends another mod be installed for the best experience, but that recommended mod is absent. The server will still run, but some features of the recommending mod may be limited or unavailable.',
      how: 'Install the recommended mod if you want the full feature set. This is optional - the warning is informational only.',
    },
    {
      id: 'commandreg', severity: 'warn',
      patterns: ['Could not register', 'command:', 'cannot access a member of class'],
      title: 'A mod failed to register a command',
      what: 'A mod tried to add a server command but ran into an access error, usually because of a mod loader version mismatch or a mod using an internal API that changed.',
      how: 'Update the mod shown in the warning. If the command is one you rely on, check the mod\'s issue tracker for known compatibility problems with your current mod loader version.',
    },

    // ── Network & authentication ──────────────────────────────────────────

    {
      id: 'connect', severity: 'error',
      patterns: ['ConnectException', 'Connection refused'],
      title: 'Could not reach the server',
      what: 'Minecraft tried to connect but the server wasn\'t responding.',
      how:  'Check that the server is online and that the address and port are correct.',
    },
    {
      id: 'timeout', severity: 'error',
      patterns: ['SocketTimeoutException', 'Timed out', 'read timed out'],
      title: 'Connection timed out',
      what: 'Minecraft reached the server but it stopped responding mid-connection.',
      how:  'Check your internet connection. If it happens repeatedly, the server may be overloaded.',
    },
    {
      id: 'unknownhost', severity: 'error',
      patterns: ['UnknownHostException'],
      title: 'Can\'t find the server address',
      what: 'The server address couldn\'t be looked up - it may be wrong, or your DNS isn\'t working.',
      how:  'Double-check the server address. If other sites work fine, try restarting your router.',
    },
    {
      id: 'ssl', severity: 'error',
      patterns: ['SSLException', 'CertificateException', 'SSLHandshakeException'],
      title: 'Secure connection problem',
      what: 'There was an issue with the encrypted connection to Mojang\'s servers.',
      how:  'Make sure your system clock is set correctly (SSL needs accurate time). Updating Java can also fix this.',
    },
    {
      id: 'auth', severity: 'error',
      patterns: ['Failed to verify username', 'Invalid session', 'Authentication servers'],
      title: 'Couldn\'t log you in',
      what: 'Minecraft couldn\'t verify your account with Mojang\'s servers.',
      how:  'Restart your launcher and make sure you\'re signed in. Check status.minecraft.net if the problem persists.',
    },
    {
      id: 'notpremium', severity: 'error',
      patterns: ['User not premium', 'not authenticated', 'Failed to authenticate'],
      title: 'Account not recognized by the server',
      what: 'The server requires a valid Minecraft account and couldn\'t verify yours.',
      how:  'Make sure you\'re signed into a genuine Minecraft account in your launcher.',
    },

    // ── Assets & resource packs ───────────────────────────────────────────

    {
      id: 'texture', severity: 'warn',
      patterns: ['Failed to load texture', 'Missing texture', 'unable to load texture'],
      title: 'Missing texture',
      what: 'A resource pack is pointing to an image file that doesn\'t exist.',
      how:  'Reinstall or disable the resource pack mentioned in the error. If it\'s a mod\'s texture, update or reinstall that mod.',
    },
    {
      id: 'model', severity: 'warn',
      patterns: ['Failed to load model', 'Missing model', 'Could not load model',
                 'Missing block model', 'Missing textures in model', 'Missing texture references in model'],
      title: 'Missing 3D model or texture',
      what: 'A resource pack or mod references a 3D model or texture file that can\'t be found. This often means the pack was built for a different Minecraft version.',
      how:  'Reinstall or update the resource pack. If the model names start with a specific namespace prefix (like "wasd:" or "tcc:"), that identifies which pack to update.',
    },
    {
      id: 'sound', severity: 'warn',
      patterns: ['Failed to load sound', 'Missing sound', 'Sound event', 'Unable to play'],
      title: 'Missing sound',
      what: 'A sound referenced by a resource pack or mod doesn\'t exist.',
      how:  'Reinstall the resource pack or mod that adds that sound.',
    },
    {
      id: 'invalidmodel', severity: 'warn',
      patterns: ['Invalid model', 'Malformed JSON', 'JSON parse error', 'JsonParseException', 'JsonSyntaxException'],
      title: 'Broken model or config file',
      what: 'A model or configuration file has a formatting error and Minecraft can\'t read it.',
      how:  'If it\'s from a resource pack, reinstall it. If from a mod, report it to the mod author.',
    },
    {
      id: 'langfile', severity: 'warn',
      patterns: ['DuplicateFormatFlagsException', 'Failed to load language', 'language file'],
      title: 'Broken language/translation file',
      what: 'A text file used for translations in a mod or resource pack has a formatting error.',
      how:  'Update the mod or resource pack - this type of bug is usually fixed in newer versions.',
    },
    {
      id: 'missinglangkeys', severity: 'error',
      patterns: ['Some multiline keys have no translations', 'have no translations. Missing'],
      title: 'Mod is missing translation keys',
      what: 'A mod references dialogue or text keys that have no translation provided. The missing text will show as a raw key name in-game (e.g. "dialogue.kattersstructures.theron.retreat") instead of readable text.',
      how: 'Update the mod to a newer version - the author likely needs to add the missing translation strings. If you speak the language the server is using, you can also contribute translations on the mod\'s Crowdin or GitHub.',
    },

    // ── Data packs (general) ──────────────────────────────────────────────

    {
      id: 'tag', severity: 'warn',
      patterns: ['Failed to load tag', 'Could not load tag'],
      title: 'Data pack tag is missing',
      what: 'A data pack is referencing a group (tag) that doesn\'t exist.',
      how:  'Make sure all required data packs are installed and loaded in the right order.',
    },
    {
      id: 'dpfunction', severity: 'warn',
      patterns: ['Failed to load function', 'Could not find function'],
      title: 'Data pack command file error',
      what: 'A command file inside a data pack has a mistake or references something that doesn\'t exist.',
      how:  'Update the data pack, or disable it temporarily to confirm it\'s the source of the problem.',
    },
    {
      id: 'dpcontent', severity: 'warn',
      patterns: ['Failed to load recipe', 'Failed to load advancement', 'Failed to load loot',
                 'Failed to load dimension', 'Failed to load biome'],
      title: 'Data pack content error',
      what: 'A recipe, advancement, loot table, or other data file in a data pack has an error.',
      how:  'Update the data pack or temporarily disable it to confirm it\'s causing the issue.',
    },

    // ── World & save data ─────────────────────────────────────────────────

    {
      id: 'corrupt', severity: 'error',
      patterns: [/[Cc]orrupt(ed)?/, 'level.dat'],
      title: 'Damaged save data',
      what: 'Part of your world or a save file is broken and Minecraft can\'t read it.',
      how:  'Restore from a backup if you have one. If it\'s a specific area of the world, a tool like Amulet can delete just that chunk so the rest stays playable.',
    },
    {
      id: 'missingmap', severity: 'warn',
      patterns: ['Missing mapping', 'Unknown mapping', 'unregistered', 'Skipping unknown'],
      title: 'Mods removed from an existing world',
      what: 'Your world was last played with mods that are no longer installed.',
      how:  'Re-install the missing mods, or use a world editor to safely remove their data from the world.',
    },
    {
      id: 'savefail', severity: 'error',
      patterns: ['Failed to save chunk', 'Failed to write', 'IOException while saving', 'Error saving'],
      title: 'Couldn\'t save the world',
      what: 'Minecraft tried to write to disk but something blocked it.',
      how:  'Check that your drive has free space and that you have write permission to the game\'s folder.',
    },
    {
      id: 'chunkread', severity: 'error',
      patterns: ['Unparseable chunk data', 'Failed to read chunk', 'Invalid chunk'],
      title: 'Corrupted chunk',
      what: 'A specific section of your world is damaged and can\'t be loaded.',
      how:  'Use a tool like Amulet to delete the broken chunk - it will regenerate the next time you visit that area.',
    },

    // ── Server setup ──────────────────────────────────────────────────────

    {
      id: 'eula', severity: 'error',
      patterns: ['EULA', 'eula.txt'],
      title: 'Server terms of service not accepted',
      what: 'The server needs you to agree to Minecraft\'s terms before it will start.',
      how:  'Open "eula.txt" in your server folder and change "eula=false" to "eula=true".',
    },
    {
      id: 'portinuse', severity: 'error',
      patterns: ['Address already in use', 'bind: Address already'],
      title: 'Port is already taken',
      what: 'Another program or server is already using the same network port.',
      how:  'Stop the other server first, or change the "server-port" value in "server.properties" to a different number.',
    },
    {
      id: 'portbind', severity: 'error',
      patterns: ['Failed to bind port', 'Cannot assign requested address'],
      title: 'Can\'t open the server port',
      what: 'The server couldn\'t reserve the network port it needs.',
      how:  'Try a different port number in "server.properties", or check your firewall settings.',
    },
    {
      id: 'servercrash', severity: 'crash',
      patterns: ['Stopping!', 'Server stopped'],
      title: 'Server stopped unexpectedly',
      what: 'The server hit a fatal problem and shut itself down.',
      how:  'Look at the errors logged just before this line - those contain the real reason it stopped.',
    },
    {
      id: 'lag', severity: 'warn',
      patterns: ["Can't keep up", 'overloaded', 'Did the system time change'],
      title: 'Server is lagging',
      what: 'The server is taking too long per game tick, which causes slowdowns for everyone.',
      how:  'Reduce the view distance, entity counts, or the number of active data packs. The Profiling Inspector on this site can help you find the exact cause.',
    },

    // ── Java & system ─────────────────────────────────────────────────────

    {
      id: 'nativelib', severity: 'error',
      patterns: ['UnsatisfiedLinkError'],
      title: 'Java library missing',
      what: 'Minecraft couldn\'t load a system-level file it requires.',
      how:  'Try reinstalling Java (64-bit version) and make sure your launcher points to the correct Java installation.',
    },
    {
      id: 'illegalaccess', severity: 'error',
      patterns: ['IllegalAccessError', 'InaccessibleObjectException'],
      title: 'Java version incompatibility',
      what: 'An older mod doesn\'t work with the version of Java you\'re running.',
      how:  'Check the mod\'s page for its required Java version. Most Minecraft launchers let you choose a Java version per profile.',
    },
    {
      id: 'zipexception', severity: 'error',
      patterns: ['ZipException', 'corrupt entry', 'invalid CEN header'],
      title: 'Broken mod file',
      what: 'One of your mod files is damaged and can\'t be opened.',
      how:  'Delete the damaged mod file and re-download it from the official source (CurseForge, Modrinth, etc.).',
    },
    {
      id: 'permission', severity: 'error',
      patterns: ['AccessDeniedException', 'Permission denied', 'Access is denied'],
      title: 'Minecraft can\'t access a file',
      what: 'Your operating system or antivirus is blocking Minecraft from reading or writing a file.',
      how:  'Check that your antivirus isn\'t quarantining game files, and verify you have write permission to the game\'s folder.',
    },
    {
      id: 'ioerror', severity: 'error',
      patterns: ['java.io.IOException', 'IOException'],
      title: 'File read/write error',
      what: 'Something went wrong reading or writing a file on your disk.',
      how:  'Check that your drive has free space and that the game folder isn\'t set to read-only.',
    },
    {
      id: 'download', severity: 'warn',
      patterns: ['Failed to download', 'Download failed', 'Unable to download'],
      title: 'Asset download failed',
      what: 'Minecraft couldn\'t download a required file from Mojang\'s servers.',
      how:  'Check your internet connection and try launching the game again - it will retry the download automatically.',
    },
  ];

  // ── Tip extraction ────────────────────────────────────────────────────────

  function extractTips(groups) {
    const seen    = new Map();
    const nonInfo = groups.filter(g => g.level !== 'info');

    for (const group of nonInfo) {
      const haystack = group.text + '\n' + group.stack.join('\n');
      for (const tip of TIPS) {
        const matched = tip.patterns.some(p =>
          p instanceof RegExp ? p.test(haystack) : haystack.includes(p)
        );
        if (!matched) continue;

        if (!seen.has(tip.id)) seen.set(tip.id, { ...tip, sources: [] });
        const instance = seen.get(tip.id);

        if (tip.contextExtract) {
          for (const val of tip.contextExtract(haystack)) {
            if (!instance.sources.includes(val)) instance.sources.push(val);
          }
        }
      }
    }

    const rank = { crash: 0, error: 1, warn: 2, info: 3 };
    return [...seen.values()].sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function detectVersion(text) {
    const m = text.match(/Minecraft Version(?:\s+ID)?:\s*([^\s\r\n]+)/i)
           || text.match(/--version\s+([^\s]+)/);
    return m ? m[1] : null;
  }

  function detectLogDate(filename) {
    const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  function tipIcon(severity) {
    return { crash: 'bi-x-circle-fill', error: 'bi-exclamation-circle-fill', warn: 'bi-exclamation-triangle-fill' }[severity] || 'bi-info-circle-fill';
  }

  function levelIcon(level) {
    return { crash: 'bi-x-circle-fill', error: 'bi-exclamation-circle', warn: 'bi-exclamation-triangle' }[level] || 'bi-info-circle';
  }

  function friendlyElementName(id) {
    const local = id.includes(':') ? id.split(':')[1] : id;
    return local.replace(/\.json$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function makeCard(iconClass, title) {
    const details = document.createElement('details');
    details.className = 'log-card';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'log-card-summary';
    summary.innerHTML = `<i class="bi ${iconClass}"></i>${esc(title)}<i class="bi bi-chevron-down log-summary-caret"></i>`;
    details.appendChild(summary);
    return details;
  }

  // ── Main renderer ─────────────────────────────────────────────────────────

  function render(filename, rawText, groups) {
    resultsEl.innerHTML = '';

    const crashes   = groups.filter(g => g.level === 'crash');
    const errors    = groups.filter(g => g.level === 'error');
    const warnings  = groups.filter(g => g.level === 'warn');
    const tips      = extractTips(groups);
    const structure = analyzeStructure(rawText);
    const version   = detectVersion(rawText);
    const logDate   = detectLogDate(filename);

    // ── Banner ────────────────────────────────────────────────────────────

    const banner = el('div', 'log-banner');
    banner.innerHTML = `
      <h2 class="log-banner-title">${esc(filename)}</h2>
      <div class="log-banner-meta">
        ${version  ? `<span class="log-tag"><i class="bi bi-boxes"></i>${esc(version)}</span>` : ''}
        ${logDate  ? `<span class="log-tag"><i class="bi bi-calendar3"></i>${esc(logDate)}</span>` : ''}
        <span class="log-tag"><i class="bi bi-list-ul"></i>${groups.length.toLocaleString()} lines</span>
        <button class="log-reset-btn" id="log-reset"><i class="bi bi-upload"></i> Upload another</button>
      </div>
    `;
    resultsEl.appendChild(banner);

    document.getElementById('log-reset').addEventListener('click', () => {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      uploadSection.hidden = false;
      fileInput.value = '';
    });

    // ── Stat cards ────────────────────────────────────────────────────────

    const statsRow = el('div', 'log-stats-row');
    // For crash reports the header line itself shows as a "crash" group - don't count it
    const crashCount = structure.crashReport
      ? crashes.filter(g => !/----\s*Minecraft Crash Report/i.test(g.text)).length
      : crashes.length;
    statsRow.appendChild(statCard('Crashes', structure.crashReport ? 1 : crashCount,
      structure.crashReport ? 'Crash report detected' : (crashCount > 0 ? 'Critical problems found' : 'No crashes detected'),
      crashes.length > 0 ? 'crash' : 'ok'));
    statsRow.appendChild(statCard('Errors', errors.length,
      errors.length > 0 ? 'Issues that need attention' : 'No errors found',
      errors.length > 0 ? 'error' : 'ok'));
    statsRow.appendChild(statCard('Warnings', warnings.length,
      warnings.length > 0 ? 'Minor issues logged' : 'No warnings found',
      warnings.length > 0 ? 'warn' : 'ok'));
    statsRow.appendChild(statCard('Fix Tips', tips.length,
      tips.length > 0 ? 'Suggestions available below' : 'Nothing specific to suggest',
      tips.length > 0 ? 'error' : 'ok'));
    resultsEl.appendChild(statsRow);

    // ── Clean bill of health ──────────────────────────────────────────────

    if (crashes.length === 0 && errors.length === 0 && warnings.length === 0) {
      const clean = el('div', 'log-card');
      clean.appendChild(el('div', 'log-empty',
        '<i class="bi bi-check-circle"></i>No crashes, errors, or warnings found in this log. Looks healthy!'));
      resultsEl.appendChild(clean);
      renderFullLog(rawText, groups);
      return;
    }

    // ── Crash report summary card ─────────────────────────────────────────
    // Shown first when the file is a Minecraft crash report so the player
    // immediately sees what happened, which mod caused it, and how to fix it.

    if (structure.crashReport) {
      const cr   = structure.crashReport;
      const card = makeCard('bi-x-circle-fill', 'Crash Summary');
      card.open = false;
      card.querySelector('.log-card-summary').style.color = '#ff6b6b';

      const body = el('div', 'log-crash-summary');

      // What was happening
      if (cr.description) {
        body.appendChild(el('div', 'log-crash-row',
          `<i class="bi bi-info-circle"></i><div><strong>What was happening:</strong> ${esc(cr.description)}</div>`));
      }

      // Which mod caused it
      let modHtml, fixHtml;
      if (cr.crashingModName) {
        modHtml = `The <strong>${esc(cr.crashingModName)}</strong> mod was found at the crash location.`;
        fixHtml = `Try <strong>updating ${esc(cr.crashingModName)}</strong> to its latest version first. If the crash keeps happening, temporarily remove it from your mods folder to confirm it\'s the cause, then report the crash on the mod\'s issue tracker or Discord.`;
      } else if (cr.crashingModId) {
        modHtml = `A mod with ID <strong>${esc(cr.crashingModId)}</strong> was found at the crash location.`;
        fixHtml = `Try updating or removing the <strong>${esc(cr.crashingModId)}</strong> mod, then test if the crash happens again.`;
      } else {
        modHtml = 'No specific mod was identified at the crash location - this may be a Minecraft game bug or an incompatibility between two mods.';
        fixHtml = 'Try updating Minecraft and all your mods. If the crash happens repeatedly in the same situation, try removing recently added mods one at a time until it stops.';
      }
      body.appendChild(el('div', 'log-crash-row',
        `<i class="bi bi-puzzle"></i><div><strong>Likely cause:</strong> ${modHtml}</div>`));
      body.appendChild(el('div', 'log-crash-row log-crash-fix',
        `<i class="bi bi-wrench"></i><div><strong>Fix:</strong> ${fixHtml}</div>`));

      // Incompatible resource packs
      if (cr.incompatiblePacks.length > 0) {
        const shown    = cr.incompatiblePacks.slice(0, 8);
        const overflow = cr.incompatiblePacks.length - shown.length;
        body.appendChild(el('div', 'log-crash-row log-crash-warn',
          `<i class="bi bi-layers-half"></i><div><strong>${cr.incompatiblePacks.length} resource pack${cr.incompatiblePacks.length !== 1 ? 's' : ''} marked incompatible:</strong> ${esc(shown.join(', '))}${overflow > 0 ? ` +${overflow} more` : ''}. These packs were made for a different Minecraft version and may cause visual glitches - but are likely not the cause of this crash.</div>`));
      }

      // Low memory warning
      if (cr.lowMemory) {
        body.appendChild(el('div', 'log-crash-row log-crash-warn',
          `<i class="bi bi-memory"></i><div><strong>Low memory allocated (${cr.maxMemMiB} MB).</strong> This can cause instability and crashes. In your launcher settings, increase the RAM to at least 4096 MB.</div>`));
      }

      card.appendChild(body);
      resultsEl.appendChild(card);
    }

    // ── Fix tips ──────────────────────────────────────────────────────────

    if (tips.length > 0) {
      const card = makeCard('bi-lightbulb', 'Fix Suggestions');
      const list = el('div', 'log-tips-list');

      for (const tip of tips) {
        const div = el('div', `log-tip ${tip.severity}`);
        const sourcesHtml = tip.sources && tip.sources.length > 0
          ? `<div class="log-tip-sources"><i class="bi bi-file-earmark-zip"></i><span>Found in: <strong>${esc(tip.sources.slice(0, 5).join(', '))}${tip.sources.length > 5 ? ` +${tip.sources.length - 5} more` : ''}</strong></span></div>`
          : '';
        div.innerHTML = `
          <i class="bi ${tipIcon(tip.severity)} log-tip-icon"></i>
          <div class="log-tip-body">
            <div class="log-tip-title">${esc(tip.title)}</div>
            <div class="log-tip-what">${esc(tip.what)}</div>
            <div class="log-tip-how">${esc(tip.how)}</div>
            ${sourcesHtml}
          </div>
        `;
        list.appendChild(div);
      }
      card.appendChild(list);
      resultsEl.appendChild(card);
    }

    // ── Data pack failures ────────────────────────────────────────────────

    const allFailedPackNames = new Set([
      ...structure.packFailures.map(f => f.pack),
      ...structure.tagFailures.map(f => f.pack),
    ]);

    if (allFailedPackNames.size > 0) {
      const card = makeCard('bi-database-x', `Data Pack Failures (${allFailedPackNames.size} pack${allFailedPackNames.size !== 1 ? 's' : ''})`);
      card.open = false;
      card.querySelector('.log-card-summary').style.color = '#ff6b6b';

      const intro = el('div', 'log-pack-intro');
      const hasVersionIssue = structure.hasVersionMismatch || structure.hasFormatMismatch || structure.hasTagMissingItems;
      if (hasVersionIssue) {
        intro.innerHTML = `
          <p>These data packs are <strong>not compatible with your current Minecraft version</strong>. They use features, blocks, or file formats that were added in a newer version of the game. Minecraft refused to load them, so their content is missing or the world cannot be opened.</p>
          <p class="log-pack-fix"><i class="bi bi-wrench"></i> <strong>Fix:</strong> For each pack listed below, either update Minecraft to the version the pack requires, or download an older release of that pack made for your current version.</p>
        `;
      } else {
        intro.innerHTML = `<p>These data packs encountered errors during loading. Some of their content is missing or disabled.</p>`;
      }
      card.appendChild(intro);

      const packList = el('div', 'log-pack-list');

      for (const { pack, elements } of structure.packFailures) {
        const shown    = elements.slice(0, 6);
        const overflow = elements.length - shown.length;
        const nameList = shown.map(friendlyElementName).join(', ') + (overflow > 0 ? `, and ${overflow} more` : '');
        const row = el('div', 'log-pack-row');
        row.innerHTML = `
          <div class="log-pack-header">
            <i class="bi bi-file-zip log-pack-icon"></i>
            <span class="log-pack-name">${esc(pack)}</span>
            <span class="log-pack-badge">${elements.length} item${elements.length !== 1 ? 's' : ''} failed</span>
          </div>
          <div class="log-pack-items">${esc(nameList)}</div>
        `;
        packList.appendChild(row);
      }

      for (const { pack, missingItems } of structure.tagFailures) {
        if (structure.packFailures.some(f => f.pack === pack)) continue;
        const shownItems = missingItems.slice(0, 5);
        const overflow   = missingItems.length - shownItems.length;
        const itemList   = shownItems.join(', ') + (overflow > 0 ? `, +${overflow} more` : '');
        const row = el('div', 'log-pack-row');
        row.innerHTML = `
          <div class="log-pack-header">
            <i class="bi bi-file-zip log-pack-icon"></i>
            <span class="log-pack-name">${esc(pack)}</span>
            <span class="log-pack-badge log-pack-badge--warn">references missing game content</span>
          </div>
          <div class="log-pack-items">${esc(itemList ? `Needs (but can\'t find): ${itemList}` : 'References blocks or items that don\'t exist in your Minecraft version')}</div>
        `;
        packList.appendChild(row);
      }

      card.appendChild(packList);
      resultsEl.appendChild(card);
    }

    // ── Resource pack failures ────────────────────────────────────────────

    if (structure.resourcePackFailures.length > 0) {
      const n    = structure.resourcePackFailures.length;
      const card = makeCard('bi-layers-half', `Resource Pack Issues (${n} pack${n !== 1 ? 's' : ''})`);
      card.open = false;
      card.querySelector('.log-card-summary').style.color = '#ff9090';

      const intro = el('div', 'log-pack-intro');
      intro.innerHTML = `
        <p>These resource packs have item model files that Minecraft <strong>could not load</strong>. Affected items will show as broken or missing in-game. This usually means the resource pack was made for a newer Minecraft version (likely 1.21.5+).</p>
        <p class="log-pack-fix"><i class="bi bi-wrench"></i> <strong>Fix:</strong> Update Minecraft to match what these packs require, or find older releases of each pack made for your current version.</p>
      `;
      card.appendChild(intro);

      const packList = el('div', 'log-pack-list');
      for (const { pack, models } of structure.resourcePackFailures) {
        const shown    = models.slice(0, 6);
        const overflow = models.length - shown.length;
        const nameList = shown.join(', ') + (overflow > 0 ? `, and ${overflow} more` : '');
        const row = el('div', 'log-pack-row');
        row.innerHTML = `
          <div class="log-pack-header">
            <i class="bi bi-layers log-pack-icon"></i>
            <span class="log-pack-name">${esc(pack)}</span>
            <span class="log-pack-badge log-pack-badge--warn">${models.length} model${models.length !== 1 ? 's' : ''} failed</span>
          </div>
          <div class="log-pack-items">${esc(nameList)}</div>
        `;
        packList.appendChild(row);
      }
      card.appendChild(packList);
      resultsEl.appendChild(card);
    }

    // ── Crashes ───────────────────────────────────────────────────────────
    // Skipped for crash reports - the Crash Summary card already covers this.

    if (crashes.length > 0 && !structure.crashReport) {
      const card = makeCard('bi-x-circle-fill', `Crashes (${crashes.length})`);
      card.open = false;
      card.querySelector('.log-card-summary').style.color = '#ff6b6b';
      card.appendChild(issueList(crashes));
      resultsEl.appendChild(card);
    }

    // ── Errors ────────────────────────────────────────────────────────────

    if (errors.length > 0) {
      const card = makeCard('bi-exclamation-circle-fill', `Errors (${errors.length})`);
      card.open = false;
      card.querySelector('.log-card-summary').style.color = '#ff9090';
      card.appendChild(issueList(errors));
      resultsEl.appendChild(card);
    }

    // ── Warnings ──────────────────────────────────────────────────────────

    if (warnings.length > 0) {
      const card = makeCard('bi-exclamation-triangle-fill', `Warnings (${warnings.length})`);
      card.open = false;
      card.querySelector('.log-card-summary').style.color = 'var(--accent-2)';
      card.appendChild(issueList(warnings));
      resultsEl.appendChild(card);
    }

    renderFullLog(rawText, groups);
  }

  // ── Issue list ────────────────────────────────────────────────────────────

  function issueList(groups) {
    const container = el('div', 'log-issues-list');

    for (const group of groups) {
      const hasStack = group.stack.length > 0;
      const div = el('div', `log-issue ${group.level}${hasStack ? ' has-stack' : ''}`);

      const header = el('div', 'log-issue-header');
      header.innerHTML = `
        <i class="bi ${levelIcon(group.level)} log-issue-icon"></i>
        <span class="log-issue-text">${esc(group.text)}</span>
        ${hasStack ? `<span class="log-issue-toggle"><span>${group.stack.length} line${group.stack.length !== 1 ? 's' : ''}</span><i class="bi bi-chevron-down"></i></span>` : ''}
      `;

      if (hasStack) {
        header.addEventListener('click', () => div.classList.toggle('is-open'));
        const stackEl = el('div', 'log-issue-stack');
        const pre = document.createElement('pre');
        pre.textContent = group.stack.join('\n');
        stackEl.appendChild(pre);
        div.appendChild(header);
        div.appendChild(stackEl);
      } else {
        div.appendChild(header);
      }

      container.appendChild(div);
    }

    return container;
  }

  // ── Full log renderer ─────────────────────────────────────────────────────

  function renderFullLog(rawText, groups) {
    const card = makeCard('bi-file-text', 'Full Log');
    card.open = false;

    const MAX_LINES = 5000;
    const allLines  = rawText.split('\n');
    const shown     = allLines.slice(0, MAX_LINES);

    const levelByLine = new Map();
    for (const g of groups) {
      levelByLine.set(g.lineNo, g.level);
      for (let i = 0; i < g.stack.length; i++) {
        levelByLine.set(g.lineNo + 1 + i, g.level);
      }
    }

    const wrap     = el('div', 'log-full-wrap');
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < shown.length; i++) {
      const lineNo = i + 1;
      const text   = shown[i];
      if (!text.trim()) continue;

      const level = levelByLine.get(lineNo) || classifyLine(text);
      const row   = el('div', `log-full-line ${level}`);
      row.innerHTML = `<span class="log-line-num">${lineNo}</span><span class="log-line-text">${esc(text)}</span>`;
      fragment.appendChild(row);
    }

    wrap.appendChild(fragment);

    if (allLines.length > MAX_LINES) {
      wrap.appendChild(el('div', 'log-truncated-note',
        `Showing first ${MAX_LINES.toLocaleString()} of ${allLines.length.toLocaleString()} lines.`));
    }

    card.appendChild(wrap);
    resultsEl.appendChild(card);
  }

  // ── Stat card ─────────────────────────────────────────────────────────────

  function statCard(label, value, sub, level) {
    const card = el('div', 'log-stat-card');
    card.innerHTML = `
      <div class="log-stat-label">${esc(label)}</div>
      <div class="log-stat-value ${level}">${esc(String(value))}</div>
      <div class="log-stat-sub">${esc(sub)}</div>
    `;
    return card;
  }

})();
