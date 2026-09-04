<?php
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/discord.php';

$state = bin2hex(random_bytes(16));
$returnTo = $_GET['return_to'] ?? '/translate/';
if (!str_starts_with($returnTo, '/')) {
  $returnTo = '/translate/';
}
set_signed_state_cookie('ee_oauth_state', $state . '|' . $returnTo, 600);

header('Location: ' . discord_authorize_url($state));
exit;
