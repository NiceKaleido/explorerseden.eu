<?php
require_once __DIR__ . '/db.php';

const SESSION_COOKIE_NAME = 'ee_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SESSION_REFRESH_THRESHOLD = SESSION_TTL_SECONDS / 2;

function signing_key(): string {
  $key = getenv('SESSION_SIGNING_KEY');
  if (!$key) {
    throw new RuntimeException('SESSION_SIGNING_KEY is not set.');
  }
  return $key;
}

function sign(string $payload): string {
  return rtrim(strtr(base64_encode(hash_hmac('sha256', $payload, signing_key(), true)), '+/', '-_'), '=');
}

function b64url_encode(string $data): string {
  return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function b64url_decode(string $data): string|false {
  return base64_decode(strtr($data, '-_', '+/') . str_repeat('=', (4 - strlen($data) % 4) % 4), true);
}

function issue_session_cookie(int $userId): void {
  $payload = json_encode(['uid' => $userId, 'iat' => time(), 'exp' => time() + SESSION_TTL_SECONDS]);
  $encoded = b64url_encode($payload);
  $value = $encoded . '.' . sign($encoded);
  $secure = (getenv('APP_ENV') !== 'local');
  setcookie(SESSION_COOKIE_NAME, $value, [
    'expires' => time() + SESSION_TTL_SECONDS,
    'path' => '/',
    'httponly' => true,
    'secure' => $secure,
    'samesite' => 'Lax',
  ]);
}

function clear_session_cookie(): void {
  setcookie(SESSION_COOKIE_NAME, '', ['expires' => time() - 3600, 'path' => '/']);
}

function read_session_cookie(): ?array {
  $raw = $_COOKIE[SESSION_COOKIE_NAME] ?? null;
  if (!$raw || !str_contains($raw, '.')) {
    return null;
  }
  [$encoded, $sig] = explode('.', $raw, 2);
  if (!hash_equals(sign($encoded), $sig)) {
    return null;
  }
  $payload = b64url_decode($encoded);
  if ($payload === false) {
    return null;
  }
  $data = json_decode($payload, true);
  if (!is_array($data) || !isset($data['uid'], $data['exp']) || $data['exp'] < time()) {
    return null;
  }
  return $data;
}

// Verifies the session cookie proves identity, then re-reads role/ban status
// from Postgres on every call - a moderator ban takes effect immediately
// without needing to invalidate any server-side session store.
function current_user(): ?array {
  static $resolved = false;
  static $user = null;
  if ($resolved) {
    return $user;
  }
  $resolved = true;

  $session = read_session_cookie();
  if (!$session) {
    return null;
  }

  $pdo = get_pdo();
  $stmt = $pdo->prepare('SELECT id, discord_id, username, global_name, avatar_hash, role, banned_at FROM users WHERE id = ?');
  $stmt->execute([$session['uid']]);
  $row = $stmt->fetch();
  if (!$row || $row['banned_at'] !== null) {
    return null;
  }

  if ($session['exp'] - time() < SESSION_REFRESH_THRESHOLD) {
    issue_session_cookie((int) $row['id']);
  }

  $user = $row;
  return $user;
}

function require_auth(): array {
  $user = current_user();
  if (!$user) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => true, 'message' => 'Login required.']);
    exit;
  }
  return $user;
}

function require_admin(): array {
  $user = require_auth();
  if ($user['role'] !== 'admin') {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => true, 'message' => 'Admin only.']);
    exit;
  }
  return $user;
}

function csrf_token(): string {
  $user = current_user();
  $uid = $user['id'] ?? 'anon';
  $day = gmdate('Y-m-d');
  return sign("csrf:{$uid}:{$day}");
}

function require_csrf(): void {
  $user = current_user();
  $uid = $user['id'] ?? 'anon';
  $day = gmdate('Y-m-d');
  $expected = sign("csrf:{$uid}:{$day}");
  $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['csrf_token'] ?? '');
  if (!$provided || !hash_equals($expected, $provided)) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => true, 'message' => 'Invalid or missing CSRF token.']);
    exit;
  }
}

function set_signed_state_cookie(string $name, string $value, int $ttlSeconds): void {
  $encoded = b64url_encode($value);
  $signed = $encoded . '.' . sign($encoded);
  setcookie($name, $signed, [
    'expires' => time() + $ttlSeconds,
    'path' => '/',
    'httponly' => true,
    'secure' => (getenv('APP_ENV') !== 'local'),
    'samesite' => 'Lax',
  ]);
}

function read_signed_state_cookie(string $name): ?string {
  $raw = $_COOKIE[$name] ?? null;
  if (!$raw || !str_contains($raw, '.')) {
    return null;
  }
  [$encoded, $sig] = explode('.', $raw, 2);
  if (!hash_equals(sign($encoded), $sig)) {
    return null;
  }
  $value = b64url_decode($encoded);
  return $value === false ? null : $value;
}
