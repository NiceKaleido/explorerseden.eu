<main class="rp-main">

  <div class="rp-hero">
    <img class="rp-hero__img" src="/assets/images/branding/resourcepack_title.png" alt="Resource Pack Assembler">
  </div>

  <div class="rp-card" id="rp-step1">
    <div class="rp-card__label">Minecraft Version</div>
    <div class="rp-version-pills" id="rp-version-pills" role="group" aria-label="Select Minecraft version">
      <span class="rp-loading">Loading versions…</span>
    </div>
  </div>

  <div class="rp-card" id="rp-step2">
    <div class="rp-card__label">Data Packs</div>
    <div class="rp-pack-controls" id="rp-pack-controls" hidden>
      <button type="button" class="rp-text-btn" id="rp-select-all">Select all</button>
      <span class="rp-pack-controls__sep" aria-hidden="true">·</span>
      <button type="button" class="rp-text-btn" id="rp-deselect-all">Deselect all</button>
    </div>
    <div class="rp-pack-grid" id="rp-pack-grid" role="group" aria-label="Select data packs">
      <span class="rp-loading">Loading packs…</span>
    </div>
  </div>

  <div class="rp-download-area" id="rp-download-area">
    <button type="button" class="rp-dl-btn" id="rp-dl-btn" disabled>
      <i class="bi bi-download" aria-hidden="true"></i> Download Resource Pack
    </button>
    <div class="rp-progress" id="rp-progress" hidden>
      <div class="rp-progress__bar-wrap">
        <div class="rp-progress__bar" id="rp-progress-bar" style="width:0%"></div>
      </div>
      <div class="rp-progress__status" id="rp-progress-status"></div>
    </div>
  </div>

  <details class="rp-conflicts" id="rp-conflicts" hidden>
    <summary><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> <span id="rp-conflicts-label">Conflicts (0)</span></summary>
    <ul class="rp-conflicts__list" id="rp-conflicts-list"></ul>
  </details>

</main>
