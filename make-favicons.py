#!/usr/bin/env python3
"""Render the favicon set from favicon.svg using a local Chrome or Edge (headless).

Writes, next to this script:
  favicon.ico          16, 32 and 48 px (PNG-compressed ICO)
  apple-touch-icon.png 180 px
  icon-192.png         192 px   (site.webmanifest)
  icon-512.png         512 px   (site.webmanifest)

Usage:  python make-favicons.py
"""
import os, pathlib, shutil, struct, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
]


def find_browser():
    for b in BROWSERS:
        if os.path.exists(b):
            return b
    for name in ("chrome", "google-chrome", "chromium", "msedge"):
        if shutil.which(name):
            return shutil.which(name)
    sys.exit("No Chrome or Edge found; install one or add its path to BROWSERS.")


def render(browser, svg_path, out, size):
    """Screenshot the SVG at exactly size x size pixels on a transparent background."""
    tmp = tempfile.mkdtemp(prefix="favicon-")
    html = os.path.join(tmp, "icon.html")
    with open(html, "w", encoding="utf-8") as f:
        f.write('<!doctype html><html><body style="margin:0;background:transparent">'
                f'<img src="{pathlib.Path(svg_path).as_uri()}" width="{size}" height="{size}" style="display:block"></body></html>')
    cmd = [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
           f"--user-data-dir={os.path.join(tmp, 'profile')}", f"--window-size={size},{size}", "--force-device-scale-factor=1",
           "--default-background-color=00000000", "--virtual-time-budget=3000", f"--screenshot={out}", pathlib.Path(html).as_uri()]
    if os.name != "nt":
        cmd.insert(1, "--no-sandbox")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    shutil.rmtree(tmp, ignore_errors=True)


def write_ico(pngs, out):
    """Pack PNG files into a single .ico (PNG-in-ICO, supported by every current browser and by Windows since Vista)."""
    entries, blobs, offset = [], [], 6 + 16 * len(pngs)
    for size, path in pngs:
        data = open(path, "rb").read()
        entries.append(struct.pack("<BBBBHHII", size if size < 256 else 0, size if size < 256 else 0, 0, 0, 1, 32, len(data), offset))
        blobs.append(data)
        offset += len(data)
    with open(out, "wb") as f:
        f.write(struct.pack("<HHH", 0, 1, len(pngs)))
        f.write(b"".join(entries))
        f.write(b"".join(blobs))


def main():
    browser = find_browser()
    svg = os.path.join(ROOT, "favicon.svg")
    tmp = tempfile.mkdtemp(prefix="favicon-set-")
    ico_parts = []
    for size in (16, 32, 48):
        p = os.path.join(tmp, f"{size}.png")
        render(browser, svg, p, size)
        ico_parts.append((size, p))
    write_ico(ico_parts, os.path.join(ROOT, "favicon.ico"))
    print("wrote favicon.ico (16, 32, 48)")
    for size, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
        render(browser, svg, os.path.join(ROOT, name), size)
        print(f"wrote {name} ({size}x{size})")
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
