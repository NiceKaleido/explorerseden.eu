function toRoman(n) {
  let num = parseInt(n, 10);
  if (!Number.isFinite(num) || num < 1) return String(n || '—');
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (num >= vals[i]) { result += syms[i]; num -= vals[i]; }
  }
  return result;
}

const state = {
  enchantments: [],
  filtered: [],
  sortDirection: 'asc',
  activePack: 'All',
};

const tbody = document.querySelector('#data-table tbody');
const searchInput = document.getElementById('search-input');
const clearButton = document.getElementById('clear-search');
const resultsCount = document.getElementById('results-count');
const sortButton = document.querySelector('[data-sort="name"]');
const quickFilters = document.getElementById('quick-filters');

function normalizeAssetPaths(html) {
  return String(html || '').replace(/src=(["'])([^"']*?\.png)\1/g, (_match, quote, src) => {
    const filename = String(src).replace(/\\\//g, '/').split('/').pop();
    return `src=${quote}/enchantments/assets/items/${filename}${quote}`;
  });
}

function titleCaseWords(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function listify(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '-' || raw.toLowerCase() === 'none') {
    return document.createTextNode('—');
  }

  const parts = raw
    .split(/\s*,\s*/)
    .map((v) => v.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return document.createTextNode(parts[0] || '—');
  }

  const ul = document.createElement('ul');
  ul.className = 'inline-list';
  parts.forEach((part) => {
    const li = document.createElement('li');
    li.textContent = part;
    ul.appendChild(li);
  });
  return ul;
}

function createAnyPill() {
  const pill = document.createElement('span');
  pill.className = 'applicable-item applicable-item--any';
  const text = document.createElement('span');
  text.textContent = 'Any';
  pill.appendChild(text);
  return pill;
}

function renderApplicableCell(html, fallbackText = '') {
  const normalized = normalizeAssetPaths(html);

  if (!normalized.trim() && fallbackText) {
    const wrapper = document.createElement('div');
    wrapper.className = 'applicable-cell';
    fallbackText.split(/\s*,\s*/).filter(Boolean).forEach((label) => {
      const pill = document.createElement('span');
      pill.className = 'applicable-item';
      const text = document.createElement('span');
      text.textContent = titleCaseWords(label.trim());
      pill.appendChild(text);
      wrapper.appendChild(pill);
    });
    return wrapper.childNodes.length ? wrapper : document.createTextNode('—');
  }

  if (normalized.trim() === '<b>Any</b>' || normalized.trim().toLowerCase() === 'any') {
    const wrapper = document.createElement('div');
    wrapper.className = 'applicable-cell';
    wrapper.appendChild(createAnyPill());
    return wrapper;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'applicable-cell';
  wrapper.innerHTML = normalized;

  const nodes = Array.from(wrapper.childNodes);
  wrapper.innerHTML = '';

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
      const pill = document.createElement('span');
      pill.className = 'applicable-item';

      node.loading = 'lazy';
      node.decoding = 'async';

      let label = '';
      const next = nodes[i + 1];
      if (next && next.nodeType === Node.TEXT_NODE) {
        label = next.textContent.trim();
        if (label) i += 1;
      }

      if (!node.alt) node.alt = label || 'Applicable item';
      pill.appendChild(node);

      if (label) {
        const text = document.createElement('span');
        text.textContent = label;
        pill.appendChild(text);
      }

      wrapper.appendChild(pill);
      continue;
    }

    if (node.nodeType === Node.ELEMENT_NODE && /^b$/i.test(node.tagName) && node.textContent.trim().toLowerCase() === 'any') {
      wrapper.appendChild(createAnyPill());
      continue;
    }

    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const textValue = node.textContent.trim();
      const pill = document.createElement('span');
      pill.className = 'applicable-item' + (textValue.toLowerCase() === 'any' ? ' applicable-item--any' : '');
      const text = document.createElement('span');
      text.textContent = textValue;
      pill.appendChild(text);
      wrapper.appendChild(pill);
    }
  }

  return wrapper.childNodes.length ? wrapper : document.createTextNode('—');
}

function createCell(content, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;

  if (content instanceof Node) {
    td.appendChild(content);
  } else {
    td.textContent = content || '—';
  }

  return td;
}

function renderTable(rows) {
  tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  rows.forEach((entry) => {
    const tr = document.createElement('tr');
    tr.appendChild(createCell(entry.name, 'name-cell'));
    tr.appendChild(createCell(entry.description, 'description-cell'));
    const levelTd = document.createElement('td');
    levelTd.className = 'level-cell';
    const levelSpan = document.createElement('span');
    levelSpan.textContent = toRoman(entry.maxLevel);
    levelTd.appendChild(levelSpan);
    tr.appendChild(levelTd);
    tr.appendChild(createCell(renderApplicableCell(entry.applicableHtml, entry.applicableText)));
    tr.appendChild(createCell(listify(entry.incompatibilities)));
    tr.appendChild(createCell(listify(entry.lootSources)));

    const packCell = document.createElement('td');
    if (entry.dataPack?.url) {
      const a = document.createElement('a');
      a.className = 'data-pack-link';
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.href = entry.dataPack.url;
      a.textContent = entry.dataPack.name;
      packCell.appendChild(a);
    } else {
      packCell.textContent = entry.dataPack?.name || '—';
    }

    tr.appendChild(packCell);
    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);
  resultsCount.textContent = '';
}

function getSearchMatchedEnchantments() {
  const query = searchInput.value.trim().toLowerCase();

  if (!query) {
    return [...state.enchantments];
  }

  return state.enchantments.filter((entry) => {
    const haystack = [
      entry.name,
      entry.description,
      entry.maxLevel,
      entry.applicableText,
      entry.incompatibilities,
      entry.lootSources,
      entry.dataPack?.name,
    ].join(' ').toLowerCase();

    return haystack.includes(query);
  });
}

function renderQuickFilters() {
  const searchMatched = getSearchMatchedEnchantments();
  const counts = new Map();

  searchMatched.forEach((entry) => {
    const pack = entry.dataPack?.name || 'Unknown';
    counts.set(pack, (counts.get(pack) || 0) + 1);
  });

  const allPacks = Array.from(new Set(state.enchantments.map((entry) => entry.dataPack?.name || 'Unknown')))
    .sort((a, b) => a.localeCompare(b));

  const packNames = ['All', ...allPacks];
  quickFilters.innerHTML = '';

  packNames.forEach((packName) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-chip' + (packName === state.activePack ? ' is-active' : '');

    const count = packName === 'All' ? searchMatched.length : (counts.get(packName) || 0);
    button.innerHTML = `<span>${packName}</span><strong>${count}</strong>`;

    if (count === 0 && packName !== 'All') {
      button.disabled = true;
      button.classList.add('is-empty');
    }

    button.addEventListener('click', () => {
      state.activePack = packName;
      applyFilters();
    });

    quickFilters.appendChild(button);
  });
}

function applyFilters() {
  const query = searchInput.value.trim().toLowerCase();
  clearButton.style.display = (query || state.activePack !== 'All') ? 'block' : 'none';

  const searchMatched = getSearchMatchedEnchantments();

  if (
    state.activePack !== 'All' &&
    !searchMatched.some((entry) => (entry.dataPack?.name || 'Unknown') === state.activePack)
  ) {
    state.activePack = 'All';
  }

  state.filtered = searchMatched.filter((entry) => {
    return state.activePack === 'All' || entry.dataPack?.name === state.activePack;
  });

  renderQuickFilters();
  sortRows(false);
}

function sortRows(toggleDirection = true) {
  if (toggleDirection) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  }

  const dir = state.sortDirection === 'asc' ? 1 : -1;
  const sorted = [...state.filtered].sort((a, b) =>
    String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()) * dir
  );

  renderTable(sorted);
}

async function loadEnchantmentsData() {
  if (Array.isArray(window.EXPLORERS_EDEN_ENCHANTMENTS)) {
    return window.EXPLORERS_EDEN_ENCHANTMENTS;
  }

  const paths = [
    '/enchantments/data/enchantments.json',
  ];

  let lastError;

  for (const path of paths) {
    try {
      const response = await fetch(path, { cache: 'no-store' });

      if (!response.ok) {
        throw new Error(`${path}: ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error(`${path}: expected an array`);
      }

      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to fetch enchantments.json');
}

const debounce = (fn, delay = 150) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
};

async function init() {
  state.enchantments = await loadEnchantmentsData();
  state.filtered = [...state.enchantments];

  applyFilters();

  searchInput.addEventListener('input', debounce(applyFilters));
  clearButton.addEventListener('click', () => {
    if (searchInput.value) {
      searchInput.value = '';
    } else if (state.activePack !== 'All') {
      state.activePack = 'All';
    }

    applyFilters();
    searchInput.focus();
  });

  sortButton.addEventListener('click', () => sortRows(true));
}

init().catch((error) => {
  console.error(error);
  resultsCount.textContent = 'Failed to load enchantments.';
});
