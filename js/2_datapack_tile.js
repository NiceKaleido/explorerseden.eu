//Second Tile
var datapack2 = [
  "https://modrinth.com/datapack/nice-mobs-remastered\"><img src=\"uploads/nmr.png"
, "https://modrinth.com/datapack/nice-villagers-remastered\"><img src=\"uploads/nvr.png"
, "https://modrinth.com/datapack/player-death-reworked\"><img src=\"uploads/pdr.jpg"
, "https://modrinth.com/datapack/hats-on\"><img src=\"uploads/ho.png"
, "https://modrinth.com/datapack/stonecutter-armor-stands\"><img src=\"uploads/sas.png"
, "https://modrinth.com/datapack/halloween-stonecutter-miniblock-recipes\"><img src=\"uploads/halloween_stonecutter.png"
, "https://modrinth.com/datapack/winter-stonecutter-miniblock-recipes\"><img src=\"uploads/winter_stonecutter.png"
];
function getsecondDatapackTag() {
var img = '<a target=\"_blank\" href=\"';
var randomIndex = Math.floor(Math.random() * datapack2.length);
img += datapack2[randomIndex];
img += '\" class=\"img-fluid\" alt=\"Image\">';
return img;
};

document.write(getsecondDatapackTag());