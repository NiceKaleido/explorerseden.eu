var imageURLs = [
    "uploads/banner_01.png"
  , "uploads/banner_02.png"
  , "uploads/banner_03.png"
  , "uploads/banner_04.jpg"
  , "uploads/banner_05.jpg"
];
function getBackgroundTag() {
 var img = '<section id=\"home\" class=\"main-banner parallaxie\" style=\"background: url(';
 var randomIndex = Math.floor(Math.random() * imageURLs.length);
 img += imageURLs[randomIndex];
 img += ')\">';
 return img;
};

document.write(getBackgroundTag());
