"""Fly review-app steps that keep PREVIEW_PASSWORD off the command line.

stage reads the password from the environment, masks it, ensures the app
exists, and feeds one NAME=VALUE line to `flyctl secrets import --stage`
on stdin. deploy and destroy never receive the password.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

TAKEN = (
    "already been taken",
    "already exists",
    "name not available",
    "already taken",
)


def app_name() -> str:
    number = os.environ.get("PR_NUMBER", "").strip()
    owner = os.environ.get("REPO_OWNER", "").strip().replace("_", "-").lower()
    name = os.environ.get("REPO_NAME", "").strip().replace("_", "-").lower()
    if not number or not owner or not name:
        raise SystemExit("PR_NUMBER, REPO_OWNER, and REPO_NAME are required.")
    app = f"pr-{number}-{owner}-{name}"
    if number not in app:
        raise SystemExit("Refusing an app name that does not contain the pull request number.")
    return app


def org() -> str:
    return os.environ.get("FLY_ORG", "").strip() or "personal"


def region() -> str:
    return os.environ.get("FLY_REGION", "").strip() or "iad"


def redact(text: str) -> str:
    password = os.environ.get("PREVIEW_PASSWORD", "")
    if password:
        text = text.replace(password, "***")
    text = re.sub(r"FlyV1\S*", "***", text)
    text = re.sub(r"(?i)(PREVIEW_PASSWORD=).*", r"\1***", text)
    text = re.sub(r"(?i)(FLY_API_TOKEN=).*", r"\1***", text)
    return text


def run_flyctl(args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["flyctl", *args],
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def password_from_env() -> str:
    password = os.environ.get("PREVIEW_PASSWORD", "")
    if password.strip() == "":
        print("PREVIEW_PASSWORD is empty. Refusing to deploy.", file=sys.stderr)
        raise SystemExit(1)
    if "\n" in password or "\r" in password or '"""' in password:
        print("PREVIEW_PASSWORD must be a single line without three double quotes.", file=sys.stderr)
        raise SystemExit(1)
    return password


def mask(password: str) -> None:
    """Ask GitHub Actions to mask the value. Local runs do not print it."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    sys.stdout.write("::add-mask::")
    sys.stdout.write(password)
    sys.stdout.write("\n")
    sys.stdout.flush()


def ensure_app(app: str, organization: str) -> None:
    listed = run_flyctl(["apps", "list", "--json"])
    if listed.returncode != 0:
        print("Could not list Fly apps.", file=sys.stderr)
        raise SystemExit(listed.returncode or 1)
    try:
        payload = json.loads(listed.stdout or "[]")
    except json.JSONDecodeError:
        print("Could not read the Fly app list.", file=sys.stderr)
        raise SystemExit(1)
    if isinstance(payload, dict):
        payload = payload.get("apps") or payload.get("Apps") or []
    names = set()
    for item in payload:
        if isinstance(item, dict):
            found = item.get("Name") or item.get("name") or ""
            if found:
                names.add(found)
    if app in names:
        print("Fly app already exists.")
        return
    created = run_flyctl(["apps", "create", app, "--org", organization])
    if created.returncode == 0:
        print("Created the Fly app.")
        return
    blob = (created.stdout + created.stderr).lower()
    if any(phrase in blob for phrase in TAKEN):
        print("Fly app already exists.")
        return
    print("Could not ensure the Fly app exists.", file=sys.stderr)
    raise SystemExit(created.returncode or 1)


def secret_line(password: str) -> str:
    # Triple quotes keep spaces, #, and inner quotes in flyctl's stdin parser.
    return f'PREVIEW_PASSWORD="""{password}"""\n'


def stage() -> None:
    password = password_from_env()
    mask(password)
    app = app_name()
    ensure_app(app, org())
    imported = run_flyctl(
        ["secrets", "import", "--stage", "--app", app],
        stdin=secret_line(password),
    )
    if imported.returncode != 0:
        print("flyctl secrets import failed.", file=sys.stderr)
        raise SystemExit(imported.returncode or 1)
    print("Staged PREVIEW_PASSWORD for the next deploy.")


def deploy() -> None:
    app = app_name()
    revision = os.environ.get("TAFO_REV", "").strip() or "unknown"
    result = run_flyctl(
        [
            "deploy",
            "--remote-only",
            "--config",
            "fly.toml",
            "--app",
            app,
            "--regions",
            region(),
            "--ha=false",
            "--vm-cpu-kind",
            "shared",
            "--vm-cpus",
            "1",
            "--vm-memory",
            "512",
            "--strategy",
            "immediate",
            "--build-arg",
            f"TAFO_REV={revision}",
        ]
    )
    sys.stdout.write(redact(result.stdout))
    sys.stderr.write(redact(result.stderr))
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def destroy() -> None:
    app = app_name()
    result = run_flyctl(["apps", "destroy", app, "-y"])
    if result.returncode != 0:
        print("Review app was already gone, or destroy did not succeed.")
        return
    print("Removed the review app.")


def gate() -> None:
    token = os.environ.get("FLY_API_TOKEN", "")
    present = "true" if token.strip() else "false"
    output = os.environ.get("GITHUB_OUTPUT", "")
    if not output:
        print("GITHUB_OUTPUT is not set.", file=sys.stderr)
        raise SystemExit(1)
    with open(output, "a", encoding="utf-8") as handle:
        handle.write(f"present={present}\n")
    if present == "false":
        print("FLY_API_TOKEN is not set. The review app stays undeployed.")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"gate", "stage", "deploy", "destroy"}:
        print("usage: fly_preview.py gate|stage|deploy|destroy", file=sys.stderr)
        return 2
    command = argv[1]
    if command == "gate":
        gate()
    elif command == "stage":
        stage()
    elif command == "deploy":
        deploy()
    else:
        destroy()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
