<main id="page-top" class="page-shell">
    <section class="enchantments-overview" aria-label="Enchantments overview">
      <img class="enchantments-overview__logo" src="/assets/images/branding/enchantments_title.png" alt="Explorer's Eden Enchantments">

      <div class="enchantments-overview__tools" role="search">
        <div class="search-wrap">
          <label class="sr-only" for="search-input">Search enchantments</label>
          <i class="bi bi-search" aria-hidden="true"></i>
          <input type="search" id="search-input" placeholder="Search enchantments...">
          <button id="clear-search" type="button" aria-label="Clear search">×</button>
        </div>

        <div class="quick-filters" id="quick-filters" aria-label="Quick enchantment filters"></div>
        <p id="results-count" class="results-count" aria-live="polite">Loading enchantments…</p>
      </div>
    </section>

    <section class="table-card" aria-label="Enchantments table">
      <div class="table-scroll">
        <table class="enchantments-table" id="data-table">
          <thead>
            <tr>
              <th scope="col"><button class="sort-button" type="button" data-sort="name">Name <i class="bi bi-arrow-down-up"></i></button></th>
              <th scope="col">Description</th>
              <th scope="col">Max Level</th>
              <th scope="col">Applicable to</th>
              <th scope="col">Incompatibilities</th>
              <th scope="col">Loot Sources</th>
              <th scope="col">Data Pack</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </main>