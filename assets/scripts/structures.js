(() => {
  const MANIFEST_URL = '/structures/structure-viewers.manifest.json';

  const searchInput = document.getElementById('structure-search');
  const clearBtn    = document.getElementById('clear-structure-search');
  const filterRoot  = document.getElementById('structure-filters');
  const groupList   = document.getElementById('structures-group-list');
  const detail      = document.getElementById('structures-detail');
  const sidebarEl   = document.querySelector('.structures-sidebar');
  const sidebarToggle = document.getElementById('structures-sidebar-toggle');
  const sidebarBody   = document.getElementById('structures-sidebar-body');

  if (!groupList || !detail) return;

  // datapack-slug → Modrinth project slug (kept in sync with recipes.js)
  const MODRINTH_SLUGS = {
    enchantments_encore: 'enchantments-encore',
    fabled_roots:        'fabled-roots',
    katters_structures:  'katters-structures',
    nice_mob_variants:   'nice-mob-variants',
    nice_things:         'nice-things-eden',
  };

  function modrinthUrl(datapackSlug) {
    const slug = MODRINTH_SLUGS[datapackSlug];
    return slug ? `https://modrinth.com/datapack/${slug}` : null;
  }

  // "kattersstructures:better_vanilla_dungeon" → "Better Vanilla Dungeon"
  function groupLabel(structureId) {
    const name = String(structureId).split(':')[1] || structureId;
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let allStructures = [];
  let packGroups  = new Map(); // datapack → Map<structureId, structure[]>
  let activeId    = null;
  let activePack  = 'All';
  let openPacks   = new Set();
  let openSubgroups = new Set();

  // ── Hover preview tooltip ───────────────────────────────────────────────────

  const tooltip = document.createElement('div');
  tooltip.className = 'structures-preview-tooltip';
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  let hideTimer   = null;
  let slideTimer  = null;

  function stopSlideshow() {
    if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
  }

  function showTooltip(s, anchorEl) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    stopSlideshow();

    const imgs = (s.previews || []).map((src, i) =>
      `<img src="${escapeHtml(src)}" alt="" loading="lazy"${i === 0 ? ' class="is-active"' : ''}>`
    ).join('');

    tooltip.innerHTML = `
      <div class="structure-preview-stack structures-tooltip-stack">
        ${imgs}
      </div>
      <p class="structures-tooltip-name">${escapeHtml(s.displayName)}</p>`;

    tooltip.hidden = false;

    const allImgs = [...tooltip.querySelectorAll('.structures-tooltip-stack img')];
    if (allImgs.length > 1) {
      let idx = 0;
      slideTimer = setInterval(() => {
        allImgs[idx].classList.remove('is-active');
        idx = (idx + 1) % allImgs.length;
        allImgs[idx].classList.add('is-active');
      }, 3000);
    }

    // Position: to the right of the sidebar, vertically centred on anchor.
    const aRect = anchorEl.getBoundingClientRect();
    const sRect = sidebarEl?.getBoundingClientRect();
    const tw    = tooltip.offsetWidth;
    const th    = tooltip.offsetHeight;

    let top  = aRect.top + aRect.height / 2 - th / 2;
    let left = (sRect ? sRect.right : aRect.right) + 12;

    // Clamp to viewport.
    top  = Math.max(10, Math.min(top, window.innerHeight - th - 10));
    left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));

    tooltip.style.top  = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function hideTooltip() {
    hideTimer = setTimeout(() => { tooltip.hidden = true; stopSlideshow(); }, 80);
  }

  // ── Manifest loading ────────────────────────────────────────────────────────

  async function loadManifest() {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      allStructures = await res.json();
    } catch (err) {
      groupList.innerHTML = `<li class="structures-empty structures-empty--error">Failed to load structures: ${escapeHtml(err.message)}</li>`;
      return;
    }

    packGroups = new Map();
    for (const s of allStructures) {
      if (!packGroups.has(s.datapack)) packGroups.set(s.datapack, new Map());
      const sidMap = packGroups.get(s.datapack);
      if (!sidMap.has(s.structureId)) sidMap.set(s.structureId, []);
      sidMap.get(s.structureId).push(s);
    }

    const firstPack = [...packGroups.keys()].sort((a, b) => a.localeCompare(b))[0];
    if (firstPack) openPacks.add(firstPack);

    groupList.setAttribute('aria-busy', 'false');
    render();
    handleHash();
    window.addEventListener('hashchange', handleHash);
  }

  function byId(id) {
    return allStructures.find(s => s.id === id) || null;
  }

  // ── Filtering / matching ─────────────────────────────────────────────────────

  function matches(s, q) {
    if (!q) return true;
    return [s.displayName, s.id, s.datapack, s.structureId]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  // ── Render sidebar ───────────────────────────────────────────────────────────

  function render() {
    const q = (searchInput?.value || '').trim().toLowerCase();
    const matched = q ? allStructures.filter(s => matches(s, q)) : allStructures.slice();

    const countsByPack = new Map();
    for (const s of matched) countsByPack.set(s.datapack, (countsByPack.get(s.datapack) || 0) + 1);

    if (activePack !== 'All' && !(countsByPack.get(activePack) || 0)) activePack = 'All';

    renderQuickFilters(countsByPack, matched.length);

    const sortedPacks = [...packGroups.keys()].sort((a, b) => a.localeCompare(b));
    const frag = document.createDocumentFragment();

    for (const pack of sortedPacks) {
      if (activePack !== 'All' && pack !== activePack) continue;

      const sidMap     = packGroups.get(pack);
      const packMatched = matched.filter(s => s.datapack === pack);
      if (!packMatched.length) continue;

      const packIsOpen = q !== '' || openPacks.has(pack) || activePack === pack;

      const packLi = document.createElement('li');
      packLi.className = 'structures-group' + (packIsOpen ? ' is-open' : '');

      const packHeader = document.createElement('button');
      packHeader.type = 'button';
      packHeader.className = 'structures-group-header';
      packHeader.setAttribute('aria-expanded', String(packIsOpen));
      packHeader.innerHTML = `
        <i class="bi bi-chevron-right structures-group-caret" aria-hidden="true"></i>
        <span class="structures-group-name">${escapeHtml(pack)}</span>
        <span class="structures-group-count">${packMatched.length}</span>
      `;
      packHeader.addEventListener('click', () => {
        if (openPacks.has(pack)) openPacks.delete(pack);
        else openPacks.add(pack);
        render();
      });

      const innerUl = document.createElement('ul');
      innerUl.className = 'structures-pack-items';

      const sortedSids = [...sidMap.keys()].sort((a, b) => groupLabel(a).localeCompare(groupLabel(b)));

      for (const sid of sortedSids) {
        const allSidItems    = sidMap.get(sid);
        const sidStructures  = allSidItems.filter(s => matches(s, q));
        if (!sidStructures.length) continue;

        if (allSidItems.length === 1) {
          innerUl.appendChild(makeItemLi(sidStructures[0]));
        } else if (sidStructures.length === 1 && q) {
          innerUl.appendChild(makeItemLi(sidStructures[0]));
        } else {
          const subIsOpen = q !== '' || openSubgroups.has(sid);

          const subLi = document.createElement('li');
          subLi.className = 'structures-type' + (subIsOpen ? ' is-open' : '');

          const subHeader = document.createElement('button');
          subHeader.type = 'button';
          subHeader.className = 'structures-type-header';
          subHeader.setAttribute('aria-expanded', String(subIsOpen));
          subHeader.innerHTML = `
            <i class="bi bi-chevron-right structures-type-caret" aria-hidden="true"></i>
            <span class="structures-type-name">${escapeHtml(groupLabel(sid))}</span>
            <span class="structures-type-count">${sidStructures.length}</span>
          `;
          subHeader.addEventListener('click', () => {
            if (openSubgroups.has(sid)) openSubgroups.delete(sid);
            else openSubgroups.add(sid);
            render();
          });

          const subUl = document.createElement('ul');
          subUl.className = 'structures-sub-items';
          for (const s of sidStructures) subUl.appendChild(makeItemLi(s));

          subLi.appendChild(subHeader);
          subLi.appendChild(subUl);
          innerUl.appendChild(subLi);
        }
      }

      packLi.appendChild(packHeader);
      packLi.appendChild(innerUl);
      frag.appendChild(packLi);
    }

    groupList.innerHTML = '';
    if (!frag.children.length) {
      groupList.innerHTML = '<li class="structures-empty">No structures match your search.</li>';
    } else {
      groupList.appendChild(frag);
    }

    if (clearBtn) clearBtn.style.display = (q || activePack !== 'All') ? 'block' : 'none';
  }

  function makeItemLi(s) {
    const li  = document.createElement('li');
    li.className = 'structures-item' + (activeId === s.id ? ' is-active' : '');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'structures-item-btn';
    btn.dataset.id = s.id;
    btn.innerHTML = `<span class="structures-item-name">${escapeHtml(s.displayName)}</span>`;

    btn.addEventListener('mouseenter', () => showTooltip(s, btn));
    btn.addEventListener('mouseleave', hideTooltip);
    btn.addEventListener('click',      () => { hideTooltip(); tooltip.hidden = true; selectStructure(s); });

    li.appendChild(btn);
    return li;
  }

  // ── Quick filter chips ───────────────────────────────────────────────────────

  function renderQuickFilters(countsByPack, totalMatched) {
    if (!filterRoot) return;
    const allPacks = [...packGroups.keys()].sort((a, b) => a.localeCompare(b));
    filterRoot.innerHTML = '';
    for (const pack of ['All', ...allPacks]) {
      const btn   = document.createElement('button');
      btn.type    = 'button';
      const count = pack === 'All' ? totalMatched : (countsByPack.get(pack) || 0);
      btn.className = 'filter-chip' + (pack === activePack ? ' is-active' : '');
      btn.innerHTML = `<span>${escapeHtml(pack)}</span><strong>${count}</strong>`;
      if (count === 0 && pack !== 'All') { btn.disabled = true; btn.classList.add('is-empty'); }
      btn.addEventListener('click', () => { if (activePack === pack) return; activePack = pack; render(); });
      filterRoot.appendChild(btn);
    }
  }

  // ── Detail pane (viewer only) ─────────────────────────────────────────────────

  function selectStructure(s) {
    activeId = s.id;
    history.replaceState(null, '', '/structures/#' + encodeURIComponent(s.id));

    document.querySelectorAll('.structures-item').forEach(li => {
      li.classList.toggle('is-active', li.querySelector('[data-id]')?.dataset.id === s.id);
    });

    renderDetailViewer(s);

    if (window.matchMedia('(max-width: 900px)').matches && sidebarBody?.classList.contains('is-open')) {
      sidebarBody.classList.remove('is-open');
      sidebarToggle?.setAttribute('aria-expanded', 'false');
    }
  }

  function overlayHead(s) {
    const url = modrinthUrl(s.datapackSlug);
    const packEl = url
      ? `<a class="structures-detail-pack" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(s.datapack)}</a>`
      : `<span class="structures-detail-pack">${escapeHtml(s.datapack)}</span>`;
    return `
      <div class="structures-viewer-overlay-group">
        <div class="structures-viewer-overlay">
          ${packEl}
          <h2 class="structures-detail-name">${escapeHtml(s.displayName)}</h2>
        </div>
        <button class="structures-copy-id" type="button" title="Copy structure ID">
          <code>${escapeHtml(s.id)}</code>
        </button>
      </div>`;
  }

  function wireCopyButton(s) {
    detail.querySelector('.structures-copy-id')?.addEventListener('click', async evt => {
      const el = evt.currentTarget;
      try {
        await navigator.clipboard.writeText(s.id);
        el.classList.add('is-copied');
        const inner = el.innerHTML;
        el.textContent = 'Copied!';
        setTimeout(() => { el.classList.remove('is-copied'); el.innerHTML = inner; }, 1100);
      } catch {}
    });
  }

  function renderDetailViewer(s) {
    // manifest url is relative to structures/ on the server; ?embed=1 hides
    // the viewer's own sidebar so only the THREE.js canvas fills the pane.
    const iframeSrc = '/structures/' + s.url + '?embed=1';

    detail.innerHTML = `
      <div class="structures-viewer-box">
        ${overlayHead(s)}
        <div class="structures-viewer-controls">
          <button class="structures-viewer-btn structures-focus-btn" type="button" title="Activate viewer controls" aria-label="Activate viewer controls">
            <i class="bi bi-cursor" aria-hidden="true"></i>
          </button>
          <button class="structures-viewer-btn structures-fullscreen-btn" type="button" title="Toggle fullscreen" aria-label="Toggle fullscreen">
            <i class="bi bi-fullscreen" aria-hidden="true"></i>
          </button>
        </div>
        <iframe
          class="structures-frame"
          src="${escapeHtml(iframeSrc)}"
          title="${escapeHtml(s.displayName)} 3D viewer"
          allowfullscreen>
        </iframe>
      </div>`;
    wireCopyButton(s);

    const box    = detail.querySelector('.structures-viewer-box');
    const iframe = detail.querySelector('.structures-frame');

    detail.querySelector('.structures-fullscreen-btn')?.addEventListener('click', evt => {
      if (!document.fullscreenElement) {
        box?.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
      evt.currentTarget.blur();
    });

    detail.querySelector('.structures-focus-btn')?.addEventListener('click', () => {
      try { iframe?.contentWindow?.focus(); } catch {}
    });

    iframe?.addEventListener('load', () => {
      try { iframe.contentWindow?.focus(); } catch {}
    });
  }

  document.addEventListener('fullscreenchange', () => {
    const icon   = detail?.querySelector('.structures-fullscreen-btn .bi');
    if (!icon) return;
    icon.className = document.fullscreenElement ? 'bi bi-fullscreen-exit' : 'bi bi-fullscreen';
    if (document.fullscreenElement) {
      const iframe = detail?.querySelector('.structures-frame');
      try { iframe?.contentWindow?.focus(); } catch {}
    }
  });

  // ── Deep linking ─────────────────────────────────────────────────────────────

  function handleHash() {
    const hash = location.hash.slice(1);
    if (!hash) return;
    const id = decodeURIComponent(hash);
    const s  = byId(id);
    if (!s) return;

    openPacks.add(s.datapack);
    const sidMap = packGroups.get(s.datapack);
    if (sidMap && (sidMap.get(s.structureId) || []).length > 1) openSubgroups.add(s.structureId);

    render();
    selectStructure(s);

    setTimeout(() => {
      const btn = groupList.querySelector(`.structures-item-btn[data-id="${CSS.escape(s.id)}"]`);
      btn?.scrollIntoView({ block: 'nearest' });
    }, 50);
  }

  // ── Search / clear ───────────────────────────────────────────────────────────

  searchInput?.addEventListener('input', () => render());

  clearBtn?.addEventListener('click', () => {
    if (searchInput?.value) searchInput.value = '';
    else activePack = 'All';
    render();
    searchInput?.focus();
  });

  // ── Mobile sidebar toggle ────────────────────────────────────────────────────

  sidebarToggle?.addEventListener('click', () => {
    const open = sidebarBody.classList.toggle('is-open');
    sidebarToggle.setAttribute('aria-expanded', String(open));
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────

  loadManifest();
})();
