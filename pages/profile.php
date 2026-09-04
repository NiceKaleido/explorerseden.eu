<?php
require_once __DIR__ . '/../translate/lib/db.php';
require_once __DIR__ . '/../translate/lib/auth.php';

$user = current_user();
if (!$user) {
  header('Location: /translate/auth/login.php?return_to=' . urlencode('/profile/'));
  exit;
}

$profileFile = __DIR__ . '/../profiles/data/' . $user['discord_id'] . '.json';
$hasProfile = is_file($profileFile) && filesize($profileFile) > 0;
?>
<main id="page-top" class="page-shell profile-shell">
  <img class="overview-banner" src="/assets/images/branding/smp_title.png" alt="A Realm Recrafted">

  <?php if (!$hasProfile): ?>
    <section class="profile-empty">
      <i class="bi bi-person-x" aria-hidden="true"></i>
      <h1>No profile yet</h1>
    </section>
  <?php else: ?>
    <div class="profile-groups" id="profile-groups"></div>

    <script type="application/json" id="profile-data"><?php echo file_get_contents($profileFile); ?></script>
  <?php endif; ?>
</main>
