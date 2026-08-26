#!/bin/bash
#
# Verify that a .dmg is signed, accepted by Gatekeeper, and has a stapled
# notarization ticket. Exits non-zero if any of that is untrue.
#
#   scripts/verify-signed-dmg.sh release/GetVect-0.1.1-arm64.dmg
#
# WHY THIS IS A SCRIPT AND NOT STEPS IN THE WORKFLOW.
#
# It runs twice against two different files: the artefact the release job is
# about to upload, and the same artefact re-downloaded from the release
# afterwards. Those must be the *same three checks* — two copies in YAML would
# be two things that drift, and the copy that drifts is the one that runs less
# often, which is the download check, which is the one that matters.
#
# WHY THE ARTEFACT AND NOT THE BUILD.
#
# "The signing step ran" and "this file is signed" are different claims. A step
# can succeed against a bundle that is later rebuilt, re-zipped, or replaced by
# a sibling artefact of the same name. Only the file itself can answer, so every
# check below takes a path and opens it.
#
# The three are not redundant; each fails alone:
#   codesign  — the signature is present, intact, and covers every nested part.
#   spctl     — Gatekeeper, the thing that actually runs on a user's machine,
#               accepts it. A validly-signed build with a revoked or untrusted
#               certificate passes codesign and fails here.
#   stapler   — the notarization ticket is attached to the file. Without it a
#               first launch offline is refused, and notarization that happened
#               but was never stapled looks identical to success everywhere else.
set -uo pipefail

DMG="${1:-}"
if [ -z "$DMG" ]; then
  echo "usage: $0 <path-to-dmg>" >&2
  exit 2
fi
if [ ! -f "$DMG" ]; then
  echo "::error::verify-signed-dmg: no such file: $DMG" >&2
  exit 2
fi

echo "verifying: $DMG"
echo "   sha256: $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
echo "    bytes: $(stat -f%z "$DMG")"
echo

fail=0
step() {
  local label="$1"; shift
  echo "── $label"
  if "$@" 2>&1 | sed 's/^/   /'; then
    echo "   PASS"
  else
    echo "::error::$label FAILED for $DMG"
    fail=1
  fi
  echo
}

# 1. The disk image's own signature.
step "codesign --verify --deep --strict (dmg)" \
  codesign --verify --deep --strict --verbose=2 "$DMG"

# 2. Gatekeeper's verdict on installing it. `-t install` is the assessment a
#    user downloading a dmg actually gets.
step "spctl -a -t install (dmg)" \
  spctl -a -t install -vv "$DMG"

# 3. The notarization ticket, stapled to the file rather than merely issued.
step "xcrun stapler validate (dmg)" \
  xcrun stapler validate "$DMG"

# 4. The application inside, which is the thing that ends up in /Applications
#    and the thing Gatekeeper judges on first launch. A signed dmg can contain
#    an unsigned or differently-signed app; the outer signature does not prove
#    the inner one.
MOUNT="$(mktemp -d)"
if hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" >/dev/null 2>&1; then
  APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)"
  if [ -n "$APP" ]; then
    step "codesign --verify --deep --strict (app)" \
      codesign --verify --deep --strict --verbose=2 "$APP"
    step "spctl -a -t exec (app)" \
      spctl -a -t exec -vv "$APP"
    step "xcrun stapler validate (app)" \
      xcrun stapler validate "$APP"
    echo "── signing authority"
    codesign -dvvv "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|Timestamp' | sed 's/^/   /' || true
    echo
  else
    echo "::error::no .app found inside $DMG"
    fail=1
  fi
  hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
else
  echo "::error::could not mount $DMG"
  fail=1
fi
rmdir "$MOUNT" 2>/dev/null || true

if [ "$fail" -ne 0 ]; then
  echo "::error::$DMG is not a signed, notarized, stapled artefact — refusing to ship it"
  exit 1
fi
echo "OK: $DMG is signed, Gatekeeper-accepted and stapled"
