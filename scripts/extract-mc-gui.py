#!/usr/bin/env python3
"""Extract Minecraft GUI textures from client JAR into src/renderer/src/assets/mc/."""

import argparse
import os
import shutil
import zipfile
from pathlib import Path

from mc_assets_config import get_assets_minecraft_path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "src" / "renderer" / "src" / "assets" / "mc"
ASSETS_PATH = Path(get_assets_minecraft_path())
BLOCK_TEX = ASSETS_PATH / "textures" / "block"

# JAR internal prefix -> output relative path
JAR_EXTRACT_MAP = [
    ("assets/minecraft/textures/gui/sprites/container/slot.png", "container/slot.png"),
    ("assets/minecraft/textures/gui/sprites/container/slot_highlight_back.png", "container/slot_highlight_back.png"),
    ("assets/minecraft/textures/gui/sprites/container/slot_highlight_front.png", "container/slot_highlight_front.png"),
    ("assets/minecraft/textures/gui/sprites/container/crafting_table/crafting_table_background.png", "container/crafting_table_background.png"),
    ("assets/minecraft/textures/gui/sprites/container/crafting_table/crafting_table_overlay.png", "container/crafting_table_overlay.png"),
    ("assets/minecraft/textures/gui/sprites/recipe_book/arrow.png", "recipe_book/arrow.png"),
    ("assets/minecraft/textures/gui/sprites/widget/button.png", "widget/button.png"),
    ("assets/minecraft/textures/gui/sprites/widget/button_highlighted.png", "widget/button_highlighted.png"),
    ("assets/minecraft/textures/gui/sprites/widget/button_disabled.png", "widget/button_disabled.png"),
    ("assets/minecraft/textures/gui/sprites/widget/text_field.png", "widget/text_field.png"),
    ("assets/minecraft/textures/gui/sprites/widget/text_field_highlighted.png", "widget/text_field_highlighted.png"),
    ("assets/minecraft/textures/gui/sprites/widget/tab.png", "widget/tab.png"),
    ("assets/minecraft/textures/gui/sprites/widget/tab_highlighted.png", "widget/tab_highlighted.png"),
    ("assets/minecraft/textures/gui/sprites/widget/tab_selected.png", "widget/tab_selected.png"),
    ("assets/minecraft/textures/gui/sprites/widget/tab_selected_highlighted.png", "widget/tab_selected_highlighted.png"),
    ("assets/minecraft/textures/gui/sprites/popup/background.png", "popup/background.png"),
    ("assets/minecraft/textures/gui/sprites/hud/food_empty.png", "hud/food_empty.png"),
    ("assets/minecraft/textures/gui/sprites/hud/food_full.png", "hud/food_full.png"),
    ("assets/minecraft/textures/gui/sprites/hud/food_half.png", "hud/food_half.png"),
    ("assets/minecraft/textures/gui/sprites/hud/armor_empty.png", "hud/armor_empty.png"),
    ("assets/minecraft/textures/gui/sprites/hud/armor_full.png", "hud/armor_full.png"),
    ("assets/minecraft/textures/gui/sprites/hud/armor_half.png", "hud/armor_half.png"),
    ("assets/minecraft/textures/gui/sprites/hud/experience_bar_background.png", "hud/experience_bar_background.png"),
    ("assets/minecraft/textures/gui/sprites/hud/experience_bar_progress.png", "hud/experience_bar_progress.png"),
    ("assets/minecraft/textures/gui/sprites/container/inventory/effect_background.png", "container/effect_background.png"),
    ("assets/minecraft/textures/gui/sprites/container/inventory/effect_background_ambient.png", "container/effect_background_ambient.png"),
    # Legacy paths (pre-atlas)
    ("assets/minecraft/textures/gui/container/inventory.png", "container/inventory.png"),
    ("assets/minecraft/textures/gui/container/crafting_table.png", "container/crafting_table.png"),
    ("assets/minecraft/textures/gui/widgets.png", "widget/widgets.png"),
    ("assets/minecraft/textures/gui/icons.png", "hud/icons.png"),
]

BLOCK_COPY_MAP = [
    ("dirt.png", "block/dirt.png"),
    ("water_still.png", "block/water_still.png"),
    ("water_flow.png", "block/water_flow.png"),
]

TITLE_COPY = [
    ("panorama_0.png", "title/panorama_0.png"),
]


def find_minecraft_jar():
    candidates = []
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        versions_dir = Path(appdata) / ".minecraft" / "versions"
        if versions_dir.is_dir():
            for version_dir in sorted(versions_dir.iterdir(), reverse=True):
                jar = version_dir / f"{version_dir.name}.jar"
                if jar.is_file():
                    candidates.append(jar)
    return candidates[0] if candidates else None


def extract_from_jar(jar_path: Path) -> int:
    count = 0
    with zipfile.ZipFile(jar_path, "r") as zf:
        names = set(zf.namelist())
        for jar_path_key, out_rel in JAR_EXTRACT_MAP:
            if jar_path_key not in names:
                # Try fuzzy: find file ending with same basename
                basename = Path(jar_path_key).name
                matches = [n for n in names if n.endswith(basename) and "textures/gui" in n]
                if not matches:
                    continue
                jar_path_key = matches[0]
            dest = OUTPUT_DIR / out_rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(jar_path_key) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            count += 1
            print(f"  extracted: {out_rel}")
    return count


def copy_block_textures() -> int:
    count = 0
    for src_name, out_rel in BLOCK_COPY_MAP:
        src = BLOCK_TEX / src_name
        if not src.is_file():
            continue
        dest = OUTPUT_DIR / out_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        count += 1
        print(f"  copied block: {out_rel}")
    return count


def generate_placeholder_slot():
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return 0

    count = 0

    slot_path = OUTPUT_DIR / "container" / "slot.png"
    if not slot_path.is_file():
        slot_path.parent.mkdir(parents=True, exist_ok=True)
        img = Image.new("RGBA", (18, 18), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, 17, 17], fill=((139, 139, 139, 255)))
        draw.rectangle([1, 1, 16, 16], fill=(55, 55, 55, 255))
        draw.rectangle([2, 2, 15, 15], fill=((139, 139, 139, 255)))
        img.save(slot_path)
        count += 1
        print("  generated placeholder: container/slot.png")

    popup_path = OUTPUT_DIR / "popup" / "background.png"
    if not popup_path.is_file():
        popup_path.parent.mkdir(parents=True, exist_ok=True)
        popup = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
        pd = ImageDraw.Draw(popup)
        pd.rectangle([0, 0, 15, 15], fill=(80, 80, 80, 255))
        pd.rectangle([4, 4, 11, 11], fill=(50, 50, 50, 255))
        popup.save(popup_path)
        count += 1
        print("  generated placeholder: popup/background.png")

    for name in ("button.png", "button_highlighted.png", "text_field.png", "text_field_highlighted.png",
                 "tab.png", "tab_highlighted.png", "tab_selected.png", "tab_selected_highlighted.png"):
        widget_path = OUTPUT_DIR / "widget" / name
        if widget_path.is_file():
            continue
        widget_path.parent.mkdir(parents=True, exist_ok=True)
        w = Image.new("RGBA", (12, 12), (0, 0, 0, 0))
        wd = ImageDraw.Draw(w)
        base = (100, 100, 100, 255) if "highlighted" not in name else (140, 140, 140, 255)
        if "selected" in name:
            base = (160, 160, 160, 255)
        wd.rectangle([0, 0, 11, 11], fill=base)
        w.save(widget_path)
        count += 1
        print(f"  generated placeholder: widget/{name}")

    crafting_path = OUTPUT_DIR / "container" / "crafting_table_background.png"
    if not crafting_path.is_file():
        crafting_path.parent.mkdir(parents=True, exist_ok=True)
        ct = Image.new("RGBA", (176, 166), (198, 198, 198, 255))
        ct.save(crafting_path)
        count += 1
        print("  generated placeholder: container/crafting_table_background.png")

    arrow_path = OUTPUT_DIR / "recipe_book" / "arrow.png"
    if not arrow_path.is_file():
        arrow_path.parent.mkdir(parents=True, exist_ok=True)
        arr = Image.new("RGBA", (24, 17), (0, 0, 0, 0))
        ad = ImageDraw.Draw(arr)
        ad.polygon([(4, 4), (20, 8), (4, 12)], fill=(255, 255, 255, 255))
        arr.save(arrow_path)
        count += 1
        print("  generated placeholder: recipe_book/arrow.png")

    for name, color in (("food_full.png", (200, 60, 60)), ("food_half.png", (200, 60, 60)),
                        ("food_empty.png", (80, 80, 80)), ("armor_full.png", (180, 180, 200)),
                        ("armor_half.png", (180, 180, 200)), ("armor_empty.png", (80, 80, 80))):
        hud_path = OUTPUT_DIR / "hud" / name
        if hud_path.is_file():
            continue
        hud_path.parent.mkdir(parents=True, exist_ok=True)
        h = Image.new("RGBA", (9, 9), (0, 0, 0, 0))
        hd = ImageDraw.Draw(h)
        hd.rectangle([1, 1, 7, 7], fill=(*color, 255))
        h.save(hud_path)
        count += 1
        print(f"  generated placeholder: hud/{name}")

    return count


def main():
    parser = argparse.ArgumentParser(description="Extract MC GUI textures")
    parser.add_argument("--jar", type=str, help="Path to Minecraft client JAR")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0

    jar_path = Path(args.jar) if args.jar else find_minecraft_jar()
    if jar_path and jar_path.is_file():
        print(f"Extracting from JAR: {jar_path}")
        total += extract_from_jar(jar_path)
    else:
        print("No Minecraft JAR found; using placeholders and block texture copies.")

    total += copy_block_textures()
    total += generate_placeholder_slot()

    print(f"Done. {total} assets in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
