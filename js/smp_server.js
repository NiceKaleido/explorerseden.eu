const playerCount = document.querySelector('.sip');
const discordCount = document.querySelector('.discord-count');

function normalizeCounterText(element) {
  if (!element) return;
  element.textContent = String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function animateCounter(element, targetValue, duration = 650) {
  if (!element) return;

  const target = Number(targetValue) || 0;
  const current = Number(String(element.textContent || '0').replace(/[^0-9.-]/g, '')) || 0;

  if (current === target) {
    element.textContent = String(target);
    return;
  }

  const startTime = performance.now();

  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(current + (target - current) * eased);
    element.textContent = String(value);

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      element.textContent = String(target);
    }
  }

  requestAnimationFrame(tick);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function updatePlayerCount() {
  if (!playerCount) return;

  const ip = playerCount.dataset.ip;
  const port = playerCount.dataset.port || '25565';
  if (!ip) {
    animateCounter(playerCount, 0);
    return;
  }

  try {
    const data = await fetchJson(`https://api.mcsrvstat.us/3/${ip}:${port}`);
    animateCounter(playerCount, data?.players?.online ?? 0);
  } catch {
    try {
      const data = await fetchJson(`https://api.bybilly.uk/api/players/${ip}/${port}`);
      animateCounter(playerCount, data?.online ?? data?.players?.online ?? 0);
    } catch {
      animateCounter(playerCount, 0);
    }
  }
}

normalizeCounterText(playerCount);
normalizeCounterText(discordCount);

if (discordCount) {
  animateCounter(discordCount, discordCount.dataset.count || discordCount.textContent || 0);
}

updatePlayerCount();
setInterval(updatePlayerCount, 60000);
