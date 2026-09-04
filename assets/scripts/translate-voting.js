(function () {
  const page = document.querySelector('.translate-page');
  if (!page) return;

  const landing = document.getElementById('translate-voting-landing');
  const detail = document.getElementById('translate-voting-detail');
  const detailTitle = document.getElementById('translate-voting-title');
  const detailStatus = document.getElementById('translate-voting-status');
  const list = document.getElementById('translate-voting-list');
  const searchInput = document.getElementById('translate-voting-search-input');
  const clearButton = document.getElementById('translate-voting-clear-search');
  const resultsCount = document.getElementById('translate-voting-results-count');

  const activeDatapack = page.dataset.activeDatapack || '';

  let me = { loggedIn: false };
  let pendingTtlDays = 31;
  let acceptThreshold = 5;
  let allSuggestions = [];

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const debounce = (fn, delay = 150) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  async function fetchJson(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.message || `Request failed: ${response.status}`);
    }
    return data;
  }

  // Postgres returns timestamps like "2026-08-21 13:28:17.815505+02" - a
  // space separator and a 2-digit UTC offset are both outside what the
  // ECMA-262 Date Time String Format guarantees browsers must parse, so
  // Safari can silently return an Invalid Date for it. Normalize to a
  // strict ISO 8601 string before handing it to `new Date()`.
  function parseServerDate(dateStr) {
    const iso = String(dateStr).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    return new Date(iso);
  }

  function timeRemainingLabel(createdAt) {
    const deadline = parseServerDate(createdAt).getTime() + pendingTtlDays * 24 * 60 * 60 * 1000;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return 'resolving soon';
    const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    return days === 1 ? 'auto-resolves in 1 day' : `auto-resolves in ${days} days`;
  }

  function relativeTimeLabel(dateStr) {
    const diffMs = Date.now() - parseServerDate(dateStr).getTime();
    const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (days <= 0) return 'today';
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  }

  function votesNeededLabel(netScore) {
    const remaining = acceptThreshold - netScore;
    if (remaining <= 0) return null;
    return remaining === 1 ? '1 more vote to accept' : `${remaining} more votes to accept`;
  }

  function renderLanding(datapacks) {
    if (!datapacks.length) {
      landing.innerHTML = '<p class="translate-empty">No translatable data packs found yet.</p>';
      return;
    }

    landing.innerHTML = datapacks.map((dp) => {
      const openLocales = [...dp.locales]
        .filter((l) => l.openCount > 0)
        .sort((a, b) => b.openCount - a.openCount)
        .slice(0, 10);
      const localesHtml = openLocales.length
        ? `
          <ul class="translate-card__locales translate-card__locales--voting">
            ${openLocales.map((l) => `
              <li>
                <span class="translate-card__locale-name">${esc(l.nativeName)}</span>
                <span class="translate-card__locale-pct">${l.openCount} open</span>
              </li>
            `).join('')}
          </ul>
        `
        : '<p class="translate-card__empty">Nothing open right now.</p>';
      return `
        <a class="translate-card" href="/translate/voting/?datapack=${encodeURIComponent(dp.slug)}">
          <div class="translate-card__header">
            <h3>${esc(dp.displayName)}</h3>
            <span class="translate-card__overall">${dp.totalOpen} open</span>
          </div>
          ${localesHtml}
        </a>
      `;
    }).join('');
  }

  async function loadLanding() {
    try {
      const data = await fetchJson('/translate/api/voting-progress.php');
      renderLanding(data.datapacks);
    } catch (err) {
      landing.innerHTML = `<p class="translate-empty">Failed to load data packs: ${esc(err.message)}</p>`;
    }
  }

  function matchesQuery(s, query) {
    if (!query) return true;
    return [s.sourceText, s.body, s.localeName, s.author, s.keyPath].filter(Boolean).join(' ').toLowerCase().includes(query);
  }

  function isAdmin() {
    return me.loggedIn && me.user.role === 'admin';
  }

  function suggestionRowHtml(s) {
    const canDelete = s.isMine || isAdmin();
    const deleteEndpoint = s.isMine ? '/translate/api/withdraw.php' : '/translate/api/admin-delete-suggestion.php';
    const deleteBtn = canDelete
      ? `<button type="button" class="translate-suggestion__delete" data-suggestion-id="${s.id}" data-delete-endpoint="${esc(deleteEndpoint)}" title="Delete this suggestion"><i class="bi bi-trash3" aria-hidden="true"></i></button>`
      : '';
    const voteDisabled = !me.loggedIn ? 'disabled title="Log in to vote"' : '';
    const upActive = s.myVote === 1 ? 'is-active' : '';
    const downActive = s.myVote === -1 ? 'is-active' : '';

    return `
      <tr class="translate-row" data-suggestion-id="${s.id}">
        <td class="translate-suggestions-table__source">
          <span class="translate-row__text">${esc(s.sourceText)}</span>
          <code class="translate-row__path">${esc(s.keyPath)} · ${esc(s.localeName)}</code>
        </td>
        <td class="translate-suggestions-table__body">
          ${esc(s.body)}
          <span class="translate-row__time-left">${timeRemainingLabel(s.createdAt)}</span>
          ${votesNeededLabel(s.netScore) ? `<span class="translate-row__votes-needed">${votesNeededLabel(s.netScore)}</span>` : ''}
        </td>
        <td class="translate-suggestions-table__author">${esc(s.author)}${s.isSystem ? ' <span class="translate-vote-none">(system)</span>' : ''}<br><span class="translate-vote-none">${relativeTimeLabel(s.createdAt)}</span></td>
        <td class="translate-suggestions-table__votes">
          <div class="translate-suggestion__votes translate-suggestion__votes--table" data-suggestion-id="${s.id}">
            <button type="button" class="translate-vote-btn translate-vote-btn--up ${upActive}" data-value="1" ${voteDisabled}><i class="bi bi-caret-up-fill"></i></button>
            <span class="translate-suggestion__score">${s.netScore}</span>
            <button type="button" class="translate-vote-btn translate-vote-btn--down ${downActive}" data-value="-1" ${voteDisabled}><i class="bi bi-caret-down-fill"></i></button>
          </div>
          ${deleteBtn}
        </td>
      </tr>
    `;
  }

  async function withdrawSuggestion(suggestionId, endpoint) {
    if (!confirm('Delete this suggestion? This can\'t be undone.')) return false;
    try {
      await fetchJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken || '' },
        body: JSON.stringify({ suggestion_id: suggestionId }),
      });
      return true;
    } catch (err) {
      alert(err.message);
      return false;
    }
  }

  function renderTable() {
    const query = searchInput.value.trim().toLowerCase();
    clearButton.style.display = query ? 'block' : 'none';
    const filtered = allSuggestions.filter((s) => matchesQuery(s, query));

    if (!filtered.length) {
      list.innerHTML = '';
      resultsCount.textContent = query ? '0 of ' + allSuggestions.length + ' suggestions' : '0 suggestions';
      detailStatus.hidden = false;
      detailStatus.textContent = allSuggestions.length ? 'No suggestions match your search.' : 'No open suggestions for this data pack right now.';
      return;
    }

    detailStatus.hidden = true;
    resultsCount.textContent = query ? `${filtered.length} of ${allSuggestions.length} suggestions` : `${allSuggestions.length} suggestions`;

    list.innerHTML = `
      <div class="table-card translate-table-card">
        <div class="table-scroll">
          <table class="translate-suggestions-table">
            <thead>
              <tr>
                <th class="translate-suggestions-table__source">Source (English)</th>
                <th class="translate-suggestions-table__body">Suggestion</th>
                <th class="translate-suggestions-table__author">By</th>
                <th class="translate-suggestions-table__votes">Votes</th>
              </tr>
            </thead>
            <tbody>${filtered.map(suggestionRowHtml).join('')}</tbody>
          </table>
        </div>
      </div>
    `;

    list.querySelectorAll('.translate-suggestion__delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (await withdrawSuggestion(Number(btn.dataset.suggestionId), btn.dataset.deleteEndpoint)) loadDetail();
      });
    });
    list.querySelectorAll('.translate-suggestion__votes--table .translate-vote-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const suggestionId = Number(btn.closest('.translate-suggestion__votes--table').dataset.suggestionId);
        const value = Number(btn.dataset.value);
        try {
          await fetchJson('/translate/api/vote.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken || '' },
            body: JSON.stringify({ suggestion_id: suggestionId, value }),
          });
          loadDetail();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  async function loadDetail() {
    detailStatus.hidden = false;
    detailStatus.textContent = 'Loading open suggestions…';
    list.innerHTML = '';
    resultsCount.textContent = '';
    try {
      const data = await fetchJson(`/translate/api/voting-suggestions.php?datapack=${encodeURIComponent(activeDatapack)}`);
      allSuggestions = data.suggestions;
      pendingTtlDays = data.pendingTtlDays || pendingTtlDays;
      acceptThreshold = data.acceptThreshold || acceptThreshold;
      detailTitle.textContent = data.datapackName || activeDatapack;
      renderTable();
    } catch (err) {
      detailStatus.textContent = `Failed to load suggestions: ${err.message}`;
    }
  }

  searchInput.addEventListener('input', debounce(renderTable));
  clearButton.addEventListener('click', () => {
    searchInput.value = '';
    renderTable();
    searchInput.focus();
  });

  async function init() {
    try {
      me = await fetchJson('/translate/api/me.php');
    } catch {
      me = { loggedIn: false };
    }

    const discordNotice = document.getElementById('translate-discord-notice');
    if (discordNotice) discordNotice.hidden = me.loggedIn;

    if (activeDatapack) {
      landing.hidden = true;
      detail.hidden = false;
      // Datapack display name isn't known until the suggestions load; fall
      // back to the slug immediately so the heading isn't empty.
      detailTitle.textContent = activeDatapack;
      loadDetail();
    } else {
      loadLanding();
    }
  }

  init();
})();
