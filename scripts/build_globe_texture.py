"""Bake the landing-page globe texture from EOX Sentinel-2 cloudless.

The landing used to stream ~40 Web-Mercator tiles from tiles.maps.eox.at on every visit (single
tiles took up to 15 s), so the globe sat half-empty while it spun. This fetches the zoom-3 tiles
once, stitches them and reprojects to one equirectangular image the WebGL globe can sample
directly, then writes two sizes into web/public/globe/:

    earth-512.jpg   ~30 KB   painted on the first frame
    earth-2k.jpg    2048x1024, swapped in as soon as it has loaded

    .\\.venv\\Scripts\\python scripts/build_globe_texture.py          # skips if both files exist
    .\\.venv\\Scripts\\python scripts/build_globe_texture.py --force

Imagery: Sentinel-2 cloudless 2020 by EOX IT Services GmbH (contains modified Copernicus
Sentinel data 2020), CC BY-NC-SA 4.0 — credited on the landing page.
"""
import io
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "globe"
URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg"
Z = 3                      # 8 x 8 tiles = a 2048 px Web-Mercator world
TILE = 256
MAX_LAT = 85.0511287798    # Web-Mercator limit


def fetch(client, x, y):
    for attempt in range(4):
        try:
            r = client.get(URL.format(z=Z, x=x, y=y), timeout=60)
            r.raise_for_status()
            return x, y, Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception as e:  # the EOX server is slow and occasionally drops requests
            print(f"  tile {x},{y} attempt {attempt + 1}: {e}")
    raise SystemExit(f"could not fetch tile {x},{y}")


def mercator_world():
    n = 2 ** Z
    world = Image.new("RGB", (n * TILE, n * TILE))
    with httpx.Client(headers={"User-Agent": "orbit-hackathon/1.0"}) as client, ThreadPoolExecutor(8) as pool:
        for x, y, im in pool.map(lambda xy: fetch(client, *xy), [(x, y) for y in range(n) for x in range(n)]):
            world.paste(im, (x * TILE, y * TILE))
    print(f"stitched {n * n} tiles -> {world.size}")
    return world


def to_equirectangular(merc, width=2048):
    """Reproject a square Web-Mercator world to a 2:1 equirectangular image (poles clamp to the edge rows)."""
    src = np.asarray(merc)
    size = src.shape[0]
    height = width // 2
    lat = 90 - (np.arange(height) + 0.5) / height * 180
    lat = np.clip(lat, -MAX_LAT, MAX_LAT)
    y_merc = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / math.pi) / 2 * size
    rows = np.clip(y_merc.astype(int), 0, size - 1)
    cols = np.clip(((np.arange(width) + 0.5) / width * size).astype(int), 0, size - 1)
    return Image.fromarray(src[rows][:, cols])


def main():
    force = "--force" in sys.argv
    big, small = OUT / "earth-2k.jpg", OUT / "earth-512.jpg"
    if big.exists() and small.exists() and not force:
        print(f"exists: {big} and {small} (use --force to rebuild)")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    eq = to_equirectangular(mercator_world())
    eq.save(big, quality=82, optimize=True, progressive=True)
    eq.resize((512, 256), Image.LANCZOS).save(small, quality=70, optimize=True)
    for p in (big, small):
        print(f"wrote {p.relative_to(ROOT)}  {p.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
