<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=60');

$dataDir = __DIR__ . '/../data';
$cacheDir = __DIR__ . '/../../assets/cache';
$cacheFile = $cacheDir . '/player-stats-aggregate.json';
$cacheTtl = 300;

if (!is_dir($cacheDir)) {
  @mkdir($cacheDir, 0755, true);
}

if (is_file($cacheFile) && (time() - filemtime($cacheFile) < $cacheTtl)) {
  readfile($cacheFile);
  exit;
}

// The 5 headline metrics shown on a single player's own profile page
// (playerGroup() in profile.js) - mirrored here as community totals plus a
// top-3 leaderboard for each, so the two pages read as the same stats at
// different scales.
const METRICS = [
  'advancementsCompleted' => ['field' => 'advancementsCompleted', 'label' => 'Advancements Completed', 'icon' => 'bi-trophy-fill'],
  'playtimeHours' => ['field' => 'playtimeHours', 'label' => 'Hours Played', 'icon' => 'bi-clock-history'],
  'deaths' => ['field' => 'deaths', 'label' => 'Deaths', 'icon' => 'bi-heartbreak-fill'],
  'mobKillsTotal' => ['field' => 'mobKillsTotal', 'label' => 'Mobs Killed', 'icon' => 'bi-crosshair'],
  'damageDealt' => ['field' => 'damageDealt', 'label' => 'Damage Dealt', 'icon' => 'bi-lightning-charge-fill'],
  'blocksMinedTotal' => ['field' => 'blocksMinedTotal', 'label' => 'Blocks Mined', 'icon' => 'bi-hammer'],
];

// "Damage Dealt" isn't one of the 4 fields on a player's stats summary - it
// only lives inside statsDetailed's General category (as a plain count, via
// the same raw field aggregateDetailedStats() reads) - pulled out here once
// per player so it can be treated like any other top-level metric below.
function damageDealt(array $player): int {
  foreach (($player['statsDetailed'] ?? []) as $cat) {
    if ($cat['category'] !== 'General') continue;
    foreach ($cat['items'] as $item) {
      if ($item['label'] === 'Damage Dealt') {
        return (int) ($item['raw'] ?? 0);
      }
    }
  }
  return 0;
}

// Matches the category order generate-player-profiles.js's STAT_CATEGORY_LABELS
// emits them in, so the combined view reads in the same order as a single
// player's "All Statistics" group.
const STAT_CATEGORY_ORDER = [
  'General', 'Blocks Mined', 'Items Crafted', 'Items Used', 'Items Broken',
  'Items Picked Up', 'Items Dropped', 'Mobs Killed', 'Killed By',
];

// Sums each (category, label) pair's raw value across every player. The raw
// unit isn't stored explicitly, but generate-player-profiles.js's formatted
// "value" string suffix (" h"/" min" for ticks, " blocks" for centimeters)
// is a reliable proxy for it since the same stat id always formats the same
// way - reused here instead of re-deriving units from scratch.
function aggregateDetailedStats(array $players): array {
  $byKey = [];
  foreach ($players as $p) {
    foreach (($p['statsDetailed'] ?? []) as $cat) {
      foreach (($cat['items'] ?? []) as $item) {
        $unit = 'count';
        if (str_ends_with($item['value'], ' h') || str_ends_with($item['value'], ' min')) {
          $unit = 'time';
        } elseif (str_ends_with($item['value'], ' blocks')) {
          $unit = 'distance';
        }
        $key = $cat['category'] . '|' . $item['label'];
        if (!isset($byKey[$key])) {
          $byKey[$key] = ['category' => $cat['category'], 'label' => $item['label'], 'raw' => 0, 'unit' => $unit];
        }
        $byKey[$key]['raw'] += $item['raw'] ?? 0;
      }
    }
  }

  $byCategory = [];
  foreach ($byKey as $entry) {
    if ($entry['unit'] === 'time') {
      $hours = $entry['raw'] / 20 / 3600;
      $value = $hours >= 1
        ? number_format($hours, 1) . ' h'
        : round($entry['raw'] / 20 / 60) . ' min';
    } elseif ($entry['unit'] === 'distance') {
      $value = number_format((int) round($entry['raw'] / 100)) . ' blocks';
    } else {
      $value = number_format((int) $entry['raw']);
    }
    $byCategory[$entry['category']][] = ['label' => $entry['label'], 'value' => $value, 'raw' => $entry['raw']];
  }

  $result = [];
  foreach (STAT_CATEGORY_ORDER as $category) {
    if (empty($byCategory[$category])) continue;
    $items = $byCategory[$category];
    usort($items, fn($a, $b) => $b['raw'] <=> $a['raw']);
    $result[] = [
      'category' => $category,
      'items' => array_map(fn($i) => ['label' => $i['label'], 'value' => $i['value']], $items),
    ];
  }
  return $result;
}

// Counts how many players have each advancement done, grouped by category
// and sorted alphabetically to match generate-player-profiles.js's own
// per-player grouping order.
function aggregateAdvancements(array $players): array {
  $byKey = [];
  foreach ($players as $p) {
    foreach (($p['advancementsDetailed'] ?? []) as $cat) {
      foreach (($cat['items'] ?? []) as $item) {
        $key = $cat['category'] . '|' . $item['label'];
        if (!isset($byKey[$key])) {
          $byKey[$key] = ['category' => $cat['category'], 'label' => $item['label'], 'description' => $item['description'] ?? '', 'count' => 0];
        }
        if (!empty($item['done'])) {
          $byKey[$key]['count']++;
        }
      }
    }
  }

  $byCategory = [];
  foreach ($byKey as $entry) {
    $byCategory[$entry['category']][] = $entry;
  }
  ksort($byCategory, SORT_STRING);

  $result = [];
  foreach ($byCategory as $category => $items) {
    usort($items, fn($a, $b) => $b['count'] <=> $a['count']);
    $result[] = [
      'category' => $category,
      'items' => array_map(fn($i) => ['label' => $i['label'], 'description' => $i['description'], 'count' => $i['count']], $items),
    ];
  }
  return $result;
}

try {
  $files = is_dir($dataDir) ? glob($dataDir . '/*.json') : [];
  $players = [];

  foreach ($files as $file) {
    $decoded = json_decode(file_get_contents($file), true);
    if (!is_array($decoded) || !isset($decoded['stats'])) {
      continue;
    }
    $decoded['damageDealt'] = damageDealt($decoded);
    $players[] = $decoded;
  }

  $totals = [
    'advancementsCompleted' => 0,
    'playtimeHours' => 0,
    'deaths' => 0,
    'mobKillsTotal' => 0,
    'blocksMinedTotal' => 0,
    'damageDealt' => 0,
  ];
  $raceCounts = [];
  $classCounts = [];

  foreach ($players as $p) {
    $totals['advancementsCompleted'] += $p['advancementsCompleted'] ?? 0;
    $totals['playtimeHours'] += $p['stats']['playtimeHours'] ?? 0;
    $totals['deaths'] += $p['stats']['deaths'] ?? 0;
    $totals['mobKillsTotal'] += $p['stats']['mobKillsTotal'] ?? 0;
    $totals['blocksMinedTotal'] += $p['stats']['blocksMinedTotal'] ?? 0;
    $totals['damageDealt'] += $p['damageDealt'];

    if (!empty($p['race'])) {
      $raceCounts[$p['race']] = ($raceCounts[$p['race']] ?? 0) + 1;
    }
    if (!empty($p['class'])) {
      $classCounts[$p['class']] = ($classCounts[$p['class']] ?? 0) + 1;
    }
  }
  $totals['playtimeHours'] = round($totals['playtimeHours'], 1);

  // advancementsCompleted and damageDealt live outside $p['stats'] (top
  // level / derived respectively) - the other 4 metrics live under stats
  // directly. One accessor covers all of them.
  $metricValue = function ($p, $field) {
    if ($field === 'advancementsCompleted') return $p['advancementsCompleted'] ?? 0;
    if ($field === 'damageDealt') return $p['damageDealt'] ?? 0;
    return $p['stats'][$field] ?? 0;
  };

  $leaderboards = [];
  foreach (METRICS as $key => $meta) {
    $field = $meta['field'];
    $sorted = $players;
    usort($sorted, fn($a, $b) => $metricValue($b, $field) <=> $metricValue($a, $field));
    $leaderboards[$key] = array_map(fn($p) => [
      'name' => $p['name'],
      'skinIcon' => $p['skinIcon'] ?? null,
      'headIcon' => $p['headIcon'] ?? null,
      'race' => $p['race'] ?? null,
      'class' => $p['class'] ?? null,
      'value' => $metricValue($p, $field),
    ], array_slice($sorted, 0, 3));
  }

  arsort($raceCounts);
  arsort($classCounts);
  $toDistribution = fn($counts) => array_map(fn($k, $v) => ['label' => $k, 'count' => $v], array_keys($counts), array_values($counts));

  $body = json_encode([
    'playerCount' => count($players),
    'totals' => $totals,
    'leaderboards' => $leaderboards,
    'raceDistribution' => $toDistribution($raceCounts),
    'classDistribution' => $toDistribution($classCounts),
    'statsDetailed' => aggregateDetailedStats($players),
    'advancementsDetailed' => aggregateAdvancements($players),
  ]);

  @file_put_contents($cacheFile, $body);
  echo $body;
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
