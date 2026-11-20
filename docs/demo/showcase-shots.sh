#!/bin/sh
# Takes the README's pictures from start to end: builds a showcase stage with this mod's scene
# (showcase.sh), takes every picture with the kit's shoot.sh, and takes the stage down.
#
#   sh docs/demo/showcase-shots.sh
#
# preview.png              the whole window, everything but the Sessions sidebar dimmed
# docs/media/sidebar.png   the sidebar alone, down to its last line
#
# Building the stage and playing the scene take about a minute; each picture then waits until
# nobody has touched the keyboard or mouse for a minute and takes turns with other stages
# (shoot.sh), so a run takes a few minutes. The stage goes down even when a step fails.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
kit=${SHOWCASE_KIT:-$HOME/workspace/herdr/herdr-showcase}
pil=
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  command -v "$p" >/dev/null 2>&1 && "$p" -c 'import PIL' 2>/dev/null && { pil=$p; break; }
done
[ -n "$pil" ] || { echo "showcase-shots: needs Pillow (pip install pillow)" >&2; exit 1; }
w=
down() { [ -n "$w" ] && sh "$kit/stage.sh" --down "$w" || :; }
trap down EXIT
trap 'exit 130' INT TERM HUP

# Public README: no VPN switch.
w=$(SHOWCASE_TFVPN=0 SHOWCASE_HOOK="$here/showcase.sh" sh "$kit/stage.sh")
[ -f "$w/env.sh" ] || { echo "showcase-shots: no stage" >&2; exit 1; }

# The sidebar's width follows the sidebar.width setting and its length the mod's row heights, so
# both are measured, in pixels of the 2x window, on the last frame the stage drew (a measure, not
# a picture): near the bottom, the first column that isn't the sidebar's own background is its
# 2-pixel border; inside it, the lowest row that isn't background is the sidebar's last line.
(. "$w/env.sh" && herdr-app shot "$w/run/measure.png" >/dev/null)
set -- $("$pil" -c '
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
bg = im.getpixel((20, h - 60))
off = lambda p: max(abs(a - b) for a, b in zip(p, bg)) > 8
edge = next(x for x in range(200, w // 2) if off(im.getpixel((x, h - 60))))
last = next(y for y in range(h - 1, 0, -1) if any(off(im.getpixel((x, y))) for x in range(16, edge - 16, 2)))
print(edge, min(h, last + 48))
' "$w/run/measure.png")
edge=$1 bottom=$2
rm -f "$w/run/measure.png"
echo "showcase-shots: the sidebar is $edge px wide, its last line ends above y=$bottom" >&2

shoot() { sh "$kit/shoot.sh" "$w" "$@"; }
# The whole window with everything but the sidebar column (its border included) dimmed, so the
# sidebar is plainly the subject while the rest stays readable behind it. 2000: past the bottom
# of any picture (1938 to 1956 high), so the whole column stays bright.
shoot "$repo/preview.png" --dim "${SIDEBAR_DIM:-0,0,$((edge + 2)),2000}"
# The sidebar alone, from the top down to Recently closed.
shoot "$repo/docs/media/sidebar.png" --crop "${SIDEBAR_CROP:-0,0,$edge,$bottom}"

# A picture over 2.5 MB goes down to 256 colors, which it doesn't show; the gallery loads it faster.
for f in "$repo/preview.png" "$repo/docs/media/sidebar.png"; do
  "$pil" -c '
import os, sys
from PIL import Image
f = sys.argv[1]
if os.path.getsize(f) > 2_500_000:
    Image.open(f).convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)
' "$f"
  echo "$f"
done
