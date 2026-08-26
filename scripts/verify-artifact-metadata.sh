#!/bin/bash
#
# Assert a packaged .app carries correct, self-consistent identity metadata.
#
#   scripts/verify-artifact-metadata.sh release/mac-arm64/GetVect.app
#
# WHY THIS EXISTS SEPARATELY FROM THE SIGNING CHECKS.
#
# SignPath Foundation requires artifact metadata to be "set and enforced":
# product name attributes matching the project, and one product version across a
# build. Ours is already correct — CFBundleName GetVect, both version fields
# 0.1.1, identifier com.craigmidwinter.getvect. It is correct because
# electron-builder derives it from package.json, and nothing has ever checked
# that it stayed correct.
#
# "Correct today and guarded by nothing" is the failure shape this repo keeps
# finding. A version bump that lands in package.json but not in a hand-edited
# plist, or a productName changed in one place, produces an artifact that
# installs fine and misreports itself — to the updater, which compares versions,
# and to anyone auditing what they just installed.
#
# It is a separate script rather than a block inside verify-signed-dmg.sh so the
# check can be pointed at a tampered copy and watched to fail, which is the only
# way to know it can.
set -uo pipefail

APP="${1:-}"
EXPECT_NAME="${2:-GetVect}"

if [ -z "$APP" ]; then
  echo "usage: $0 <path-to-.app> [expected-product-name]" >&2
  exit 2
fi
PLIST="$APP/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  echo "::error::verify-artifact-metadata: no Info.plist at $PLIST" >&2
  exit 2
fi

get() { /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" 2>/dev/null; }

NAME="$(get CFBundleName)"
DISPLAY="$(get CFBundleDisplayName)"
SHORT="$(get CFBundleShortVersionString)"
BUILD="$(get CFBundleVersion)"
IDENT="$(get CFBundleIdentifier)"

echo "metadata for $APP"
printf '  %-28s %s\n' CFBundleName "$NAME"
printf '  %-28s %s\n' CFBundleDisplayName "$DISPLAY"
printf '  %-28s %s\n' CFBundleShortVersionString "$SHORT"
printf '  %-28s %s\n' CFBundleVersion "$BUILD"
printf '  %-28s %s\n' CFBundleIdentifier "$IDENT"
echo

fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "   PASS  $1"
  else
    echo "::error::$1 — expected '$3', got '$2'"
    fail=1
  fi
}
present() {
  if [ -n "$2" ]; then
    echo "   PASS  $1"
  else
    echo "::error::$1 is empty"
    fail=1
  fi
}

check "product name matches the project" "$NAME" "$EXPECT_NAME"
check "display name matches the product name" "$DISPLAY" "$EXPECT_NAME"
present "bundle identifier is set" "$IDENT"
present "short version is set" "$SHORT"
# The one that actually drifts. Two version fields that disagree produce an app
# whose updater compares one number and whose About box shows another.
check "one product version across the build" "$BUILD" "$SHORT"

if [ "$fail" -ne 0 ]; then
  echo "::error::$APP has inconsistent identity metadata"
  exit 1
fi
echo "OK: metadata is set and self-consistent"
