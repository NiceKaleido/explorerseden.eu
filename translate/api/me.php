<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';

$user = current_user();

if (!$user) {
  echo json_encode(['loggedIn' => false]);
  exit;
}

$avatarUrl = $user['avatar_hash']
  ? "https://cdn.discordapp.com/avatars/{$user['discord_id']}/{$user['avatar_hash']}.png?size=64"
  : '/assets/images/icons/discord-default-avatar.png';

$profileFile = __DIR__ . '/../../profiles/data/' . $user['discord_id'] . '.json';

echo json_encode([
  'loggedIn' => true,
  'user' => [
    'username' => $user['global_name'] ?: $user['username'],
    'role' => $user['role'],
    'discordId' => $user['discord_id'],
    'avatarUrl' => $avatarUrl,
    'hasProfile' => is_file($profileFile),
  ],
  'csrfToken' => csrf_token(),
]);
