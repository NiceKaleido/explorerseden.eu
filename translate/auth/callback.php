<?php
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/discord.php';

function fail(string $message): never {
  http_response_code(400);
  echo '<p>' . htmlspecialchars($message, ENT_QUOTES) . ' <a href="/translate/">Go back</a>.</p>';
  exit;
}

$code = $_GET['code'] ?? null;
$state = $_GET['state'] ?? null;
if (!$code || !$state) {
  fail('Missing OAuth code or state.');
}

$stateCookie = read_signed_state_cookie('ee_oauth_state');
if (!$stateCookie || !str_contains($stateCookie, '|')) {
  fail('Your login attempt expired or is invalid. Please try again.');
}
[$expectedState, $returnTo] = explode('|', $stateCookie, 2);
if (!hash_equals($expectedState, $state)) {
  fail('OAuth state mismatch. Please try again.');
}

try {
  $token = discord_exchange_code($code);
  $accessToken = $token['access_token'];

  if (!discord_is_guild_member($accessToken)) {
    fail("You must be a member of Explorer's Eden's Discord server to contribute translations.");
  }

  $profile = discord_fetch_user($accessToken);
  if (!isset($profile['id'])) {
    fail('Could not read your Discord profile.');
  }

  $pdo = get_pdo();
  $stmt = $pdo->prepare('
    INSERT INTO users (discord_id, username, global_name, avatar_hash, last_login_at)
    VALUES (?, ?, ?, ?, now())
    ON CONFLICT (discord_id) DO UPDATE SET
      username = EXCLUDED.username,
      global_name = EXCLUDED.global_name,
      avatar_hash = EXCLUDED.avatar_hash,
      last_login_at = now()
    RETURNING id, banned_at
  ');
  $stmt->execute([
    $profile['id'],
    $profile['username'] ?? $profile['id'],
    $profile['global_name'] ?? null,
    $profile['avatar'] ?? null,
  ]);
  $row = $stmt->fetch();

  if ($row['banned_at'] !== null) {
    fail('Your account has been banned from contributing translations.');
  }

  issue_session_cookie((int) $row['id']);
} catch (Throwable $e) {
  fail('Login failed: ' . $e->getMessage());
}

setcookie('ee_oauth_state', '', ['expires' => time() - 3600, 'path' => '/']);
header('Location: ' . $returnTo);
exit;
