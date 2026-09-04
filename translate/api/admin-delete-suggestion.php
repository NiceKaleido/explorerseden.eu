<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
  http_response_code(405);
  echo json_encode(['error' => true, 'message' => 'POST required.']);
  exit;
}

require_admin();
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

  // Unlike withdraw.php (self-service, pending-only), admins can remove any
  // suggestion regardless of owner or current status - including an already
  // accepted one, which puts that key/locale back to having no translation.
  $stmt = $pdo->prepare("UPDATE translation_suggestions SET status = 'withdrawn', decided_at = now() WHERE id = ? RETURNING id");
  $stmt->execute([$suggestionId]);

  if (!$stmt->fetch()) {
    http_response_code(404);
    echo json_encode(['error' => true, 'message' => 'Suggestion not found.']);
    exit;
  }

  echo json_encode(['ok' => true]);
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
