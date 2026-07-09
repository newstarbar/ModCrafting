#!/usr/bin/env python3
"""Ensure MC client assets, generate item previews, and refresh GUI placeholders."""

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from ensure_minecraft_assets import ensure_minecraft_assets
from generate_items import generate_items


def main():
    force = "--force" in sys.argv
    ensure_minecraft_assets(force=force)
    generate_items()

    extract_script = os.path.join(SCRIPT_DIR, "extract-mc-gui.py")
    if os.path.isfile(extract_script):
        import subprocess

        subprocess.run([sys.executable, extract_script], check=True)


if __name__ == "__main__":
    main()
