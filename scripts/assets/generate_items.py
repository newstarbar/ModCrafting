import json
import os
import shutil
import sys

from PIL import Image

from mc_assets_config import ROOT, get_assets_minecraft_path

ASSETS_PATH = get_assets_minecraft_path()
OUTPUT_PATH = os.path.join(ROOT, "src", "renderer", "src", "data", "items.ts")
PUBLIC_DIR = os.path.join(ROOT, "src", "renderer", "public")

SHAPE_PARENTS = {
    "slab": "slab",
    "slab_top": "slab",
    "stairs": "stairs",
    "inner_stairs": "stairs",
    "outer_stairs": "stairs",
    "hopper": "hopper",
    "hopper_side": "hopper",
}

CUBE_PARENTS = {"cube_all", "cube", "cube_column", "cube_bottom_top", "cube_mirrored_all"}


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        return None


def normalize_model_id(model_id):
    if model_id.startswith("minecraft:"):
        model_id = model_id.split(":", 1)[1]
    if model_id.startswith("block/"):
        model_id = model_id[6:]
    if model_id.startswith("item/"):
        model_id = model_id[5:]
    return model_id


def resolve_model_full(model_id, kind="block"):
    model_id = normalize_model_id(model_id)
    path = os.path.join(ASSETS_PATH, "models", kind, model_id + ".json")
    model = load_json(path)
    if not model:
        return None, None, []

    textures = {}
    parent_chain = []

    if "parent" in model:
        parent_id = normalize_model_id(model["parent"])
        parent_chain.append(parent_id)
        parent_textures, parent_model, parent_chain_ext = resolve_model_full(parent_id, "block")
        if parent_textures:
            textures.update(parent_textures)
        parent_chain.extend(parent_chain_ext)

    if "textures" in model:
        for key, value in model["textures"].items():
            if isinstance(value, str):
                if value.startswith("#"):
                    ref_key = value[1:]
                    if ref_key in textures:
                        textures[key] = textures[ref_key]
                elif value.startswith("minecraft:"):
                    textures[key] = value.split(":", 1)[1]
                else:
                    textures[key] = value

    return textures, model, parent_chain


def detect_block_shape(parent_chain, model_id):
    names = [normalize_model_id(n) for n in parent_chain]
    names.append(normalize_model_id(model_id))
    for name in reversed(names):
        for key, shape in SHAPE_PARENTS.items():
            if name == key or name.endswith("/" + key):
                return shape
        for cube in CUBE_PARENTS:
            if name == cube or name.endswith("/" + cube):
                return "cube"
    if any("hopper" in n for n in names):
        return "hopper"
    return "other"


def tex_to_filename(tex):
    if not tex:
        return None
    if tex.startswith("block/"):
        return tex[6:] + ".png"
    if tex.startswith("item/"):
        return tex[5:] + ".png"
    return tex + ".png" if not tex.endswith(".png") else tex


def textures_to_faces(textures):
    result = {
        "top": None,
        "bottom": None,
        "north": None,
        "south": None,
        "east": None,
        "west": None,
    }

    if "all" in textures:
        fn = tex_to_filename(textures["all"])
        for face in result:
            result[face] = fn
        return result

    mapping = [
        ("top", ["top", "up", "end"]),
        ("bottom", ["bottom", "down", "end"]),
        ("north", ["north", "side", "front"]),
        ("south", ["south", "side", "front"]),
        ("east", ["east", "side", "front"]),
        ("west", ["west", "side", "front"]),
    ]
    for face, keys in mapping:
        for key in keys:
            if key in textures:
                result[face] = tex_to_filename(textures[key])
                break

    if result["south"] is None:
        result["south"] = result["north"]
    if result["east"] is None:
        result["east"] = result["north"]
    if result["west"] is None:
        result["west"] = result["north"]

    if all(v is None for v in result.values()):
        return None
    return result


def get_item_model_info(item_json):
    if not item_json or "model" not in item_json:
        return None, None
    model_info = item_json["model"]
    if not isinstance(model_info, dict):
        return None, None
    model_value = model_info.get("model")
    if not isinstance(model_value, str):
        return None, None
    if model_value.startswith("minecraft:block/"):
        return "block", model_value[16:]
    if model_value.startswith("minecraft:item/"):
        return "item", model_value[15:]
    return None, None


def is_generated_item_model(item_model_id):
    model_id = normalize_model_id(item_model_id)
    path = os.path.join(ASSETS_PATH, "models", "item", model_id + ".json")
    model = load_json(path)
    if not model:
        return False
    parent = model.get("parent", "")
    return "generated" in parent


def copy_texture(tex_name, src_dirs, dest_dir, copied_textures):
    if not tex_name:
        return False
    cache_key = (dest_dir, tex_name)
    if cache_key in copied_textures:
        return False
    for src_dir in src_dirs:
        src_path = os.path.join(src_dir, tex_name)
        if os.path.exists(src_path):
            os.makedirs(dest_dir, exist_ok=True)
            dest_path = os.path.join(dest_dir, tex_name)
            shutil.copy2(src_path, dest_path)
            copied_textures.add(cache_key)
            return True
    return False


# MC biome colormap tints (plains defaults)
GRASS_COLOR = (124, 189, 107)
FOLIAGE_COLOR = (109, 153, 63)


def tint_colormap(tex_img, color):
    """Apply MC colormap tint (grayscale index texture → color)."""
    tex_img = tex_img.convert("RGBA")
    gray, _, _, alpha = tex_img.split()
    tinted = Image.merge(
        "RGB",
        (
            gray.point(lambda i: color[0] * i // 255),
            gray.point(lambda i: color[1] * i // 255),
            gray.point(lambda i: color[2] * i // 255),
        ),
    )
    tinted.putalpha(alpha)
    return tinted


def apply_texture_tint(tex_img, tex_name):
    if not tex_name:
        return tex_img
    name = tex_name.lower()
    if "grass_block_top" in name or name.endswith("grass_top.png"):
        return tint_colormap(tex_img, GRASS_COLOR)
    if "leaves" in name or "leaf" in name:
        return tint_colormap(tex_img, FOLIAGE_COLOR)
    return tex_img


def load_texture_image(tex_name, block_textures_dir, item_textures_dir):
    for src_dir in (block_textures_dir, item_textures_dir):
        path = os.path.join(src_dir, tex_name)
        if os.path.exists(path):
            img = Image.open(path).convert("RGBA")
            return apply_texture_tint(img, tex_name)
    return Image.new("RGBA", (16, 16), (128, 128, 128, 255))


def pick_primary_texture(face_textures):
    for key in ("top", "north", "south", "east", "west", "bottom"):
        tex = face_textures.get(key)
        if tex:
            return tex
    return None


def compose_flat_preview(shape, face_textures, block_tex_dir, item_tex_dir, size=16):
    primary_name = pick_primary_texture(face_textures)
    if not primary_name:
        return Image.new("RGBA", (size, size), (128, 128, 128, 255))

    tex = load_texture_image(primary_name, block_tex_dir, item_tex_dir)
    tile = tex.resize((size, size), Image.NEAREST)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    if shape == "slab":
        half = size // 2
        slab_bg = Image.new("RGBA", (size, half), (55, 55, 55, 180))
        bottom_strip = tile.resize((size, half), Image.NEAREST)
        canvas.paste(slab_bg, (0, 0))
        canvas.paste(bottom_strip, (0, half), bottom_strip)
    elif shape == "stairs":
        half = size // 2
        bottom = tile.resize((size, half), Image.NEAREST)
        top_right = tile.resize((half, half), Image.NEAREST)
        canvas.paste(bottom, (0, half), bottom)
        canvas.paste(top_right, (half, 0), top_right)
    else:
        canvas.paste(tile, (0, 0))

    return canvas


def load_lang_data(assets_path):
    for name in ("zh_cn.json", "en_us.json"):
        lang_path = os.path.join(assets_path, "lang", name)
        if os.path.isfile(lang_path):
            with open(lang_path, "r", encoding="utf-8") as f:
                return json.load(f)
    return {}


def generate_items():
    items_dir = os.path.join(ASSETS_PATH, "items")
    item_textures_dir = os.path.join(ASSETS_PATH, "textures", "item")
    block_textures_dir = os.path.join(ASSETS_PATH, "textures", "block")

    public_items_dir = os.path.join(PUBLIC_DIR, "items")
    public_blocks_dir = os.path.join(PUBLIC_DIR, "blocks")
    public_previews_dir = os.path.join(public_items_dir, "previews")
    os.makedirs(public_items_dir, exist_ok=True)
    os.makedirs(public_blocks_dir, exist_ok=True)
    os.makedirs(public_previews_dir, exist_ok=True)

    lang_data = load_lang_data(ASSETS_PATH)

    item_files = [f for f in os.listdir(items_dir) if f.endswith(".json")]
    existing_textures = set()
    if os.path.exists(item_textures_dir):
        existing_textures.update(os.listdir(item_textures_dir))
    if os.path.exists(block_textures_dir):
        existing_textures.update(os.listdir(block_textures_dir))

    copied_textures = set()
    src_dirs = [block_textures_dir, item_textures_dir]
    items = []

    for item_file in item_files:
        item_id = item_file.replace(".json", "")
        if item_id.startswith("_") or item_id == "air":
            continue

        full_id = f"minecraft:{item_id}"
        icon_name = item_id + ".png"
        item_json = load_json(os.path.join(items_dir, item_file))

        model_kind, model_ref = get_item_model_info(item_json)
        icon_kind = "flat"
        block_shape = None
        block_textures = None
        preview_icon = None

        if model_kind == "item" and is_generated_item_model(model_ref):
            icon_kind = "flat"
        elif model_kind == "block" and model_ref:
            textures, model, parent_chain = resolve_model_full(model_ref, "block")
            block_shape = detect_block_shape(parent_chain, model_ref)
            block_textures = textures_to_faces(textures) if textures else None

            if block_shape in ("slab", "stairs"):
                icon_kind = block_shape
            elif block_shape == "cube" and block_textures:
                icon_kind = "cube"
            elif block_textures:
                icon_kind = "cube"
                block_shape = "cube"
            else:
                icon_kind = "flat"
                block_textures = None
                block_shape = None

            if block_textures and icon_kind in ("slab", "stairs", "cube", "other"):
                preview_shape = block_shape if block_shape in ("slab", "stairs") else "cube"
                preview_name = item_id.replace(":", "_") + ".png"
                preview_path = os.path.join(public_previews_dir, preview_name)
                preview = compose_flat_preview(
                    preview_shape, block_textures, block_textures_dir, item_textures_dir
                )
                preview.save(preview_path)
                preview_icon = "previews/" + preview_name
                icon_kind = "preview"
        elif model_kind == "item":
            icon_kind = "flat"
        elif os.path.exists(os.path.join(ASSETS_PATH, "models", "block", item_id + ".json")):
            textures, model, parent_chain = resolve_model_full(item_id, "block")
            block_shape = detect_block_shape(parent_chain, item_id)
            block_textures = textures_to_faces(textures) if textures else None
            if block_textures:
                preview_shape = block_shape if block_shape in ("slab", "stairs") else "cube"
                preview_name = item_id.replace(":", "_") + ".png"
                preview_path = os.path.join(public_previews_dir, preview_name)
                preview = compose_flat_preview(
                    preview_shape, block_textures, block_textures_dir, item_textures_dir
                )
                preview.save(preview_path)
                preview_icon = "previews/" + preview_name
                icon_kind = "preview"
                if block_shape not in ("slab", "stairs"):
                    block_shape = "cube"

        if icon_kind == "flat" and icon_name not in existing_textures:
            continue

        name = lang_data.get(f"item.minecraft.{item_id}", "")
        if not name or name == item_id:
            name = lang_data.get(f"block.minecraft.{item_id}", "")
        if not name or name == item_id:
            name = item_id.replace("_", " ")

        item_data = {"id": full_id, "name": name, "icon": icon_name, "iconKind": icon_kind}

        if not preview_icon:
            copy_texture(icon_name, src_dirs, public_items_dir, copied_textures)

        if preview_icon:
            item_data["previewIcon"] = preview_icon
            item_data["iconKind"] = "preview"

        if block_textures and icon_kind in ("cube", "preview", "slab", "stairs", "hopper"):
            block_tex_files = {t for t in block_textures.values() if t}
            for tex_name in block_tex_files:
                copy_texture(tex_name, src_dirs, public_blocks_dir, copied_textures)

            block_textures_updated = {}
            for face in ("top", "bottom", "north", "south", "east", "west"):
                tex_name = block_textures.get(face)
                block_textures_updated[face] = ("blocks/" + tex_name) if tex_name else None

            item_data["isBlock"] = True
            item_data["blockTextures"] = block_textures_updated
            if block_shape:
                item_data["blockShape"] = block_shape if block_shape != "other" else "cube"
            elif icon_kind == "cube":
                item_data["blockShape"] = "cube"

        items.append(item_data)

    items.sort(key=lambda x: x["name"])

    ts_content = '''export interface BlockTextures {
  top: string | null
  bottom: string | null
  north: string | null
  south: string | null
  east: string | null
  west: string | null
}

export type IconKind = 'flat' | 'cube' | 'slab' | 'stairs' | 'hopper' | 'preview' | 'other'
export type BlockShape = 'cube' | 'slab' | 'stairs' | 'hopper'

export interface MinecraftItem {
  id: string
  name: string
  icon: string
  iconKind?: IconKind
  blockShape?: BlockShape
  previewIcon?: string
  isBlock?: boolean
  blockTextures?: BlockTextures
}

export const minecraftItems: MinecraftItem[] = [
'''

    for item in items:
        name_esc = item["name"].replace("'", "\\'")
        ts_item = f"  {{ id: '{item['id']}', name: '{name_esc}', icon: '{item['icon']}'"
        if item.get("iconKind"):
            ts_item += f", iconKind: '{item['iconKind']}'"
        if item.get("previewIcon"):
            ts_item += f", previewIcon: '{item['previewIcon']}'"
        if item.get("blockShape"):
            ts_item += f", blockShape: '{item['blockShape']}'"
        if item.get("isBlock") and item.get("blockTextures"):
            bt = item["blockTextures"]
            ts_item += (
                f", isBlock: true, blockTextures: {{ top: '{bt['top'] or ''}', bottom: '{bt['bottom'] or ''}', "
                f"north: '{bt['north'] or ''}', south: '{bt['south'] or ''}', east: '{bt['east'] or ''}', "
                f"west: '{bt['west'] or ''}' }}"
            )
        ts_item += " },"
        ts_content += ts_item + "\n"

    ts_content += ''']

export function getItemById(id: string): MinecraftItem | undefined {
  return minecraftItems.find(item => item.id === id)
}

export function searchItems(query: string): MinecraftItem[] {
  const lowerQuery = query.toLowerCase()
  return minecraftItems.filter(item =>
    item.name.toLowerCase().includes(lowerQuery) ||
    item.id.toLowerCase().includes(lowerQuery)
  )
}
'''

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(ts_content)

    preview_count = sum(1 for item in items if item.get("previewIcon"))
    block_count = sum(1 for item in items if item.get("isBlock"))
    print(f"Generated {len(items)} items, {block_count} blocks, {preview_count} flat previews")

    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    from cleanup_public_assets import cleanup_public_assets

    cleanup_public_assets()


if __name__ == "__main__":
    generate_items()
