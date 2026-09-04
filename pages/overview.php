<main id="page-top" class="page-shell overview-shell">
  <img class="overview-banner" src="/assets/images/branding/smp_title.png" alt="A Realm Recrafted">

  <div class="overview-actions">
    <button id="copy-server-ip" type="button" class="overview-btn">
      <i class="bi bi-clipboard"></i> <span>Copy Server IP</span>
    </button>
    <a class="overview-btn" target="_blank" rel="noreferrer" href="https://modrinth.com/server/a-realm-recrafted">
      <i class="bi bi-box-arrow-up-right"></i> View on Modrinth
    </a>
  </div>

  <section class="overview-status" id="overview-status" aria-live="polite" aria-label="Server status">
    <p class="overview-status__loading">Checking server status…</p>
  </section>

  <section class="overview-readme" id="overview-readme" aria-label="Server README">
    <?php
      $readmeFile = __DIR__ . '/../overview/data/readme.html';
      if (is_file($readmeFile) && filesize($readmeFile) > 0) {
        readfile($readmeFile);
      } else {
        echo '<p class="overview-readme__missing">README content is being generated - check back soon.</p>';
      }
    ?>
  </section>
</main>
