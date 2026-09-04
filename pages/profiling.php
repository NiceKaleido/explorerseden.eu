<main id="page-top" class="prof-shell">

  <section class="prof-hero">
    <img class="prof-title-img" src="/assets/images/branding/profiling_title.png" alt="Explorer's Eden Profiling Inspector">
  </section>

  <section class="prof-upload-section" id="prof-upload-section">
    <div class="prof-upload-zone" id="prof-upload-zone" tabindex="0" role="button" aria-label="Upload profiling ZIP file">
      <input type="file" id="prof-file-input" accept=".zip" aria-hidden="true">
      <i class="bi bi-file-zip prof-upload-icon"></i>
      <p class="prof-upload-label">Drop your profiling <code>.zip</code> here, or click to browse</p>
      <div class="prof-upload-hints">
        <div class="prof-hint"><i class="bi bi-display"></i><div><strong>Singleplayer</strong> - Press <kbd>F3</kbd> + <kbd>L</kbd> in-game to start</div></div>
        <div class="prof-hint"><i class="bi bi-hdd-network"></i><div><strong>Multiplayer</strong> - Run <code>/perf start</code> as an operator, it records for 10 seconds</div></div>
        <div class="prof-hint"><i class="bi bi-folder2-open"></i><div>The ZIP is saved in <code>.minecraft/debug/profiling/</code></div></div>
      </div>
    </div>
    <p class="prof-privacy-note"><i class="bi bi-shield-lock"></i> Your file never leaves your browser - all analysis happens locally.</p>
  </section>

  <section class="prof-results" id="prof-results" hidden>
    <!-- populated by profiling.js -->
  </section>

</main>
