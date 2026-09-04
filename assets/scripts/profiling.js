/* global JSZip */
(function () {
  'use strict';

  // ── DOM refs ────────────────────────────────────────────────────────────

  const uploadSection = document.getElementById('prof-upload-section');
  const uploadZone    = document.getElementById('prof-upload-zone');
  const fileInput     = document.getElementById('prof-file-input');
  const resultsEl     = document.getElementById('prof-results');

  // ── Upload handling ─────────────────────────────────────────────────────

  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('is-dragover'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('is-dragover'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('is-dragover');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) processFile(fileInput.files[0]);
  });

  async function processFile(file) {
    uploadZone.style.opacity = '.5';
    uploadZone.style.pointerEvents = 'none';
    uploadZone.querySelector('.prof-upload-label').textContent = 'Reading…';

    try {
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const data = await extractData(zip, file.name);
      render(data);
      uploadSection.hidden = true;
      resultsEl.hidden = false;
    } catch (err) {
      console.error(err);
      uploadZone.querySelector('.prof-upload-label').textContent = 'Failed to read file. Is this a valid profiling ZIP?';
    } finally {
      uploadZone.style.opacity = '';
      uploadZone.style.pointerEvents = '';
    }
  }

  // ── ZIP data extraction ─────────────────────────────────────────────────

  async function txt(zip, path) {
    const f = zip.file(path);
    return f ? f.async('string') : null;
  }

  async function extractData(zip, filename) {
    const [systemTxt, serverStats, serverProfiling, serverThreads, gamerulesTxt] = await Promise.all([
      txt(zip, 'system.txt'),
      txt(zip, 'server/stats.txt'),
      txt(zip, 'server/profiling.txt'),
      txt(zip, 'server/threads.txt'),
      txt(zip, 'server/gamerules.txt'),
    ]);

    // Discover all dimensions
    const dimPaths = [];
    zip.forEach((relativePath) => {
      if (relativePath.match(/^server\/levels\/[^/]+\/[^/]+\/$/) ||
          relativePath.match(/^server\/levels\/[^/]+\/[^/]+\/entities\.csv$/)) {
        const m = relativePath.match(/^server\/levels\/([^/]+)\/([^/]+)\//);
        if (m) {
          const key = `${m[1]}/${m[2]}`;
          if (!dimPaths.find(d => d.key === key)) {
            dimPaths.push({ key, namespace: m[1], name: m[2], base: `server/levels/${m[1]}/${m[2]}/` });
          }
        }
      }
    });

    const dims = await Promise.all(dimPaths.map(async (d) => ({
      ...d,
      entities:      await txt(zip, `${d.base}entities.csv`),
      blockEntities: await txt(zip, `${d.base}block_entities.csv`),
      stats:         await txt(zip, `${d.base}stats.txt`),
      chunks:        await txt(zip, `${d.base}chunks.csv`),
      entityChunks:  await txt(zip, `${d.base}entity_chunks.csv`),
    })));

    return {
      filename,
      systemTxt,
      serverStats,
      serverProfiling,
      gamerulesTxt,
      dims,
    };
  }

  function parseGamerules(txt) {
    if (!txt) return [];
    return txt.trim().split('\n')
      .map(line => {
        const eq = line.indexOf('=');
        if (eq < 0) return null;
        const key = line.slice(0, eq).replace(/^minecraft:/, '').trim();
        const val = line.slice(eq + 1).trim();
        return { key, val };
      })
      .filter(Boolean)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  // ── Parsers ─────────────────────────────────────────────────────────────

  function parseSystemTxt(txt) {
    if (!txt) return {};
    const line = (key) => {
      const m = txt.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    const worldMatch = txt.match(/l='ServerLevel\[([^\]]+)\]'/);
    const playerCountMatch = txt.match(/Player Count:\s*(\d+)\s*\/\s*(\d+)/);
    const dataPacksMatch = txt.match(/Active Data Packs:\s*(.+)/);
    const dataPacks = dataPacksMatch
      ? dataPacksMatch[1].split(',')
          .map(s => s.trim().replace(/\s*\([^)]*\)\s*$/, ''))
          .filter(s => s && s !== 'vanilla')
      : [];

    return {
      mcVersion:    line('Minecraft Version') || line('Minecraft Version ID'),
      os:           line('Operating System'),
      cpuCount:     line('CPUs'),
      cpuName:      line('Processor Name'),
      memUsed:      parseMemMiB(line('Memory')),
      memMax:       parseMemMax(line('Memory')),
      worldName:    worldMatch ? worldMatch[1] : null,
      players:      playerCountMatch ? parseInt(playerCountMatch[1]) : 0,
      maxPlayers:   playerCountMatch ? parseInt(playerCountMatch[2]) : 0,
      renderDist:   line('Render Distance'),
      dataPacks,
    };
  }

  function parseMemMiB(s) {
    if (!s) return null;
    const m = s.match(/(\d+)\s*MiB\)/);
    return m ? parseInt(m[1]) : null;
  }

  function parseMemMax(s) {
    if (!s) return null;
    const parts = s.match(/up to \d+ bytes \((\d+) MiB\)/);
    return parts ? parseInt(parts[1]) : null;
  }

  function parseServerStats(txt) {
    if (!txt) return {};
    const avgMatch = txt.match(/average_tick_time:\s*([\d.E+]+)/);
    const timesMatch = txt.match(/tick_times:\s*\[([^\]]+)\]/);
    const pendingMatch = txt.match(/pending_tasks:\s*(\d+)/);

    const tickTimesNs = timesMatch
      ? timesMatch[1].split(',').map(s => parseFloat(s.trim()))
      : [];

    return {
      avgTickMs:    avgMatch ? parseFloat(avgMatch[1]) : null,
      tickTimesMs:  tickTimesNs.map(ns => ns / 1_000_000),
      pendingTasks: pendingMatch ? parseInt(pendingMatch[1]) : 0,
    };
  }

  function parseProfilingTxt(txt) {
    if (!txt) return {};

    const timeSpanMatch = txt.match(/^Time span:\s*(\d+)\s*ms/m);
    const tickSpanMatch = txt.match(/^Tick span:\s*(\d+)/m);
    const tpsMatch      = txt.match(/approximately\s*([\d.]+)\s*ticks per second/);

    const items = [];
    const lineRe = /^\[(\d+)\] [\s|]*(.+?)\((\d+)(?:\/\d+)?\)\s*-\s*([\d.]+)%\/([\d.]+)%/gm;
    let m;
    while ((m = lineRe.exec(txt)) !== null) {
      items.push({
        depth:     parseInt(m[1]),
        name:      m[2].trim(),
        calls:     parseInt(m[3]),
        localPct:  parseFloat(m[4]),
        globalPct: parseFloat(m[5]),
      });
    }

    // Aggregate data pack functions by namespace.
    // Track minDepth so we can identify entry-point calls vs nested sub-calls.
    // Calls are summed across all occurrences; pct keeps the max globalPct seen.
    const fnDataByName = {};  // fnName → { pct, calls, minDepth }
    for (const item of items) {
      if (!item.name.startsWith('function ')) continue;
      const fnName = item.name.slice(9);
      if (!fnDataByName[fnName]) {
        fnDataByName[fnName] = { pct: item.globalPct, calls: item.calls, minDepth: item.depth };
      } else {
        if (item.globalPct > fnDataByName[fnName].pct) fnDataByName[fnName].pct = item.globalPct;
        fnDataByName[fnName].calls += item.calls;
        if (item.depth < fnDataByName[fnName].minDepth) fnDataByName[fnName].minDepth = item.depth;
      }
    }
    const fnByNs = {};  // ns → { fnName: { pct, calls, minDepth } }
    for (const [fnName, data] of Object.entries(fnDataByName)) {
      const ns = fnName.includes(':') ? fnName.split(':')[0] : fnName;
      if (!fnByNs[ns]) fnByNs[ns] = {};
      fnByNs[ns][fnName] = data;
    }
    const functions = Object.entries(fnByNs)
      .map(([ns, fns]) => {
        // Only entry-point calls (shallowest depth for this namespace) count toward the
        // namespace total. Deeper sub-calls have their time already included in their
        // parent's globalPct, so adding them would double-count.
        const nsMinDepth = Math.min(...Object.values(fns).map(d => d.minDepth));
        const entryFns = Object.values(fns).filter(d => d.minDepth === nsMinDepth);
        return {
          ns,
          pct:   entryFns.reduce((s, d) => s + d.pct, 0),
          calls: entryFns.reduce((s, d) => s + d.calls, 0),
          topFunctions: Object.entries(fns)
            .map(([name, d]) => ({ name, pct: d.pct, calls: d.calls }))
            .sort((a, b) => b.pct - a.pct)
            .slice(0, 10),
        };
      })
      .sort((a, b) => b.pct - a.pct);

    // Depth-4 categories (main server tick categories)
    const CATEGORY_LABELS = {
      entities:           { label: 'Mob processing',         desc: 'Entity AI, pathfinding, and movement' },
      chunkSource:        { label: 'Chunk management',       desc: 'Loading, saving, and generating chunks' },
      scheduledFunctions: { label: 'Data pack functions',    desc: 'Scheduled commands run every tick by data packs' },
      blockEntities:      { label: 'Block Entities',          desc: 'Furnaces, hoppers, pistons, and other ticking blocks' },
      tickPending:        { label: 'Pending block ticks',    desc: 'Queued block and fluid updates (redstone, water, etc.)' },
      entityManagement:   { label: 'Entity spawning',        desc: 'Finding positions to spawn and despawn entities' },
      weather:            { label: 'Weather',                desc: 'Rain and thunder simulation' },
      raid:               { label: 'Raid logic',             desc: 'Raid spawning and tracking' },
      players:            { label: 'Player handling',        desc: 'Processing player actions and movement' },
      blockEvents:        { label: 'Block events',           desc: 'Piston extensions, note blocks, etc.' },
    };

    // Accumulate global% per category and collect depth-5 sub-items (for expandable rows)
    const categoryTotals = {};
    let curCat4 = null;
    const catChildTotals = {};  // catName → { itemName: summedGlobalPct }
    for (const item of items) {
      if (item.depth === 4) {
        const def = CATEGORY_LABELS[item.name];
        if (def) {
          categoryTotals[item.name] = (categoryTotals[item.name] || 0) + item.globalPct;
          curCat4 = item.name;
        } else {
          curCat4 = null;
        }
      } else if (item.depth === 5 && curCat4 !== null) {
        if (!catChildTotals[curCat4]) catChildTotals[curCat4] = {};
        catChildTotals[curCat4][item.name] = (catChildTotals[curCat4][item.name] || 0) + item.globalPct;
      } else if (item.depth <= 3) {
        curCat4 = null;
      }
    }

    const categories = Object.entries(categoryTotals)
      .filter(([, pct]) => pct >= 0.1)
      .map(([name, pct]) => ({
        name, pct, ...CATEGORY_LABELS[name],
        topChildren: Object.entries(catChildTotals[name] || {})
          .filter(([n]) => n !== 'unspecified' && !n.startsWith('#'))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([n, p]) => ({ name: n.startsWith('function ') ? n.slice(9) : n, pct: p })),
      }))
      .sort((a, b) => b.pct - a.pct);

    // Top entity types (minecraft:type at depth 6)
    const entityTypeTotals = {};
    for (const item of items) {
      if (item.depth !== 6) continue;
      if (!item.name.match(/^[a-z_]+:[a-z_]+$/)) continue;
      entityTypeTotals[item.name] = (entityTypeTotals[item.name] || 0) + item.globalPct;
    }
    const entityTypes = Object.entries(entityTypeTotals)
      .map(([type, pct]) => ({ type, pct }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 12);

    // Scheduled / tick functions - depth-5 items directly under scheduledFunctions (depth 4).
    // These are the functions Minecraft actually called from the tick loop or via `schedule`.
    // Track dims count so interval = tickSpan / (calls / dims) stays per-dimension accurate.
    const scheduledMap = {};
    let inScheduled = false;
    let scheduledDepth = -1;
    for (const item of items) {
      if (item.depth === 4 && item.name === 'scheduledFunctions') {
        inScheduled = true;
        scheduledDepth = 4;
        continue;
      }
      if (inScheduled) {
        if (item.depth <= scheduledDepth) { inScheduled = false; continue; }
        if (item.depth === scheduledDepth + 1 && item.name.startsWith('function ')) {
          const fnName = item.name.slice(9);
          if (!scheduledMap[fnName]) {
            scheduledMap[fnName] = { pct: item.globalPct, calls: item.calls, dims: 1 };
          } else {
            scheduledMap[fnName].pct   += item.globalPct;
            scheduledMap[fnName].calls += item.calls;
            scheduledMap[fnName].dims  += 1;
          }
        }
      }
    }
    const tSpan = tickSpanMatch ? parseInt(tickSpanMatch[1]) : null;
    const scheduledFunctions = Object.entries(scheduledMap)
      .map(([name, d]) => {
        const interval = tSpan ? Math.round(tSpan / (d.calls / d.dims)) : null;
        return { name, pct: d.pct, calls: Math.round(d.calls / d.dims), interval };
      })
      .sort((a, b) => b.pct - a.pct);

    return {
      timeSpan: timeSpanMatch ? parseInt(timeSpanMatch[1]) : null,
      tickSpan: tickSpanMatch ? parseInt(tickSpanMatch[1]) : null,
      tps:      tpsMatch ? parseFloat(tpsMatch[1]) : null,
      categories,
      entityTypes,
      functions,
      scheduledFunctions,
      items,
    };
  }

  function parseEntitiesCsv(csv) {
    if (!csv) return {};
    const lines = csv.trim().split('\n').slice(1); // skip header
    const counts = {};
    for (const line of lines) {
      const parts = line.split(',');
      const type = parts[4];
      if (type) counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  function parseBlockEntitiesCsv(csv) {
    if (!csv) return {};
    const lines = csv.trim().split('\n').slice(1);
    const counts = {};
    for (const line of lines) {
      const parts = line.split(',');
      const type = parts[3];
      if (type) counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  function parseDimStats(txt) {
    if (!txt) return {};
    const kv = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^([\w.]+):\s*(.+)/);
      if (m) kv[m[1]] = m[2].trim();
    }
    return {
      blockEntityTickers: parseInt(kv['block_entity_tickers']) || 0,
      spawnMonster:       parseInt(kv['spawn_count.monster']) || 0,
      spawnCreature:      parseInt(kv['spawn_count.creature']) || 0,
      spawnAmbient:       parseInt(kv['spawn_count.ambient']) || 0,
    };
  }

  function parseChunksCsv(csv) {
    // x,z,level,...,block_entity_count,...,block_ticks,fluid_ticks
    if (!csv) return new Map();
    const lines = csv.trim().split('\n');
    const header = lines[0].split(',');
    const idx = (col) => header.indexOf(col);
    const iX = idx('x'), iZ = idx('z'), iBE = idx('block_entity_count'),
          iBT = idx('block_ticks'), iFT = idx('fluid_ticks');
    const map = new Map();
    for (const line of lines.slice(1)) {
      const p = line.split(',');
      const key = `${p[iX]},${p[iZ]}`;
      map.set(key, {
        x:               parseInt(p[iX]),
        z:               parseInt(p[iZ]),
        blockEntities:   parseInt(p[iBE]) || 0,
        blockTicks:      parseInt(p[iBT]) || 0,
        fluidTicks:      parseInt(p[iFT]) || 0,
      });
    }
    return map;
  }

  function parseEntityChunksCsv(csv) {
    // x,y,z,visibility,load_status,entity_count - x/z are chunk coords, y is section index
    if (!csv) return new Map();
    const lines = csv.trim().split('\n').slice(1);
    const map = new Map();
    for (const line of lines) {
      const p = line.split(',');
      const key = `${p[0]},${p[2]}`;
      const prev = map.get(key) || 0;
      map.set(key, prev + (parseInt(p[5]) || 0));
    }
    return map;
  }

  function buildChunkActivity(chunksMap, entityChunksMap) {
    // Merge both maps into a unified per-chunk activity object, sorted by score.
    const all = new Map();
    for (const [key, c] of chunksMap) {
      all.set(key, { x: c.x, z: c.z, entities: 0,
        blockEntities: c.blockEntities, blockTicks: c.blockTicks, fluidTicks: c.fluidTicks });
    }
    for (const [key, count] of entityChunksMap) {
      if (all.has(key)) {
        all.get(key).entities += count;
      } else {
        const [cx, cz] = key.split(',').map(Number);
        all.set(key, { x: cx, z: cz, entities: count,
          blockEntities: 0, blockTicks: 0, fluidTicks: 0 });
      }
    }
    return [...all.values()]
      .map(c => ({
        ...c,
        score: c.entities * 2 + c.blockEntities * 4 +
               Math.sqrt(c.blockTicks) + Math.sqrt(c.fluidTicks),
      }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function formatInterval(ticks) {
    if (!ticks || ticks <= 0) return null;
    if (ticks <= 1)  return 'every tick';
    if (ticks === 2) return 'every 2t';
    const secs = ticks / 20;
    if (Number.isInteger(secs) && secs >= 1) {
      return secs === 1 ? 'every 20t (1s)' : `every ${ticks}t (${secs}s)`;
    }
    return `every ${ticks}t`;
  }

  function friendlyType(type) {
    if (!type) return '';
    const name = type.includes(':') ? type.split(':')[1] : type;
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function friendlyDim(namespace, name) {
    const labels = {
      'minecraft/overworld':  'Overworld',
      'minecraft/the_nether': 'Nether',
      'minecraft/the_end':    'The End',
    };
    return labels[`${namespace}/${name}`] || `${namespace}: ${name.replace(/_/g, ' ')}`;
  }

  function tpsStatus(tps) {
    if (tps == null) return 'info';
    if (tps >= 18) return 'good';
    if (tps >= 14) return 'warn';
    return 'poor';
  }

  function tickStatus(ms) {
    if (ms == null) return 'info';
    if (ms < 45)  return 'good';
    if (ms < 100) return 'warn';
    return 'poor';
  }

  function statusLabel(status) {
    return { good: '● Healthy', warn: '▲ Moderate', poor: '✕ High load', info: '-' }[status];
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // ── Renderer ─────────────────────────────────────────────────────────────

  function render(data) {
    const sys       = parseSystemTxt(data.systemTxt);
    const stats     = parseServerStats(data.serverStats);
    const prof      = parseProfilingTxt(data.serverProfiling);
    const gamerules = parseGamerules(data.gamerulesTxt);

    const dims = data.dims.map(d => ({
      ...d,
      entityCounts:      parseEntitiesCsv(d.entities),
      blockEntityCounts: parseBlockEntitiesCsv(d.blockEntities),
      dimStats:          parseDimStats(d.stats),
      chunkActivity:     buildChunkActivity(parseChunksCsv(d.chunks), parseEntityChunksCsv(d.entityChunks)),
    }));

    const totalEntities = dims.reduce((sum, d) =>
      sum + Object.values(d.entityCounts).reduce((s, n) => s + n, 0), 0);

    resultsEl.innerHTML = '';

    // ── Session banner ──────────────────────────────────────────────────
    const banner = el('div', 'prof-banner');
    const worldName = sys.worldName || data.filename.replace(/\.zip$/, '');
    banner.innerHTML = `
      <h2 class="prof-banner-title">${esc(worldName)}</h2>
      <div class="prof-banner-meta">
        ${sys.mcVersion ? `<span class="prof-tag"><i class="bi bi-boxes"></i>${esc(sys.mcVersion)}</span>` : ''}
        ${prof.timeSpan ? `<span class="prof-tag"><i class="bi bi-stopwatch"></i>${prof.timeSpan / 1000}s session</span>` : ''}
        ${prof.tickSpan ? `<span class="prof-tag"><i class="bi bi-arrow-repeat"></i>${prof.tickSpan} ticks</span>` : ''}
        ${sys.players != null ? `<span class="prof-tag"><i class="bi bi-person"></i>${sys.players} / ${sys.maxPlayers} players</span>` : ''}
        <button class="prof-reset-btn" id="prof-reset"><i class="bi bi-upload"></i> Upload another</button>
      </div>
    `;
    resultsEl.appendChild(banner);

    document.getElementById('prof-reset').addEventListener('click', () => {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      uploadSection.hidden = false;
      fileInput.value = '';
    });

    // ── Stat cards ──────────────────────────────────────────────────────
    const tpsStatus_   = tpsStatus(prof.tps);
    const tickStatus_  = tickStatus(stats.avgTickMs);
    const statsRow = el('div', 'prof-stats-row');

    statsRow.append(
      statCard('TPS',
        prof.tps != null ? prof.tps.toFixed(1) : '-',
        'Ticks per second (target: 20)',
        tpsStatus_, statusLabel(tpsStatus_)),

      statCard('Avg Tick',
        stats.avgTickMs != null ? `${stats.avgTickMs.toFixed(1)} ms` : '-',
        'Time per tick (target: under 50 ms)',
        tickStatus_, statusLabel(tickStatus_)),

      statCard('Entities',
        totalEntities.toLocaleString(),
        `Across ${dims.length} dimension${dims.length !== 1 ? 's' : ''}`,
        totalEntities > 2000 ? 'warn' : totalEntities > 4000 ? 'poor' : 'info',
        totalEntities > 2000 ? '▲ Large count' : ''),

      statCard('Data Packs',
        sys.dataPacks.length.toString(),
        sys.dataPacks.length > 0 ? sys.dataPacks.slice(0, 3).map(d => d.replace(/^file\//, '')).join(', ') + (sys.dataPacks.length > 3 ? `…` : '') : 'Vanilla only',
        'info', '')
    );
    resultsEl.appendChild(statsRow);

    // ── Tick timeline ───────────────────────────────────────────────────
    if (stats.tickTimesMs.length > 0) {
      const card = el('div', 'prof-card');
      card.appendChild(el('h3', 'prof-card-title', '<i class="bi bi-bar-chart-line"></i> Tick timeline'));

      const wrap = el('div', 'prof-timeline-wrap');
      const canvas = document.createElement('canvas');
      canvas.className = 'prof-timeline-canvas';
      wrap.appendChild(canvas);

      const legend = el('div', 'prof-timeline-legend');
      legend.innerHTML = `
        <span><span class="dot dot-good"></span>Under 50 ms (on time)</span>
        <span><span class="dot dot-warn"></span>50–100 ms (slightly slow)</span>
        <span><span class="dot dot-poor"></span>Over 100 ms (very slow)</span>
        <span style="margin-left:auto;color:rgba(255,255,255,.3)">Each bar = one tick</span>
      `;
      wrap.appendChild(legend);

      // Tooltip
      const tooltip = el('div', 'prof-timeline-tooltip');
      wrap.appendChild(tooltip);

      canvas.addEventListener('mousemove', e => {
        const rect  = canvas.getBoundingClientRect();
        const x     = e.clientX - rect.left;
        const W     = canvas.clientWidth;
        const n     = stats.tickTimesMs.length;
        const gap   = W > n * 2 ? 1 : 0;
        const barW  = (W - gap * (n - 1)) / n;
        const i     = Math.min(n - 1, Math.max(0, Math.floor(x / (barW + gap))));
        const ms    = stats.tickTimesMs[i];
        const qual  = ms < 50 ? 'good' : ms < 100 ? 'warn' : 'poor';
        tooltip.textContent = `Tick ${i + 1}: ${ms.toFixed(1)} ms`;
        tooltip.className   = `prof-timeline-tooltip ${qual}`;
        // Keep tooltip horizontally within the container
        const tipW = 140;
        tooltip.style.left  = `${Math.min(W - tipW, Math.max(0, x - tipW / 2))}px`;
      });
      canvas.addEventListener('mouseleave', () => {
        tooltip.className = 'prof-timeline-tooltip';
      });

      card.appendChild(wrap);
      resultsEl.appendChild(card);

      requestAnimationFrame(() => drawTimeline(canvas, stats.tickTimesMs));
    }

    // ── Potential issues ────────────────────────────────────────────────
    const flags = buildFlags(prof, stats, totalEntities, dims);
    if (flags.length > 0) {
      const card = el('div', 'prof-card');
      card.appendChild(el('h3', 'prof-card-title', '<i class="bi bi-exclamation-triangle"></i> Things to look at'));
      const flagsEl = el('div', 'prof-flags');
      for (const f of flags) {
        const div = el('div', `prof-flag ${f.level}`);
        div.innerHTML = `<i class="bi ${f.icon}"></i><div>${f.html}</div>`;
        flagsEl.appendChild(div);
      }
      card.appendChild(flagsEl);
      resultsEl.appendChild(card);
    }

    // ── Server time breakdown ───────────────────────────────────────────
    if (prof.categories && prof.categories.length > 0) {
      const card = makeCollapsible('bi-pie-chart', 'Server time breakdown');

      const sub = el('p', null);
      sub.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 14px;font-weight:600;';
      sub.textContent = 'What the server is spending its tick budget on. The remaining time is idle (waiting for the next tick).';
      card.appendChild(sub);

      // Bar width = raw tick-budget %, so the visual directly represents the displayed number
      const list = el('div', 'prof-breakdown-list');
      for (const cat of prof.categories) {
        const heat = cat.pct > 5 ? 'hot' : cat.pct > 2 ? 'warm' : '';
        const hasChildren = cat.topChildren && cat.topChildren.length > 0;

        if (hasChildren) {
          const details = document.createElement('details');
          details.className = 'prof-breakdown-item';
          const summary = document.createElement('summary');
          summary.className = 'prof-breakdown-row';
          summary.innerHTML = `
            <i class="bi bi-chevron-right prof-breakdown-caret"></i>
            <div class="prof-breakdown-name">${esc(cat.label)}</div>
            <div class="prof-breakdown-bar-wrap"><div class="prof-breakdown-fill ${heat}" style="width:${cat.pct.toFixed(1)}%"></div></div>
            <div class="prof-breakdown-pct">${cat.pct.toFixed(1)}%</div>
            <div class="prof-breakdown-desc">${esc(cat.desc)}</div>
          `;
          details.appendChild(summary);

          const subList = el('div', 'prof-breakdown-sublist');
          for (const child of cat.topChildren) {
            const childHeat = child.pct > 5 ? 'hot' : child.pct > 2 ? 'warm' : '';
            const subRow = el('div', 'prof-breakdown-subrow');
            subRow.innerHTML = `
              <div class="prof-breakdown-name">${esc(child.name)}</div>
              <div class="prof-breakdown-bar-wrap"><div class="prof-breakdown-fill ${childHeat}" style="width:${child.pct.toFixed(1)}%"></div></div>
              <div class="prof-breakdown-pct">${child.pct.toFixed(1)}%</div>
            `;
            subList.appendChild(subRow);
          }
          details.appendChild(subList);
          list.appendChild(details);
        } else {
          const row = el('div', 'prof-breakdown-row');
          row.innerHTML = `
            <span></span>
            <div class="prof-breakdown-name">${esc(cat.label)}</div>
            <div class="prof-breakdown-bar-wrap"><div class="prof-breakdown-fill ${heat}" style="width:${cat.pct.toFixed(1)}%"></div></div>
            <div class="prof-breakdown-pct">${cat.pct.toFixed(1)}%</div>
            <div class="prof-breakdown-desc">${esc(cat.desc)}</div>
          `;
          list.appendChild(row);
        }
      }

      card.appendChild(list);
      resultsEl.appendChild(card);
    }

    // ── Entity breakdown per dimension ──────────────────────────────────
    const activeDims = dims.filter(d => Object.keys(d.entityCounts).length > 0);
    if (activeDims.length > 0) {
      const outer = makeCollapsible('bi-bug', 'Entity breakdown');
      const sub = el('p', null);
      sub.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 14px;font-weight:600;';
      sub.textContent = 'Entity counts per dimension. Bars show each type\'s share of that dimension\'s total entity population. Only the top 10 types are shown.';
      outer.appendChild(sub);
      const grid = el('div', 'prof-dims-grid');

      for (const dim of activeDims) {
        const total = Object.values(dim.entityCounts).reduce((s, n) => s + n, 0);
        const sorted = Object.entries(dim.entityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

        const card = el('div', 'prof-card');
        const dimLabel = friendlyDim(dim.namespace, dim.name);
        const be = dim.dimStats.blockEntityTickers;

        card.appendChild(el('h3', 'prof-card-title', `<i class="bi bi-globe"></i>${esc(dimLabel)}`));

        const list = el('div', 'prof-entity-list');
        for (const [type, count] of sorted) {
          const row = el('div', 'prof-entity-row');
          row.innerHTML = `
            <div class="prof-entity-name">${esc(friendlyType(type))}</div>
            <div class="prof-entity-bar-wrap"><div class="prof-entity-fill" style="width:${(count / total * 100).toFixed(1)}%"></div></div>
            <div class="prof-entity-count">${count.toLocaleString()}</div>
          `;
          list.appendChild(row);
        }

        const totRow = el('div', 'prof-entity-total');
        totRow.innerHTML = `<span>Total entities</span><strong style="color:var(--text)">${total.toLocaleString()}</strong>`;
        list.appendChild(totRow);

        if (be > 0) {
          const beRow = el('div', 'prof-entity-total');
          beRow.innerHTML = `<span>Active block entities (furnaces, hoppers…)</span><strong style="color:var(--text)">${be.toLocaleString()}</strong>`;
          list.appendChild(beRow);
        }

        card.appendChild(list);
        grid.appendChild(card);
      }

      outer.appendChild(grid);
      resultsEl.appendChild(outer);
    }

    // ── Chunk activity hotspots ─────────────────────────────────────────
    const activeDimsChunks = dims.filter(d => d.chunkActivity.length > 0);
    if (activeDimsChunks.length > 0) {
      const outer = makeCollapsible('bi-map', 'Chunk activity hotspots');

      const sub = el('p', null);
      sub.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 16px;font-weight:600;';
      sub.textContent = 'The busiest chunks by entity load, block entities, and pending ticks. Coordinates are block positions you can visit with F3.';
      outer.appendChild(sub);

      const grid = el('div', 'prof-dims-grid');

      for (const dim of activeDimsChunks) {
        const chunks = dim.chunkActivity;
        const dimLabel = friendlyDim(dim.namespace, dim.name);

        const card = el('div', 'prof-card');
        card.appendChild(el('h3', 'prof-card-title', `<i class="bi bi-globe"></i>${esc(dimLabel)}`));

        const list = el('div', 'prof-entity-list');
        for (const c of chunks) {
          const bx = c.x * 16, bz = c.z * 16;
          const reasons = [];
          if (c.entities > 0)      reasons.push(`${c.entities} entities`);
          if (c.blockEntities > 0) reasons.push(`${c.blockEntities} block entities`);
          if (c.blockTicks > 0)    reasons.push(`${c.blockTicks} block ticks`);
          if (c.fluidTicks > 0)    reasons.push(`${c.fluidTicks} fluid ticks`);

          const row = el('div', 'prof-chunk-row');
          row.innerHTML = `
            <div class="prof-chunk-coords">[${bx}, ${bz}]</div>
            <div class="prof-chunk-tags">${reasons.map(r => `<span class="prof-chunk-tag">${esc(r)}</span>`).join('')}</div>
          `;
          list.appendChild(row);
        }

        card.appendChild(list);
        grid.appendChild(card);
      }

      outer.appendChild(grid);
      resultsEl.appendChild(outer);
    }

    // ── Data pack function time ─────────────────────────────────────────
    if (prof.functions && prof.functions.length > 0) {
      const card = makeCollapsible('bi-code-slash', 'Data pack time usage');

      // Max-scale bars: the biggest namespace fills the bar; others are proportional.
      // The subtitle shows the absolute total so both relative rank and tick impact are visible.
      const totalNsPct = prof.functions.reduce((s, fn) => s + fn.pct, 0);
      const maxNsPct   = Math.max(...prof.functions.map(fn => fn.pct));

      const sub = el('p', null);
      sub.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 16px;font-weight:600;';
      sub.textContent = `How much server time each data pack's functions are consuming. Total: ${totalNsPct.toFixed(2)}% of server tick time. Expand a namespace to see its top 10 individual functions.`;
      card.appendChild(sub);

      // Build lookup: full function name → schedule interval (from tick loop analysis)
      const scheduledMap = new Map(
        (prof.scheduledFunctions || []).map(fn => [fn.name, fn.interval])
      );

      const nsList = el('div', 'prof-fn-list');

      for (const fn of prof.functions.slice(0, 12)) {
        const details = document.createElement('details');
        details.className = 'prof-fn-ns';

        // Namespace header row (summary)
        const summary = document.createElement('summary');
        summary.className = 'prof-fn-ns-summary';
        summary.innerHTML = `
          <i class="bi bi-chevron-right prof-fn-caret"></i>
          <div class="prof-fn-name">${esc(fn.ns)}</div>
          <div class="prof-breakdown-bar-wrap"><div class="prof-breakdown-fill ${fn.pct > 5 ? 'hot' : fn.pct > 2 ? 'warm' : ''}" style="width:${(fn.pct / maxNsPct * 100).toFixed(1)}%"></div></div>
          <div class="prof-fn-meta"><span>${fn.pct.toFixed(2)}%</span><span class="prof-fn-calls">${fn.calls.toLocaleString()}×</span></div>
        `;
        details.appendChild(summary);

        // Sub-functions: bars relative to their namespace total so each shows its share of the namespace
        if (fn.topFunctions && fn.topFunctions.length > 0) {
          const subList = el('div', 'prof-fn-sublist');
          for (const f of fn.topFunctions) {
            const funcPath = f.name.includes(':') ? f.name.split(':')[1] : f.name;
            const interval = scheduledMap.has(f.name) ? formatInterval(scheduledMap.get(f.name)) : null;
            const row = el('div', 'prof-fn-subrow');
            row.innerHTML = `
              <span></span>
              <div class="prof-fn-subname-wrap">
                <span class="prof-fn-subname" title="${esc(f.name)}">${esc(funcPath)}</span>
                ${interval ? `<span class="prof-sched-interval">${esc(interval)}</span>` : ''}
              </div>
              <div class="prof-breakdown-bar-wrap"><div class="prof-breakdown-fill" style="width:${(f.pct / fn.pct * 100).toFixed(1)}%"></div></div>
              <div class="prof-fn-meta"><span>${f.pct.toFixed(2)}%</span><span class="prof-fn-calls">${f.calls.toLocaleString()}×</span></div>
            `;
            subList.appendChild(row);
          }
          details.appendChild(subList);
        }

        nsList.appendChild(details);
      }

      card.appendChild(nsList);
      resultsEl.appendChild(card);
    }

    // ── Gamerules ───────────────────────────────────────────────────────
    if (gamerules.length > 0) {
      const card = makeCollapsible('bi-sliders', 'Gamerules');
      card.open = false;
      const grid = el('div', 'prof-gamerules-grid');
      for (const { key, val } of gamerules) {
        const row = el('div', 'prof-gamerule-row');
        const isBool = val === 'true' || val === 'false';
        const valClass = isBool ? (val === 'true' ? 'prof-gamerule-val--true' : 'prof-gamerule-val--false') : '';
        row.innerHTML = `<span class="prof-gamerule-key">${esc(key)}</span><span class="prof-gamerule-val ${valClass}">${esc(val)}</span>`;
        grid.appendChild(row);
      }
      card.appendChild(grid);
      resultsEl.appendChild(card);
    }

    // ── System info (collapsible) ───────────────────────────────────────
    const sysInfo = buildSysInfoSection(sys, stats, prof);
    resultsEl.appendChild(sysInfo);
  }

  // ── Tick timeline canvas ──────────────────────────────────────────────

  function drawTimeline(canvas, tickTimesMs) {
    const dpr  = window.devicePixelRatio || 1;
    const W    = canvas.parentElement.clientWidth;
    const H    = 64;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const n   = tickTimesMs.length;
    // Drop the gap when the canvas is too narrow so bars never exceed W.
    // Use exact float widths so bars fill the canvas with zero trailing gap.
    const gap  = W > n * 2 ? 1 : 0;
    const barW = (W - gap * (n - 1)) / n;
    const max  = Math.max(200, ...tickTimesMs); // at least 200ms scale

    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, W, H);

    // 50ms line
    const y50 = H - (50 / max) * H;
    ctx.strokeStyle = 'rgba(255,209,139,.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y50);
    ctx.lineTo(W, y50);
    ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 0; i < n; i++) {
      const ms = tickTimesMs[i];
      const x  = i * (barW + gap);
      const h  = Math.min(H, (ms / max) * H);
      const y  = H - h;

      ctx.fillStyle = ms < 50 ? '#5ee69b' : ms < 100 ? '#ffd18b' : '#ff9090';
      ctx.fillRect(x, y, barW, h);
    }
  }

  // ── Flags / issue detection ───────────────────────────────────────────

  function buildFlags(prof, stats, totalEntities, dims) {
    const flags = [];

    if (stats.avgTickMs != null && stats.avgTickMs > 50) {
      flags.push({
        level: 'poor', icon: 'bi-speedometer2',
        html: `<strong>Server is lagging.</strong> Average tick time is ${stats.avgTickMs.toFixed(1)} ms - the target is under 50 ms. Players likely experience delays.`,
      });
    } else if (stats.avgTickMs != null && stats.avgTickMs > 35) {
      flags.push({
        level: 'warn', icon: 'bi-speedometer',
        html: `<strong>Tick time is elevated.</strong> Average is ${stats.avgTickMs.toFixed(1)} ms (target: under 50 ms). You have headroom but should watch for spikes.`,
      });
    }

    if (totalEntities > 4000) {
      flags.push({
        level: 'poor', icon: 'bi-bug-fill',
        html: `<strong>Very high entity count (${totalEntities.toLocaleString()}).</strong> More than 4,000 entities can significantly impact performance. Check which dimension has the most and consider using a mob limiter.`,
      });
    } else if (totalEntities > 2000) {
      flags.push({
        level: 'warn', icon: 'bi-bug',
        html: `<strong>High entity count (${totalEntities.toLocaleString()}).</strong> Over 2,000 entities is worth monitoring, especially if mobs are concentrated in one area.`,
      });
    }

    for (const dim of dims) {
      const be = dim.dimStats.blockEntityTickers;
      if (be > 500) {
        const dimLabel = friendlyDim(dim.namespace, dim.name);
        flags.push({
          level: be > 1000 ? 'poor' : 'warn',
          icon: 'bi-gear-wide-connected',
          html: `<strong>${be.toLocaleString()} active block entities in ${esc(dimLabel)}.</strong> Each hopper, furnace, and piston checks every tick. Large numbers of these can add up - consider replacing hoppers with other item transport methods where possible.`,
        });
      }
    }

    if (prof.categories) {
      const entityCat = prof.categories.find(c => c.name === 'entities');
      if (entityCat && entityCat.pct > 10) {
        flags.push({
          level: entityCat.pct > 20 ? 'poor' : 'warn',
          icon: 'bi-cpu',
          html: `<strong>Mob AI is using ${entityCat.pct.toFixed(1)}% of the server's tick budget.</strong> This is the time spent on pathfinding, goal checking, and movement for all entities. Reducing the mob count or render distance can help.`,
        });
      }

      const fnCat = prof.categories.find(c => c.name === 'scheduledFunctions');
      if (fnCat && fnCat.pct > 5) {
        flags.push({
          level: fnCat.pct > 10 ? 'poor' : 'warn',
          icon: 'bi-code-square',
          html: `<strong>Data pack functions are using ${fnCat.pct.toFixed(1)}% of server time.</strong> One or more data packs are running heavy commands every tick. Check the data pack breakdown below.`,
        });
      }
    }

    if (stats.tickTimesMs.length > 0) {
      const spikes   = stats.tickTimesMs.filter(ms => ms > 150).length;
      const total    = stats.tickTimesMs.length;
      if (spikes > 5) {
        flags.push({
          level: 'warn', icon: 'bi-lightning-charge',
          html: `<strong>${spikes} of the last ${total} recorded tick${total !== 1 ? 's' : ''} spiked over 150 ms.</strong> Occasional spikes cause brief freezes. Check the timeline above for the pattern.`,
        });
      }
    }

    return flags;
  }

  // ── Collapsible card factory ──────────────────────────────────────────

  function makeCollapsible(iconClass, title) {
    const details = document.createElement('details');
    details.className = 'prof-card';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'prof-card-summary';
    summary.innerHTML = `<i class="bi ${iconClass}"></i>${esc(title)}<i class="bi bi-chevron-down prof-summary-caret"></i>`;
    details.appendChild(summary);
    return details;
  }

  // ── System info section ───────────────────────────────────────────────

  function buildSysInfoSection(sys, stats, prof) {
    const details = makeCollapsible('bi-info-circle', 'System details');
    details.open = false;

    const body = el('div', 'prof-sysinfo-body');
    const rows = [
      ['Minecraft version', sys.mcVersion],
      ['CPU', sys.cpuName ? `${sys.cpuCount}× ${sys.cpuName}` : sys.cpuCount],
      ['RAM used / max', sys.memUsed ? `${sys.memUsed.toLocaleString()} MiB / ${sys.memMax?.toLocaleString() ?? '?'} MiB` : null],
      ['Operating system', sys.os],
      ['Render distance', sys.renderDist],
      ['Tick span', prof.tickSpan ? `${prof.tickSpan} ticks over ${(prof.timeSpan / 1000).toFixed(1)}s` : null],
      ['Peak tick time', stats.tickTimesMs.length > 0 ? `${Math.max(...stats.tickTimesMs).toFixed(1)} ms` : null],
      ['Active data packs', sys.dataPacks.length > 0 ? sys.dataPacks.map(d => d.replace(/^file\//, '')).join(', ') : 'Vanilla only'],
    ];

    for (const [key, val] of rows) {
      if (!val) continue;
      const row = el('div', 'prof-sysinfo-row');
      row.innerHTML = `<div class="prof-sysinfo-key">${esc(key)}</div><div class="prof-sysinfo-val">${esc(String(val))}</div>`;
      body.appendChild(row);
    }
    details.appendChild(body);
    return details;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  function statCard(label, value, sub, status, badge) {
    const card = el('div', 'prof-stat-card');
    card.innerHTML = `
      <div class="prof-stat-label">${esc(label)}</div>
      <div class="prof-stat-value">${esc(value)}</div>
      <div class="prof-stat-sub">${esc(sub)}</div>
      ${badge ? `<div class="prof-stat-badge ${status}">${esc(badge)}</div>` : ''}
    `;
    return card;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
