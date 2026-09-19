"""Download /built from Modal Volume "orbit-data" into data/built/ (overwrites).

    .\\.venv\\Scripts\\python scripts/pull_data.py            # everything
    .\\.venv\\Scripts\\python scripts/pull_data.py satellite  # only built/satellite
"""
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import modal
from modal.volume import FileEntryType

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "data" / "built"


def main():
    sub = sys.argv[1].strip("/") if len(sys.argv) > 1 else ""
    remote_root = "built" + (f"/{sub}" if sub else "")
    vol = modal.Volume.from_name("orbit-data")
    files = [e.path for e in vol.listdir(remote_root, recursive=True) if e.type == FileEntryType.FILE]
    print(f"Pulling {len(files)} files from orbit-data:/{remote_root} -> {DEST}")

    def fetch(path: str):
        rel = path.lstrip("/")[len("built/"):]
        out = DEST / Path(*rel.split("/"))
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "wb") as f:
            vol.read_file_into_fileobj(path, f)

    with ThreadPoolExecutor(32) as ex:
        for i, _ in enumerate(ex.map(fetch, files), 1):
            if i % 500 == 0:
                print(f"  {i}/{len(files)}")
    print("Done.")


if __name__ == "__main__":
    main()
