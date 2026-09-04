<?php
require_once __DIR__ . '/../lib/auth.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
  http_response_code(405);
  header('Content-Type: application/json');
  echo json_encode(['error' => true, 'message' => 'POST required.']);
  exit;
}

clear_session_cookie();
header('Content-Type: application/json');
echo json_encode(['ok' => true]);
