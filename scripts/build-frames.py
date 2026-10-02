#!/usr/bin/env python3
"""Cuts assets/v2-64x36/cat-sheet.png into one PNG a frame, for the `png` cat.

Where the terminal draws real images (the kitty graphics protocol), the cat is
an Image fed these files: each frame enlarged six times with hard edges, and
its mirror, under assets/frames/<clip>-<n>[-flip].png. Run it again whenever
the sheet changes.
"""
import json, os, shutil, subprocess

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
home = os.path.join(root, 'assets', 'v2-64x36')
sheet = json.load(open(os.path.join(home, 'cat-sheet.json')))
width, height, scale = sheet['frameWidth'], sheet['frameHeight'], 6
out = os.path.join(root, 'assets', 'frames')
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
made = 0
for one in sheet['animations']:
    for k in range(one['frames']):
        crop = f"{width}x{height}+{k * width}+{one['row'] * height}"
        for flip, name in (([], ''), (['-flop'], '-flip')):
            subprocess.run(
                ['magick', os.path.join(home, sheet['image']), '-crop', crop, '+repage', *flip,
                 '-filter', 'point', '-resize', f'{scale * 100}%', '-strip',
                 os.path.join(out, f"{one['name']}-{k}{name}.png")], check=True)
            made += 1
print(f'{made} frames of {width * scale}x{height * scale} in {out}')
