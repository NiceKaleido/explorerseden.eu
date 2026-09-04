<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';

$datapackSlug = $_GET['datapack'] ?? '';
$localeCode = $_GET['locale'] ?? '';
$offset = max(0, (int) ($_GET['offset'] ?? 0));
// The frontend loads a datapack's full key list in one request (like the
// enchantments table does) and searches/filters client-side rather than
// paginating - some lang files run into the thousands of keys, so the cap
// here is a safety ceiling, not a real page size.
$limit = min(10000, max(1, (int) ($_GET['limit'] ?? 10000)));

if ($datapackSlug === '' || $localeCode === '') {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'datapack and locale are required.']);
  exit;
}

try {
  $pdo = get_pdo();
  $user = current_user();
  $userId = $user['id'] ?? null;

  $keysStmt = $pdo->prepare('
    SELECT tk.id, tk.namespace, tk.key_path, tk.source_text, tk.source_hash
    FROM translation_keys tk
    JOIN datapacks d ON d.id = tk.datapack_id
    WHERE d.slug = ? AND tk.removed_at IS NULL
    ORDER BY tk.namespace, tk.key_path
    OFFSET ? LIMIT ?
  ');
  $keysStmt->execute([$datapackSlug, $offset, $limit]);
  $keys = $keysStmt->fetchAll();

  $pendingTtlDays = (int) get_config($pdo, 'pending_ttl_days', '31');
  $acceptThreshold = (int) get_config($pdo, 'auto_accept_threshold', '5');

  if (!$keys) {
    echo json_encode(['keys' => [], 'pendingTtlDays' => $pendingTtlDays, 'acceptThreshold' => $acceptThreshold]);
    exit;
  }

  $keyIds = array_column($keys, 'id');
  $placeholders = implode(',', array_fill(0, count($keyIds), '?'));

  $suggestionsStmt = $pdo->prepare("
    SELECT
      ts.id, ts.translation_key_id, ts.body, ts.status, ts.source_hash_at_submission,
      ts.created_at, ts.user_id, u.username, u.global_name,
      COALESCE(SUM(tv.value), 0) AS net_score,
      MAX(CASE WHEN tv.user_id = ? THEN tv.value END) AS my_vote
    FROM translation_suggestions ts
    JOIN users u ON u.id = ts.user_id
    LEFT JOIN translation_votes tv ON tv.suggestion_id = ts.id
    WHERE ts.translation_key_id IN ({$placeholders}) AND ts.locale_code = ?
      AND ts.status IN ('pending', 'accepted')
    GROUP BY ts.id, u.username, u.global_name
    ORDER BY ts.status = 'accepted' DESC, net_score DESC, ts.created_at ASC
  ");
  $suggestionsStmt->execute([$userId, ...$keyIds, $localeCode]);
  $suggestions = $suggestionsStmt->fetchAll();

  $byKey = [];
  foreach ($suggestions as $s) {
    $byKey[$s['translation_key_id']][] = $s;
  }

  $result = [];
  foreach ($keys as $key) {
    $keySuggestions = $byKey[$key['id']] ?? [];
    $accepted = null;
    $pending = [];
    foreach ($keySuggestions as $s) {
      $entry = [
        'id' => (int) $s['id'],
        'body' => $s['body'],
        'status' => $s['status'],
        'netScore' => (int) $s['net_score'],
        'myVote' => $s['my_vote'] !== null ? (int) $s['my_vote'] : null,
        'author' => $s['global_name'] ?: $s['username'],
        'createdAt' => $s['created_at'],
        'possiblyOutdated' => $s['source_hash_at_submission'] !== $key['source_hash'],
        'isMine' => $userId !== null && (int) $s['user_id'] === (int) $userId,
      ];
      if ($s['status'] === 'accepted') {
        $accepted = $entry;
      } else {
        $pending[] = $entry;
      }
    }
    $result[] = [
      'id' => (int) $key['id'],
      'namespace' => $key['namespace'],
      'keyPath' => $key['key_path'],
      'sourceText' => $key['source_text'],
      'accepted' => $accepted,
      'pendingSuggestions' => $pending,
    ];
  }

  echo json_encode(['keys' => $result, 'pendingTtlDays' => $pendingTtlDays, 'acceptThreshold' => $acceptThreshold]);
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
