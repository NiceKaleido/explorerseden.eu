<?php
// Local dev env vars (e.g. for MAMP, which has no easy way to inject real
// env vars). Production sets these as real container env vars and never has
// this file, so file_exists() is the only cost there.
if (file_exists(__DIR__ . '/../../local.env.php')) {
  require_once __DIR__ . '/../../local.env.php';
}

// Shared Postgres connection for the translate/ feature. DATABASE_URL is a
// standard postgres:// URI, e.g. postgres://user:pass@host:5432/dbname.

function get_pdo(): PDO {
  static $pdo = null;
  if ($pdo !== null) {
    return $pdo;
  }

  $url = getenv('DATABASE_URL');
  if (!$url) {
    throw new RuntimeException('DATABASE_URL is not set.');
  }

  $parts = parse_url($url);
  if ($parts === false || !isset($parts['host'], $parts['path'])) {
    throw new RuntimeException('DATABASE_URL is not a valid postgres:// connection string.');
  }

  $host = $parts['host'];
  $port = $parts['port'] ?? 5432;
  $dbname = ltrim($parts['path'], '/');
  $user = isset($parts['user']) ? rawurldecode($parts['user']) : '';
  $pass = isset($parts['pass']) ? rawurldecode($parts['pass']) : '';

  $dsn = "pgsql:host={$host};port={$port};dbname={$dbname}";
  $pdo = new PDO($dsn, $user, $pass, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);

  return $pdo;
}

function get_config(PDO $pdo, string $key, string $default): string {
  $stmt = $pdo->prepare('SELECT value FROM app_config WHERE key = ?');
  $stmt->execute([$key]);
  $value = $stmt->fetchColumn();
  return $value === false ? $default : $value;
}
