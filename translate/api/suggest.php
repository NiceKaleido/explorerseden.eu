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
$translationKeyId = (int) ($input['translation_key_id'] ?? 0);
$localeCode = trim($input['locale'] ?? '');
$body = trim($input['body'] ?? '');

if ($translationKeyId <= 0 || $localeCode === '' || $body === '') {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'translation_key_id, locale, and body are required.']);
  exit;
}
if (mb_strlen($body) > 2000) {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'Suggestion is too long.']);
  exit;
}

try {
  $pdo = get_pdo();

  $keyStmt = $pdo->prepare('SELECT source_hash FROM translation_keys WHERE id = ? AND removed_at IS NULL');
  $keyStmt->execute([$translationKeyId]);
  $sourceHash = $keyStmt->fetchColumn();
  if ($sourceHash === false) {
    http_response_code(404);
    echo json_encode(['error' => true, 'message' => 'Translation key not found.']);
    exit;
  }

  $localeStmt = $pdo->prepare('SELECT 1 FROM locales WHERE code = ? AND active');
  $localeStmt->execute([$localeCode]);
  if (!$localeStmt->fetchColumn()) {
    http_response_code(400);
    echo json_encode(['error' => true, 'message' => 'Unknown or inactive locale.']);
    exit;
  }

  $insertStmt = $pdo->prepare('
    INSERT INTO translation_suggestions (translation_key_id, locale_code, user_id, body, source_hash_at_submission)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id, status
  ');
  $insertStmt->execute([$translationKeyId, $localeCode, $user['id'], $body, $sourceHash]);
  $row = $insertStmt->fetch();

  echo json_encode(['ok' => true, 'suggestion' => ['id' => (int) $row['id'], 'status' => $row['status']]]);
} catch (PDOException $e) {
  if ($e->getCode() === '23505') { // unique_violation
    http_response_code(409);
    echo json_encode(['error' => true, 'message' => 'You already have a pending suggestion for this string in this language.']);
    exit;
  }
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
