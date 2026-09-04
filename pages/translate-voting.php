<?php
$activeDatapack = isset($_GET['datapack']) ? trim($_GET['datapack']) : '';
?>
<main id="page-top" class="page-shell translate-page" data-active-datapack="<?= htmlspecialchars($activeDatapack, ENT_QUOTES) ?>">

  <section class="translate-hero" aria-label="Community translation voting">
    <img class="translate-hero__logo" src="/assets/images/branding/translations_title.png" alt="Explorer's Eden Translations">
  </section>

  <aside class="translate-discord-notice" id="translate-discord-notice" aria-label="Discord membership required">
    <i class="bi bi-discord" aria-hidden="true"></i>
    <p>You must be a member of our Discord server to vote or delete suggestions. <a target="_blank" rel="noreferrer" href="https://discord.gg/f2pMggfgVv">Join the Discord</a></p>
  </aside>

  <section class="translate-landing" id="translate-voting-landing" aria-label="Open suggestions per data pack">
    <p class="translate-loading">Loading data packs…</p>
  </section>

  <section class="translate-mine" id="translate-voting-detail" hidden aria-label="Vote on suggestions">
    <a href="/translate/voting/" class="translate-detail__back"><i class="bi bi-arrow-left" aria-hidden="true"></i> All data packs</a>
    <h2 id="translate-voting-title"></h2>

    <div class="translate-detail__tools" role="search">
      <div class="search-wrap">
        <label class="sr-only" for="translate-voting-search-input">Search open suggestions</label>
        <i class="bi bi-search" aria-hidden="true"></i>
        <input type="search" id="translate-voting-search-input" placeholder="Search by text or language...">
        <button id="translate-voting-clear-search" type="button" aria-label="Clear search">×</button>
      </div>
      <p id="translate-voting-results-count" class="results-count" aria-live="polite"></p>
    </div>

    <p id="translate-voting-status" class="translate-loading">Loading open suggestions…</p>
    <div class="translate-strings" id="translate-voting-list"></div>
  </section>

</main>
