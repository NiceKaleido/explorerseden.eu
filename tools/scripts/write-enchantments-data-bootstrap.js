#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const jsonPath = process.env.TARGET_ENCHANTMENTS_JSON || path.join(root, 'enchantments', 'data', 'enchantments.json');
const outPath = process.env.TARGET_ENCHANTMENTS_BOOTSTRAP || path.join(root, 'enchantments', 'data', 'enchantments-data.js');

if (!fs.existsSync(jsonPath)) {
  console.log(`No enchantment JSON found at ${jsonPath}; skipping bootstrap generation.`);
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `window.EXPLORERS_EDEN_ENCHANTMENTS = ${JSON.stringify(data)};\n`, 'utf8');
console.log(`Wrote ${path.relative(root, outPath)} with ${Array.isArray(data) ? data.length : 0} enchantment entries.`);
