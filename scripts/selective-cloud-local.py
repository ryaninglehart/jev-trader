"""Read independent paper checkpoints with infrastructure auth kept in memory."""
import os
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 4 or sys.argv[1:3] != ["status", "--out"]:
    raise SystemExit("Use status --out FILE; this helper cannot start a collector.")
bun = "/Users/ryaninglehart/Documents/Codex/2026-10-15/what-x20/work/runtime/node_modules/.bin/bun"
token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()
result = subprocess.run([bun, "--no-env-file", "scripts/selective-cloud.ts", *sys.argv[1:], "--key-file", "data/cloud-migration/checkpoint-key"], cwd=root,
    env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GH_TOKEN": token, "DRY_RUN": "true"})
raise SystemExit(result.returncode)
