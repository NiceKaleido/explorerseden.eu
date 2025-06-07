var logo = [
  "images/ee_rr_1.png"
, "images/ee_rr_2.png"
, "images/ee_rr_3.png"
, "images/ee_rr_4.png"
];
function getLogoTag() {
var img = '<img width=\"40%\" src=\"';
var randomIndex = Math.floor(Math.random() * logo.length);
img += logo[randomIndex];
img += '\" alt=\"\" />';
return img;
};

document.write(getLogoTag());