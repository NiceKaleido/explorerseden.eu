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

if ($suggestionId <= 0) {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'suggestion_id is required.']);
  exit;
}

try {
  $pdo = get_pdo();

  $stmt = $pdo->prepare('SELECT user_id, status FROM translation_suggestions WHERE id = ?');
  $stmt->execute([$suggestionId]);
  $suggestion = $stmt->fetch();

  if (!$suggestion) {
    http_response_code(404);
    echo json_encode(['error' => true, 'message' => 'Suggestion not found.']);
    exit;
  }
  if ((int) $suggestion['user_id'] !== (int) $user['id']) {
    http_response_code(403);
    echo json_encode(['error' => true, 'message' => 'You can only delete your own suggestions.']);
    exit;
  }
  if ($suggestion['status'] !== 'pending') {
    http_response_code(409);
    echo json_encode(['error' => true, 'message' => 'Only pending suggestions can be deleted.']);
    exit;
  }

  $pdo->prepare("UPDATE translation_suggestions SET status = 'withdrawn', decided_at = now() WHERE id = ?")
    ->execute([$suggestionId]);

  echo json_encode(['ok' => true]);
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
