#!/usr/bin/env python3
"""Thumbnails of a mockup file, as Raster cells the focus pane draws.

usage: thumbs.py <mockup.html> <pixel-rows>

Each `figure.stage` of the file is one screen: its `.vp` is shot alone, at its
own `data-w` width, by a headless browser, then scaled to <pixel-rows> pixels
tall. A file with no such figure is shot once, from its top. Prints a JSON list
of `{id, title, columns, rows, cells}`; `cells` is base64 of three little-endian
uint32 a cell: the upper half block, the top pixel, the bottom pixel.
"""
import base64, concurrent.futures, hashlib, html, json, os, re, shutil, struct, subprocess, sys, tempfile

UPPER_HALF = 0x2580
BROWSERS = ('brave', 'chromium', 'google-chrome-stable', 'google-chrome', 'chrome')
ISOLATE = """<script>(function(){var m=location.hash.match(/shot=(\\d+)/);if(!m)return;
var vp=document.querySelectorAll('figure.stage .vp')[+m[1]];if(!vp)return;
var f=vp.firstElementChild;if(f)f.style.zoom=1;
document.body.innerHTML='';document.body.style.cssText='margin:0;padding:0;background:#fff';
vp.style.cssText='margin:0;border:0;border-radius:0;overflow:visible;width:'+vp.dataset.w+'px';
document.body.appendChild(vp);})();</script>"""


def screens(text):
    found = re.findall(r'<figcaption>(.*?)</figcaption>\s*<div class="vp" data-w="(\d+)"', text, re.S)
    out = []
    for caption, width in found:
        mark = re.match(r'\s*<b>(.*?)</b>', caption)
        said = html.unescape(re.sub(r'<[^>]+>', '', re.sub(r'<code>.*?</code>', '', caption)))
        said = re.sub(r'\s+', ' ', said).strip(' ·')
        ident = mark.group(1) if mark else str(len(out) + 1)
        out.append({'id': ident, 'title': said[len(ident):].strip(' ·') if said.startswith(ident) else said, 'width': int(width)})
    return out


def height_for(width):
    # A phone and an A4 sheet are shot tall, a desktop screen 16:10.
    return 640 if width <= 480 else 1123 if width <= 900 else int(width * 0.625)


def shoot(browser, url, width, height, png):
    subprocess.run(
        [browser, '--headless', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=4000',
         f'--window-size={width},{height}', f'--screenshot={png}', url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)
    return os.path.exists(png)


def cells(png, columns, pixel_rows):
    raw = subprocess.run(
        ['magick', png, '-resize', f'{columns}x{pixel_rows}!', '-alpha', 'off', '-depth', '8', 'rgb:-'],
        capture_output=True, timeout=30, check=True).stdout
    px = lambda x, y: (raw[(y * columns + x) * 3] << 16) | (raw[(y * columns + x) * 3 + 1] << 8) | raw[(y * columns + x) * 3 + 2]
    out = bytearray()
    for row in range(pixel_rows // 2):
        for x in range(columns):
            out += struct.pack('<III', UPPER_HALF, px(x, row * 2), px(x, row * 2 + 1))
    return base64.b64encode(bytes(out)).decode()


def main():
    source, pixel_rows = sys.argv[1], int(sys.argv[2]) // 2 * 2
    stat = os.stat(source)
    stamp = hashlib.sha1(f'{source}:{stat.st_mtime_ns}:{stat.st_size}:{pixel_rows}:2'.encode()).hexdigest()[:16]
    cache = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'), 'focus-pane')
    kept = os.path.join(cache, f'{stamp}.json')
    if os.path.exists(kept):
        sys.stdout.write(open(kept).read())
        return 0

    browser = next((one for one in BROWSERS if shutil.which(one)), None)
    if browser is None or shutil.which('magick') is None:
        sys.stderr.write('needs a Chromium browser and ImageMagick\n')
        return 3

    text = open(source, encoding='utf-8').read()
    found = screens(text)
    with tempfile.TemporaryDirectory() as work:
        page = os.path.join(work, 'page.html')
        isolated = text.replace('</body>', ISOLATE + '</body>') if '</body>' in text else text + ISOLATE
        open(page, 'w', encoding='utf-8').write(isolated)
        if not found:
            found = [{'id': '1', 'title': os.path.basename(source), 'width': 1440, 'whole': True}]

        def one(at):
            shot = found[at]
            height = height_for(shot['width'])
            png = os.path.join(work, f'{at}.png')
            url = f'file://{page}' + ('' if shot.get('whole') else f'#shot={at}')
            if not shoot(browser, url, shot['width'], height, png):
                return None
            columns = max(8, round(pixel_rows * shot['width'] / height))
            return {'id': shot['id'], 'title': shot['title'], 'columns': columns, 'rows': pixel_rows // 2,
                    'cells': cells(png, columns, pixel_rows)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            made = [shot for shot in pool.map(one, range(len(found))) if shot]

    if not made:
        sys.stderr.write('no screenshot came out\n')
        return 4
    out = json.dumps(made, ensure_ascii=False)
    os.makedirs(cache, exist_ok=True)
    open(kept, 'w').write(out)
    sys.stdout.write(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
