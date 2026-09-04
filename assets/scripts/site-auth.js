(function () {
  const root = document.getElementById('nav-auth');
  if (!root) return;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.message || `Request failed: ${response.status}`);
    }
    return data;
  }

  function returnToUrl() {
    return window.location.pathname + window.location.search;
  }

  function renderLoggedOut() {
    const loginUrl = `/translate/auth/login.php?return_to=${encodeURIComponent(returnToUrl())}`;
    root.innerHTML = `
      <a class="nav-auth__login" href="${esc(loginUrl)}"><i class="bi bi-discord"></i> Log In with Discord</a>
    `;
  }

  function renderLoggedIn(user) {
    const profileItem = user.hasProfile
      ? `<a href="/profile/" role="menuitem"><i class="bi bi-person-fill"></i> My SMP Profile</a>`
      : '';
    root.innerHTML = `
      <div class="nav-dropdown">
        <button class="nav-dropdown__trigger" type="button" aria-haspopup="true">
          <img class="nav-dropdown__avatar" src="${esc(user.avatarUrl)}" alt="">
          ${esc(user.username)} <i class="bi bi-chevron-down nav-dropdown__arrow"></i>
        </button>
        <div class="nav-dropdown__menu nav-dropdown__menu--right" role="menu">
          ${profileItem}
          <a href="/translate/?mine=1" role="menuitem"><i class="bi bi-list-check"></i> My Translation Suggestions</a>
          <div class="nav-dropdown__divider"></div>
          <button type="button" id="nav-logout-btn" role="menuitem"><i class="bi bi-box-arrow-right"></i> Log Out</button>
        </div>
      </div>
    `;

    document.getElementById('nav-logout-btn').addEventListener('click', async () => {
      await fetch('/translate/auth/logout.php', { method: 'POST' });
      window.location.reload();
    });
  }

  async function init() {
    try {
      const me = await fetchJson('/translate/api/me.php');
      if (me.loggedIn) {
        renderLoggedIn(me.user);
      } else {
        renderLoggedOut();
      }
    } catch {
      renderLoggedOut();
    }
  }

  init();
})();
