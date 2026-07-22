import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FABRIC_VERSIONS_PATH = os.path.join(ROOT, "resources", "fabric-versions.json")


def load_fabric_versions():
    with open(FABRIC_VERSIONS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def get_minecraft_assets_version():
    versions = load_fabric_versions()
    return versions.get("minecraft_assets_version") or versions.get("minecraft_version", "1.21.4")


def get_assets_root():
    version = get_minecraft_assets_version()
    return os.path.join(ROOT, "temp", f"minecraft-assets-{version}")


def get_assets_minecraft_path():
    return os.path.join(get_assets_root(), "assets", "minecraft")


def get_stamp_path():
    return os.path.join(get_assets_root(), ".ready")
