<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';

$datapackSlug = trim($_GET['datapack'] ?? '');
if ($datapackSlug === '') {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'datapack is required.']);
  exit;
}

try {
  $pdo = get_pdo();
  $user = current_user();
  $userId = $user['id'] ?? null;

  $pendingTtlDays = (int) get_config($pdo, 'pending_ttl_days', '31');
  $acceptThreshold = (int) get_config($pdo, 'auto_accept_threshold', '5');

  // Looked up independently of the suggestions query below so the display
  // name is still correct when a data pack has zero open suggestions (the
  // JOIN in that query would otherwise return no rows to read it from).
  $datapackStmt = $pdo->prepare('SELECT display_name FROM datapacks WHERE slug = ? AND active');
  $datapackStmt->execute([$datapackSlug]);
  $datapackName = $datapackStmt->fetchColumn();
  if ($datapackName === false) {
    http_response_code(404);
    echo json_encode(['error' => true, 'message' => 'Data pack not found.']);
    exit;
  }

  $stmt = $pdo->prepare('
    SELECT
      ts.id, ts.body, ts.status, ts.created_at, ts.locale_code,
      l.native_name AS locale_name,
      d.slug AS datapack_slug, d.display_name AS datapack_name,
      tk.key_path, tk.source_text,
      u.id AS user_id, u.username, u.global_name, u.discord_id,
      COALESCE(SUM(tv.value), 0) AS net_score,
      MAX(CASE WHEN tv.user_id = ? THEN tv.value END) AS my_vote
    FROM translation_suggestions ts
    JOIN translation_keys tk ON tk.id = ts.translation_key_id
    JOIN datapacks d ON d.id = tk.datapack_id
    JOIN locales l ON l.code = ts.locale_code
    JOIN users u ON u.id = ts.user_id
    LEFT JOIN translation_votes tv ON tv.suggestion_id = ts.id
    WHERE d.slug = ? AND ts.status = \'pending\' AND tk.removed_at IS NULL
    GROUP BY ts.id, l.native_name, d.slug, d.display_name, tk.key_path, tk.source_text, u.id, u.username, u.global_name, u.discord_id
    ORDER BY ts.created_at ASC
  ');
  $stmt->execute([$userId, $datapackSlug]);
  $rows = $stmt->fetchAll();

  $result = array_map(fn($r) => [
    'id' => (int) $r['id'],
    'body' => $r['body'],
    'status' => $r['status'],
    'createdAt' => $r['created_at'],
    'netScore' => (int) $r['net_score'],
    'myVote' => $r['my_vote'] !== null ? (int) $r['my_vote'] : null,
    'localeCode' => $r['locale_code'],
    'localeName' => $r['locale_name'],
    'datapackSlug' => $r['datapack_slug'],
    'datapackName' => $r['datapack_name'],
    'keyPath' => $r['key_path'],
    'sourceText' => $r['source_text'],
    'author' => $r['global_name'] ?: $r['username'],
    'isSystem' => str_starts_with((string) $r['discord_id'], 'system:'),
    'isMine' => $userId !== null && (int) $r['user_id'] === (int) $userId,
  ], $rows);

  echo json_encode([
    'suggestions' => $result,
    'datapackName' => $datapackName,
    'pendingTtlDays' => $pendingTtlDays,
    'acceptThreshold' => $acceptThreshold,
  ]);
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
