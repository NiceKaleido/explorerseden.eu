<main id="page-top" class="structures-shell">
  <section class="structures-hero">
    <img class="structures-title-img" src="/assets/images/branding/structures_title.png" alt="Explorer's Eden Structures">
    <div class="structures-controls" aria-label="Structure filters">
      <div class="structure-search-wrap">
        <i class="bi bi-search" aria-hidden="true"></i>
        <input id="structure-search" type="search" placeholder="Search structures..." autocomplete="off">
        <button id="clear-structure-search" type="button" aria-label="Clear search">×</button>
      </div>
      <div class="structure-quick-filters" id="structure-filters" aria-label="Quick data-pack filters"></div>
    </div>
  </section>

  <section class="structures-layout">
    <aside class="structures-sidebar" aria-label="Structure list">
      <button class="structures-sidebar-toggle" type="button" id="structures-sidebar-toggle" aria-expanded="false" aria-controls="structures-sidebar-body">
        <i class="bi bi-list" aria-hidden="true"></i>
        <span>Browse structures</span>
      </button>
      <div class="structures-sidebar-body" id="structures-sidebar-body">
        <ul class="structures-group-list" id="structures-group-list" role="tree" aria-busy="true">
          <li class="structures-empty">Loading…</li>
        </ul>
      </div>
    </aside>

    <article class="structures-detail" id="structures-detail" aria-live="polite">
      <div class="structures-detail-empty" id="structures-detail-empty">
        <i class="bi bi-arrow-left-circle" aria-hidden="true"></i>
        <p>Select a structure from the list to open the 3D viewer.</p>
      </div>
    </article>
  </section>
</main>
<script src="/assets/scripts/structures.js"></script>
