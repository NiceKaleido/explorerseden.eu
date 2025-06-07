<?php
$online = json_decode(file_get_contents('https://discordapp.com/api/guilds/878270685867311164/widget.json'), true)['presence_count'];
//echo " Discord • " . $online . " Online";
if ($online >= 1) {
echo " Discord • " . $online . " Online";
}
else {
    echo " Discord";
}
?>

