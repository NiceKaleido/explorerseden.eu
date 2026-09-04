<?php
// Discord OAuth2 helpers: code exchange, profile fetch, guild-membership check.
// Mirrors the cURL-with-fallback fetch pattern already used in modrinth-projects.php.

const DISCORD_GUILD_ID = '878270685867311164'; // same guild ID already used in discord.php

function discord_redirect_uri(): string {
  $scheme = (($_SERVER['HTTPS'] ?? '') === 'on' || (getenv('APP_ENV') !== 'local')) ? 'https' : 'http';
  $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
  return "{$scheme}://{$host}/translate/auth/callback.php";
}

function discord_authorize_url(string $state): string {
  $params = [
    'client_id' => getenv('DISCORD_CLIENT_ID'),
    'redirect_uri' => discord_redirect_uri(),
    'response_type' => 'code',
    'scope' => 'identify guilds',
    'state' => $state,
  ];
  return 'https://discord.com/api/oauth2/authorize?' . http_build_query($params);
}

function discord_http_request(string $method, string $url, array $headers = [], ?string $body = null): array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_CONNECTTIMEOUT => 6,
    CURLOPT_TIMEOUT => 12,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_HTTPHEADER => $headers,
  ]);
  if ($body !== null) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
  }
  $response = curl_exec($ch);
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $error = curl_error($ch);
  curl_close($ch);
  if ($response === false) {
    throw new Exception("Discord request to {$url} failed: {$error}");
  }
  return ['status' => $status, 'body' => $response];
}

function discord_exchange_code(string $code): array {
  $body = http_build_query([
    'client_id' => getenv('DISCORD_CLIENT_ID'),
    'client_secret' => getenv('DISCORD_CLIENT_SECRET'),
    'grant_type' => 'authorization_code',
    'code' => $code,
    'redirect_uri' => discord_redirect_uri(),
  ]);
  $res = discord_http_request('POST', 'https://discord.com/api/oauth2/token', [
    'Content-Type: application/x-www-form-urlencoded',
  ], $body);
  if ($res['status'] < 200 || $res['status'] >= 300) {
    throw new Exception('Discord token exchange failed: HTTP ' . $res['status']);
  }
  $decoded = json_decode($res['body'], true);
  if (!is_array($decoded) || !isset($decoded['access_token'])) {
    throw new Exception('Discord token exchange returned an unexpected response.');
  }
  return $decoded;
}

function discord_fetch_user(string $accessToken): array {
  $res = discord_http_request('GET', 'https://discord.com/api/users/@me', [
    "Authorization: Bearer {$accessToken}",
  ]);
  if ($res['status'] < 200 || $res['status'] >= 300) {
    throw new Exception('Fetching Discord user failed: HTTP ' . $res['status']);
  }
  return json_decode($res['body'], true) ?: [];
}

// Returns true if the authorized user (via the 'guilds' scope) is a member
// of the community's Discord server. Only server members may vote/suggest.
function discord_is_guild_member(string $accessToken): bool {
  $res = discord_http_request('GET', 'https://discord.com/api/users/@me/guilds', [
    "Authorization: Bearer {$accessToken}",
  ]);
  if ($res['status'] < 200 || $res['status'] >= 300) {
    throw new Exception('Fetching Discord guilds failed: HTTP ' . $res['status']);
  }
  $guilds = json_decode($res['body'], true) ?: [];
  foreach ($guilds as $guild) {
    if (($guild['id'] ?? null) === DISCORD_GUILD_ID) {
      return true;
    }
  }
  return false;
}
