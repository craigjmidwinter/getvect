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
cannot ship.** Three properties, each of which is a thing that has gone wrong in
real projects:

1. **The artefact is verified, not the build.** After packaging, the finished
   `.dmg` is checked with `codesign --verify --deep --strict`, `spctl -a -t
   install` and `xcrun stapler validate`, plus the same three against the `.app`
   inside it. *A signing step that ran* and *a file that is signed* are different
   claims, and only the file can answer the second.

2. **Absent credentials fail; they never skip.** The credential check has no
   `if:` on it. The usual way this gate breaks is a condition like
   `if: secrets.CSC_LINK != ''` guarding the signing steps — which cannot tell
   "this is not a release" from "someone deleted the secret", and publishes an
   unsigned build with a green check in the second case. This workflow only runs
   on a release tag, so there is no legitimate path that does not need to sign.

3. **The last check runs on the re-downloaded asset.** A separate job downloads
   the `.dmg` from the release and runs the same script against it. The file that
   was verified and the file a user gets are only the same file if you check.
   It runs while the release is still a draft, so a failure means nothing was
   ever public.

The three checks live in `scripts/verify-signed-dmg.sh` — one script, run twice,
so the pre-upload and post-download gates cannot drift apart.

---

## The five secrets

Set these as **repository secrets** (Settings → Secrets and variables → Actions).

| Secret | What it is | Who has it |
|---|---|---|
| `MACOS_CERT_P12_BASE64` | The Developer ID certificate *and its private key*, as base64 | derived from a file on Craig's machine — command below |
| `MACOS_CERT_PASSWORD` | The password protecting that `.p12` | **Craig — nobody else knows it** |
| `APPLE_API_KEY_P8_BASE64` | The App Store Connect API key file (`AuthKey_XXXX.p8`), base64 | **Craig — downloadable once, from Apple** |
| `APPLE_API_KEY_ID` | That key's ID, e.g. `2X9R4ABCDE` | **Craig — from Apple** |
| `APPLE_API_ISSUER_ID` | The issuer UUID for the team | **Craig — from Apple** |

**On "two secrets".** This was scoped as two, and it is honestly five. The API key
is *three* values because Apple issues it as three — the key ID, the issuer ID
and the `.p8` file — and collapsing them loses the `.p8` entirely. The
certificate is two: the blob and the password that protects it. Only the last
four require information nobody else has; the first is mechanical.

### Before setting anything: the certificate needs a real password

As of 2026-08-25 the `.p12` at `~/.apple-signing/developer_id.p12` **opens with
an empty password.** Verified:

```bash
openssl pkcs12 -in ~/.apple-signing/developer_id.p12 -passin pass: -nokeys -noout   # succeeds
```

That is a Developer ID private key valid until 2031 protected by nothing. It is
survivable while it sits in a `0600` file in a `0700` directory on one machine.
**It stops being survivable the moment it is base64'd into a CI secret**, because
an empty password means the blob alone is enough to sign as Craig.

So the order matters:

```bash
# 1. Re-export with a real password. You will be prompted twice for a new one;
#    that value becomes MACOS_CERT_PASSWORD.
openssl pkcs12 -in ~/.apple-signing/developer_id.p12 -passin pass: -nodes \
  | openssl pkcs12 -export -out ~/.apple-signing/developer_id-protected.p12

# 2. Confirm the new file does NOT open with an empty password.
openssl pkcs12 -in ~/.apple-signing/developer_id-protected.p12 -passin pass: -nokeys -noout \
  && echo "STILL UNPROTECTED — do not upload this" \
  || echo "protected, good"

# 3. Only now, remove the unprotected original.
rm ~/.apple-signing/developer_id.p12
```

The private key does pair with the issued certificate — checked without a
keychain prompt, by comparing moduli:

```bash
openssl x509 -in ~/.apple-signing/developerID_application.cer -inform DER -noout -modulus | openssl md5
openssl rsa  -in ~/.apple-signing/developer_id.key -noout -modulus | openssl md5
# identical => importing produces a working signing identity; the CSR does not need redoing
```

### Setting them

```bash
# The certificate blob (mechanical — no information only you have):
gh secret set MACOS_CERT_P12_BASE64 --repo craigjmidwinter/getvect \
  < <(base64 -i ~/.apple-signing/developer_id-protected.p12)

# The password you just chose:
gh secret set MACOS_CERT_PASSWORD --repo craigjmidwinter/getvect

# The App Store Connect key, from App Store Connect → Users and Access → Integrations → Keys.
# The .p8 downloads exactly once; if it is lost, revoke and make a new one.
gh secret set APPLE_API_KEY_P8_BASE64 --repo craigjmidwinter/getvect \
  < <(base64 -i ~/Downloads/AuthKey_XXXXXXXXXX.p8)
gh secret set APPLE_API_KEY_ID --repo craigjmidwinter/getvect       # e.g. 2X9R4ABCDE
gh secret set APPLE_API_ISSUER_ID --repo craigjmidwinter/getvect    # the issuer UUID
```

The signing identity string itself is **not** a secret and is not one of the
five. It defaults to `Developer ID Application: Craig Midwinter (6UV93L24YL)` in
the workflow, and can be overridden with a repository *variable*
`MACOS_SIGN_IDENTITY` if the certificate is ever reissued under a different name.

---

## What happens on a release tag until these exist

**The release fails, by design, at the first step of the macOS job**, before
anything is built:

```
::error::macOS release signing is not configured. Missing repository secret(s): …
::error::A release cannot be published unsigned. See SIGNING.md for what each one is and how to set it.
```

That failure is the gate working. It was induced and confirmed before any
credential existed — with all five absent, and with four present and one absent,
which is the likelier accident — and confirmed to pass with all five set, because
a gate that cannot pass is as broken as one that cannot fail.

## Checking a build by hand

```bash
scripts/verify-signed-dmg.sh release/GetVect-0.1.1-arm64.dmg
```

Against today's unsigned builds this **fails**, and should.

## Windows

Windows executables are not signed by this workflow. That is a separate track —
see the SignPath Foundation note on the site's download section. Nothing in this
file applies to the `.exe`.
