"""Read cloud checkpoints using existing GitHub auth; never print or persist its token."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
if len(sys.argv) < 2 or sys.argv[1] not in ("status", "restore", "audit"):
    raise SystemExit("Use status, restore or audit; this helper cannot start a collector.")
bun = shutil.which("bun") or "/Users/ryaninglehart/Documents/Codex/2026-10-15/what-x20/work/runtime/node_modules/.bin/bun"
if not Path(bun).is_file():
    raise SystemExit("The recorded Bun runtime is unavailable.")
token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()
if not token:
    raise SystemExit("Existing GitHub authentication is unavailable.")
arguments = sys.argv[1:]
if "--key-file" not in arguments:
    arguments += ["--key-file", "data/cloud-migration/checkpoint-key"]
result = subprocess.run([bun, "--no-env-file", "run", "scripts/cloud-study.ts", *arguments], cwd=root,
                        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GH_TOKEN": token, "DRY_RUN": "true"})
raise SystemExit(result.returncode)
