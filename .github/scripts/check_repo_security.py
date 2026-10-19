#!/usr/bin/env python3
"""Read-only Phase 0.5 repository security gate; no network or secrets required."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.name
EXPECTED = {
    "renivet-frontend": {"npm", "github-actions", "docker"},
    "renivet-backend": {"npm", "github-actions", "docker"},
    "renivet-python-services": {"uv", "github-actions", "docker"},
    "renivet-engineering-os": {"github-actions"},
}
ISSUES: list[str] = []


def issue(message: str) -> None:
    ISSUES.append(message)
    print("FAIL:", message)


config = ROOT / ".github" / "dependabot.yml"
if not config.is_file():
    issue("Missing .github/dependabot.yml")
else:
    body = config.read_text(encoding="utf8")
    if not re.search(r"(?m)^version:\s*2\s*$", body):
        issue("Dependabot config must use version: 2")
    found = set(re.findall(r'(?m)^\s*-\s*package-ecosystem:\s*["\x27]?([a-z-]+)', body))
    wanted = EXPECTED.get(REPO)
    if wanted is None:
        issue("Unrecognized repo name; review expected package ecosystems")
    elif found != wanted:
        issue(f"Dependabot ecosystems differ: found {sorted(found)}; expected {sorted(wanted)}")
    if re.search(r"(?m)^\s*target-branch\s*:", body):
        issue("Never set target-branch in default config: it changes security update routing")

workflows = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
if not workflows:
    issue("No GitHub Actions workflow definitions found")

for workflow in workflows:
    data = workflow.read_text(encoding="utf8")
    if re.search(r"(?m)^\s*pull_request_target\s*:", data):
        issue(f"{workflow.name}: pull_request_target is forbidden for untrusted PR code")
    if not re.search(r"(?m)^permissions:\s*\n\s+contents:\s*read\b", data):
        issue(f"{workflow.name}: workflow-level contents: read permission missing")
    if re.search(r"(?m)^\s+[\w-]+:\s*write\b", data):
        issue(f"{workflow.name}: write-scope permissions require manual security approval")
    for match in re.finditer(r"(?m)^\s*(?:-\s*)?uses:\s*[\"']?([^\s\"'#]+)", data):
        reference = match.group(1)
        if reference.startswith("./"):
            continue
        suffix = reference.rsplit("@", 1)[-1]
        if not re.fullmatch(r"[0-9a-f]{40}", suffix):
            issue(f"{workflow.name}: third-party action not pinned to full SHA: {reference}")

tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\x00")
for filename in filter(None, tracked):
    path = Path(filename)
    name = path.name.lower()
    allowed = {".env.example", ".env.sample", ".env.template"}
    secret_filename = (
        (name == ".env" or name.startswith(".env.")) and name not in allowed
        or name in {"id_rsa", "id_ed25519", "private_key.pem", "credentials.json", "service-account.json"}
        or (name.endswith((".pem", ".p12", ".pfx", ".key")) and not name.endswith(".pub"))
    )
    if secret_filename:
        issue(f"Potential sensitive file tracked in Git: {filename}")

if ISSUES:
    print(f"{len(ISSUES)} repository-security policy finding(s)")
    sys.exit(1)
print("PASS: immutable Action SHAs, read-only workflow permissions, supported Dependabot ecosystems and sensitive filename checks")
