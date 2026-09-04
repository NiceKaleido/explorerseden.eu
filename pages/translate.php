<?php
$activeDatapack = isset($_GET['datapack']) ? trim($_GET['datapack']) : '';
$showMine = isset($_GET['mine']) && $activeDatapack === '';
?>
<main id="page-top" class="page-shell translate-page" data-active-datapack="<?= htmlspecialchars($activeDatapack, ENT_QUOTES) ?>" data-show-mine="<?= $showMine ? '1' : '' ?>">

  <section class="translate-hero" aria-label="Community translations">
    <img class="translate-hero__logo" src="/assets/images/branding/translations_title.png" alt="Explorer's Eden Translations">
  </section>

  <aside class="translate-discord-notice" id="translate-discord-notice" aria-label="Discord membership required">
    <i class="bi bi-discord" aria-hidden="true"></i>
    <p>You must be a member of our Discord server to contribute translations. <a target="_blank" rel="noreferrer" href="https://discord.gg/f2pMggfgVv">Join the Discord</a></p>
  </aside>

  <section class="translate-landing" id="translate-landing" aria-label="Data pack translation progress">
    <p class="translate-loading">Loading data packs…</p>
  </section>

  <section class="translate-detail" id="translate-detail" hidden aria-label="Translate strings">
    <a href="/translate/" class="translate-detail__back"><i class="bi bi-arrow-left" aria-hidden="true"></i> All data packs</a>

    <h2 id="translate-detail-title"></h2>

    <div class="translate-detail__tools" role="search">
      <label class="translate-locale-picker translate-locale-picker--inline">
        <span class="sr-only">Language</span>
        <select id="translate-locale-select"></select>
      </label>
      <div class="search-wrap">
        <label class="sr-only" for="translate-search-input">Search strings</label>
        <i class="bi bi-search" aria-hidden="true"></i>
        <input type="search" id="translate-search-input" placeholder="Search strings...">
        <button id="clear-search" type="button" aria-label="Clear search">×</button>
      </div>
      <p id="translate-results-count" class="results-count" aria-live="polite"></p>
    </div>

    <p id="translate-detail-status" class="translate-loading">Loading strings…</p>

    <div class="translate-strings" id="translate-strings"></div>
  </section>

  <section class="translate-mine" id="translate-mine" hidden aria-label="My suggestions">
    <a href="/translate/" class="translate-detail__back"><i class="bi bi-arrow-left" aria-hidden="true"></i> All data packs</a>
    <h2>My Suggestions</h2>
    <div class="translate-detail__tools" role="search">
      <div class="search-wrap">
        <label class="sr-only" for="translate-mine-search-input">Search my suggestions</label>
        <i class="bi bi-search" aria-hidden="true"></i>
        <input type="search" id="translate-mine-search-input" placeholder="Search by text, pack, or language...">
        <button id="translate-mine-clear-search" type="button" aria-label="Clear search">×</button>
      </div>
      <p id="translate-mine-results-count" class="results-count" aria-live="polite"></p>
    </div>
    <p id="translate-mine-status" class="translate-loading">Loading your suggestions…</p>
    <div class="translate-strings" id="translate-mine-list"></div>
  </section>

  <dialog class="translate-modal" id="translate-suggestions-modal">
    <div class="translate-modal__header">
      <h3 id="translate-modal-title">Suggestions</h3>
      <button type="button" class="translate-modal__close" id="translate-modal-close" aria-label="Close"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
    </div>
    <p class="translate-modal__source" id="translate-modal-source"></p>
    <div class="translate-suggestion-list" id="translate-modal-list"></div>
  </dialog>

  <div class="translate-bulk-bar" id="translate-bulk-bar" hidden>
    <span id="translate-bulk-count">0 suggestions ready</span>
    <div class="translate-bulk-bar__actions">
      <button type="button" class="translate-bulk-bar__cancel" id="translate-bulk-cancel">Cancel</button>
      <button type="button" class="translate-bulk-bar__submit" id="translate-bulk-submit">Submit suggestions</button>
    </div>
  </div>

</main>
