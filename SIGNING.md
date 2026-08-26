# Signing and notarization

macOS release builds are signed with a Developer ID certificate and notarized by
Apple. This file is the setup, and it exists because the parts only Craig can
supply are the parts a document has to name exactly.

**Nothing here is needed to build locally.** `npm run dist` stays unsigned by
design (`electron-builder.yml`, `mac.identity: null`) — no keychain prompt, no
certificate, no API key. This is the release path only.

---

## The shape of the gate, before the list of secrets

The release workflow does not "have a signing step". **An unsigned artefact
cannot ship.** Three properties, each one a thing that has gone wrong in real
projects:

1. **The artefact is verified, not the build.** After packaging, the finished
   `.dmg` is checked with `codesign --verify --deep --strict`, `spctl -a -t
   install` and `xcrun stapler validate` — plus the same three against the
   `.app` inside it, because a signed dmg can carry an unsigned app and the
   outer signature says nothing about the inner one. *A signing step that ran*
   and *a file that is signed* are different claims.

2. **Absent credentials fail; they never skip.** The credential check has no
   `if:` on it. The usual way this gate breaks is a condition like
   `if: secrets.X != ''` guarding the signing steps — which cannot tell "this is
   not a release" from "someone deleted the secret", and publishes an unsigned
   build with a green check in the second case. This workflow only runs on a
   release tag, so there is no legitimate path that does not need to sign.

3. **The last check runs on the re-downloaded asset.** A separate macOS job
   downloads the `.dmg` from the release and runs the same script against it.
   The file that was verified and the file a user gets are only the same file if
   you check. It runs while the release is still a draft, so a failure there
   means nothing was ever public.

The checks live in `scripts/verify-signed-dmg.sh` — one script, run twice, so the
pre-upload and post-download gates cannot drift apart.

---

## The five secrets

Set these as **repository secrets** (Settings → Secrets and variables → Actions).
The exact names matter; the workflow looks for these and nothing else.

| Secret | Value | Where it comes from |
|---|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | contents of `~/.apple-signing/developer_id_p12_base64.txt` | the exported Developer ID `.p12`, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | contents of `~/.apple-signing/p12_password.txt` | the password that `.p12` was exported with |
| `NOTARY_KEY_P8_BASE64` | contents of `~/.apple-signing/authkey_p8_base64.txt` | the App Store Connect API key, base64 |
| `NOTARY_KEY_ID` | `6RS2C83FF9` | App Store Connect → Integrations → Keys |
| `NOTARY_ISSUER_ID` | `c80776f3-5436-4638-97a7-4545770309a8` | the same page, issuer ID |

```bash
gh secret set MACOS_CERTIFICATE_P12_BASE64 --repo craigjmidwinter/getvect < ~/.apple-signing/developer_id_p12_base64.txt
gh secret set MACOS_CERTIFICATE_PASSWORD   --repo craigjmidwinter/getvect < ~/.apple-signing/p12_password.txt
gh secret set NOTARY_KEY_P8_BASE64         --repo craigjmidwinter/getvect < ~/.apple-signing/authkey_p8_base64.txt
printf '6RS2C83FF9' | gh secret set NOTARY_KEY_ID --repo craigjmidwinter/getvect
printf 'c80776f3-5436-4638-97a7-4545770309a8' | gh secret set NOTARY_ISSUER_ID --repo craigjmidwinter/getvect
```

**On the count.** The last two are identifiers rather than secrets — they appear
in Apple's own UI and leak nothing — and they are stored as secrets anyway so
there is one place to look rather than two. That is why this is five entries and
was described as four: the two identifiers are one logical thing (the notary key)
and three separate values, because Apple issues it as three. Five names to paste.

The signing identity string is **not** among them. It defaults in the workflow to
`Developer ID Application: Craig Midwinter (6UV93L24YL)` and can be overridden
with a repository *variable* `MACOS_SIGN_IDENTITY` if the certificate is ever
reissued under a different name.

---

## Three traps, all of which produce a misleading error

Both were hit for real during setup. Both cost time because the message points
somewhere other than the cause.

### 1. The `.p12` must be exported with OpenSSL's `-legacy` flag

Without it, `security import` fails with:

```
MAC verification failed during PKCS12 import (wrong password?)
```

**The password is fine.** OpenSSL 3 defaults to a MAC algorithm that macOS's
`security` cannot read, and the error blames the password — so the natural
response is to re-type, re-export and re-check a password that was never wrong.

```bash
openssl pkcs12 -export -legacy -out developer_id.p12 \
  -inkey developer_id.key -in developer_id.pem
```

### 2. A certificate with no chain is not an identity

After a successful import, `security find-identity -v -p codesigning` can still
report:

```
0 valid identities found
```

with the certificate plainly present in the keychain. The leaf needs Apple's
intermediate to chain to a trusted root, and **a fresh CI runner has no Apple
intermediates at all**, so CI hits this every time unless it is installed:

```bash
curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
security import DeveloperIDG2CA.cer -k "$KEYCHAIN" -T /usr/bin/codesign
```

The release workflow does this before importing the `.p12`, and then **checks the
identity count rather than the import's exit status** — because both traps look
identical from the outside: an import that succeeded and produced nothing usable.
Failing there with a named cause is the difference between a two-minute fix and
twenty minutes of opaque electron-builder output.

### 3. electron-builder wants the identity *without* its prefix

Every Apple tool — `security find-identity`, `codesign -dvvv` — names the identity
in full:

```
Developer ID Application: Craig Midwinter (6UV93L24YL)
```

Passing that to electron-builder fails:

```
⨯ Please remove prefix "Developer ID Application:" from the specified name —
  appropriate certificate will be chosen automatically
```

So `mac.identity` must be **`Craig Midwinter (6UV93L24YL)`**, and the string you
copy out of every diagnostic command is the wrong one. Found by running the real
signed build rather than by reading: in CI this would have failed on the first
release tag, *after* packaging, with the certificate correctly imported, the
notary credentials correct and nothing wrong except this string — the most
expensive possible place to learn it.

---

## Verifying the credentials without a release

**The signing identity:**

```bash
security find-identity -v -p codesigning
# 1) CBA6881A6604D4A497F9D06195DD0CD5AA5DBDD6 "Developer ID Application: Craig Midwinter (6UV93L24YL)"
#    1 valid identities found
```

**The notary credentials** — and this is the check the workflow reuses, because it
is the cheapest proof that the key, key id and issuer id agree with each other
and with Apple:

```bash
xcrun notarytool history --key AuthKey.p8 --key-id 6RS2C83FF9 \
  --issuer c80776f3-5436-4638-97a7-4545770309a8
# No submission history.
```

**"No submission history." with exit 0 is the success case.** A fresh key has
never submitted anything; what is being tested is that Apple accepted the
credentials at all. Reading that as a failure is the obvious mistake and it is
why it is written down.

---

## What happens on a release tag if a secret is missing

**The release fails at the first step of the macOS job**, before anything is
built:

```
::error::macOS release signing is not configured. Missing repository secret(s): …
::error::A release cannot be published unsigned. See SIGNING.md for what each one is and how to set it.
```

That failure is the gate working. It was induced three ways before any credential
existed: all five absent, **four present and one absent** — the likelier accident,
since nobody deletes five secrets but somebody rotates one and mistypes the name —
and all five present, which must pass, because a gate that cannot pass sends the
next person to rip out working code to satisfy it.

## WHEN THE SITE MAY SAY "SIGNED" — a binding sequencing rule

The site and README currently say the published macOS build is unsigned. **That
stays until CI has proven otherwise end to end**, which means all of:

1. a real `notarytool` submission that returns **Accepted**,
2. the ticket **stapled**,
3. `xcrun stapler validate` passing on the asset **re-downloaded from the
   published release**.

**Not when the workflow is wired. Not when it runs green locally. Not when the
secrets exist.** A local signed build proves the pipeline can sign; it does not
prove that what a user downloads is signed, and the claim on the site is about
what a user downloads. **The evidence has to be the file a user gets.**

A sibling artefact that exercises the same code path is exactly convincing
enough to stop you checking the real one — which is the failure this repo has hit
repeatedly: an injector verified on a build directory while the deploy served a
hand-copied snapshot, a favicon verified at 512px while the tab drew 16.

**When it does pass, change the copy in the SAME commit that records the proof**,
so the claim and its evidence cannot drift apart, and write what a reader can
check themselves rather than an assertion:

> Signed with Developer ID, Team `6UV93L24YL`, and notarized by Apple. Verify it
> yourself: `spctl -a -t install -vv GetVect-<version>-arm64.dmg` should say
> `accepted`, and `codesign -dvvv` should show that team identifier.

A claim a reader can run beats a claim a reader must believe.

## The proof, recorded — v0.1.3, 26 August 2026

The three conditions above are met, so this section exists rather than the claim
sitting on its own. Everything here was measured against
`GetVect-0.1.3-arm64.dmg` **re-downloaded from the published release** with a
cache-buster, not against a build directory:

    sha256   ae25f7185dd514615a230af41fa988a37b4723c0766d9f73cb19f0f56ddcac8f
    bytes    121,635,204   (post-staple)
    feed     sha512 in latest-mac.yml MATCHES the downloaded bytes

    notarytool   status Accepted   log status Accepted   issues 0
    codesign --verify --deep --strict   dmg PASS   app PASS
    spctl -a -t install / -t exec       accepted, source=Notarized Developer ID
    xcrun stapler validate              dmg PASS   app PASS

    Authority=Developer ID Application: Craig Midwinter (6UV93L24YL)
    Authority=Developer ID Certification Authority
    Authority=Apple Root CA
    TeamIdentifier=6UV93L24YL

Two details worth keeping. Apple accepted the hardened runtime **first
submission, zero issues** — the sharp and resvg native binaries needed no
entitlement exceptions beyond what is already in `build/entitlements.mac.plist`.
And the CDN served the download as `x-cache: HIT`; that is fine *because the
digest was checked*, which is the whole reason the check compares bytes rather
than trusting that a fresh URL returns fresh bytes.

The site, docs, README and the release-notes template were updated to the signed
copy in the same commit as this section, per the rule above.

## Checking a build by hand

```bash
scripts/verify-signed-dmg.sh release/GetVect-0.1.3-arm64.dmg
```

Against an unsigned build this fails with six distinct reasons and exits 1.

## Windows

Windows executables are not signed by this workflow, and nothing in this file
applies to the `.exe`. That is a separate track — see the **Code signing policy**
section on the site.
