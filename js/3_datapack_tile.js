//Third Tile
var datapack3 = [
  "https://modrinth.com/datapack/villager-type-changer\"><img src=\"uploads/type_changer.png"
, "https://modrinth.com/datapack/nice-villager-leashing\"><img src=\"uploads/villager_leashing.png"
, "https://modrinth.com/datapack/nice-rarity-mobs\"><img src=\"uploads/rarity_mobs.png"
, "https://modrinth.com/datapack/nice-swimming-mounts\"><img src=\"uploads/swimming_mounts.png"
, "https://modrinth.com/datapack/nice-horse-stats\"><img src=\"uploads/horse_stats.png"
, "https://modrinth.com/datapack/nice-talking-villager\"><img src=\"uploads/talking_villager.png"
, "https://modrinth.com/datapack/nice-mob-equipment\"><img src=\"uploads/mob_equipment.png"
, "https://modrinth.com/datapack/nice-villager-names\"><img src=\"uploads/villager_names.png"
, "https://modrinth.com/datapack/nice-mob-scaling\"><img src=\"uploads/mob_scaling.png"
, "https://modrinth.com/datapack/nice-wandering-trader-trades\"><img src=\"uploads/trader_trades.png"
, "https://modrinth.com/datapack/nice-village-names\"><img src=\"uploads/village_names.png"
, "https://modrinth.com/datapack/nice-creeper-tweaks\"><img src=\"uploads/creeper_tweaks.png"
, "https://modrinth.com/datapack/nice-huds-and-events\"><img src=\"uploads/huds_events.png"
, "https://modrinth.com/datapack/nice-nitwit-quests\"><img src=\"uploads/nitwit_quests.png"
, "https://modrinth.com/datapack/nice-blockhead-mobs\"><img src=\"uploads/blockhead_mobs.png"
, "https://modrinth.com/datapack/nice-illusioner\"><img src=\"uploads/illusioner.png"
, "https://modrinth.com/datapack/nice-baby-mounts\"><img src=\"uploads/baby_mounts.png"
, "https://modrinth.com/datapack/nice-pig-tweaks\"><img src=\"uploads/pig_tweaks.png"
, "https://modrinth.com/datapack/nice-bat-tweaks\"><img src=\"uploads/bat_tweaks.png"
, "https://modrinth.com/datapack/nice-sitting-players\"><img src=\"uploads/sitting_players.png"
, "https://modrinth.com/datapack/nice-rabbit-tweaks\"><img src=\"uploads/rabbit_tweaks.png"
, "https://modrinth.com/datapack/nice-jeb-sheep\"><img src=\"uploads/jeb_sheep.png"
, "https://modrinth.com/datapack/nice-villager-master-trades\"><img src=\"uploads/master_trades.png"
, "https://modrinth.com/datapack/nice-wandering-trader-announcement\"><img src=\"uploads/trader_announcements.png"
, "https://modrinth.com/datapack/nice-villager-data-command\"><img src=\"uploads/villager_data.png"
, "https://modrinth.com/datapack/nice-end-mobs\"><img src=\"uploads/end_mobs.png"
, "https://modrinth.com/datapack/nice-campfires\"><img src=\"uploads/campfires.png"
, "https://modrinth.com/datapack/nice-keep-inventory\"><img src=\"uploads/keepinv.png"
, "https://modrinth.com/datapack/nice-death-tweaks\"><img src=\"uploads/deathtweaks.png"

];
function getthirdDatapackTag() {
var img = '<a target=\"_blank\" href=\"';
var randomIndex = Math.floor(Math.random() * datapack3.length);
img += datapack3[randomIndex];
img += '\" class=\"img-fluid\" alt=\"Image\">';
return img;
};

document.write(getthirdDatapackTag());