const grid = document.getElementById('waypoint-hub-grid');
const searchInput = document.getElementById('waypoint-search');
const clearButton = document.getElementById('clear-waypoint-search');
const resultsCount = document.getElementById('waypoint-results-count');

let hubs = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

async function loadManifest() {
  const response = await fetch('/waypoint-hubs/data/waypoint-hubs.manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function cardHtml(hub) {
  const name = escapeHtml(hub.name || 'Unnamed Waypoint');
  const owner = escapeHtml(hub.owner || 'Unknown');
  const dimension = escapeHtml(hub.dimension || '');
  const fallbackAvatar = `https://mc-heads.net/avatar/${encodeURIComponent(hub.owner || 'MHF_Question')}/64`;
  const avatarSrc = hub.icon || fallbackAvatar;
  const description = hub.description
    ? `<p class="waypoint-card__description">${escapeHtml(hub.description)}</p>`
    : '';
  return `
    <article class="waypoint-card">
      <img class="waypoint-card__avatar" src="${avatarSrc}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallbackAvatar}';">
      <div class="waypoint-card__body">
        <h3>${name}</h3>
        <p class="waypoint-card__owner">by ${owner}</p>
        <p class="waypoint-card__coords"><i class="bi bi-geo-alt-fill"></i> ${hub.x}, ${hub.y}, ${hub.z} · ${dimension}</p>
        ${description}
      </div>
    </article>
  `;
}

function render(list) {
  if (!grid) return;
  grid.innerHTML = list.length
    ? list.map(cardHtml).join('')
    : '<p class="waypoint-hubs-empty">No matching waypoint hubs.</p>';

  if (resultsCount) {
    resultsCount.textContent = `${list.length} waypoint hub${list.length === 1 ? '' : 's'}`;
  }
}

function applyFilter() {
  const query = (searchInput?.value || '').trim().toLowerCase();
  const filtered = query
    ? hubs.filter((hub) => (hub.name || '').toLowerCase().includes(query) || (hub.owner || '').toLowerCase().includes(query))
    : hubs;
  render(filtered);
}

async function init() {
  try {
    hubs = await loadManifest();
    render(hubs);
  } catch {
    if (grid) grid.innerHTML = '<p class="waypoint-hubs-empty">Could not load waypoint hubs.</p>';
    if (resultsCount) resultsCount.textContent = '';
  }
}

if (searchInput) {
  searchInput.addEventListener('input', applyFilter);
}

if (clearButton) {
  clearButton.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    applyFilter();
    searchInput?.focus();
  });
}

init();
