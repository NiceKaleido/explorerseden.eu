<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';

$user = require_auth();

try {
  $pdo = get_pdo();
  $pendingTtlDays = (int) get_config($pdo, 'pending_ttl_days', '31');
  $acceptThreshold = (int) get_config($pdo, 'auto_accept_threshold', '5');

  $stmt = $pdo->prepare('
    SELECT
      ts.id, ts.body, ts.status, ts.created_at, ts.locale_code,
      l.native_name AS locale_name,
      d.slug AS datapack_slug, d.display_name AS datapack_name,
      tk.key_path, tk.source_text,
      COALESCE(SUM(tv.value), 0) AS net_score
    FROM translation_suggestions ts
    JOIN translation_keys tk ON tk.id = ts.translation_key_id
    JOIN datapacks d ON d.id = tk.datapack_id
    JOIN locales l ON l.code = ts.locale_code
    LEFT JOIN translation_votes tv ON tv.suggestion_id = ts.id
    WHERE ts.user_id = ? AND ts.status IN (\'pending\', \'withdrawn\')
    GROUP BY ts.id, l.native_name, d.slug, d.display_name, tk.key_path, tk.source_text
    ORDER BY ts.status = \'pending\' DESC, ts.created_at DESC
  ');
  $stmt->execute([$user['id']]);
  $rows = $stmt->fetchAll();

  $result = array_map(fn($r) => [
    'id' => (int) $r['id'],
    'body' => $r['body'],
    'status' => $r['status'],
    'createdAt' => $r['created_at'],
    'netScore' => (int) $r['net_score'],
    'localeCode' => $r['locale_code'],
    'localeName' => $r['locale_name'],
    'datapackSlug' => $r['datapack_slug'],
    'datapackName' => $r['datapack_name'],
    'keyPath' => $r['key_path'],
    'sourceText' => $r['source_text'],
  ], $rows);

  echo json_encode(['suggestions' => $result, 'pendingTtlDays' => $pendingTtlDays, 'acceptThreshold' => $acceptThreshold]);
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
