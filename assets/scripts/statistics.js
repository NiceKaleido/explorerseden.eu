(function () {
  const shell = document.querySelector('.statistics-shell');
  if (!shell) return;

  const subtitle = document.getElementById('statistics-subtitle');
  const summary = document.getElementById('statistics-summary');
  const distribution = document.getElementById('statistics-distribution');
  const groups = document.getElementById('statistics-groups');
  const leaderboards = document.getElementById('statistics-leaderboards');

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Mirrors profile.js's group() helper so the combined stats read as the
  // same collapsible-card component as a single player's own profile page,
  // just closed by default instead of the first one open.
  function group(id, summaryHtml, bodyHtml) {
    return `
      <details class="profile-group" id="statistics-group-${id}">
        <summary>
          ${summaryHtml}
          <i class="bi bi-chevron-down profile-group__arrow" aria-hidden="true"></i>
        </summary>
        <div class="profile-group__body">${bodyHtml}</div>
      </details>
    `;
  }

  // Same 6 headline metrics as the single-player profile page's summary
  // tiles (profile.js's playerGroup()), so the two pages read as the same
  // stats at different scales.
  const METRICS = [
    { key: 'advancementsCompleted', label: 'Advancements Completed', icon: 'bi-trophy-fill' },
    { key: 'playtimeHours', label: 'Hours Played', icon: 'bi-clock-history' },
    { key: 'deaths', label: 'Deaths', icon: 'bi-heartbreak-fill' },
    { key: 'mobKillsTotal', label: 'Mobs Killed', icon: 'bi-crosshair' },
    { key: 'damageDealt', label: 'Damage Dealt', icon: 'bi-lightning-charge-fill' },
    { key: 'blocksMinedTotal', label: 'Blocks Mined', icon: 'bi-hammer' },
  ];

  function statTile(icon, label, value) {
    return `
      <div class="profile-stat-tile">
        <i class="bi ${icon}"></i>
        <div>
          <p class="profile-stat-tile__value">${value}</p>
          <p class="profile-stat-tile__label">${label}</p>
        </div>
      </div>
    `;
  }

  function renderSummary(data) {
    summary.innerHTML = `
      <h2 class="statistics-section-title"><i class="bi bi-people-fill"></i> Community Totals <span class="profile-count-badge">${data.playerCount} players</span></h2>
      <div class="profile-stat-grid">
        ${METRICS.map((m) => statTile(m.icon, m.label, data.totals[m.key].toLocaleString())).join('')}
      </div>
    `;
  }

  const RANK_ICONS = ['bi-trophy-fill', 'bi-award-fill', 'bi-award-fill'];
  const RANK_LABELS = ['1st', '2nd', '3rd'];

  function leaderCardHtml(entry, rank) {
    const icon = entry.headIcon || entry.skinIcon;
    const skin = icon
      ? `<img class="stats-leader-card__skin" src="${esc(icon)}" alt="" loading="lazy">`
      : '<div class="stats-leader-card__skin stats-leader-card__skin--missing"><i class="bi bi-person-fill"></i></div>';
    const badges = [];
    if (entry.race) badges.push(`<span class="profile-badge profile-badge--small"><i class="bi bi-stars"></i> ${esc(entry.race)}</span>`);
    if (entry.class) badges.push(`<span class="profile-badge profile-badge--small"><i class="bi bi-award"></i> ${esc(entry.class)}</span>`);

    return `
      <article class="stats-leader-card stats-leader-card--rank${rank}">
        ${skin}
        <div class="stats-leader-card__body">
          <p class="stats-leader-card__name">${esc(entry.name)}</p>
          <div class="stats-leader-card__badges">${badges.join('')}</div>
        </div>
        <div class="stats-leader-card__right">
          <span class="stats-leader-card__rank"><i class="bi ${RANK_ICONS[rank - 1]}"></i> ${RANK_LABELS[rank - 1]}</span>
          <p class="stats-leader-card__value">${entry.value.toLocaleString()}</p>
        </div>
      </article>
    `;
  }

  function leaderboardCardHtml(m, entries) {
    const rowHtml = entries.length
      ? `<div class="stats-leaderboard__row">${entries.map((entry, i) => leaderCardHtml(entry, i + 1)).join('')}</div>`
      : '<p class="profile-empty-note">No data yet.</p>';
    return `
      <section class="stats-leaderboard-card">
        <h3 class="statistics-section-title"><i class="bi ${m.icon}"></i> Top ${esc(m.label)}</h3>
        ${rowHtml}
      </section>
    `;
  }

  function renderLeaderboards(data) {
    leaderboards.innerHTML = METRICS.map((m) => leaderboardCardHtml(m, data.leaderboards[m.key] || [])).join('');
  }

  // ── Race / class distribution ────────────────────────────────────────────

  const DIST_ICONS = ['bi-1-circle-fill', 'bi-2-circle-fill', 'bi-3-circle-fill'];

  function distRowHtml(item, index, total) {
    const pct = total ? Math.round((item.count / total) * 100) : 0;
    const rankIcon = index < 3 ? `<i class="bi ${DIST_ICONS[index]} stats-dist-row__rank"></i>` : `<span class="stats-dist-row__rank stats-dist-row__rank--plain">${index + 1}</span>`;
    return `
      <div class="stats-dist-row">
        ${rankIcon}
        <span class="stats-dist-row__label">${esc(item.label)}</span>
        <div class="stats-dist-row__bar"><div class="stats-dist-row__fill" style="width:${pct}%"></div></div>
        <span class="stats-dist-row__count">${item.count} <span class="stats-dist-row__pct">(${pct}%)</span></span>
      </div>
    `;
  }

  const DIST_MAX_ROWS = 5;

  function renderDistribution(data) {
    const raceTotal = data.raceDistribution.reduce((sum, r) => sum + r.count, 0);
    const classTotal = data.classDistribution.reduce((sum, c) => sum + c.count, 0);
    const races = data.raceDistribution.slice(0, DIST_MAX_ROWS);
    const classes = data.classDistribution.slice(0, DIST_MAX_ROWS);
    distribution.innerHTML = `
      <div class="stats-dist-col">
        <h3 class="statistics-section-title"><i class="bi bi-stars"></i> Races</h3>
        <div class="stats-dist-rows">${races.map((r, i) => distRowHtml(r, i, raceTotal)).join('')}</div>
      </div>
      <div class="stats-dist-col">
        <h3 class="statistics-section-title"><i class="bi bi-award"></i> Classes</h3>
        <div class="stats-dist-rows">${classes.map((c, i) => distRowHtml(c, i, classTotal)).join('')}</div>
      </div>
    `;
  }

  // ── All Statistics (combined) ────────────────────────────────────────────
  // Mirrors profile.js's statsDetailGroup(), fed by the community-summed
  // equivalent of a single player's statsDetailed array.

  function allStatisticsGroupHtml(statsDetailed) {
    const summaryHtml = `<span class="profile-group__title"><i class="bi bi-bar-chart-fill"></i> Statistics</span>`;
    const bodyHtml = statsDetailed.length
      ? statsDetailed.map((cat) => `
          <details class="profile-detail-section">
            <summary class="profile-detail-section__title">${esc(cat.category)} <span class="profile-count-badge">${cat.items.length}</span> <i class="bi bi-chevron-down profile-detail-section__arrow"></i></summary>
            <div class="profile-stat-rows">
              ${cat.items.map((item) => `
                <div class="profile-stat-row">
                  <span>${esc(item.label)}</span>
                  <span class="profile-stat-row__value">${esc(item.value)}</span>
                </div>
              `).join('')}
            </div>
          </details>
        `).join('')
      : '<p class="profile-empty-note">No stats recorded yet.</p>';
    return group('all-stats', summaryHtml, bodyHtml);
  }

  // ── Advancements (combined) ──────────────────────────────────────────────
  // Mirrors profile.js's advancementsDetailGroup(), but instead of a
  // done/not-done checkmark per advancement, shows how many players have
  // unlocked it out of the community total.

  function advancementsGroupHtml(advancementsDetailed, playerCount) {
    const summaryHtml = `<span class="profile-group__title"><i class="bi bi-trophy-fill"></i> Advancements</span>`;
    const bodyHtml = advancementsDetailed.length
      ? advancementsDetailed.map((cat) => `
          <details class="profile-detail-section">
            <summary class="profile-detail-section__title">${esc(cat.category)} <span class="profile-count-badge">${cat.items.length}</span> <i class="bi bi-chevron-down profile-detail-section__arrow"></i></summary>
            <div class="profile-stat-rows">
              ${cat.items.map((item) => `
                <div class="profile-stat-row"${item.description ? ` data-tooltip="${esc(item.description)}"` : ''}>
                  <span>${esc(item.label)}</span>
                  <span class="profile-stat-row__value">${item.count}/${playerCount}</span>
                </div>
              `).join('')}
            </div>
          </details>
        `).join('')
      : '<p class="profile-empty-note">No advancements recorded yet.</p>';
    return group('advancements', summaryHtml, bodyHtml);
  }

  function renderGroups(data) {
    groups.innerHTML = allStatisticsGroupHtml(data.statsDetailed || [])
      + advancementsGroupHtml(data.advancementsDetailed || [], data.playerCount);
  }

  async function init() {
    try {
      const response = await fetch('/profiles/api/aggregate.php', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.message || `Request failed: ${response.status}`);
      }
      subtitle.hidden = true;
      renderSummary(data);
      renderDistribution(data);
      renderGroups(data);
      renderLeaderboards(data);
    } catch (err) {
      subtitle.textContent = `Failed to load community statistics: ${err.message}`;
    }
  }

  // Advancement description tooltip - mirrors profile.js's identical
  // floating-tooltip pattern so hovering an advancement here behaves the
  // same as it does on a single player's own profile page.
  const tooltip = document.createElement('div');
  tooltip.className = 'profile-tooltip';
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  function positionTooltip(anchorEl) {
    const aRect = anchorEl.getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let top = aRect.top - th - 10;
    let left = aRect.left;
    if (top < 10) top = aRect.bottom + 10;
    top = Math.max(10, Math.min(top, window.innerHeight - th - 10));
    left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  groups.addEventListener('mouseover', (ev) => {
    const row = ev.target.closest('.profile-stat-row[data-tooltip]');
    if (!row) return;
    tooltip.textContent = row.dataset.tooltip;
    tooltip.hidden = false;
    positionTooltip(row);
  });

  groups.addEventListener('mouseout', (ev) => {
    if (ev.target.closest('.profile-stat-row[data-tooltip]')) tooltip.hidden = true;
  });

  init();
})();
