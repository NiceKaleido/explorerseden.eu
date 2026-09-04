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

$input = json_decode(file_get_contents('php://input'), true) ?? [];
$localeCode = trim($input['locale'] ?? '');
$suggestions = is_array($input['suggestions'] ?? null) ? $input['suggestions'] : [];

if ($localeCode === '' || !$suggestions) {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'locale and at least one suggestion are required.']);
  exit;
}
if (count($suggestions) > 200) {
  http_response_code(400);
  echo json_encode(['error' => true, 'message' => 'Too many suggestions in one submission (max 200).']);
  exit;
}

try {
  $pdo = get_pdo();

  $localeStmt = $pdo->prepare('SELECT 1 FROM locales WHERE code = ? AND active');
  $localeStmt->execute([$localeCode]);
  if (!$localeStmt->fetchColumn()) {
    http_response_code(400);
    echo json_encode(['error' => true, 'message' => 'Unknown or inactive locale.']);
    exit;
  }

  $keyStmt = $pdo->prepare('SELECT source_hash FROM translation_keys WHERE id = ? AND removed_at IS NULL');
  $insertStmt = $pdo->prepare('
    INSERT INTO translation_suggestions (translation_key_id, locale_code, user_id, body, source_hash_at_submission)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id, status
  ');

  $results = [];
  foreach ($suggestions as $entry) {
    $translationKeyId = (int) ($entry['translation_key_id'] ?? 0);
    $body = trim($entry['body'] ?? '');

    if ($translationKeyId <= 0 || $body === '') {
      $results[] = ['translationKeyId' => $translationKeyId, 'ok' => false, 'message' => 'Missing key or empty suggestion.'];
      continue;
    }
    if (mb_strlen($body) > 2000) {
      $results[] = ['translationKeyId' => $translationKeyId, 'ok' => false, 'message' => 'Suggestion is too long.'];
      continue;
    }

    $keyStmt->execute([$translationKeyId]);
    $sourceHash = $keyStmt->fetchColumn();
    if ($sourceHash === false) {
      $results[] = ['translationKeyId' => $translationKeyId, 'ok' => false, 'message' => 'Translation key not found.'];
      continue;
    }

    try {
      $insertStmt->execute([$translationKeyId, $localeCode, $user['id'], $body, $sourceHash]);
      $row = $insertStmt->fetch();
      $results[] = ['translationKeyId' => $translationKeyId, 'ok' => true, 'suggestionId' => (int) $row['id']];
    } catch (PDOException $e) {
      if ($e->getCode() === '23505') {
        $results[] = ['translationKeyId' => $translationKeyId, 'ok' => false, 'message' => 'You already have a pending suggestion for this string.'];
      } else {
        $results[] = ['translationKeyId' => $translationKeyId, 'ok' => false, 'message' => $e->getMessage()];
      }
    }
  }

  $submitted = count(array_filter($results, fn($r) => $r['ok']));
  echo json_encode(['ok' => true, 'submitted' => $submitted, 'total' => count($results), 'results' => $results]);
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode(['error' => true, 'message' => $e->getMessage()]);
}
