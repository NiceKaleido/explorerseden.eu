<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=300');

$cacheDir = __DIR__ . '/assets/cache';
$cacheFile = $cacheDir . '/modrinth-projects.json';
$cacheTtl = 900;

if (!is_dir($cacheDir)) {
  @mkdir($cacheDir, 0755, true);
}

if (is_file($cacheFile) && (time() - filemtime($cacheFile) < $cacheTtl)) {
  readfile($cacheFile);
  exit;
}

function loadModrinthSlugs($yamlPath) {
  $slugs = [];
  foreach (file($yamlPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
    $line = trim($line);
    if ($line === '' || $line[0] === '#') continue;
    $pos = strpos($line, ':');
    if ($pos === false) continue;
    $slugs[] = trim(substr($line, 0, $pos));
  }
  return $slugs;
}

$slugs = loadModrinthSlugs(__DIR__ . '/tools/modrinth_projects.yml');

$endpoint = 'https://api.modrinth.com/v2/projects?ids=' . rawurlencode(json_encode($slugs));
$userAgent = 'ExplorersEdenWebsite/1.1 (https://explorerseden.eu)';

function fetch_url($url, $userAgent) {
  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_FOLLOWLOCATION => true,
      CURLOPT_CONNECTTIMEOUT => 6,
      CURLOPT_TIMEOUT => 12,
      CURLOPT_SSL_VERIFYPEER => true,
      CURLOPT_HTTPHEADER => [
        'Accept: application/json',
        'User-Agent: ' . $userAgent
      ]
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($body !== false && $status >= 200 && $status < 300) {
      return $body;
    }
    throw new Exception('Modrinth request failed: HTTP ' . $status . ' ' . $error);
  }

  $context = stream_context_create([
    'http' => [
      'method' => 'GET',
      'header' => "Accept: application/json\r\nUser-Agent: {$userAgent}\r\n",
      'timeout' => 12
    ]
  ]);

  $body = @file_get_contents($url, false, $context);
  if ($body !== false) {
    return $body;
  }
  throw new Exception('Modrinth request failed.');
}

try {
  $body = fetch_url($endpoint, $userAgent);
  $decoded = json_decode($body);
  if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
    throw new Exception('Invalid JSON returned by Modrinth.');
  }
  @file_put_contents($cacheFile, $body);
  echo $body;
} catch (Throwable $e) {
  http_response_code(502);
  echo json_encode([
    'error' => true,
    'message' => $e->getMessage()
  ]);
}
