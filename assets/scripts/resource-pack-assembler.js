'use strict';

(function () {

  // ── State ──────────────────────────────────────────────────────────────────

  let packData      = null; // full manifest
  let selectedVer   = null; // currently chosen MC version
  let checkedSlugs  = new Set();

  // ── Element refs ────────────────────────────────────────────────────────────

  const el = {
    pills:        document.getElementById('rp-version-pills'),
    controls:     document.getElementById('rp-pack-controls'),
    grid:         document.getElementById('rp-pack-grid'),
    dlBtn:        document.getElementById('rp-dl-btn'),
    selectAll:    document.getElementById('rp-select-all'),
    deselectAll:  document.getElementById('rp-deselect-all'),
    progress:     document.getElementById('rp-progress'),
    progressBar:  document.getElementById('rp-progress-bar'),
    progressSt:   document.getElementById('rp-progress-status'),
    conflicts:    document.getElementById('rp-conflicts'),
    conflictLbl:  document.getElementById('rp-conflicts-label'),
    conflictList: document.getElementById('rp-conflicts-list'),
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024)    return Math.round(b / 1024) + ' KB';
    return b + ' B';
  }

  function setProgress(pct, msg) {
    el.progressBar.style.width = pct + '%';
    el.progressSt.textContent = msg;
  }

  // ── Derived data helpers ─────────────────────────────────────────────────────

  function availableVersions() {
    if (!packData) return [];
    const verSet = new Set();
    for (const proj of packData.projects) {
      for (const [ver, info] of Object.entries(proj.byVersion)) {
        if (info.hasAssets) verSet.add(ver);
      }
    }
    return [...verSet].sort((a, b) => {
      const toArr = v => v.split('.').map(Number);
      const [am, an, ap = 0] = toArr(a);
      const [bm, bn, bp = 0] = toArr(b);
      return am - bm || an - bn || ap - bp;
    });
  }

  function projectsForVersion(ver) {
    return packData.projects.filter(p => p.byVersion[ver]);
  }

  function selectedProjects() {
    return projectsForVersion(selectedVer)
      .filter(p => checkedSlugs.has(p.slug) && p.byVersion[selectedVer].hasAssets);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function renderVersionPills(versions) {
    el.pills.innerHTML = '';
    if (!versions.length) {
      el.pills.innerHTML = '<span class="rp-empty">No resource pack data available yet.</span>';
      return;
    }
    for (const ver of versions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rp-pill' + (ver === selectedVer ? ' is-active' : '');
      btn.textContent = ver;
      btn.addEventListener('click', () => selectVersion(ver));
      el.pills.appendChild(btn);
    }
  }

  function renderPackGrid(ver) {
    el.grid.innerHTML = '';
    const projects = projectsForVersion(ver);

    if (!projects.length) {
      el.grid.innerHTML = '<span class="rp-empty">No data packs available for this version.</span>';
      el.controls.hidden = true;
      el.dlBtn.disabled = true;
      return;
    }

    const hasAnyAssets = projects.some(p => p.byVersion[ver].hasAssets);
    el.controls.hidden = !hasAnyAssets;

    const frag = document.createDocumentFragment();
    for (const proj of projects.sort((a, b) => a.name.localeCompare(b.name))) {
      const info = proj.byVersion[ver];
      const hasAssets = info.hasAssets;

      const label = document.createElement('label');
      label.className = 'rp-pack-card' + (hasAssets ? '' : ' is-disabled');
      label.title = hasAssets ? '' : 'This pack has no resource assets for this version.';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'rp-pack-card__cb';
      cb.value = proj.slug;
      cb.disabled = !hasAssets;
      cb.checked = hasAssets && checkedSlugs.has(proj.slug);
      cb.addEventListener('change', () => {
        if (cb.checked) checkedSlugs.add(proj.slug);
        else checkedSlugs.delete(proj.slug);
        updateDlBtn();
      });

      const body = document.createElement('div');
      body.className = 'rp-pack-card__body';

      const name = document.createElement('span');
      name.className = 'rp-pack-card__name';
      name.textContent = proj.name;

      body.appendChild(name);

      if (hasAssets) {
        const badge = document.createElement('span');
        badge.className = 'rp-pack-card__badge';
        badge.textContent = info.assetBytes != null ? fmtBytes(info.assetBytes) : '';
        if (badge.textContent) body.appendChild(badge);
      } else {
        const note = document.createElement('span');
        note.className = 'rp-pack-card__no-assets';
        note.textContent = 'No assets';
        body.appendChild(note);
      }

      label.appendChild(cb);
      label.appendChild(body);
      frag.appendChild(label);
    }
    el.grid.appendChild(frag);
    updateDlBtn();
  }

  function updateDlBtn() {
    el.dlBtn.disabled = selectedProjects().length === 0;
  }

  // ── Version selection ────────────────────────────────────────────────────────

  function selectVersion(ver) {
    selectedVer = ver;

    // Pre-check all projects that have assets for this version
    checkedSlugs = new Set(
      packData.projects
        .filter(p => p.byVersion[ver]?.hasAssets)
        .map(p => p.slug)
    );

    renderVersionPills(availableVersions());
    renderPackGrid(ver);
  }

  // ── Select / Deselect All ───────────────────────────────────────────────────

  el.selectAll.addEventListener('click', () => {
    projectsForVersion(selectedVer)
      .filter(p => p.byVersion[selectedVer].hasAssets)
      .forEach(p => checkedSlugs.add(p.slug));
    el.grid.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => { cb.checked = true; });
    updateDlBtn();
  });

  el.deselectAll.addEventListener('click', () => {
    checkedSlugs.clear();
    el.grid.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => { cb.checked = false; });
    updateDlBtn();
  });

  // ── Assembly ──────────────────────────────────────────────────────────────────

  el.dlBtn.addEventListener('click', buildResourcePack);

  async function buildResourcePack() {
    const projects = selectedProjects();
    if (!projects.length) return;

    el.dlBtn.disabled = true;
    el.dlBtn.innerHTML = '<span class="rp-spinner" aria-hidden="true"></span> Building…';
    el.progress.hidden = false;
    el.conflicts.hidden = true;
    el.conflictList.innerHTML = '';

    const conflictLog = []; // { path, winner, loser }
    const fileMap = {};     // path → { data: ArrayBuffer, owner: projectName }
    const total   = projects.length + 2; // +fetch pack.png +build zip
    let   done    = 0;

    try {
      // ── Fetch each selected pack and extract assets/ ──────────────────────
      for (const proj of projects) {
        const info = proj.byVersion[selectedVer];
        setProgress(Math.round((done / total) * 90), `Fetching ${proj.name}…`);

        let zipBuf;
        try {
          const resp = await fetch(info.fileUrl, { mode: 'cors' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          zipBuf = await resp.arrayBuffer();
        } catch (err) {
          console.warn(`Could not fetch ${proj.slug}: ${err.message}`);
          done++;
          continue;
        }

        const zip = await JSZip.loadAsync(zipBuf);
        for (const [entryPath, entry] of Object.entries(zip.files)) {
          if (!entryPath.startsWith('assets/') || entry.dir) continue;
          const data = await entry.async('arraybuffer');
          if (fileMap[entryPath]) {
            conflictLog.push({ path: entryPath, winner: proj.name, loser: fileMap[entryPath].owner });
          }
          fileMap[entryPath] = { data, owner: proj.name };
        }
        done++;
      }

      // ── Fetch pack.png ────────────────────────────────────────────────────
      setProgress(Math.round((done / total) * 90), 'Fetching pack.png…');
      let packPng = null;
      try {
        const resp = await fetch('/resource-pack/pack.png');
        if (resp.ok) packPng = await resp.arrayBuffer();
      } catch { /* skip — game will use default pack icon */ }
      done++;

      // ── Build output ZIP ──────────────────────────────────────────────────
      setProgress(Math.round((done / total) * 90), 'Assembling ZIP…');
      const outZip = new JSZip();

      for (const [p, { data }] of Object.entries(fileMap)) {
        outZip.file(p, data);
      }

      if (packPng) outZip.file('pack.png', packPng);

      const rpFormat = packData.rpFormats[selectedVer] ?? 34;
      const description = [{ text: "Explorer's Eden Resources", color: 'white' }];
      const packSection = rpFormat >= 69
        ? { min_format: rpFormat, max_format: rpFormat, description }
        : { description, pack_format: rpFormat };
      const mcmeta = JSON.stringify({ pack: packSection }, null, 2);
      outZip.file('pack.mcmeta', mcmeta);
      done++;

      setProgress(95, 'Compressing…');
      const blob = await outZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      // ── Trigger download ──────────────────────────────────────────────────
      const safeVer  = selectedVer.replace(/\./g, '_');
      const built    = selectedProjects();
      const packName = built.length === 1
        ? built[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + `_${safeVer}`
        : `explorers_eden_resource_pack_${safeVer}`;
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `${packName}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setProgress(100, `Done! ${Object.keys(fileMap).length} files assembled.`);

      // ── Show conflicts ────────────────────────────────────────────────────
      const visibleConflicts = conflictLog.filter(c => !c.path.includes('petrified_oak_slab'));
      if (visibleConflicts.length) {
        el.conflictLbl.textContent = `Conflicts (${visibleConflicts.length})`;
        el.conflictList.innerHTML = visibleConflicts.map(c =>
          `<li><code>${escapeHtml(c.path)}</code>: kept <strong>${escapeHtml(c.winner)}</strong>, discarded <strong>${escapeHtml(c.loser)}</strong></li>`
        ).join('');
        el.conflicts.hidden = false;
      }

    } catch (err) {
      setProgress(0, `Error: ${err.message}`);
      console.error(err);
    } finally {
      el.dlBtn.disabled = false;
      el.dlBtn.innerHTML = '<i class="bi bi-download" aria-hidden="true"></i> Download Resource Pack';
      updateDlBtn();
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    try {
      const resp = await fetch('/resource-pack-assembler/data/pack-data.json');
      if (resp.status === 404) {
        el.pills.innerHTML = '<span class="rp-empty">No resource pack data available yet. Check back after the next CI run.</span>';
        el.grid.innerHTML  = '';
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      packData = await resp.json();

      const versions = availableVersions();
      if (!versions.length) {
        el.pills.innerHTML = '<span class="rp-empty">No resource pack data available yet. Check back after the next CI run.</span>';
        el.grid.innerHTML  = '';
        return;
      }

      selectVersion(versions[versions.length - 1]); // default to latest
    } catch (err) {
      el.pills.innerHTML = `<span class="rp-empty">Failed to load pack data: ${escapeHtml(err.message)}</span>`;
      el.grid.innerHTML  = '';
      console.error(err);
    }
  }

  init();

})();
