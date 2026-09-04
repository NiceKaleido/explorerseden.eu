<?php
$online = 0;
$response = @file_get_contents('https://discordapp.com/api/guilds/878270685867311164/widget.json');
if ($response !== false) {
    $data = json_decode($response, true);
    if (isset($data['presence_count'])) {
        $online = (int) $data['presence_count'];
    }
}
echo '<span class="nav-counter-text">Discord • <span class="discord-count animated-counter" data-count="' . $online . '">' . $online . '</span> Online</span>';
?>
