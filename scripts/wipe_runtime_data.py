from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "server"

# Runtime data only. Never delete source code, assets, configuration examples,
# or environment variables.
FILES = [
    "users.json",
    "pendings.json",
    "codes.json",
    "resets.json",
    ".challenge.json",
    ".challenge-done.json",
    ".notifications.json",
    ".archive.json",
    ".messages.json",
    ".replies.json",
    ".student-archive.json",
]

for name in FILES:
    path = DATA_DIR / name
    try:
        path.unlink()
        print(f"[wipe] removed {path}")
    except FileNotFoundError:
        pass

# Uploaded reply media is runtime data too, but keep the directory itself.
media = DATA_DIR / "media"
if media.exists():
    for item in media.iterdir():
        if item.is_file() or item.is_symlink():
            item.unlink()
            print(f"[wipe] removed {item}")

print("[wipe] runtime data cleared")
