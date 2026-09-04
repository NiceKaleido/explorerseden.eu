<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../lib/db.php';

$cacheDir = __DIR__ . '/../../assets/cache';
$cacheFile = $cacheDir . '/translate-progress.json';
$cacheTtl = 60;

if (!is_dir($cacheDir)) {
  @mkdir($cacheDir, 0755, true);
}

if (is_file($cacheFile) && (time() - filemtime($cacheFile) < $cacheTtl)) {
  header('Cache-Control: public, max-age=60');
  readfile($cacheFile);
  exit;
}

try {
  $pdo = get_pdo();
  $rows = $pdo->query('
    SELECT
      d.slug AS datapack_slug,
      d.display_name AS datapack_name,
      l.code AS locale_code,
      l.english_name AS locale_english_name,
      l.native_name AS locale_native_name,
      count(tk.id) FILTER (WHERE tk.id IS NOT NULL) AS total_keys,
      count(ts.id) FILTER (WHERE ts.status = \'accepted\') AS translated_keys
    FROM datapacks d
    CROSS JOIN locales l
    LEFT JOIN translation_keys tk ON tk.datapack_id = d.id AND tk.removed_at IS NULL
    LEFT JOIN translation_suggestions ts
      ON ts.translation_key_id = tk.id AND ts.locale_code = l.code AND ts.status = \'accepted\'
    WHERE d.active AND l.active
    GROUP BY d.slug, d.display_name, l.code, l.english_name, l.native_name
    ORDER BY d.display_name, l.english_name
  ')->fetchAll();

  $datapacks = [];
  foreach ($rows as $row) {
    $slug = $row['datapack_slug'];
    if (!isset($datapacks[$slug])) {
      $datapacks[$slug] = [
        'slug' => $slug,
        'displayName' => $row['datapack_name'],
        'totalKeys' => (int) $row['total_keys'],
        'locales' => [],
      ];
    }
    $total = (int) $row['total_keys'];
    $translated = (int) $row['translated_keys'];
    $datapacks[$slug]['locales'][] = [
      'code' => $row['locale_code'],
      'englishName' => $row['locale_english_name'],
      'nativeName' => $row['locale_native_name'],
      'translated' => $translated,
      'total' => $total,
      'percent' => $total > 0 ? round(100 * $translated / $total, 1) : 0,
    ];
  }

  $body = json_encode(['datapacks' => array_values($datapacks)]);
  @file_put_contents($cacheFile, $body);
  header('Cache-Control: public, max-age=60');
  echo $body;
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
