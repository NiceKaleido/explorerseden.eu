<main id="page-top" class="cfg-shell">

  <section class="cfg-hero">
    <img class="cfg-title-img" src="/assets/images/branding/configurator_title.png"
         alt="Explorer's Eden Data Pack Configurator">
  </section>

  <!-- Upload zone - visible until a ZIP is loaded -->
  <section class="cfg-upload-zone" id="cfg-upload-zone" aria-label="Upload data pack">
    <i class="bi bi-file-earmark-zip cfg-upload-zone__icon" aria-hidden="true"></i>
    <p class="cfg-upload-zone__label">Drop a data pack <code>.zip</code> here, or click to browse</p>
    <p class="cfg-upload-zone__version">Supports Minecraft versions starting with 1.21</p>
    <p class="cfg-upload-zone__desc">Configure <strong>enchantment weights &amp; loot sources</strong>, <strong>mob variant spawns</strong>, <strong>structure biomes</strong>, <strong>structure set spacing</strong>, and <strong>villager trade payments &amp; assignments</strong> - then download the modified pack.</p>
    <input type="file" id="cfg-file-input" accept=".zip" class="sr-only" aria-label="Choose ZIP file">
  </section>
  <p class="prof-privacy-note">
    <i class="bi bi-shield-check" aria-hidden="true"></i>
    Processed entirely in your browser - nothing is uploaded to our servers.
  </p>

  <!-- Status bar (loading / error) -->
  <div class="cfg-status" id="cfg-status" hidden>
    <div class="cfg-status__loading" id="cfg-loading" hidden>
      <span class="cfg-spinner" aria-hidden="true"></span>
      <span id="cfg-loading-msg">Parsing ZIP…</span>
    </div>
    <div class="cfg-status__error" id="cfg-error" hidden role="alert">
      <i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>
      <span id="cfg-error-msg"></span>
    </div>
  </div>

  <!-- Editor - hidden until a ZIP is successfully parsed -->
  <section class="cfg-editor" id="cfg-editor" hidden aria-label="Configurator editor">

    <!-- Pack info / action bar -->
    <div class="cfg-pack-bar" id="cfg-pack-bar">
      <div class="cfg-pack-bar__info">
        <span class="cfg-pack-bar__name" id="cfg-pack-name"></span>
      </div>
      <div class="cfg-pack-bar__actions">
        <span class="cfg-pack-bar__version" id="cfg-pack-version"></span>
        <button type="button" class="cfg-pack-bar__reset" id="cfg-reset-btn" title="Load a different pack">
          <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i> Load different pack
        </button>
        <button type="button" class="cfg-download-btn" id="cfg-download-btn">
          <i class="bi bi-download" aria-hidden="true"></i> Download configured pack
        </button>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="cfg-tabs" role="tablist" aria-label="Configurator sections">
      <button type="button" class="cfg-tab-btn is-active" role="tab"
              data-tab="enchantments" aria-selected="true" aria-controls="cfg-panel-enchantments">
        <i class="bi bi-magic" aria-hidden="true"></i>
        <span class="cfg-tab-label-wrap">Enchantments
          <span class="cfg-tab-tooltip" role="tooltip">
            Change the loot sources and weight of enchantments from the uploaded data pack.
            <span class="cfg-tab-tooltip__note">
              <i class="bi bi-info-circle" aria-hidden="true"></i>
              Doesn't apply to hardcoded enchantments in loot sources.
            </span>
          </span>
        </span>
        <span class="cfg-tab-count" id="cfg-count-enchantments">0</span>
      </button>
      <button type="button" class="cfg-tab-btn" role="tab"
              data-tab="mob-variants" aria-selected="false" aria-controls="cfg-panel-mob-variants">
        <i class="bi bi-bug" aria-hidden="true"></i>
        <span class="cfg-tab-label-wrap">Mob Variants
          <span class="cfg-tab-tooltip" role="tooltip">
            Change the structures and biomes that data-driven mobs from the uploaded data pack can spawn in.
            <span class="cfg-tab-tooltip__note">
              <i class="bi bi-info-circle" aria-hidden="true"></i>
              Changing these values doesn't affect general mob spawning behaviour. For example: cats don't spawn in the Nether in vanilla Minecraft regardless of this setting.
            </span>
          </span>
        </span>
        <span class="cfg-tab-count" id="cfg-count-mob-variants">0</span>
      </button>
      <button type="button" class="cfg-tab-btn" role="tab"
              data-tab="structures" aria-selected="false" aria-controls="cfg-panel-structures">
        <i class="bi bi-boxes" aria-hidden="true"></i>
        <span class="cfg-tab-label-wrap">Structures
          <span class="cfg-tab-tooltip" role="tooltip">
            Change the biomes in which structures from the uploaded data pack can generate.
          </span>
        </span>
        <span class="cfg-tab-count" id="cfg-count-structures">0</span>
      </button>
      <button type="button" class="cfg-tab-btn" role="tab"
              data-tab="structure-sets" aria-selected="false" aria-controls="cfg-panel-structure-sets">
        <i class="bi bi-grid-3x3-gap" aria-hidden="true"></i>
        <span class="cfg-tab-label-wrap">Structure Sets
          <span class="cfg-tab-tooltip" role="tooltip">
            Change the spacing between Structure Sets generating in your world.
          </span>
        </span>
        <span class="cfg-tab-count" id="cfg-count-structure-sets">0</span>
      </button>
      <button type="button" class="cfg-tab-btn" role="tab"
              data-tab="villager-trades" aria-selected="false" aria-controls="cfg-panel-villager-trades">
        <i class="bi bi-person-badge" aria-hidden="true"></i>
        <span class="cfg-tab-label-wrap">Villager Trades
          <span class="cfg-tab-tooltip" role="tooltip">
            Change the payment items and amounts for trades from the uploaded data pack, and reassign them to different villager professions and levels.
            <span class="cfg-tab-tooltip__note">
              <i class="bi bi-info-circle" aria-hidden="true"></i>
              Only affects trades defined in this data pack, not vanilla villager trades.
            </span>
          </span>
        </span>
        <span class="cfg-tab-count" id="cfg-count-villager-trades">0</span>
      </button>
    </div>

    <!-- ── Enchantments panel ─────────────────────────────────── -->
    <div class="cfg-tab-panel" id="cfg-panel-enchantments"
         data-tab="enchantments" role="tabpanel">
      <div class="cfg-table-card">
        <div class="cfg-table-scroll">
          <table class="cfg-ench-table" id="cfg-ench-table">
            <thead>
              <tr>
                <th scope="col">Enchantment</th>
                <th scope="col">Weight</th>
                <th scope="col" title="in_enchanting_table">Ench. Table</th>
                <th scope="col" title="on_mob_spawn_equipment">Mob Equip.</th>
                <th scope="col" title="on_random_loot">Random Loot</th>
                <th scope="col" title="on_traded_equipment">Traded Equip.</th>
                <th scope="col" title="tradeable">Tradeable</th>
                <th scope="col" title="treasure">Treasure</th>
              </tr>
            </thead>
            <tbody id="cfg-ench-tbody">
              <tr class="cfg-empty-row"><td colspan="8">No enchantments found in this pack.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── Mob Variants panel ─────────────────────────────────── -->
    <div class="cfg-tab-panel" id="cfg-panel-mob-variants"
         data-tab="mob-variants" role="tabpanel" hidden>
      <div class="cfg-mob-body" id="cfg-mob-body">
        <p class="cfg-empty-msg">No mob variants found in this pack.</p>
      </div>
    </div>

    <!-- ── Structures panel ───────────────────────────────────── -->
    <div class="cfg-tab-panel" id="cfg-panel-structures"
         data-tab="structures" role="tabpanel" hidden>
      <div class="cfg-struct-body" id="cfg-struct-body">
        <p class="cfg-empty-msg">No structures found in this pack.</p>
      </div>
    </div>

    <!-- ── Structure Sets panel ──────────────────────────────── -->
    <div class="cfg-tab-panel" id="cfg-panel-structure-sets"
         data-tab="structure-sets" role="tabpanel" hidden>
      <div class="cfg-struct-body" id="cfg-struct-set-body">
        <p class="cfg-empty-msg">No structure sets found in this pack.</p>
      </div>
    </div>

    <!-- ── Villager Trades panel ──────────────────────────────── -->
    <div class="cfg-tab-panel" id="cfg-panel-villager-trades"
         data-tab="villager-trades" role="tabpanel" hidden>
      <div class="cfg-struct-body" id="cfg-trades-body">
        <p class="cfg-empty-msg">No villager trades found in this pack.</p>
      </div>
    </div>

  </section>

  <!-- Shared datalist for vanilla item IDs (populated by JS after pack-data loads) -->
  <datalist id="cfg-item-datalist"></datalist>

  <!-- Picker dropdown (shared, positioned by JS) -->
  <div class="cfg-picker" id="cfg-picker" hidden role="dialog" aria-modal="true" aria-label="Choose values">
    <div class="cfg-picker__search-wrap">
      <i class="bi bi-search" aria-hidden="true"></i>
      <input type="search" id="cfg-picker-search" placeholder="Search…" autocomplete="off">
    </div>
    <ul class="cfg-picker__list" id="cfg-picker-list" role="listbox" aria-multiselectable="true"></ul>
  </div>

</main>
