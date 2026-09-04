#!/usr/bin/env python3
import json
import os
import re
from pathlib import Path

SOURCE_ROOT = Path(os.environ.get("ENCHANTMENT_SOURCE_ROOT", os.getcwd()))
TARGET_JSON = Path(os.environ.get("TARGET_ENCHANTMENTS_JSON", "enchantments/data/enchantments.json"))
DATAPACK_NAME = os.environ.get("WIKI_DATAPACK_NAME") or os.environ.get("DATAPACK_NAME") or SOURCE_ROOT.name
DATAPACK_URL = os.environ.get("WIKI_DATAPACK_URL") or os.environ.get("DATAPACK_URL") or ""
ITEM_ICON_BASE = os.environ.get("ENCHANTMENT_ITEM_ICON_BASE", "/enchantments/assets/items/")

ROMAN_TO_INT_MAP = {
    "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5,
    "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10,
    "XI": 11, "XII": 12, "XIII": 13, "XIV": 14, "XV": 15,
    "XVI": 16, "XVII": 17, "XVIII": 18, "XIX": 19, "XX": 20,
}

APPLICABLE_NORMALIZATION_MAP = {
    "Any": "Any",
    "Helmet": "Helmet", "Helmets": "Helmet",
    "Chestplate": "Chestplate", "Chestplates": "Chestplate",
    "Leggings": "Leggings",
    "Boot": "Boots", "Boots": "Boots",
    "Elytra": "Elytra",
    "Shield": "Shield", "Shields": "Shield",
    "Sword": "Sword", "Swords": "Sword",
    "Spear": "Spear", "Spears": "Spear",
    "Axe": "Axe", "Axes": "Axe",
    "Pickaxe": "Pickaxe", "Pickaxes": "Pickaxe",
    "Shovel": "Shovel", "Shovels": "Shovel",
    "Hoe": "Hoe", "Hoes": "Hoe",
    "Mace": "Mace", "Maces": "Mace",
    "Trident": "Trident", "Tridents": "Trident",
    "Bow": "Bow", "Bows": "Bow",
    "Crossbow": "Crossbow", "Crossbows": "Crossbow",
    "Fishing Rod": "Fishing Rod", "Fishing Rods": "Fishing Rod",
    "Shears": "Shears",
    "Carrot on a Stick": "Carrot on a Stick",
    "Warped Fungus on a Stick": "Warped Fungus on a Stick",
    "Flint and Steel": "Flint and Steel", "Flint And Steel": "Flint and Steel",
    "Brush": "Brush",
    "Goat Horn": "Goat Horn",
    "Wolf Armor": "Wolf Armor",
    "Horse Armor": "Horse Armor",
    "Harness": "Harness", "Harnesses": "Harness",
    "Saddle": "Saddle", "Saddles": "Saddle",
    "Book": "Book", "Books": "Book",
    "Scroll": "Scroll", "Scrolls": "Scroll",
    "Crown of Roots": "Crown of Roots",
    "Blaze Rod": "Blaze Rod", "Blaze Rods": "Blaze Rod",
}

APPLICABLE_EXPANSION_MAP = {
    "Armor": ["Helmet", "Chestplate", "Leggings", "Boots"],
    "Melee Weapons": ["Sword", "Spear", "Axe"],
    "Tools": ["Axe", "Hoe", "Pickaxe", "Shovel", "Sword", "Spear", "Flint and Steel", "Shears", "Brush"],
}

ITEM_IMAGE_MAP = {
    "Helmet": "helmet.png", "Chestplate": "chestplate.png", "Leggings": "leggings.png", "Boots": "boots.png",
    "Elytra": "elytra.png", "Shield": "shield.png", "Sword": "sword.png", "Spear": "spear.png",
    "Axe": "axe.png", "Pickaxe": "pickaxe.png", "Shovel": "shovel.png", "Hoe": "hoe.png",
    "Mace": "mace.png", "Trident": "trident.png", "Bow": "bow.png", "Crossbow": "crossbow.png",
    "Fishing Rod": "fishing_rod.png", "Shears": "shears.png",
    "Carrot on a Stick": "carrot_on_a_stick.png", "Warped Fungus on a Stick": "warped_fungus_on_a_stick.png",
    "Flint and Steel": "flint_and_steel.png", "Brush": "brush.png", "Goat Horn": "goat_horn.png",
    "Wolf Armor": "wolf_armor.png", "Horse Armor": "horse_armor.png", "Harness": "harness.png",
    "Saddle": "saddle.png", "Book": "enchanted_book_1.png", "Scroll": "scroll.png",
    "Crown of Roots": "crown_of_roots.png", "Blaze Rod": "blaze_rod.png", "Any": None,
}

def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", str(text)).strip()

def strip_formatting(text: str) -> str:
    return re.sub(r"§.", "", str(text)).strip()

def roman_to_int(text: str) -> str:
    s = strip_formatting(text).upper()
    if s.isdigit():
        return str(min(int(s), 20))
    if s in ROMAN_TO_INT_MAP:
        return str(ROMAN_TO_INT_MAP[s])
    return s or "-"

def split_csv_field(text: str):
    text = strip_formatting(text)
    if text in {"-", "–", "—", ""}:
        return "-"
    return ", ".join([normalize_space(part) for part in text.split(",") if normalize_space(part)])

def normalize_applicable_item(item: str) -> str:
    item = normalize_space(strip_formatting(item))
    return APPLICABLE_NORMALIZATION_MAP.get(item, item)

def split_applicable_items(text: str):
    text = strip_formatting(text)
    if text in {"-", "–", "—", ""}:
        return ["Any"]

    expanded = []
    for item in [normalize_space(part) for part in text.split(",") if normalize_space(part)]:
        if item in APPLICABLE_EXPANSION_MAP:
            expanded.extend(APPLICABLE_EXPANSION_MAP[item])
        else:
            expanded.append(normalize_applicable_item(item))

    out = []
    seen = set()
    for item in expanded:
        item = normalize_applicable_item(item)
        if item not in seen:
            out.append(item)
            seen.add(item)
    return out or ["Any"]

def render_applicable_html(items):
    parts = []
    base = ITEM_ICON_BASE.rstrip("/") + "/"
    for item in items:
        image = ITEM_IMAGE_MAP.get(item)
        if image:
            parts.append(f'<img src="{base}{image}" width="32px"/> {item}')
        else:
            parts.append(item)
    return " ".join(parts)

def find_enchantment_sources():
    data_root = SOURCE_ROOT / "data"
    if not data_root.exists():
        return []

    sources = []
    for enchant_dir in data_root.glob("*/enchantment"):
        if not enchant_dir.is_dir():
            continue

        namespace = enchant_dir.parent.name
        lang_path = SOURCE_ROOT / "assets" / namespace / "lang" / "en_us.json"

        if not lang_path.exists():
            print(f"Skipping enchantment namespace {namespace}: missing assets/{namespace}/lang/en_us.json")
            continue

        enchant_files = sorted(enchant_dir.glob("*.json"))
        if enchant_files:
            sources.append((namespace, lang_path, enchant_files))

    return sources

def build_entry(namespace, enchant_id, lang):
    enchant_name = lang.get(f"enchantment.{namespace}.{enchant_id}")
    wiki_text = lang.get(f"wiki.{namespace}.{enchant_id}")

    if not enchant_name or not wiki_text:
        print(f"WARNING: Skipping {namespace}:{enchant_id} (missing lang entry)")
        return None

    cleaned = strip_formatting(wiki_text).replace("\r\n", "\n")
    sections = [part.strip() for part in cleaned.split("\n\n") if part.strip()]

    description = sections[0] if sections else ""
    max_level = "-"
    applicable_to = ["Any"]
    incompatibilities = "-"
    loot_sources = "-"

    for section in sections[1:]:
        section = section.replace("•", "").strip()
        if ":" not in section:
            continue

        label, value = section.split(":", 1)
        label = normalize_space(label).lower()
        value = value.strip()

        if label == "max level":
            max_level = roman_to_int(value)
        elif label == "applicable to":
            applicable_to = split_applicable_items(value)
        elif label in {"incompabilities", "incompatibilities"}:
            incompatibilities = split_csv_field(value)
        elif label == "loot sources":
            loot_sources = split_csv_field(value)

    data_pack = {"name": DATAPACK_NAME}
    if DATAPACK_URL:
        data_pack["url"] = DATAPACK_URL

    return {
        "name": strip_formatting(enchant_name),
        "description": description,
        "maxLevel": max_level,
        "applicableHtml": render_applicable_html(applicable_to),
        "applicableText": ", ".join(applicable_to),
        "incompatibilities": incompatibilities,
        "lootSources": loot_sources,
        "dataPack": data_pack,
    }

def main():
    sources = find_enchantment_sources()
    if not sources:
        print(f"No enchantment info found in {SOURCE_ROOT}; skipping enchantment data update.")
        return 0

    if not TARGET_JSON.exists():
        raise FileNotFoundError(f"Missing target enchantment data file: {TARGET_JSON}")

    target_entries = json.loads(TARGET_JSON.read_text(encoding="utf-8"))
    if not isinstance(target_entries, list):
        raise ValueError(f"{TARGET_JSON} is not a JSON array")

    generated = []
    skipped = []

    for namespace, lang_path, enchant_files in sources:
        lang = json.loads(lang_path.read_text(encoding="utf-8"))
        for enchant_file in enchant_files:
            enchant_id = enchant_file.stem
            try:
                entry = build_entry(namespace, enchant_id, lang)
                if entry:
                    generated.append(entry)
                else:
                    skipped.append(f"{namespace}:{enchant_id}")
            except Exception as exc:
                print(f"WARNING: {namespace}:{enchant_id}: {exc}")
                skipped.append(f"{namespace}:{enchant_id}")

    if not generated:
        print(f"No valid enchantment entries generated for {DATAPACK_NAME}; skipping target update.")
        return 0

    index_by_key = {
        (entry.get("name"), entry.get("dataPack", {}).get("name")): idx
        for idx, entry in enumerate(target_entries)
    }

    updated = 0
    added = 0
    generated_keys = set()

    for entry in generated:
        key = (entry["name"], entry["dataPack"]["name"])
        generated_keys.add(key)

        if key in index_by_key:
            target_entries[index_by_key[key]] = entry
            updated += 1
        else:
            target_entries.append(entry)
            added += 1

    before_count = len(target_entries)
    target_entries = [
        entry for entry in target_entries
        if (
            entry.get("dataPack", {}).get("name") != DATAPACK_NAME
            or (entry.get("name"), entry.get("dataPack", {}).get("name")) in generated_keys
        )
    ]
    removed = before_count - len(target_entries)

    target_entries.sort(key=lambda e: (
        str(e.get("dataPack", {}).get("name", "")).lower(),
        str(e.get("name", "")).lower(),
    ))

    TARGET_JSON.parent.mkdir(parents=True, exist_ok=True)
    TARGET_JSON.write_text(json.dumps(target_entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Updated enchantment data for {DATAPACK_NAME}: {updated} updated, {added} added, {removed} removed, {len(skipped)} skipped.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
