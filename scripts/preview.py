#!/usr/bin/env python3
"""Regenerates preview.png: the sidebar drawn by Herdr itself, showing example sessions.

Needs the Herdr app running with this mod installed, and Pillow. The command
`agent-sidebar.demo` opens a copy of the sidebar with the sessions of
mods/agent-sidebar/demo.js; this takes a shot of the window, cuts that copy out of it and
rounds its corners, so nothing of the window behind it is in the picture.
"""
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RADIUS = 24


def app(*args):
    subprocess.run(["herdr-app", *args], check=True, stdout=subprocess.DEVNULL)


def close(a, b, tolerance=10):
    return all(abs(a[i] - b[i]) <= tolerance for i in range(3))


def main():
    with tempfile.TemporaryDirectory() as folder:
        shot = Path(folder) / "window.png"
        app("do", "agent-sidebar.demo")
        try:
            time.sleep(2.5)
            app("shot", str(shot))
        finally:
            app("do", "overlay.close")
        window = Image.open(shot).convert("RGB")
    width, height = window.size
    pixels = window.load()

    def edge(x, y, dx, dy, color):
        while 0 < x < width - 1 and 0 < y < height - 1 and close(pixels[x, y], color):
            x, y = x + dx, y + dy
        return x, y

    # The copy is centered. Its title bar is plain beside the middle, and so is its left
    # padding: walk out from there until the color is no longer the copy's own.
    row, start = int(height * 0.125), width // 2 + 40
    color = pixels[start, row]
    left, right = edge(start, row, -1, 0, color)[0] + 1, edge(start, row, 1, 0, color)[0] - 1
    column = left + 6
    top, bottom = edge(column, height // 2, 0, -1, color)[1] + 1, edge(column, height // 2, 0, 1, color)[1] - 1
    if right - left < 300 or bottom - top < 600:
        sys.exit("Could not find the example copy in the window: is the mod installed and the window large enough?")
    picture = window.crop((left, top, right + 1, bottom + 1)).convert("RGBA")
    mask = Image.new("L", picture.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, picture.size[0] - 1, picture.size[1] - 1), radius=RADIUS, fill=255)
    picture.putalpha(mask)
    picture.save(ROOT / "preview.png")
    print(f"preview.png: {picture.size[0]}x{picture.size[1]}")


if __name__ == "__main__":
    main()
