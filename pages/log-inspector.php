<main id="page-top" class="log-shell">

  <section class="log-hero">
    <img class="log-title-img" src="/assets/images/branding/loginspector_title.png" alt="Log Inspector">
  </section>

  <section class="log-upload-section" id="log-upload-section">
    <div class="log-upload-zone" id="log-upload-zone" tabindex="0" role="button" aria-label="Upload Minecraft log file">
      <input type="file" id="log-file-input" accept=".log,.txt,.gz" aria-hidden="true">
      <i class="bi bi-file-text log-upload-icon"></i>
      <p class="log-upload-label">Drop your log file here, or click to browse</p>
      <p class="log-upload-sub">Accepts <code>.log</code>, <code>.txt</code>, and <code>.log.gz</code> files</p>
      <div class="log-upload-hints">
        <div class="log-hint"><i class="bi bi-display"></i><div><strong>Singleplayer / Client</strong> - Find logs in <code>.minecraft/logs/latest.log</code></div></div>
        <div class="log-hint"><i class="bi bi-hdd-network"></i><div><strong>Server</strong> - Find logs in your server folder under <code>logs/latest.log</code></div></div>
        <div class="log-hint"><i class="bi bi-exclamation-octagon"></i><div><strong>Crash report</strong> - Find these in <code>.minecraft/crash-reports/</code></div></div>
      </div>
    </div>
    <p class="log-privacy-note"><i class="bi bi-shield-lock"></i> Your file never leaves your browser - all analysis happens locally.</p>
  </section>

  <section class="log-results" id="log-results" hidden>
    <!-- populated by log-inspector.js -->
  </section>

</main>
