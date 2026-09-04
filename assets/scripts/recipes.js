(() => {
  const MANIFEST_URL = '/recipes/data/recipes.manifest.json';

  const searchInput = document.getElementById('recipe-search');
  const clearBtn = document.getElementById('clear-recipe-search');
  const groupList = document.getElementById('recipes-group-list');
  const detail = document.getElementById('recipes-detail');
  const emptyState = document.getElementById('recipes-detail-empty');
  const quickFilters = document.getElementById('recipe-quick-filters');
  const sidebarToggle = document.getElementById('recipes-sidebar-toggle');
  const sidebarBody = document.getElementById('recipes-sidebar-body');

  if (!groupList || !detail) return;

  let recipes = [];
  // groups: Map<datapack, Map<type, entries[]>>
  let groups = new Map();
  let activeId = null;
  let activePack = 'All';
  let mdCache = new Map();
  let openGroups = new Set();      // open data-pack groups
  let openTypeGroups = new Set();  // open `${pack}::${type}` sub-groups

  // datapack-slug → Modrinth project slug, kept in sync with the same map in
  // generate-structure-web-viewers.js. Used to turn the data-pack chip above
  // each recipe title into a link to the project's Modrinth page.
  const MODRINTH_PROJECT_SLUGS = {
    a_realm_recrafted: 'a-realm-recrafted',
    enchantments_encore: 'enchantments-encore',
    fabled_roots: 'fabled-roots',
    katters_structures: 'katters-structures',
    nice_actions: 'nice-actions',
    nice_admin_tools: 'nice-admin-tools',
    nice_keep_inventory: 'nice-keep-inventory',
    nice_mob_manager: 'nice-mob-manager',
    nice_mob_variants: 'nice-mob-variants',
    nice_name_tags: 'nice-name-tags',
    nice_things: 'nice-things-eden',
    warping_wonders: 'warping-wonders'
  };
  function modrinthUrlFor(slug) {
    const m = MODRINTH_PROJECT_SLUGS[slug];
    return m ? `https://modrinth.com/datapack/${m}` : null;
  }

  // Older committed manifests still carry "Crafting — Shaped" with an em-dash;
  // newer regens emit "Crafting: Shaped". Normalise on display so the sidebar
  // looks consistent during the transition.
  function normalizeType(t) {
    if (!t) return 'Other';
    return String(t).replace(/\s*—\s*/g, ': ').trim();
  }

  function slugId(recipe) {
    return `${recipe.datapackSlug}__${recipe.namespace}__${recipe.recipePath}`.replace(/[^a-z0-9_]+/gi, '-');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadManifest() {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      recipes = await res.json();
    } catch (err) {
      groupList.innerHTML = `<li class="recipes-empty recipes-empty--error">Failed to load recipes: ${err.message}</li>`;
      return;
    }

    // Normalize types in place so sort/group lookups are consistent.
    for (const r of recipes) r.type = normalizeType(r.type);

    // Build nested grouping: datapack → type → entries
    groups = new Map();
    for (const r of recipes) {
      if (!groups.has(r.datapack)) groups.set(r.datapack, new Map());
      const typeMap = groups.get(r.datapack);
      if (!typeMap.has(r.type)) typeMap.set(r.type, []);
      typeMap.get(r.type).push(r);
    }

    // Default-open the first pack so the sidebar isn't empty on load.
    const firstPack = [...groups.keys()].sort((a, b) => a.localeCompare(b))[0];
    if (firstPack) openGroups.add(firstPack);

    groupList.setAttribute('aria-busy', 'false');
    render();
    handleHash();
    window.addEventListener('hashchange', handleHash);
  }

  function matches(recipe, query) {
    if (!query) return true;
    const haystack = [recipe.name, recipe.id, recipe.type, recipe.result, recipe.datapack, recipe.namespace, recipe.recipePath]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  }

  function searchMatched() {
    const q = (searchInput.value || '').trim().toLowerCase();
    return q ? recipes.filter(r => matches(r, q)) : recipes.slice();
  }

  function renderQuickFilters(visibleCountsByPack, totalMatched) {
    if (!quickFilters) return;
    const allPacks = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    const packs = ['All', ...allPacks];
    quickFilters.innerHTML = '';
    for (const pack of packs) {
      const button = document.createElement('button');
      button.type = 'button';
      const count = pack === 'All' ? totalMatched : (visibleCountsByPack.get(pack) || 0);
      button.className = 'filter-chip' + (pack === activePack ? ' is-active' : '');
      button.innerHTML = `<span>${escapeHtml(pack)}</span><strong>${count}</strong>`;
      if (count === 0 && pack !== 'All') {
        button.disabled = true;
        button.classList.add('is-empty');
      }
      button.addEventListener('click', () => {
        if (activePack === pack) return;
        activePack = pack;
        render();
      });
      quickFilters.appendChild(button);
    }
  }

  function render() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const matched = searchMatched();

    // Per-pack visible counts (BEFORE applying activePack filter, so chips
    // show how many results each pack has under the current search).
    const countsByPack = new Map();
    for (const r of matched) countsByPack.set(r.datapack, (countsByPack.get(r.datapack) || 0) + 1);

    // If the active pack has zero results under the new search, fall back to All
    // so the user isn't stuck on an empty filter.
    if (activePack !== 'All' && (countsByPack.get(activePack) || 0) === 0) {
      activePack = 'All';
    }

    renderQuickFilters(countsByPack, matched.length);

    const sortedPacks = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    const frag = document.createDocumentFragment();

    for (const pack of sortedPacks) {
      if (activePack !== 'All' && pack !== activePack) continue;
      const filteredEntries = (groups.get(pack) ? [...groups.get(pack).entries()] : [])
        .map(([type, entries]) => [type, entries.filter(r => matches(r, q))])
        .filter(([, entries]) => entries.length > 0)
        .sort((a, b) => a[0].localeCompare(b[0]));
      const packTotal = filteredEntries.reduce((sum, [, e]) => sum + e.length, 0);
      if (packTotal === 0) continue;

      const packIsOpen = q !== '' || openGroups.has(pack) || activePack === pack;

      const packLi = document.createElement('li');
      packLi.className = 'recipes-group' + (packIsOpen ? ' is-open' : '');

      const packHeader = document.createElement('button');
      packHeader.type = 'button';
      packHeader.className = 'recipes-group-header';
      packHeader.setAttribute('aria-expanded', String(packIsOpen));
      packHeader.innerHTML = `
        <i class="bi bi-chevron-right recipes-group-caret" aria-hidden="true"></i>
        <span class="recipes-group-name">${escapeHtml(pack)}</span>
        <span class="recipes-group-count">${packTotal}</span>
      `;
      packHeader.addEventListener('click', () => {
        if (openGroups.has(pack)) openGroups.delete(pack);
        else openGroups.add(pack);
        render();
      });

      const typesUl = document.createElement('ul');
      typesUl.className = 'recipes-types-list';

      for (const [type, entries] of filteredEntries) {
        const typeKey = `${pack}::${type}`;
        // Auto-expand types when there's an active search OR only one type in the pack.
        const typeIsOpen = q !== '' || openTypeGroups.has(typeKey) || filteredEntries.length === 1;

        const typeLi = document.createElement('li');
        typeLi.className = 'recipes-type' + (typeIsOpen ? ' is-open' : '');

        const typeHeader = document.createElement('button');
        typeHeader.type = 'button';
        typeHeader.className = 'recipes-type-header';
        typeHeader.setAttribute('aria-expanded', String(typeIsOpen));
        typeHeader.innerHTML = `
          <i class="bi bi-chevron-right recipes-type-caret" aria-hidden="true"></i>
          <span class="recipes-type-name">${escapeHtml(type)}</span>
          <span class="recipes-type-count">${entries.length}</span>
        `;
        typeHeader.addEventListener('click', () => {
          if (openTypeGroups.has(typeKey)) openTypeGroups.delete(typeKey);
          else openTypeGroups.add(typeKey);
          render();
        });

        const itemsUl = document.createElement('ul');
        itemsUl.className = 'recipes-group-items';

        for (const r of entries) {
          const item = document.createElement('li');
          item.className = 'recipes-item' + (activeId === slugId(r) ? ' is-active' : '');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'recipes-item-btn';
          btn.dataset.id = slugId(r);
          btn.innerHTML = `<span class="recipes-item-name">${escapeHtml(r.name || r.recipePath)}</span>`;
          btn.addEventListener('click', () => selectRecipe(r));
          item.appendChild(btn);
          itemsUl.appendChild(item);
        }

        typeLi.appendChild(typeHeader);
        typeLi.appendChild(itemsUl);
        typesUl.appendChild(typeLi);
      }

      packLi.appendChild(packHeader);
      packLi.appendChild(typesUl);
      frag.appendChild(packLi);
    }

    groupList.innerHTML = '';
    if (!frag.children.length) {
      groupList.innerHTML = '<li class="recipes-empty">No recipes match your search.</li>';
    } else {
      groupList.appendChild(frag);
    }

    if (clearBtn) clearBtn.style.display = (q || activePack !== 'All') ? 'block' : 'none';
  }

  // Lightweight MD → HTML. The generator's recipe markdown is well-formed, so
  // we just need to handle: H2/H3 headings, bulleted lists, paragraphs,
  // **bold**, `code`, and pass through raw <table> / <details> blocks verbatim.
  function renderMdToHtml(md) {
    let text = md;
    text = text.replace(/^#\s+.+\n+/m, '');
    text = text.replace(/^\*\*Type:\*\*.+$\n?/m, '');
    text = text.replace(/^\*\*Recipe ID:\*\*.+$\n?/m, '');
    text = text.replace(/^\*\*Result:\*\*.+$\n?/m, '');
    // Older MDs still ship a "**Group:** ..." line. The generator no longer
    // emits it, but strip it client-side so the transition period doesn't
    // leak the line into the rendered detail body.
    text = text.replace(/^\*\*Group:\*\*.+$\n?/m, '');

    const lines = text.split(/\r?\n/);
    const out = [];
    let inList = false;
    let inTable = false; // tables are emitted verbatim — their cell content is literal

    function closeList() { if (inList) { out.push('</ul>'); inList = false; } }

    for (const line of lines) {
      const trimmed = line.trim();

      // <details>/<summary> wrap MD content that still needs list rendering, so
      // we pass the tags through but keep processing the body. Tables are
      // different — cells are literal text — so once we open one we just echo
      // everything until </table>.
      if (/^<table\b/i.test(trimmed)) { closeList(); inTable = true; out.push(line); continue; }
      if (inTable) { out.push(line); if (/^<\/table>/i.test(trimmed)) inTable = false; continue; }
      if (/^<\/?(details|summary)\b/i.test(trimmed)) { closeList(); out.push(line); continue; }

      if (!trimmed) { closeList(); out.push(''); continue; }

      let m = trimmed.match(/^##\s+(.+)$/);
      if (m) { closeList(); out.push(`<h3>${escapeHtml(m[1])}</h3>`); continue; }
      m = trimmed.match(/^###\s+(.+)$/);
      if (m) { closeList(); out.push(`<h4>${escapeHtml(m[1])}</h4>`); continue; }

      if (/^[-*]\s+/.test(trimmed)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${renderInline(trimmed.replace(/^[-*]\s+/, ''))}</li>`);
        continue;
      }

      closeList();
      out.push(`<p>${renderInline(trimmed)}</p>`);
    }
    closeList();
    return out.join('\n');
  }

  function renderInline(s) {
    let text = escapeHtml(s);
    text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    text = text.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
    return text;
  }

  async function fetchMd(recipe) {
    if (mdCache.has(recipe.mdUrl)) return mdCache.get(recipe.mdUrl);
    try {
      const res = await fetch(recipe.mdUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      mdCache.set(recipe.mdUrl, text);
      return text;
    } catch (err) {
      return `# ${recipe.name}\n\n*Recipe details could not be loaded: ${err.message}*\n`;
    }
  }

  async function selectRecipe(recipe) {
    activeId = slugId(recipe);
    // Pin to /recipes/ explicitly so the copied URL always lands on this
    // page — relying on the current path meant some browsers stripped or
    // resolved it to /#…, which dumped visitors on the home page.
    history.replaceState(null, '', `/recipes/#${encodeURIComponent(recipe.datapackSlug)}/${encodeURIComponent(recipe.namespace)}/${encodeURIComponent(recipe.recipePath)}`);

    groupList.querySelectorAll('.recipes-item').forEach(li => {
      li.classList.toggle('is-active', li.querySelector('.recipes-item-btn')?.dataset.id === activeId);
    });

    const type = normalizeType(recipe.type);

    detail.innerHTML = `
      <header class="recipes-detail-head">
        ${(() => {
          const url = modrinthUrlFor(recipe.datapackSlug);
          return url
            ? `<a class="recipes-detail-pack" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="View ${escapeHtml(recipe.datapack)} on Modrinth">${escapeHtml(recipe.datapack)}</a>`
            : `<div class="recipes-detail-pack">${escapeHtml(recipe.datapack)}</div>`;
        })()}
        <h2 class="recipes-detail-name">${escapeHtml(recipe.name || recipe.recipePath)}</h2>
        ${recipe.id ? `<button class="recipes-copy-id" type="button" data-copy="${escapeHtml(recipe.id)}" title="Click to copy"><code>${escapeHtml(recipe.id)}</code></button>` : ''}
      </header>
      <div class="recipes-detail-grid">
        <div class="recipes-detail-image-wrap">
          ${recipe.imageUrl
            ? `<img class="recipes-detail-image" src="${escapeHtml(recipe.imageUrl)}" alt="${escapeHtml(recipe.name || '')} recipe image" loading="lazy">`
            : '<div class="recipes-detail-noimage">No recipe image available.</div>'}
        </div>
        <div class="recipes-detail-body" id="recipes-detail-body">
          <p class="recipes-detail-loading">Loading recipe…</p>
        </div>
      </div>
    `;
    if (emptyState) emptyState.remove();

    // Wire copy-on-click for the recipe ID.
    const copyBtn = detail.querySelector('.recipes-copy-id');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const v = copyBtn.dataset.copy || '';
        try {
          await navigator.clipboard.writeText(v);
          const codeEl = copyBtn.querySelector('code');
          const orig = codeEl.textContent;
          codeEl.textContent = 'Copied!';
          copyBtn.classList.add('is-copied');
          setTimeout(() => {
            codeEl.textContent = orig;
            copyBtn.classList.remove('is-copied');
          }, 1100);
        } catch { /* clipboard unavailable */ }
      });
    }

    const md = await fetchMd(recipe);
    const body = document.getElementById('recipes-detail-body');
    if (body) body.innerHTML = renderMdToHtml(md);

    if (window.matchMedia('(max-width: 900px)').matches) {
      sidebarBody?.classList.remove('is-open');
      sidebarToggle?.setAttribute('aria-expanded', 'false');
    }
  }

  function handleHash() {
    const h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    const parts = h.split('/').map(decodeURIComponent);
    if (parts.length < 3) return;
    const [slug, ns, ...rest] = parts;
    const recipePath = rest.join('/');
    const r = recipes.find(x => x.datapackSlug === slug && x.namespace === ns && x.recipePath === recipePath);
    if (r) {
      openGroups.add(r.datapack);
      openTypeGroups.add(`${r.datapack}::${normalizeType(r.type)}`);
      render();
      selectRecipe(r);
    }
  }

  searchInput?.addEventListener('input', render);
  clearBtn?.addEventListener('click', () => {
    if (searchInput.value || activePack !== 'All') {
      searchInput.value = '';
      activePack = 'All';
      render();
      searchInput.focus();
    }
  });

  sidebarToggle?.addEventListener('click', () => {
    const open = sidebarBody?.classList.toggle('is-open');
    sidebarToggle.setAttribute('aria-expanded', String(!!open));
  });

  loadManifest();
})();
