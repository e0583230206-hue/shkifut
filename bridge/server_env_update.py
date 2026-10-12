"""ON THE SERVER: merge KEY=VALUE pairs (JSON on stdin) into an .env file. Keeps other lines, backs the file up,
keeps its permissions, prints only key names and lengths.   python3 server_env_update.py /opt/bridge/.env"""
import json
import os
import shutil
import sys
import time

path = sys.argv[1]
updates = json.load(sys.stdin)
for k, v in updates.items():
    if not k.isidentifier() or "\n" in str(v) or "\r" in str(v):
        sys.exit(f"refusing key/value for {k!r}")
backup = f"{path}.bak.{time.strftime('%Y%m%d-%H%M%S')}"
shutil.copy2(path, backup)
mode = os.stat(path).st_mode & 0o777
lines = open(path, encoding="utf-8").read().splitlines()
seen = set()
for i, line in enumerate(lines):
    key = line.split("=", 1)[0]
    if key in updates and not line.startswith("#"):
        lines[i] = f"{key}={updates[key]}"
        seen.add(key)
lines += [f"{k}={v}" for k, v in updates.items() if k not in seen]
open(path + ".tmp", "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
os.chmod(path + ".tmp", mode)
os.replace(path + ".tmp", path)
print("backup:", backup)
for k, v in updates.items():
    print(f"updated {k} (length {len(str(v))})")
