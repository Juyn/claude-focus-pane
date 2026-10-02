#!/usr/bin/env python3
"""Draws the panda's sheet from nothing: assets/cats/panda/cat-sheet.png and its manifest.

No picture is read: every frame is built here from a few shapes — ellipses,
capsules, single pixels — sampled at the pixel grid, then ringed with a one
pixel outline, as the cats' sheets are. Same layout as theirs: 64x36 frames,
8 columns by 7 rows, the animal facing right, its feet on the bottom row.
Run it again to redraw; then scripts/build-sprites.py bakes it into the mod.
"""
import json, math, os, struct, zlib

W, H = 64, 36
PALETTE = {
    'O': (0x6d, 0x6a, 0x7c),  # outline: reads on a dark ground and on a light one
    'K': (0x2b, 0x2a, 0x33),  # black fur
    'k': (0x3d, 0x3c, 0x48),  # black fur, lit
    'D': (0x1f, 0x1e, 0x25),  # black fur, far side
    'W': (0xf7, 0xf3, 0xea),  # white fur
    'w': (0xd9, 0xd3, 0xc7),  # white fur, shaded
    'P': (0xf2, 0x8f, 0xa0),  # tongue, cheeks
    'G': (0x7c, 0xc2, 0x4e),  # bamboo
    'g': (0x4e, 0x93, 0x38),  # bamboo, shaded
}


class Frame:
    def __init__(self):
        self.px = [[None] * W for _ in range(H)]

    def put(self, x, y, color):
        x, y = int(math.floor(x)), int(math.floor(y))
        if 0 <= x < W and 0 <= y < H:
            self.px[y][x] = color

    def ellipse(self, cx, cy, rx, ry, color, shade=None, lit=None, angle=0.0):
        """A filled ellipse; `shade` colors its lower third, `lit` its upper crescent."""
        ca, sa = math.cos(angle), math.sin(angle)
        for y in range(int(cy - rx - ry - 1), int(cy + rx + ry + 2)):
            for x in range(int(cx - rx - ry - 1), int(cx + rx + ry + 2)):
                dx, dy = x + 0.5 - cx, y + 0.5 - cy
                u, v = (dx * ca + dy * sa) / rx, (-dx * sa + dy * ca) / ry
                if u * u + v * v <= 1.0:
                    tone = color
                    if shade and (dy / ry) > 0.42:
                        tone = shade
                    if lit and (dy / ry) < -0.5 and abs(dx / rx) < 0.75:
                        tone = lit
                    self.put(x, y, tone)

    def capsule(self, x0, y0, x1, y1, r, color, lit=None):
        """A thick rounded line: a limb."""
        lx, ly = x1 - x0, y1 - y0
        ll = lx * lx + ly * ly or 1.0
        for y in range(int(min(y0, y1) - r - 1), int(max(y0, y1) + r + 2)):
            for x in range(int(min(x0, x1) - r - 1), int(max(x0, x1) + r + 2)):
                px, py = x + 0.5 - x0, y + 0.5 - y0
                t = max(0.0, min(1.0, (px * lx + py * ly) / ll))
                ddx, ddy = px - lx * t, py - ly * t
                if ddx * ddx + ddy * ddy <= r * r:
                    self.put(x, y, lit if lit and ddx < -r * 0.35 else color)

    def outline(self):
        """Rings what is drawn with one pixel of outline, where there is room."""
        ring = []
        for y in range(H):
            for x in range(W):
                if self.px[y][x] is None and any(
                        0 <= x + dx < W and 0 <= y + dy < H and self.px[y + dy][x + dx] not in (None,)
                        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    ring.append((x, y))
        for x, y in ring:
            self.px[y][x] = 'O'


# ----------------------------------------------------------------- the panda

def face(f, cx, cy, eyes='open', look=0, tongue=False, r=8.0):
    """The head, seen from the front or three quarters: `look` slides the face sideways."""
    f.ellipse(cx - r * 0.66, cy - r * 0.78, 3.1, 3.1, 'K', lit='k')   # ears first: the head covers their roots
    f.ellipse(cx + r * 0.66, cy - r * 0.78, 3.1, 3.1, 'K', lit='k')
    f.ellipse(cx, cy, r, r * 0.92, 'W', shade='w')
    fx = cx + look
    for side in (-1, 1):                                                # the eye patches, drooping outward
        ex = fx + side * r * 0.42
        f.ellipse(ex, cy + 0.2, 2.3, 2.9, 'K', angle=side * 0.5)
        if eyes == 'open':
            f.put(ex - side * 0.2, cy - 0.6, 'W')
        elif eyes == 'wide':
            f.put(ex - side * 0.2, cy - 0.6, 'W')
            f.put(ex - side * 0.2, cy + 0.4, 'W')
        elif eyes == 'closed':
            f.put(ex - 1, cy + 0.8, 'O')                                # a lid drawn shut: a pale line across the patch
            f.put(ex, cy + 0.8, 'O')
            f.put(ex + 1 if side < 0 else ex - 2, cy + 0.2, 'O')
    f.ellipse(fx, cy + r * 0.42, 1.6, 1.0, 'K')                         # nose
    f.put(fx - 0.5, cy + r * 0.42 + 1.5, 'w')
    if tongue:
        f.put(fx - 0.5, cy + r * 0.42 + 2.0, 'P')
        f.put(fx + 0.5, cy + r * 0.42 + 2.0, 'P')


def profile(f, t=None, stride=3.0, lift=1.6, bob=0.0, dy=0.0, eyes='open', look=0.0, stretch=0.0, tongue=False):
    """The panda on all fours, facing right; `t` is where its walk cycle stands."""
    base = 34.0 + dy                                                    # where a resting foot ends
    by = 20.5 + dy + bob
    legs = [                                                            # hip x, phase, near side
        (23.0 - stretch, 0.0, False), (39.5 + stretch, 0.5, False),
        (19.5 - stretch, 0.5, True), (36.0 + stretch, 0.0, True),
    ]

    def leg(hip, phase, near):
        swing = 0.0 if t is None else stride * math.cos(2 * math.pi * (t + phase))
        up = 0.0 if t is None else max(0.0, math.sin(2 * math.pi * (t + phase))) * lift
        f.capsule(hip, by + 3.0, hip + swing, base - 3.0 - up, 3.3, 'K' if near else 'D', lit='k' if near else None)

    for hip, phase, near in legs:
        if not near:
            leg(hip, phase, near)
    f.ellipse(15.6 - stretch, by - 2.5, 2.3, 2.3, 'W', shade='w')        # tail, a round stub
    f.ellipse(22.5 - stretch, by + 0.4, 7.6, 8.6, 'W', shade='w')        # rump, round
    f.ellipse(29.5, by, 12.6 + stretch, 8.8, 'W', shade='w')            # body
    f.capsule(38.5 + stretch, by - 6.5, 35.5 + stretch, by + 4.0, 3.9, 'K', lit='k')  # the black band over the shoulders
    for hip, phase, near in legs:
        if near:
            leg(hip, phase, near)
    face(f, 46.5 + stretch, by - 6.0 - bob * 0.5, eyes=eyes, look=1.6 + look, tongue=tongue, r=8.0)


def seated(f, eyes='open', look=0.0, sway=0.0, breath=0.0, arms=0.0, tongue=False, bamboo=False, dy=0.0):
    """The panda sitting, facing you."""
    cy = 25.0 + dy
    f.ellipse(32.0, cy, 12.0, 9.6 + breath, 'W', shade='w')             # body
    for side in (-1, 1):                                                # feet, soles toward you
        f.ellipse(32.0 + side * 9.5, cy + 6.3, 4.6, 3.6, 'K', lit='k')
        f.ellipse(32.0 + side * 9.8, cy + 6.8, 1.9, 1.5, 'k')
    for side in (-1, 1):                                                # arms, down the sides onto the belly
        f.capsule(32.0 + side * 10.5, cy - 6.0, 32.0 + side * (6.5 - arms), cy + 0.5 - arms, 3.0, 'K', lit='k')
    if bamboo:
        f.capsule(34.0, cy - 0.5, 41.5, cy - 8.5, 1.0, 'G', lit='g')    # a stalk of bamboo, held up to chew
        for lx, ly, tone in ((42.5, -10.5, 'G'), (43.5, -9.5, 'G'), (44.0, -11.0, 'g'), (41.0, -11.0, 'G'), (40.0, -12.0, 'g')):
            f.put(lx, cy + ly, tone)
    face(f, 32.0 + sway, 12.5 + dy - breath * 0.5, eyes=eyes, look=look, tongue=tongue, r=9.5)


def turning(f, k):
    """From the side to facing you, in five."""
    if k == 0:
        profile(f)
    elif k == 1:
        profile(f, look=-1.6)
    elif k == 2:                                                        # the body swings round: shorter, the head already facing
        by = 21.5
        for hip, near in ((24.0, False), (36.0, False), (22.0, True), (38.0, True)):
            f.capsule(hip, by + 3.0, hip, 31.4, 2.9, 'K' if near else 'D', lit='k' if near else None)
        f.ellipse(30.5, by, 11.5, 8.8, 'W', shade='w')
        f.capsule(38.0, by - 5.5, 37.0, by + 4.0, 3.6, 'K', lit='k')
        f.capsule(23.5, by - 4.5, 23.0, by + 4.0, 3.2, 'K', lit='k')
        face(f, 34.0, 13.5, look=0.8, r=9.0)
    elif k == 3:
        seated(f, dy=-1.0, arms=-1.0)
    else:
        seated(f)


def asleep(f, breath=0.0, puff=False):
    """Flat on its belly, chin on its paws."""
    f.ellipse(15.0, 26.0, 2.2, 2.2, 'W', shade='w')
    f.ellipse(22.0, 26.6 - breath * 0.5, 7.4, 7.2 + breath, 'W', shade='w')   # rump, round
    f.ellipse(29.5, 27.0 - breath * 0.5, 12.0, 6.8 + breath, 'W', shade='w')
    f.capsule(18.5, 32.0, 25.0, 32.4, 2.5, 'K', lit='k')                # hind leg, folded under
    f.capsule(37.0, 23.5 - breath, 36.0, 30.5, 3.6, 'K', lit='k')       # the shoulder band
    f.capsule(36.0, 32.0, 50.0, 32.3, 2.3, 'K', lit='k')                # forelegs stretched out
    face(f, 46.5, 24.5 + breath * 0.3, eyes='closed', look=1.2, r=7.6)
    if puff:
        f.put(55, 22, 'w')


FRAMES = {
    'walk': [lambda f, k=k: profile(f, t=k / 8, bob=-0.6 * abs(math.sin(2 * math.pi * k / 8 * 2))) for k in range(8)],
    'run': [lambda f, k=k: profile(f, t=k / 6, stride=4.6, lift=2.6, stretch=0.8 * math.sin(2 * math.pi * k / 6),
                                   bob=-1.6 * abs(math.sin(2 * math.pi * k / 6)), tongue=True) for k in range(6)],
    'turn': [lambda f, k=k: turning(f, k) for k in range(5)],
    'sit': [
        lambda f: seated(f),
        lambda f: seated(f, breath=0.4),
        lambda f: seated(f, sway=1.0, look=0.6),
        lambda f: seated(f, eyes='closed', breath=0.4),
        lambda f: seated(f, sway=-1.0, look=-0.6),
        lambda f: seated(f, bamboo=True, tongue=True),
    ],
    'sleep': [
        lambda f: asleep(f),
        lambda f: asleep(f, breath=0.5),
        lambda f: asleep(f, breath=1.0, puff=True),
        lambda f: asleep(f, breath=0.5),
    ],
    'happy': [
        lambda f: profile(f, t=0.0, dy=-1.0, eyes='closed', tongue=True),
        lambda f: profile(f, t=0.2, dy=-5.0, lift=3.0, eyes='closed', tongue=True),
        lambda f: profile(f, t=0.45, dy=-7.0, lift=3.0, stride=4.0, eyes='closed', tongue=True),
        lambda f: profile(f, t=0.7, dy=-3.0, eyes='closed', tongue=True),
    ],
    'alert': [
        lambda f: profile(f, eyes='wide'),
        lambda f: profile(f, eyes='wide', dy=-1.5, stretch=-1.0, look=0.4),
        lambda f: profile(f, eyes='wide', dy=-3.0, stretch=-1.6, look=0.4, lift=2.0, t=0.25),
    ],
}
PACE = {'walk': 120, 'run': 80, 'turn': 100, 'sit': 260, 'sleep': 520, 'happy': 120, 'alert': 130}
LOOPS = {'walk', 'run', 'sit', 'sleep', 'happy'}
ORDER = ['walk', 'run', 'turn', 'sit', 'sleep', 'happy', 'alert']


def png(width, height, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    raw = b''.join(b'\x00' + row for row in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def main():
    across, down = 8, len(ORDER)
    sheet = [[None] * (across * W) for _ in range(down * H)]
    for row, name in enumerate(ORDER):
        for k, draw in enumerate(FRAMES[name]):
            frame = Frame()
            draw(frame)
            frame.outline()
            for y in range(H):
                for x in range(W):
                    sheet[row * H + y][k * W + x] = frame.px[y][x]
    rows = [b''.join(bytes((*PALETTE[c], 255)) if c else b'\x00\x00\x00\x00' for c in line) for line in sheet]
    home = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'cats', 'panda')
    os.makedirs(home, exist_ok=True)
    open(os.path.join(home, 'cat-sheet.png'), 'wb').write(png(across * W, down * H, rows))
    json.dump({
        'image': 'cat-sheet.png', 'frameWidth': W, 'frameHeight': H, 'columns': across, 'rows': down, 'facing': 'right',
        'animations': [{'name': name, 'row': row, 'frames': len(FRAMES[name]), 'frameDurationMs': PACE[name],
                        'loop': name in LOOPS} for row, name in enumerate(ORDER)],
    }, open(os.path.join(home, 'cat-sheet.json'), 'w'), indent=2)
    print(f'panda: {sum(len(v) for v in FRAMES.values())} frames of {W}x{H}')


if __name__ == '__main__':
    main()
