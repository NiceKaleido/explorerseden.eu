const STATUS_IP = 'play.explorerseden.eu';
const STATUS_PORT = 25569;
const SERVER_IP_TEXT = 'play.explorerseden.eu';

const statusRoot = document.getElementById('overview-status');
const copyBtn = document.getElementById('copy-server-ip');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function playersHtml(players) {
  if (!Array.isArray(players) || !players.length) {
    return '<p class="overview-status__players-empty">No players online right now.</p>';
  }
  const items = players.map((player) => {
    const name = escapeHtml(typeof player === 'string' ? player : player?.name || 'Unknown');
    return `<li><img src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/22" alt="" loading="lazy">${name}</li>`;
  }).join('');
  return `<ul class="overview-status__players">${items}</ul>`;
}

function motdHtml(data) {
  const lines = data?.motd?.clean;
  if (!Array.isArray(lines) || !lines.length) return '';
  // mcsrvstat's "clean" MOTD text is already HTML-entity-encoded (e.g. &#039;)
  // for direct embedding, so it is not re-escaped here.
  return `<p class="overview-status__motd">${lines.join(' ')}</p>`;
}

function renderOnline(data) {
  const online = data?.players?.online ?? 0;
  const max = data?.players?.max ?? '?';
  const version = data?.version ? escapeHtml(data.version) : 'Unknown';
  statusRoot.innerHTML = `
    <div class="overview-status__card">
      <div class="overview-status__top">
        <div class="overview-status__badge is-online"><i class="bi bi-circle-fill"></i> Online</div>
        <div class="overview-status__meta">
          <span><i class="bi bi-hdd-network"></i> v${version}</span>
          <span><i class="bi bi-people-fill"></i> ${online}/${max} Playing</span>
        </div>
      </div>
      ${motdHtml(data)}
    </div>
    <div class="overview-status__players-card">
      <h2>Online Players</h2>
      ${playersHtml(data?.players?.list)}
    </div>
  `;
}

function renderOffline() {
  statusRoot.innerHTML = `
    <div class="overview-status__card">
      <div class="overview-status__badge is-offline"><i class="bi bi-circle-fill"></i> Offline</div>
    </div>
    <div class="overview-status__players-card">
      <h2>Online Players</h2>
      <p class="overview-status__players-empty">Server is offline.</p>
    </div>
  `;
}

async function updateStatus() {
  if (!statusRoot) return;
  try {
    const data = await fetchJson(`https://api.mcsrvstat.us/3/${STATUS_IP}:${STATUS_PORT}`);
    if (data?.online) {
      renderOnline(data);
    } else {
      renderOffline();
    }
  } catch {
    renderOffline();
  }
}

function copyServerIp() {
  const restoreLabel = () => {
    copyBtn.classList.remove('is-copied');
    copyBtn.querySelector('span').textContent = 'Copy Server IP';
  };

  const onCopied = () => {
    copyBtn.classList.add('is-copied');
    copyBtn.querySelector('span').textContent = 'Copied!';
    setTimeout(restoreLabel, 1800);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(SERVER_IP_TEXT).then(onCopied).catch(() => fallbackCopy(onCopied));
  } else {
    fallbackCopy(onCopied);
  }
}

function fallbackCopy(onCopied) {
  const textarea = document.createElement('textarea');
  textarea.value = SERVER_IP_TEXT;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    onCopied();
  } catch {
    // Clipboard unavailable; silently ignore.
  } finally {
    document.body.removeChild(textarea);
  }
}

if (copyBtn) {
  copyBtn.addEventListener('click', copyServerIp);
}

updateStatus();
setInterval(updateStatus, 60000);
