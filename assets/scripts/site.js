// If a recipe deep-link gets opened against the root path (older copies of
// the URL were `https://explorerseden.eu/#<slug>/<ns>/<recipePath>` instead
// of `/recipes/#…`), bounce to /recipes/ before the home page even renders.
// The hash for a recipe deep-link always has at least two unescaped slashes.
(() => {
  const path = location.pathname.replace(/\/+$/, '');
  const hash = location.hash;
  if (path === '' && hash.length > 1 && hash.slice(1).split('/').length >= 3) {
    location.replace(`/recipes/${hash}`);
  }
})();

const backgrounds = [
  '/assets/images/backgrounds/1.png',
  '/assets/images/backgrounds/2.png',
  '/assets/images/backgrounds/3.jpg',
  '/assets/images/backgrounds/4.jpg',
  '/assets/images/backgrounds/5.png',
  '/assets/images/backgrounds/6.jpg',
  '/assets/images/backgrounds/7.png',
  '/assets/images/backgrounds/8.png'
];

const lockedPalette = {
  bg: '#0b1018',
  accent: '#b6c8ff',
  accent2: '#ffd18b',
  cardA: 'rgba(10, 12, 22, .88)',
  cardB: 'rgba(3, 5, 10, .94)',
  glass: 'rgba(5, 7, 13, .86)'
};

const fallbackProjects = [
  ['katters-structures', "Katter's Structures", 'Adds 30+ brand new vanilla like structures to the game.', '/assets/images/mods/ks.png'],
  ['enchantments-encore', 'Enchantments Encore', 'Supercharges your Minecraft experience with a vast array of new, creative enchantments to enhance weapons, tools, and armor like never before.', '/assets/images/mods/ee.png'],
  ['warping-wonders', 'Warping Wonders', 'Provides vanilla friendly teleportation methods like Waypoint Hubs to further immerse you in your worlds. No more /tpa, /home, or similar commands needed.', '/assets/images/mods/wawo.png'],
  ['fabled-roots', 'Fabled Roots', 'Fabled Roots adds 10 unique races and 10 powerful classes to Minecraft, along with new weapons, items, spells and structures to explore.', '/assets/images/mods/fabled_roots.png'],
  ['nice-mob-variants', 'Nice Mob Variants', 'Giving your game a whole bunch of new mob variants to check out.', '/assets/images/mods/mob_variants.png'],
  ['nice-keep-inventory', 'Nice Keep Inventory', 'Keep only Equipment and important items upon death. Also includes a fully fletched Graves system and 3 new enchantments. Fully configurable.', '/assets/images/mods/keepinv.png'],
  ['nice-things-eden', 'Nice Things Eden', 'A loose collection of vanilla feeling items, blocks, recipes, structures and small gameplay tweaks.', '/assets/images/mods/nice_things.png'],
  ['nice-name-tags', 'Nice Name Tags', 'Change entity behavior with name tags - make mobs silent, keep them as babies, change villager types, and more.', '/assets/images/mods/nnt.png'],
  ['nice-mob-manager', 'Nice Mob Manager', 'Probably the most advanced mob customizing data pack out there - tweak individual mobs, equipment, behavior and more easily via in-game menus.', '/assets/images/mods/mob_manager.png'],
  ['nice-actions', 'Nice Actions', 'Adding a simple, user-friendly menu for actions like RTP, sitting, and setting a home - no complicated commands required. Perfect for Single and Multiplayer.', '/assets/images/mods/actions.png'],
  ['nice-admin-tools', 'Nice Admin Tools', 'User-friendly & lightweight Admin Tools with intuitive menu navigation. Great for Admins, Operators, and Map Makers.', '/assets/images/mods/nat.png']
].map(([slug, title, description, icon_url]) => ({ slug, title, description, icon_url, downloads: null, followers: null, updated_at: null }));

const preferredOrder = fallbackProjects.map(project => project.slug);
const localIconFallbacks = Object.fromEntries(fallbackProjects.map(project => [project.slug, project.icon_url]));
const siteBg = document.querySelector('.site-bg');

function applyPalette(palette) {
  const root = document.documentElement;
  root.style.setProperty('--bg', palette.bg);
  root.style.setProperty('--accent', palette.accent);
  root.style.setProperty('--accent-2', palette.accent2);
  root.style.setProperty('--card-a', palette.cardA);
  root.style.setProperty('--card-b', palette.cardB);
  root.style.setProperty('--glass', palette.glass);
}

if (siteBg) {
  siteBg.style.backgroundImage = `url('${backgrounds[Math.floor(Math.random() * backgrounds.length)]}')`;
  applyPalette(lockedPalette);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en', {
    notation: number >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(number);
}

function formatRelativeDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const units = [['year',31536000000],['month',2592000000],['week',604800000],['day',86400000],['hour',3600000],['minute',60000]];
  for (const [unit, ms] of units) {
    const amount = Math.floor(absMs / ms);
    if (amount >= 1) return future ? `in ${amount} ${unit}${amount === 1 ? '' : 's'}` : `${amount} ${unit}${amount === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

function isKatterSubProject(project) {
  const slug = String(project.slug || '').toLowerCase();
  return slug.startsWith('katters-structures-') && slug !== 'katters-structures';
}

function isDataPack(project) {
  const tags = [...(project.loaders || []), ...(project.categories || []), ...(project.additional_categories || [])]
    .map(tag => String(tag).toLowerCase());
  return tags.includes('datapack') || tags.includes('data pack');
}

function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    const downloadDiff = (Number(b.downloads) || 0) - (Number(a.downloads) || 0);
    if (downloadDiff !== 0) return downloadDiff;
    return String(a.title || a.slug).localeCompare(String(b.title || b.slug));
  });
}

function bestGalleryImage(project) {
  const gallery = Array.isArray(project.gallery) ? project.gallery : [];
  if (!gallery.length) return null;
  const chosen = gallery[Math.floor(Math.random() * gallery.length)];
  return chosen.raw_url || chosen.url || null;
}

function normalizeProjects(projects) {
  return sortProjects(projects)
    .filter(project => project && project.slug)
    .filter(project => !isKatterSubProject(project))
    .filter(project => isDataPack(project) || preferredOrder.includes(project.slug))
    .map(project => ({
      slug: project.slug,
      title: project.title || project.name || project.slug,
      description: project.description || "A Minecraft data pack by Explorer's Eden.",
      icon_url: project.icon_url || localIconFallbacks[project.slug] || '/assets/images/mods/ee.png',
      gallery_url: bestGalleryImage(project),
      downloads: project.downloads,
      followers: project.followers,
      updated_at: project.updated || project.date_updated || project.updated_at || null,
      page_url: `https://modrinth.com/datapack/${project.slug}`
    }));
}

const MARQUEE_SECONDS_PER_CARD = 12.5;

function titleCardHtml(project) {
  const bgImage = project.gallery_url
    ? `<img class="mod-title-card__bg-img" src="${escapeHtml(project.gallery_url)}" alt="" loading="eager" fetchpriority="high" referrerpolicy="no-referrer">`
    : '';
  return `
    <a class="mod-title-card" href="${escapeHtml(project.page_url || `https://modrinth.com/datapack/${project.slug}`)}" target="_blank" rel="noreferrer" aria-label="Open ${escapeHtml(project.title)} on Modrinth">
      <div class="mod-title-card__bg">${bgImage}</div>
      <div class="mod-title-card__scrim"></div>
      <div class="mod-title-card__header">
        <div class="mod-title-card__icon">
          <img src="${escapeHtml(project.icon_url)}" alt="" loading="eager" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${escapeHtml(localIconFallbacks[project.slug] || '/assets/images/mods/ee.png')}';">
        </div>
        <div class="mod-title-card__heading">
          <h2>${escapeHtml(project.title)}</h2>
          <p>${escapeHtml(project.description)}</p>
        </div>
      </div>
      <div class="mod-title-card__footer">
        <div class="mod-meta" aria-label="Modrinth stats">
          <span><i class="bi bi-download"></i> ${formatNumber(project.downloads)}</span>
          <span><i class="bi bi-star-fill"></i> ${formatNumber(project.followers)}</span>
          <span><i class="bi bi-clock-history"></i> ${formatRelativeDate(project.updated_at)}</span>
        </div>
        <span class="mod-title-card__cta">View on Modrinth <i class="bi bi-box-arrow-up-right"></i></span>
      </div>
    </a>
  `;
}

function gridCardHtml(project) {
  return `
    <a class="mod-grid-card" href="${escapeHtml(project.page_url || `https://modrinth.com/datapack/${project.slug}`)}" target="_blank" rel="noreferrer" aria-label="Open ${escapeHtml(project.title)} on Modrinth">
      <div class="mod-grid-card__icon">
        <img src="${escapeHtml(project.icon_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${escapeHtml(localIconFallbacks[project.slug] || '/assets/images/mods/ee.png')}';">
      </div>
      <div class="mod-grid-card__body">
        <h3>${escapeHtml(project.title)}</h3>
        <div class="mod-meta" aria-label="Modrinth stats">
          <span><i class="bi bi-download"></i> ${formatNumber(project.downloads)}</span>
          <span><i class="bi bi-star-fill"></i> ${formatNumber(project.followers)}</span>
          <span><i class="bi bi-clock-history"></i> ${formatRelativeDate(project.updated_at)}</span>
        </div>
      </div>
    </a>
  `;
}

function renderProjects(projects, fallback = false) {
  const list = document.querySelector('#mod-list');
  const grid = document.querySelector('#mod-grid');
  if (!list) return;

  const note = fallback
    ? '<p class="mod-list-note">Live Modrinth data could not be loaded, so fallback entries are shown.</p>'
    : '';

  // Duplicated once so the track can loop seamlessly: translating exactly
  // -50% lands on a pixel-identical copy of the starting frame.
  const marqueeCards = projects.map(project => titleCardHtml(project)).join('');
  const duration = Math.max(24, projects.length * MARQUEE_SECONDS_PER_CARD);

  list.innerHTML = `
    ${note}
    <div class="mod-marquee" id="mod-marquee">
      <div class="mod-marquee__track" style="animation-duration:${duration}s;">
        ${marqueeCards}${marqueeCards}
      </div>
    </div>
  `;

  if (grid) {
    grid.innerHTML = projects.map(project => gridCardHtml(project)).join('');
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {})
      },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`${url} did not return a project array.`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadModrinthProjects() {
  const list = document.querySelector('#mod-list');
  if (!list) return;

  renderProjects(fallbackProjects.map(project => ({
    ...project,
    page_url: `https://modrinth.com/datapack/${project.slug}`
  })), true);

  const slugs = preferredOrder;
  const directApi = `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(slugs))}`;
  const localProxy = list.dataset.modrinthSource || 'modrinth-projects.php';

  try {
    let data;
    try {
      data = await fetchJsonWithTimeout(localProxy, {}, 5000);
    } catch (proxyError) {
      console.warn('Local Modrinth proxy failed, trying direct Modrinth API:', proxyError);
      data = await fetchJsonWithTimeout(directApi, {}, 7000);
    }

    const projects = normalizeProjects(data);
    if (!projects.length) throw new Error('No data pack projects found.');
    renderProjects(projects, false);
  } catch (error) {
    console.warn('Could not load live Modrinth projects:', error);
    const note = document.querySelector('.mod-list-note');
    if (note) {
      note.textContent = 'Live Modrinth stats could not be loaded right now, so local entries are shown.';
    }
  }
}

loadModrinthProjects();

// ── Mobile nav burger menu ───────────────────────────────────────────────
// Loaded on every page (shared header), so guard on the elements existing
// rather than assuming anything about the current page.
(() => {
  const burger = document.getElementById('nav-burger');
  const navLinks = document.getElementById('nav-links');
  if (!burger || !navLinks) return;

  const burgerIcon = burger.querySelector('i');

  function closeDropdowns() {
    navLinks.querySelectorAll('.nav-dropdown.is-open').forEach((d) => d.classList.remove('is-open'));
  }

  function setMenuOpen(open) {
    navLinks.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', String(open));
    if (burgerIcon) burgerIcon.className = open ? 'bi bi-x-lg' : 'bi bi-list';
    if (!open) closeDropdowns();
  }

  burger.addEventListener('click', () => {
    setMenuOpen(!navLinks.classList.contains('is-open'));
  });

  // Dropdown triggers are <button>s with no default action, so this only
  // ever toggles - on desktop the .is-open class has no visual effect since
  // that CSS is scoped inside the max-width:900px block; hover still drives
  // it there.
  navLinks.querySelectorAll('.nav-dropdown__trigger').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const dropdown = trigger.closest('.nav-dropdown');
      const wasOpen = dropdown.classList.contains('is-open');
      closeDropdowns();
      if (!wasOpen) dropdown.classList.add('is-open');
    });
  });

  document.addEventListener('click', (e) => {
    if (!navLinks.classList.contains('is-open')) return;
    if (navLinks.contains(e.target) || burger.contains(e.target)) return;
    setMenuOpen(false);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks.classList.contains('is-open')) setMenuOpen(false);
  });
})();
