(function () {
  const page = document.querySelector('.translate-page');
  if (!page) return;

  const landing = document.getElementById('translate-landing');
  const detail = document.getElementById('translate-detail');
  const detailTitle = document.getElementById('translate-detail-title');
  const detailStatus = document.getElementById('translate-detail-status');
  const localeSelect = document.getElementById('translate-locale-select');
  const stringsBox = document.getElementById('translate-strings');
  const searchInput = document.getElementById('translate-search-input');
  const clearButton = document.getElementById('clear-search');
  const resultsCount = document.getElementById('translate-results-count');

  const modal = document.getElementById('translate-suggestions-modal');
  const modalTitle = document.getElementById('translate-modal-title');
  const modalSource = document.getElementById('translate-modal-source');
  const modalList = document.getElementById('translate-modal-list');
  const modalClose = document.getElementById('translate-modal-close');

  const mineSection = document.getElementById('translate-mine');
  const mineStatus = document.getElementById('translate-mine-status');
  const mineList = document.getElementById('translate-mine-list');
  const mineSearchInput = document.getElementById('translate-mine-search-input');
  const mineClearButton = document.getElementById('translate-mine-clear-search');
  const mineResultsCount = document.getElementById('translate-mine-results-count');

  const bulkBar = document.getElementById('translate-bulk-bar');
  const bulkCount = document.getElementById('translate-bulk-count');
  const bulkCancel = document.getElementById('translate-bulk-cancel');
  const bulkSubmit = document.getElementById('translate-bulk-submit');

  const activeDatapack = page.dataset.activeDatapack || '';
  const showMine = Boolean(page.dataset.showMine);

  let me = { loggedIn: false };
  let progressData = { datapacks: [] };
  let allKeys = [];
  let pendingTtlDays = 7;
  let acceptThreshold = 5;
  let openModalKeyId = null;
  const stagedSuggestions = new Map(); // keyId -> body text, not yet submitted

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


  function progressBarHtml(percent) {
    const pct = Math.max(0, Math.min(100, percent));
    return `
      <div class="translate-progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="translate-progress-bar__fill" style="width:${pct}%"></div>
      </div>
    `;
  }

  function renderLanding() {
    if (!progressData.datapacks.length) {
      landing.innerHTML = '<p class="translate-empty">No translatable data packs found yet.</p>';
      return;
    }

    landing.innerHTML = progressData.datapacks.map((dp) => {
      const localesWithProgress = dp.locales.filter((l) => l.total > 0);
      const overall = localesWithProgress.length
        ? localesWithProgress.reduce((sum, l) => sum + l.percent, 0) / localesWithProgress.length
        : 0;
      const topLocales = [...dp.locales].sort((a, b) => b.percent - a.percent).slice(0, 10);

      return `
        <a class="translate-card" href="/translate/?datapack=${encodeURIComponent(dp.slug)}">
          <div class="translate-card__header">
            <h3>${esc(dp.displayName)}</h3>
            <span class="translate-card__overall">${overall.toFixed(0)}% avg</span>
          </div>
          <p class="translate-card__meta">${dp.totalKeys} translatable string${dp.totalKeys === 1 ? '' : 's'}</p>
          <ul class="translate-card__locales">
            ${topLocales.map((l) => `
              <li>
                <span class="translate-card__locale-name">${esc(l.nativeName)}</span>
                ${progressBarHtml(l.percent)}
                <span class="translate-card__locale-pct">${l.percent}%</span>
              </li>
            `).join('')}
          </ul>
        </a>
      `;
    }).join('');
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

  function keyRowHtml(key) {
    const pendingCount = key.pendingSuggestions.length;
    const currentHtml = key.accepted
      ? `${esc(key.accepted.body)}${key.accepted.possiblyOutdated ? '<i class="bi bi-exclamation-triangle-fill translate-row__outdated" title="The English source text has changed since this was submitted"></i>' : ''}`
      : '<span class="translate-row__empty">No translation yet</span>';
    const suggestionsBtn = pendingCount
      ? `<button type="button" class="translate-suggestions-btn" data-key-id="${key.id}">${pendingCount} pending <i class="bi bi-chat-square-text" aria-hidden="true"></i></button>`
      : '<span class="translate-vote-none">No suggestions</span>';
    const staged = stagedSuggestions.get(key.id) || '';

    return `
      <tr class="translate-row ${staged ? 'translate-row--staged' : ''}" data-key-id="${key.id}">
        <td class="translate-row__source">
          <span class="translate-row__text">${esc(key.sourceText)}</span>
          <code class="translate-row__path">${esc(key.keyPath)}</code>
        </td>
        <td class="translate-row__current">${currentHtml}</td>
        <td class="translate-row__actions">
          <form class="translate-suggest-form" data-key-id="${key.id}">
            <input type="text" name="body" placeholder="Suggest a translation…" maxlength="2000" value="${esc(staged)}" ${me.loggedIn ? '' : 'disabled'}>
          </form>
        </td>
        <td class="translate-row__suggestions">${suggestionsBtn}</td>
      </tr>
    `;
  }

  function modalSuggestionHtml(suggestion) {
    if (suggestion.status === 'accepted') {
      return `
        <div class="translate-suggestion translate-suggestion--accepted">
          <span class="translate-vote-badge" title="Current accepted translation">
            <i class="bi bi-check-circle-fill" aria-hidden="true"></i> ${suggestion.netScore}
          </span>
          <div class="translate-suggestion__body">
            <p class="translate-suggestion__text">${esc(suggestion.body)}</p>
            <p class="translate-suggestion__meta">Current translation · by ${esc(suggestion.author)} · ${relativeTimeLabel(suggestion.createdAt)}</p>
          </div>
        </div>
      `;
    }

    const voteDisabled = !me.loggedIn ? 'disabled title="Log in to vote"' : '';
    const upActive = suggestion.myVote === 1 ? 'is-active' : '';
    const downActive = suggestion.myVote === -1 ? 'is-active' : '';
    const deleteBtn = suggestion.isMine
      ? `<button type="button" class="translate-suggestion__delete" data-suggestion-id="${suggestion.id}" title="Delete your suggestion"><i class="bi bi-trash3" aria-hidden="true"></i></button>`
      : '';

    return `
      <div class="translate-suggestion" data-suggestion-id="${suggestion.id}">
        <div class="translate-suggestion__votes">
          <button type="button" class="translate-vote-btn translate-vote-btn--up ${upActive}" data-value="1" ${voteDisabled}><i class="bi bi-caret-up-fill"></i></button>
          <span class="translate-suggestion__score">${suggestion.netScore}</span>
          <button type="button" class="translate-vote-btn translate-vote-btn--down ${downActive}" data-value="-1" ${voteDisabled}><i class="bi bi-caret-down-fill"></i></button>
        </div>
        <div class="translate-suggestion__body">
          <p class="translate-suggestion__text">${esc(suggestion.body)}</p>
          <p class="translate-suggestion__meta">by ${esc(suggestion.author)} · ${relativeTimeLabel(suggestion.createdAt)} · ${timeRemainingLabel(suggestion.createdAt)}${votesNeededLabel(suggestion.netScore) ? ` · ${votesNeededLabel(suggestion.netScore)}` : ''}</p>
        </div>
        ${deleteBtn}
      </div>
    `;
  }

  async function withdrawSuggestion(suggestionId, endpoint = '/translate/api/withdraw.php') {
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

  function renderModalContent(key) {
    modalTitle.textContent = key.keyPath;
    modalSource.textContent = key.sourceText;
    const all = key.accepted ? [key.accepted, ...key.pendingSuggestions] : key.pendingSuggestions;
    modalList.innerHTML = all.length
      ? all.map(modalSuggestionHtml).join('')
      : '<p class="translate-empty translate-empty--inline">No suggestions.</p>';
    attachModalHandlers();
  }

  function openModal(keyId) {
    const key = allKeys.find((k) => k.id === keyId);
    if (!key) return;
    openModalKeyId = keyId;
    renderModalContent(key);
    if (!modal.open) modal.showModal();
  }

  function matchesQuery(key, query) {
    if (!query) return true;
    const haystack = [
      key.sourceText,
      key.keyPath,
      key.accepted?.body,
      ...key.pendingSuggestions.map((s) => s.body),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  }

  function compareKeys(a, b) {
    const aPending = a.pendingSuggestions.length > 0;
    const bPending = b.pendingSuggestions.length > 0;
    if (aPending !== bPending) return aPending ? -1 : 1;
    return a.sourceText.localeCompare(b.sourceText);
  }

  function renderTable() {
    const query = searchInput.value.trim().toLowerCase();
    clearButton.style.display = query ? 'block' : 'none';

    const filtered = allKeys.filter((key) => matchesQuery(key, query)).sort(compareKeys);

    if (!filtered.length) {
      stringsBox.innerHTML = '';
      resultsCount.textContent = query ? '0 of ' + allKeys.length + ' strings' : '0 strings';
      detailStatus.hidden = false;
      detailStatus.textContent = allKeys.length ? 'No strings match your search.' : 'No translatable strings found for this data pack.';
      return;
    }

    detailStatus.hidden = true;
    resultsCount.textContent = query ? `${filtered.length} of ${allKeys.length} strings` : `${allKeys.length} strings`;

    stringsBox.innerHTML = `
      <div class="table-card translate-table-card">
        <div class="table-scroll">
          <table class="translate-table">
            <thead>
              <tr>
                <th>Source (English)</th>
                <th>Current Translation</th>
                <th>Suggest new</th>
                <th>Suggestions</th>
              </tr>
            </thead>
            <tbody>${filtered.map(keyRowHtml).join('')}</tbody>
          </table>
        </div>
      </div>
    `;
    attachDetailHandlers();
  }

  function updateBulkBar() {
    const count = stagedSuggestions.size;
    bulkBar.hidden = count === 0;
    bulkCount.textContent = count === 1 ? '1 suggestion ready' : `${count} suggestions ready`;
  }

  function stageSuggestion(keyId, body, rowEl) {
    if (body) {
      stagedSuggestions.set(keyId, body);
      rowEl?.classList.add('translate-row--staged');
    } else {
      stagedSuggestions.delete(keyId);
      rowEl?.classList.remove('translate-row--staged');
    }
    updateBulkBar();
  }

  function attachDetailHandlers() {
    stringsBox.querySelectorAll('.translate-suggestions-btn').forEach((btn) => {
      btn.addEventListener('click', () => openModal(Number(btn.dataset.keyId)));
    });

    stringsBox.querySelectorAll('.translate-suggest-form').forEach((form) => {
      const keyId = Number(form.dataset.keyId);
      const input = form.querySelector('input');
      const row = form.closest('.translate-row');

      input.addEventListener('input', () => {
        stageSuggestion(keyId, input.value.trim(), row);
      });

      // Enter implicitly submits a single-input form even with no button -
      // treat that as "done editing this row" rather than actually posting.
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        input.blur();
      });
    });
  }

  function attachModalHandlers() {
    modalList.querySelectorAll('.translate-vote-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const suggestionId = Number(btn.closest('.translate-suggestion').dataset.suggestionId);
        const value = Number(btn.dataset.value);
        try {
          await fetchJson('/translate/api/vote.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken || '' },
            body: JSON.stringify({ suggestion_id: suggestionId, value }),
          });
          const keyId = openModalKeyId;
          await loadStrings();
          openModal(keyId);
        } catch (err) {
          alert(err.message);
        }
      });
    });

    modalList.querySelectorAll('.translate-suggestion__delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const suggestionId = Number(btn.dataset.suggestionId);
        const keyId = openModalKeyId;
        if (await withdrawSuggestion(suggestionId)) {
          await loadStrings();
          openModal(keyId);
        }
      });
    });
  }

  const STATUS_LABELS = {
    pending: 'Pending',
    accepted: 'Accepted',
    declined: 'Declined',
    withdrawn: 'Deleted',
    superseded: 'Replaced by a newer suggestion',
  };

  // Shared between "My Suggestions" and the Voting per-datapack tables. Uses
  // semantic per-column classes (not nth-child) so the extra "By" column
  // Voting adds can't throw off widths meant for the 4-column case.
  function suggestionRowHtml(s, { showAuthor, canDeleteFn, deleteEndpointFn, interactiveVotes, showTimeRemaining }) {
    const canDelete = s.status === 'pending' && canDeleteFn(s);
    const deleteBtn = canDelete
      ? `<button type="button" class="translate-suggestion__delete" data-suggestion-id="${s.id}" data-delete-endpoint="${esc(deleteEndpointFn(s))}" title="Delete this suggestion"><i class="bi bi-trash3" aria-hidden="true"></i></button>`
      : '';
    const authorCell = showAuthor
      ? `<td class="translate-suggestions-table__author">${esc(s.author)}${s.isSystem ? ' <span class="translate-vote-none">(system)</span>' : ''}</td>`
      : '';

    let votesHtml = '';
    if (s.status === 'pending' && interactiveVotes) {
      const voteDisabled = !me.loggedIn ? 'disabled title="Log in to vote"' : '';
      const upActive = s.myVote === 1 ? 'is-active' : '';
      const downActive = s.myVote === -1 ? 'is-active' : '';
      votesHtml = `
        <div class="translate-suggestion__votes translate-suggestion__votes--table" data-suggestion-id="${s.id}">
          <button type="button" class="translate-vote-btn translate-vote-btn--up ${upActive}" data-value="1" ${voteDisabled}><i class="bi bi-caret-up-fill"></i></button>
          <span class="translate-suggestion__score">${s.netScore}</span>
          <button type="button" class="translate-vote-btn translate-vote-btn--down ${downActive}" data-value="-1" ${voteDisabled}><i class="bi bi-caret-down-fill"></i></button>
        </div>
      `;
    } else if (s.status === 'pending') {
      votesHtml = `<span class="translate-suggestion__score">${s.netScore} votes</span>`;
    }

    const timeRemainingHtml = (s.status === 'pending' && showTimeRemaining)
      ? `<span class="translate-row__time-left">${timeRemainingLabel(s.createdAt)}</span>`
      : '';
    const votesNeeded = s.status === 'pending' ? votesNeededLabel(s.netScore) : null;
    const votesNeededHtml = votesNeeded ? `<span class="translate-row__votes-needed">${votesNeeded}</span>` : '';

    return `
      <tr class="translate-row" data-suggestion-id="${s.id}">
        <td class="translate-suggestions-table__source">
          <span class="translate-row__text">${esc(s.sourceText)}</span>
          <code class="translate-row__path">${esc(s.datapackName)} · ${esc(s.localeName)}</code>
        </td>
        <td class="translate-suggestions-table__body">${esc(s.body)}${timeRemainingHtml}${votesNeededHtml}</td>
        ${authorCell}
        <td class="translate-suggestions-table__status">
          <span class="translate-mine-status translate-mine-status--${s.status}">${STATUS_LABELS[s.status] || s.status}</span>
        </td>
        <td class="translate-suggestions-table__votes">
          ${votesHtml}
          ${deleteBtn}
        </td>
      </tr>
    `;
  }

  function renderSuggestionsTable(container, list, { showAuthor, canDeleteFn, deleteEndpointFn, interactiveVotes = false, showTimeRemaining = false, onReload }) {
    const headerCols = [
      ['translate-suggestions-table__source', 'Source (English)'],
      ['translate-suggestions-table__body', showAuthor ? 'Suggestion' : 'Your suggestion'],
      showAuthor ? ['translate-suggestions-table__author', 'By'] : null,
      ['translate-suggestions-table__status', 'Status'],
      ['translate-suggestions-table__votes', 'Votes'],
    ].filter(Boolean);
    container.innerHTML = `
      <div class="table-card translate-table-card">
        <div class="table-scroll">
          <table class="translate-suggestions-table">
            <thead><tr>${headerCols.map(([cls, label]) => `<th class="${cls}">${label}</th>`).join('')}</tr></thead>
            <tbody>${list.map((s) => suggestionRowHtml(s, { showAuthor, canDeleteFn, deleteEndpointFn, interactiveVotes, showTimeRemaining })).join('')}</tbody>
          </table>
        </div>
      </div>
    `;
    container.querySelectorAll('.translate-suggestion__delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (await withdrawSuggestion(Number(btn.dataset.suggestionId), btn.dataset.deleteEndpoint)) onReload();
      });
    });
    if (interactiveVotes) {
      container.querySelectorAll('.translate-suggestion__votes--table .translate-vote-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const suggestionId = Number(btn.closest('.translate-suggestion__votes--table').dataset.suggestionId);
          const value = Number(btn.dataset.value);
          try {
            await fetchJson('/translate/api/vote.php', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken || '' },
              body: JSON.stringify({ suggestion_id: suggestionId, value }),
            });
            onReload();
          } catch (err) {
            alert(err.message);
          }
        });
      });
    }
  }

  function matchesSuggestionQuery(s, query) {
    if (!query) return true;
    return [s.sourceText, s.body, s.datapackName, s.localeName, s.author, s.keyPath]
      .filter(Boolean).join(' ').toLowerCase().includes(query);
  }

  let allMineSuggestions = [];

  function renderMineTable() {
    const query = mineSearchInput.value.trim().toLowerCase();
    mineClearButton.style.display = query ? 'block' : 'none';
    const filtered = allMineSuggestions.filter((s) => matchesSuggestionQuery(s, query));

    if (!filtered.length) {
      mineList.innerHTML = '';
      mineResultsCount.textContent = query ? '0 of ' + allMineSuggestions.length + ' suggestions' : '0 suggestions';
      mineStatus.hidden = false;
      mineStatus.textContent = allMineSuggestions.length
        ? 'No suggestions match your search.'
        : "You haven't submitted any suggestions yet.";
      return;
    }
    mineStatus.hidden = true;
    mineResultsCount.textContent = query ? `${filtered.length} of ${allMineSuggestions.length} suggestions` : `${allMineSuggestions.length} suggestions`;

    renderSuggestionsTable(mineList, filtered, {
      showAuthor: false,
      canDeleteFn: () => true,
      deleteEndpointFn: () => '/translate/api/withdraw.php',
      showTimeRemaining: true,
      onReload: loadMine,
    });
  }

  async function loadMine() {
    mineStatus.hidden = false;
    mineStatus.textContent = 'Loading your suggestions…';
    mineList.innerHTML = '';
    mineResultsCount.textContent = '';
    try {
      const data = await fetchJson('/translate/api/my-suggestions.php');
      allMineSuggestions = data.suggestions;
      pendingTtlDays = data.pendingTtlDays || pendingTtlDays;
      acceptThreshold = data.acceptThreshold || acceptThreshold;
      renderMineTable();
    } catch (err) {
      mineStatus.textContent = `Failed to load your suggestions: ${err.message}`;
    }
  }


  async function loadStrings() {
    detailStatus.hidden = false;
    detailStatus.textContent = 'Loading strings…';
    stringsBox.innerHTML = '';
    resultsCount.textContent = '';
    try {
      const url = `/translate/api/strings.php?datapack=${encodeURIComponent(activeDatapack)}&locale=${encodeURIComponent(localeSelect.value)}`;
      const data = await fetchJson(url);
      allKeys = data.keys;
      pendingTtlDays = data.pendingTtlDays || 7;
      acceptThreshold = data.acceptThreshold || acceptThreshold;
      renderTable();
    } catch (err) {
      detailStatus.textContent = `Failed to load strings: ${err.message}`;
    }
  }

  function renderDetail() {
    const dp = progressData.datapacks.find((d) => d.slug === activeDatapack);
    if (!dp) {
      detailTitle.textContent = 'Data pack not found';
      detailStatus.hidden = false;
      detailStatus.textContent = '';
      return;
    }
    detailTitle.textContent = dp.displayName;
    localeSelect.innerHTML = dp.locales
      .slice()
      .sort((a, b) => a.englishName.localeCompare(b.englishName))
      .map((l) => `<option value="${esc(l.code)}">${esc(l.nativeName)} (${l.percent}%)</option>`)
      .join('');
    localeSelect.addEventListener('change', () => { searchInput.value = ''; loadStrings(); });

    searchInput.addEventListener('input', debounce(renderTable));
    clearButton.addEventListener('click', () => {
      searchInput.value = '';
      renderTable();
      searchInput.focus();
    });

    loadStrings();
  }

  modalClose.addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close(); // click on the ::backdrop
  });
  modal.addEventListener('close', () => { openModalKeyId = null; });

  mineSearchInput.addEventListener('input', debounce(renderMineTable));
  mineClearButton.addEventListener('click', () => {
    mineSearchInput.value = '';
    renderMineTable();
    mineSearchInput.focus();
  });

  bulkCancel.addEventListener('click', () => {
    stagedSuggestions.clear();
    updateBulkBar();
    renderTable();
  });

  bulkSubmit.addEventListener('click', async () => {
    if (!stagedSuggestions.size) return;
    bulkSubmit.disabled = true;
    try {
      const suggestions = Array.from(stagedSuggestions, ([translation_key_id, body]) => ({ translation_key_id, body }));
      const data = await fetchJson('/translate/api/suggest-bulk.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken || '' },
        body: JSON.stringify({ locale: localeSelect.value, suggestions }),
      });

      const failures = [];
      data.results.forEach((r) => {
        if (r.ok) {
          stagedSuggestions.delete(r.translationKeyId);
        } else {
          const key = allKeys.find((k) => k.id === r.translationKeyId);
          failures.push(`${key ? key.keyPath : r.translationKeyId}: ${r.message}`);
        }
      });

      updateBulkBar();
      await loadStrings();

      if (failures.length) {
        alert(`${data.submitted} of ${data.total} suggestions submitted. These failed:\n\n${failures.join('\n')}`);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      bulkSubmit.disabled = false;
    }
  });

  async function init() {
    try {
      me = await fetchJson('/translate/api/me.php');
    } catch {
      me = { loggedIn: false };
    }

    // Logging in at all already requires Discord guild membership (enforced
    // in the OAuth callback), so being logged in is sufficient here.
    const discordNotice = document.getElementById('translate-discord-notice');
    if (discordNotice) discordNotice.hidden = me.loggedIn;

    try {
      progressData = await fetchJson('/translate/api/progress.php');
    } catch (err) {
      landing.innerHTML = `<p class="translate-empty">Failed to load data packs: ${esc(err.message)}</p>`;
      return;
    }

    if (activeDatapack) {
      landing.hidden = true;
      detail.hidden = false;
      renderDetail();
    } else if (showMine) {
      landing.hidden = true;
      mineSection.hidden = false;
      loadMine();
    } else {
      renderLanding();
    }
  }

  init();
})();
