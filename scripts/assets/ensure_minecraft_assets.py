#!/usr/bin/env python3
"""Download Minecraft client JAR and extract assets for item preview generation."""

import hashlib
import json
import os
import shutil
import sys
import urllib.error
import urllib.request
import zipfile

from mc_assets_config import (
    get_assets_minecraft_path,
    get_assets_root,
    get_minecraft_assets_version,
    get_stamp_path,
    load_fabric_versions,
)

MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ModCrafting/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def download_file(url, dest_path):
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "ModCrafting/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(dest_path, "wb") as out:
        shutil.copyfileobj(resp, out)


def resolve_client_url(version_id):
    manifest = fetch_json(MANIFEST_URL)
    versions = manifest.get("versions", [])
    by_id = {entry["id"]: entry for entry in versions}

    candidates = [version_id]
    fabric = load_fabric_versions()
    mc_version = fabric.get("minecraft_version")
    if mc_version and mc_version not in candidates:
        candidates.append(mc_version)

    for candidate in candidates:
        entry = by_id.get(candidate)
        if not entry:
            continue
        detail = fetch_json(entry["url"])
        client_url = detail.get("downloads", {}).get("client", {}).get("url")
        if client_url:
            return candidate, client_url, detail.get("downloads", {}).get("client", {}).get("sha1")

    raise RuntimeError(f"无法在 Mojang 版本清单中找到客户端: {candidates}")


def stamp_valid(version_id, jar_sha1):
    stamp_path = get_stamp_path()
    if not os.path.isfile(stamp_path):
        return False
    try:
        with open(stamp_path, "r", encoding="utf-8") as f:
            stamp = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False

    items_dir = os.path.join(get_assets_minecraft_path(), "items")
    if not os.path.isdir(items_dir):
        return False
    if stamp.get("version") != version_id:
        return False
    if jar_sha1 and stamp.get("jar_sha1") != jar_sha1:
        return False
    return True


def write_stamp(version_id, jar_sha1):
    with open(get_stamp_path(), "w", encoding="utf-8") as f:
        json.dump({"version": version_id, "jar_sha1": jar_sha1}, f, indent=2)


def extract_jar(jar_path, assets_minecraft):
    os.makedirs(assets_minecraft, exist_ok=True)
    prefix = "assets/minecraft/"
    data_items_prefix = "data/minecraft/items/"
    copied = 0

    with zipfile.ZipFile(jar_path, "r") as zf:
        for name in zf.namelist():
            if name.startswith(prefix) and not name.endswith("/"):
                rel = name[len(prefix) :]
                dest = os.path.join(assets_minecraft, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(name) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                copied += 1

        items_dir = os.path.join(assets_minecraft, "items")
        if not os.path.isdir(items_dir) or not os.listdir(items_dir):
            for name in zf.namelist():
                if not name.startswith(data_items_prefix) or name.endswith("/"):
                    continue
                rel = name[len("data/minecraft/") :]
                dest = os.path.join(assets_minecraft, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(name) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                copied += 1

    return copied


def sha1_file(path):
    digest = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_zh_cn_lang(version_id, assets_minecraft):
    lang_dir = os.path.join(assets_minecraft, "lang")
    zh_path = os.path.join(lang_dir, "zh_cn.json")
    if os.path.isfile(zh_path):
        return

    url = f"https://assets.mcasset.cloud/{version_id}/assets/minecraft/lang/zh_cn.json"
    os.makedirs(lang_dir, exist_ok=True)
    try:
        print(f"Downloading zh_cn language pack for {version_id}...")
        download_file(url, zh_path)
        with open(zh_path, "r", encoding="utf-8") as f:
            json.load(f)
    except (OSError, json.JSONDecodeError, urllib.error.URLError) as err:
        if os.path.isfile(zh_path):
            os.remove(zh_path)
        print(f"Warning: failed to download zh_cn.json ({err}), will fall back to en_us")


def ensure_minecraft_assets(force=False):
    version_id = get_minecraft_assets_version()
    resolved_id, client_url, jar_sha1 = resolve_client_url(version_id)
    assets_root = get_assets_root()
    assets_minecraft = get_assets_minecraft_path()

    if not force and stamp_valid(resolved_id, jar_sha1):
        download_zh_cn_lang(resolved_id, assets_minecraft)
        print(f"Minecraft assets already ready: {assets_root}")
        return

    jar_dir = os.path.join(ROOT, "temp", "_minecraft_jars")
    os.makedirs(jar_dir, exist_ok=True)
    jar_path = os.path.join(jar_dir, f"{resolved_id}.jar")

    print(f"Downloading Minecraft client {resolved_id}...")
    download_file(client_url, jar_path)

    actual_sha1 = sha1_file(jar_path)
    if jar_sha1 and actual_sha1 != jar_sha1:
        raise RuntimeError(f"JAR sha1 mismatch: expected {jar_sha1}, got {actual_sha1}")

    if os.path.isdir(assets_root):
        shutil.rmtree(assets_root)
    os.makedirs(assets_minecraft, exist_ok=True)

    count = extract_jar(jar_path, assets_minecraft)
    download_zh_cn_lang(resolved_id, assets_minecraft)
    write_stamp(resolved_id, actual_sha1)
    print(f"Extracted {count} files to {assets_minecraft}")


if __name__ == "__main__":
    force = "--force" in sys.argv
    ensure_minecraft_assets(force=force)
