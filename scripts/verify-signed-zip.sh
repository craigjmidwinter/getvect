#!/bin/bash
#
# Verify that the macOS update .zip contains a signed, Gatekeeper-accepted,
# stapled app. Exits non-zero if any of that is untrue.
#
#   scripts/verify-signed-zip.sh release/GetVect-0.1.3-arm64-mac.zip
#
# WHY THE ZIP NEEDS ITS OWN GATE.
#
# The dmg is what a human downloads. The zip is what the SHIPPED APP downloads:
# `latest-mac.yml`'s top-level `path`/`sha512` point at it, and electron-updater
# on macOS installs from it, never from the dmg. So the release gate was
# verifying the artefact a person gets while leaving the artefact the software
# gets unchecked — and only one of those two runs unattended on someone else's
# machine.
#
# It was correct by luck. `notarize-dmg.mjs` says in a comment that
# electron-builder staples the .app before building any target, so the zip
# already contains a stapled app. That is true today and it is an ASSUMPTION
# ABOUT ANOTHER TOOL'S ORDERING, written in prose, never checked. The identical
# assumption about the dmg — "notarization succeeded, so the artefact is
# notarized" — is exactly what shipped v0.1.2 unsigned with a green build log.
#
# WHY IT MATTERS MORE ONCE auto UPDATES ARE ON.
#
# Squirrel.Mac refuses an update whose signature it cannot validate against the
# running app's. An unsigned or unstapled app inside this zip does not fail
# loudly at build time: it fails on a user's machine, after a ~120 MB download,
# every launch, silently, with the app carrying on as if nothing happened. That
# is the worst failure shape available — it costs the user bandwidth, tells them
# nothing, and leaves them on an old build believing they are current.
#
# The three checks mirror verify-signed-dmg.sh deliberately, and run against the
# extracted bundle rather than the archive, because a zip carries no signature
# of its own — the thing that has to be signed is the app inside it.
set -uo pipefail

ZIP="${1:-}"
if [ -z "$ZIP" ]; then
  echo "usage: $0 <path-to-mac-zip>" >&2
  exit 2
fi
if [ ! -f "$ZIP" ]; then
  echo "::error::verify-signed-zip: no such file: $ZIP" >&2
  exit 2
fi

echo "verifying: $ZIP"
echo "   sha256: $(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
echo "    bytes: $(stat -f%z "$ZIP")"
echo

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ditto preserves the signed bundle's extended attributes and symlinks; plain
# `unzip` mangles framework symlinks and can break a signature that is in fact
# fine, which would make this gate fail for the wrong reason.
if ! ditto -x -k "$ZIP" "$WORK" 2>&1 | sed 's/^/   /'; then
  echo "::error::could not extract $ZIP" >&2
  exit 1
fi

APP="$(find "$WORK" -maxdepth 2 -name '*.app' -print -quit)"
if [ -z "$APP" ]; then
  echo "::error::no .app bundle inside $ZIP — this is what the updater installs" >&2
  exit 1
fi
echo "   contains: $(basename "$APP")"
echo

fail=0
step() {
  local label="$1"; shift
  echo "── $label"
  if "$@" 2>&1 | sed 's/^/   /'; then
    echo "   PASS"
  else
    echo "::error::$label FAILED for the app inside $ZIP"
    fail=1
  fi
  echo
}

step "codesign --verify --deep --strict (app in zip)" \
  codesign --verify --deep --strict --verbose=2 "$APP"

# -t exec, not -t install: this bundle is executed, not mounted.
step "spctl -a -t exec (app in zip)" spctl -a -t exec -vv "$APP"

step "xcrun stapler validate (app in zip)" xcrun stapler validate "$APP"

echo "── signing authority"
codesign -dvvv "$APP" 2>&1 | grep -E '^(Authority|TeamIdentifier|Identifier)=' | sed 's/^/   /'
echo

if [ "$fail" -ne 0 ]; then
  echo "::error::$ZIP would break in-app updates: Squirrel validates this bundle's"
  echo "::error::signature against the running app's and refuses it after the download."
  exit 1
fi

echo "OK: the app inside $ZIP is signed, Gatekeeper-accepted and stapled"
