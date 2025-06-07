//First Tile
var datapack1 = [
  "https://modrinth.com/datapack/katters-structures\"><img src=\"uploads/ks.png"
, "https://modrinth.com/datapack/enchantments-encore\"><img src=\"uploads/ee.png"
, "https://modrinth.com/datapack/warping-wonders\"><img src=\"uploads/wawo.png"
, "https://modrinth.com/datapack/astral-plane-dimension\"><img src=\"uploads/astral_plane.png"
, "https://modrinth.com/datapack/automaticons\"><img src=\"uploads/am.png"
, "https://modrinth.com/datapack/nice-mobs\"><img src=\"uploads/nice_mobs.png"
];
function getfirstDatapackTag() {
var img = '<a target=\"_blank\" href=\"';
var randomIndex = Math.floor(Math.random() * datapack1.length);
img += datapack1[randomIndex];
img += '\" class=\"img-fluid\" alt=\"Image\">';
return img;
};

document.write(getfirstDatapackTag());
