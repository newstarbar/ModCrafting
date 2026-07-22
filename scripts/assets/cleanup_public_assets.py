import hashlib
import os
import re
import shutil

from mc_assets_config import ROOT

PUBLIC_DIR = os.path.join(ROOT, "src", "renderer", "public")
ITEMS_DIR = os.path.join(PUBLIC_DIR, "items")
ITEMS_TS = os.path.join(ROOT, "src", "renderer", "src", "data", "items.ts")
SPRITES_DIR = os.path.join(ITEMS_DIR, "sprites")


def load_preview_icon_basenames():
    if not os.path.exists(ITEMS_TS):
        return set()
    text = open(ITEMS_TS, encoding="utf-8").read()
    names = set()
    for match in re.finditer(r"previewIcon: 'previews/([^']+)'", text):
        names.add(match.group(1))
    return names


def remove_sprites_dir():
    if not os.path.isdir(SPRITES_DIR):
        return 0
    count = sum(len(files) for _, _, files in os.walk(SPRITES_DIR))
    shutil.rmtree(SPRITES_DIR)
    return count


def remove_duplicate_item_icons(preview_basenames):
    removed = 0
    for name in preview_basenames:
        path = os.path.join(ITEMS_DIR, name)
        if os.path.isfile(path):
            os.remove(path)
            removed += 1
    return removed


def count_content_duplicates():
    hashes = {}
    duplicate_files = 0
    for root, _, files in os.walk(PUBLIC_DIR):
        for name in files:
            if not name.endswith(".png"):
                continue
            path = os.path.join(root, name)
            digest = hashlib.md5(open(path, "rb").read()).hexdigest()
            rel = os.path.relpath(path, PUBLIC_DIR).replace("\\", "/")
            hashes.setdefault(digest, []).append(rel)
    groups = [paths for paths in hashes.values() if len(paths) > 1]
    duplicate_files = sum(len(g) - 1 for g in groups)
    return len(groups), duplicate_files


def cleanup_public_assets():
    preview_basenames = load_preview_icon_basenames()
    sprites_removed = remove_sprites_dir()
    icons_removed = remove_duplicate_item_icons(preview_basenames)
    dup_groups, dup_files = count_content_duplicates()

    remaining_items = len(
        [f for f in os.listdir(ITEMS_DIR) if f.endswith(".png")]
    ) if os.path.isdir(ITEMS_DIR) else 0
    previews = 0
    previews_dir = os.path.join(ITEMS_DIR, "previews")
    if os.path.isdir(previews_dir):
        previews = len([f for f in os.listdir(previews_dir) if f.endswith(".png")])

    blocks = 0
    blocks_dir = os.path.join(PUBLIC_DIR, "blocks")
    if os.path.isdir(blocks_dir):
        blocks = len([f for f in os.listdir(blocks_dir) if f.endswith(".png")])

    print(
        f"Cleanup: removed sprites={sprites_removed}, duplicate item icons={icons_removed}"
    )
    print(f"Remaining: items/*.png={remaining_items}, previews={previews}, blocks={blocks}")
    print(f"Content duplicate groups={dup_groups}, extra files={dup_files} (blocks/ kept)")


if __name__ == "__main__":
    cleanup_public_assets()
