<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
  http_response_code(405);
  echo json_encode(['error' => true, 'message' => 'POST required.']);
  exit;
}

$user = require_auth();
require_csrf();

$input = json_decode(file_get_contents('php://input'), true) ?? $_POST;
$suggestionId = (int) ($input['suggestion_id'] ?? 0);
$value = (int) ($input['value'] ?? 0);

if ($suggestionId <= 0 || !in_array($value, [-1, 1], true)) {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'suggestion_id and value (1 or -1) are required.']);
  exit;
}

$pdo = null;
try {
  $pdo = get_pdo();
  $pdo->beginTransaction();

  $lockStmt = $pdo->prepare('SELECT id, translation_key_id, locale_code, status FROM translation_suggestions WHERE id = ? FOR UPDATE');
  $lockStmt->execute([$suggestionId]);
  $suggestion = $lockStmt->fetch();

  if (!$suggestion) {
    $pdo->rollBack();
    http_response_code(404);
    echo json_encode(['error' => true, 'message' => 'Suggestion not found.']);
    exit;
  }
  if ($suggestion['status'] !== 'pending') {
    $pdo->rollBack();
    http_response_code(409);
    echo json_encode(['error' => true, 'message' => 'This suggestion has already been resolved.']);
    exit;
  }

  $existingVoteStmt = $pdo->prepare('SELECT value FROM translation_votes WHERE suggestion_id = ? AND user_id = ?');
  $existingVoteStmt->execute([$suggestionId, $user['id']]);
  $existingValue = $existingVoteStmt->fetchColumn();

  if ($existingValue !== false && (int) $existingValue === $value) {
    // Voting the same direction again toggles the vote off.
    $pdo->prepare('DELETE FROM translation_votes WHERE suggestion_id = ? AND user_id = ?')
      ->execute([$suggestionId, $user['id']]);
  } else {
    $pdo->prepare('
      INSERT INTO translation_votes (suggestion_id, user_id, value) VALUES (?, ?, ?)
      ON CONFLICT (suggestion_id, user_id) DO UPDATE SET value = EXCLUDED.value, created_at = now()
    ')->execute([$suggestionId, $user['id'], $value]);
  }

  $netStmt = $pdo->prepare('SELECT COALESCE(SUM(value), 0) FROM translation_votes WHERE suggestion_id = ?');
  $netStmt->execute([$suggestionId]);
  $netScore = (int) $netStmt->fetchColumn();

  $acceptThreshold = (int) get_config($pdo, 'auto_accept_threshold', '5');
  $declineThreshold = (int) get_config($pdo, 'auto_decline_threshold', '-3');

  $newStatus = 'pending';
  if ($netScore >= $acceptThreshold) {
    $pdo->prepare("
      UPDATE translation_suggestions SET status = 'superseded', decided_at = now()
      WHERE translation_key_id = ? AND locale_code = ? AND status = 'accepted'
    ")->execute([$suggestion['translation_key_id'], $suggestion['locale_code']]);

    $pdo->prepare("UPDATE translation_suggestions SET status = 'accepted', decided_at = now() WHERE id = ?")
      ->execute([$suggestionId]);
    $newStatus = 'accepted';
  } elseif ($netScore <= $declineThreshold) {
    $pdo->prepare("UPDATE translation_suggestions SET status = 'declined', decided_at = now() WHERE id = ?")
      ->execute([$suggestionId]);
    $newStatus = 'declined';
  }

  $pdo->commit();

  echo json_encode(['ok' => true, 'netScore' => $netScore, 'status' => $newStatus]);
} catch (Throwable $e) {
  if ($pdo && $pdo->inTransaction()) {
    $pdo->rollBack();
  }
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
