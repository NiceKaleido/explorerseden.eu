<?php
$page = $_GET['page'] ?? trim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
$page = trim($page, '/');

if ($page === '') {
  $page = 'home';
}

$routes = [
  'home' => [
    'title' => "Explorer's Eden: Home",
    'description' => "Explorer's Eden is all about Java Minecraft. We create Data Packs and host a small SMP.",
    'bodyClass' => 'home-page',
    'file' => __DIR__ . '/pages/home.php',
  ],
  'enchantments' => [
    'title' => "Explorer's Eden: Enchantments",
    'description' => "Explorer's Eden enchantment overview for our data packs.",
    'bodyClass' => 'enchantments-page',
    'file' => __DIR__ . '/pages/enchantments.php',
  ],
  'structures' => [
    'title' => "Explorer's Eden: Structures",
    'description' => "Interactive Explorer's Eden structure previews.",
    'bodyClass' => 'structures-page',
    'file' => __DIR__ . '/pages/structures.php',
  ],
  'recipes' => [
    'title' => "Explorer's Eden: Recipes",
    'description' => "Browse all recipes from Explorer's Eden data packs.",
    'bodyClass' => 'recipes-page',
    'file' => __DIR__ . '/pages/recipes.php',
  ],
  'data-pack-configurator' => [
    'title' => "Explorer's Eden: Data Pack Configurator",
    'description' => "Upload a Minecraft data pack ZIP and configure enchantments, mob variants, and structures — all in your browser.",
    'bodyClass' => 'cfg-page',
    'file' => __DIR__ . '/pages/data-pack-configurator.php',
  ],
  'resource-pack' => [
    'title' => "Explorer's Eden: Resource Pack",
    'description' => "Assemble a custom Explorer's Eden resource pack for any supported Minecraft version.",
    'bodyClass' => 'rp-page',
    'file' => __DIR__ . '/pages/resource-pack.php',
  ],
  'profiling' => [
    'title' => "Explorer's Eden: Profiling Inspector",
    'description' => "Turn your Minecraft profiling report into an easy-to-read server performance breakdown.",
    'bodyClass' => 'profiling-page',
    'file' => __DIR__ . '/pages/profiling.php',
  ],
  'log-inspector' => [
    'title' => "Explorer's Eden: Log Inspector",
    'description' => "Upload a Minecraft log file and get a plain-English summary of errors, warnings, and how to fix them.",
    'bodyClass' => 'log-page',
    'file' => __DIR__ . '/pages/log-inspector.php',
  ],
  'translate' => [
    'title' => "Explorer's Eden: Translations",
    'description' => "Help translate Explorer's Eden data packs into your language.",
    'bodyClass' => 'translate-body-page',
    'file' => __DIR__ . '/pages/translate.php',
  ],
  'translate-voting' => [
    'title' => "Explorer's Eden: Translation Voting",
    'description' => "Vote on community-submitted translation suggestions for Explorer's Eden data packs.",
    'bodyClass' => 'translate-body-page',
    'file' => __DIR__ . '/pages/translate-voting.php',
  ],
  'overview' => [
    'title' => "Explorer's Eden: Overview",
    'description' => "A Realm Recrafted SMP overview - live status, connect info, and README.",
    'bodyClass' => 'overview-page',
    'file' => __DIR__ . '/pages/overview.php',
  ],
  'waypoint-hubs' => [
    'title' => "Explorer's Eden: Waypoint Hubs",
    'description' => "Browse the public Waypoint Hubs on the A Realm Recrafted SMP.",
    'bodyClass' => 'waypoint-hubs-page',
    'file' => __DIR__ . '/pages/waypoint-hubs.php',
  ],
  'profile' => [
    'title' => "Explorer's Eden: My Profile",
    'description' => "Your A Realm Recrafted SMP profile - waypoints, claims, advancements and stats.",
    'bodyClass' => 'profile-page',
    'file' => __DIR__ . '/pages/profile.php',
  ],
  'statistics' => [
    'title' => "Explorer's Eden: Statistics",
    'description' => "Community-wide stats for the A Realm Recrafted SMP - totals, leaderboards, and race/class breakdowns.",
    'bodyClass' => 'statistics-page',
    'file' => __DIR__ . '/pages/statistics.php',
  ],
];

if (!isset($routes[$page])) {
  http_response_code(404);
  $page = 'home';
}

$current = $routes[$page];
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <base href="/">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="keywords" content="minecraft, java, smp server, survival, data packs, mods, nice mobs remastered, katters structures, enchantments encore, discord, free">
  <meta name="description" content="<?= htmlspecialchars($current['description'], ENT_QUOTES) ?>">

  <title><?= htmlspecialchars($current['title'], ENT_QUOTES) ?></title>

  <meta property="og:url" content="https://explorerseden.eu">
  <meta property="og:type" content="website">
  <meta property="og:title" content="<?= htmlspecialchars($current['title'], ENT_QUOTES) ?>">
  <meta property="og:description" content="<?= htmlspecialchars($current['description'], ENT_QUOTES) ?>">
  <meta property="og:image" content="https://explorerseden.eu/assets/images/branding/ee_banner_new.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="3000">
  <meta property="og:image:height" content="1000">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://explorerseden.eu/assets/images/branding/ee_banner_new.png">

  <link rel="shortcut icon" href="/assets/images/icons/favicon.ico" type="image/x-icon">
  <link rel="apple-touch-icon" href="/assets/images/icons/apple-touch-icon.png">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Montserrat:wght@500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles/site.css?v=<?php echo filemtime(__DIR__.'/assets/styles/site.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/enchantments.css">
  <link rel="stylesheet" href="/assets/styles/structures.css">
  <link rel="stylesheet" href="/assets/styles/recipes.css">
  <link rel="stylesheet" href="/assets/styles/data-pack-configurator.css?v=<?php echo filemtime(__DIR__.'/assets/styles/data-pack-configurator.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/resource-pack.css?v=<?php echo filemtime(__DIR__.'/assets/styles/resource-pack.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/profiling.css?v=<?php echo filemtime(__DIR__.'/assets/styles/profiling.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/log-inspector.css?v=<?php echo filemtime(__DIR__.'/assets/styles/log-inspector.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/translate.css?v=<?php echo filemtime(__DIR__.'/assets/styles/translate.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/overview.css?v=<?php echo filemtime(__DIR__.'/assets/styles/overview.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/waypoint-hubs.css?v=<?php echo filemtime(__DIR__.'/assets/styles/waypoint-hubs.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/profile.css?v=<?php echo filemtime(__DIR__.'/assets/styles/profile.css'); ?>">
  <link rel="stylesheet" href="/assets/styles/statistics.css?v=<?php echo filemtime(__DIR__.'/assets/styles/statistics.css'); ?>">
</head>
<body class="<?= htmlspecialchars($current['bodyClass'], ENT_QUOTES) ?>">
  <div class="site-bg"></div>
  <div class="starfield" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>

  <header class="navbar">
    <div class="navbar-inner">
      <a class="brand" href="/" aria-label="Explorer's Eden home">
        <img src="/assets/images/branding/ee_title_default.png" alt="Explorer's Eden">
      </a>

      <nav class="nav-links" id="nav-links" aria-label="Main navigation">
        <a target="_blank" rel="noreferrer" href="https://discord.gg/f2pMggfgVv"><i class="bi bi-discord"></i> <?php include ('discord.php'); ?></a>
        <div class="nav-dropdown">
          <button class="nav-dropdown__trigger" type="button" aria-haspopup="true">
            <i class="bi bi-dpad-fill"></i><span class="nav-counter-text">Java SMP • <span class="sip animated-counter" data-ip="play.explorerseden.eu" data-port="25569">0</span> Playing</span> <i class="bi bi-chevron-down nav-dropdown__arrow"></i>
          </button>
          <div class="nav-dropdown__menu" role="menu">
            <a href="/overview/" role="menuitem"><i class="bi bi-info-circle"></i> Overview</a>
            <a href="/statistics/" role="menuitem"><i class="bi bi-bar-chart-fill"></i> Statistics</a>
            <a href="/waypoint-hubs/" role="menuitem"><i class="bi bi-signpost-split"></i> Waypoint Hubs</a>
            <a target="_blank" rel="noreferrer" href="https://map.explorerseden.eu/" role="menuitem"><i class="bi bi-map"></i> World Map</a>
          </div>
        </div>
        <div class="nav-dropdown">
          <button class="nav-dropdown__trigger" type="button" aria-haspopup="true">
            <i class="bi bi-tools"></i> Resources <i class="bi bi-chevron-down nav-dropdown__arrow"></i>
          </button>
          <div class="nav-dropdown__menu" role="menu">
            <a href="/data-pack-configurator/" role="menuitem"><i class="bi bi-sliders"></i> Configurator</a>
            <a href="/resource-pack/" role="menuitem"><i class="bi bi-layers-fill"></i> Resource Pack</a>
            <a href="/profiling/" role="menuitem"><i class="bi bi-activity"></i> Profiling Inspector</a>
            <a href="/log-inspector/" role="menuitem"><i class="bi bi-file-text"></i> Log Inspector</a>
          </div>
        </div>
        <div class="nav-dropdown">
          <button class="nav-dropdown__trigger" type="button" aria-haspopup="true">
            <i class="bi bi-layers"></i> Overviews <i class="bi bi-chevron-down nav-dropdown__arrow"></i>
          </button>
          <div class="nav-dropdown__menu" role="menu">
            <a href="/enchantments/" role="menuitem"><i class="bi bi-magic"></i> Enchantments</a>
            <a href="/structures/" role="menuitem"><i class="bi bi-boxes"></i> Structures</a>
            <a href="/recipes/" role="menuitem"><i class="bi bi-book-half"></i> Recipes</a>
          </div>
        </div>
        <div class="nav-dropdown">
          <button class="nav-dropdown__trigger" type="button" aria-haspopup="true">
            <i class="bi bi-translate"></i> Translations <i class="bi bi-chevron-down nav-dropdown__arrow"></i>
          </button>
          <div class="nav-dropdown__menu" role="menu">
            <a href="/translate/" role="menuitem"><i class="bi bi-list-columns"></i> Overview</a>
            <a href="/translate/voting/" role="menuitem"><i class="bi bi-check2-square"></i> Voting</a>
          </div>
        </div>
        <div class="nav-dropdown">
          <button class="nav-dropdown__trigger" type="button" aria-haspopup="true">
            <i class="bi bi-link-45deg"></i> Links <i class="bi bi-chevron-down nav-dropdown__arrow"></i>
          </button>
          <div class="nav-dropdown__menu" role="menu">
            <a target="_blank" rel="noreferrer" href="https://wiki.explorerseden.eu" role="menuitem"><i class="bi bi-journal-bookmark-fill"></i> Wiki</a>
            <a target="_blank" rel="noreferrer" href="https://modrinth.com/organization/explorers-eden" role="menuitem"><i class="bi bi-gear-fill"></i> Modrinth</a>
            <a target="_blank" rel="noreferrer" href="https://github.com/Explorers-Eden" role="menuitem"><i class="bi bi-github"></i> Github</a>
          </div>
        </div>
      </nav>

      <div class="nav-auth" id="nav-auth"></div>

      <button class="nav-burger" id="nav-burger" type="button" aria-label="Toggle navigation menu" aria-expanded="false" aria-controls="nav-links">
        <i class="bi bi-list" aria-hidden="true"></i>
      </button>
    </div>
  </header>

  <?php include $current['file']; ?>

  <footer class="site-footer">
    Explorer's Eden is in no way affiliated with Minecraft, Mojang AB and/or Notch Development AB.
  </footer>

  <script src="/assets/scripts/site.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/site.js'); ?>"></script>
  <script src="/assets/scripts/site-auth.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/site-auth.js'); ?>"></script>
  <script src="/js/smp_server.js"></script>
  <?php if ($page === 'enchantments'): ?>
    <script src="/enchantments/data/enchantments-data.js"></script>
    <script src="/assets/scripts/enchantments.js"></script>
  <?php elseif ($page === 'recipes'): ?>
    <script src="/assets/scripts/recipes.js"></script>
  <?php elseif ($page === 'data-pack-configurator'): ?>
    <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" crossorigin="anonymous"></script>
    <script src="/assets/scripts/data-pack-configurator.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/data-pack-configurator.js'); ?>"></script>
  <?php elseif ($page === 'resource-pack'): ?>
    <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" crossorigin="anonymous"></script>
    <script src="/assets/scripts/resource-pack-assembler.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/resource-pack-assembler.js'); ?>"></script>
  <?php elseif ($page === 'profiling'): ?>
    <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" crossorigin="anonymous"></script>
    <script src="/assets/scripts/profiling.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/profiling.js'); ?>"></script>
  <?php elseif ($page === 'log-inspector'): ?>
    <script src="/assets/scripts/log-inspector.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/log-inspector.js'); ?>"></script>
  <?php elseif ($page === 'translate'): ?>
    <script src="/assets/scripts/translate.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/translate.js'); ?>"></script>
  <?php elseif ($page === 'translate-voting'): ?>
    <script src="/assets/scripts/translate-voting.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/translate-voting.js'); ?>"></script>
  <?php elseif ($page === 'overview'): ?>
    <script src="/assets/scripts/server-overview.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/server-overview.js'); ?>"></script>
  <?php elseif ($page === 'waypoint-hubs'): ?>
    <script src="/assets/scripts/waypoint-hubs.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/waypoint-hubs.js'); ?>"></script>
  <?php elseif ($page === 'profile'): ?>
    <script src="/assets/scripts/profile.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/profile.js'); ?>"></script>
  <?php elseif ($page === 'statistics'): ?>
    <script src="/assets/scripts/statistics.js?v=<?php echo filemtime(__DIR__.'/assets/scripts/statistics.js'); ?>"></script>
  <?php endif; ?>
</body>
</html>
