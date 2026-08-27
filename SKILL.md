---
name: getvect
description: >-
  Convert a raster image (PNG, JPEG, BMP) into a vector file (SVG, EPS, DXF,
  PDF) locally, with no network call and no account. Use when you have generated
  or been given a bitmap and need clean editable paths — a logo to scale, line
  art to cut, a diagram to embed at any size. Do not use for photographs you
  want to keep looking photographic, or for anything you only need resized.
license: MIT
compatibility: >-
  macOS and Windows. Install with `brew install craigjmidwinter/tap/getvect`,
  or clone and run `node bin/getvect.mjs` after `npm run build:node`.
metadata:
  author: Craig Midwinter
  version: "0.1.6"
  homepage: https://github.com/craigjmidwinter/getvect
---

# getvect

Trace a bitmap into vector paths. Runs entirely on the local machine.

## When to use this

Reach for it when the output must stay sharp at any size, or must be edited as
shapes rather than pixels:

- a logo or icon that needs to scale
- line art or a scan destined for a cutter or CAD (`dxf`)
- flat illustration you want as editable colour layers
- an image you produced yourself and now need as paths

**Do not use it for:**

- photographs you want to still look like photographs — tracing posterises them
- resizing, cropping or format conversion between raster formats
- text you could set as text instead; traced letterforms are outlines, not words
- an image whose output nobody will edit or scale, where the bitmap is fine

## Invocation

```bash
getvect <input> [output] [options]
```

The common case takes no options:

```bash
getvect logo.png              # writes logo.svg beside the input
```

Name the output to choose the format by extension:

```bash
getvect logo.png logo.dxf     # svg | eps | dxf | pdf | png
```

## Choosing settings

Start with the default. Change one thing at a time and re-run — it is fast and
deterministic, so the same input and flags always produce the same bytes.

| you have | use |
|---|---|
| a logo, icon or flat illustration | the default: `getvect logo.png` |
| the same, but colours look merged | `-c 16` (more colours) |
| a photograph | `-p photo -c 24` |
| a scan, sketch or line art | `-p drawing` — two-tone; add `--threshold 90..170` if too much or too little survives |
| a pencil or shaded drawing | `-p sketch` |
| output for a cutter or old CAD | `-f dxf --dxf-lines` |
| a noisy or JPEG-artefacted source | `--noise-reduction high` |
| too many tiny specks in the result | `--min-area 90` |
| detail lost at edges | `--detail 85` |

`-c` is a **ceiling on detection, not a promise**. The engine merges
near-identical colours, so asking for 32 often yields fewer. Read `--stats` for
what you actually got rather than assuming.

Full flag list, ranges and defaults: `getvect --help`, or `docs/CLI.md`.

## Reading the result

Exit code 0 means the file was written. Anything else means **nothing was
written** — do not look for partial output.

| code | meaning | do |
|---|---|---|
| 0 | written | continue |
| 64 | bad arguments | fix the flag; the message names it and its range |
| 65 | input not usable | wrong extension, or the file is not a valid image |
| 66 | input not found | check the path |
| 69 | not built | run `npm run build:node` in the clone |
| 70 | trace failed | report it; should not happen on a valid image |
| 73 | cannot write | see below — usually the output already exists |

Every failure prints one line to stderr, prefixed `getvect: `. stdout stays
empty unless you pass `--stats`, so you never have to parse around chatter.

## Exit 73 — read this before choosing a filename

**getvect will not overwrite an existing file.** Writing to a path that already
exists exits 73 and writes nothing.

This is the most likely way an automated caller goes wrong, because **the
default output name is derived**: `getvect logo.png` writes `logo.svg`, so it
can refuse over a file you never named.

On 73, do one of these — do not retry the same command:

1. **Pick a different output path** and re-run. Preferred: it cannot destroy
   anything.
2. **Pass `--force`** only if replacing that specific file is what you intend.

```bash
getvect logo.png out.svg || {
  # 73: out.svg exists. Choose another name rather than forcing.
  getvect logo.png "out-$(date +%s).svg"
}
```

Never pass `--force` speculatively to make an error go away. The file it
replaces may be something you cannot get back.

## Machine-readable output

```bash
getvect logo.png out.svg --stats
```

prints one JSON object on one line to stdout:

```json
{"input":"logo.png","output":"/work/out.svg","format":"svg","width":1195,
 "height":896,"colors":7,"layers":7,"bytes":17844,"ms":595}
```

Use `colors` to check whether `-c` did what you expected, and `layers` to see
how many editable colour groups the SVG has.

`--stats` cannot be combined with `-` (stdout output) — both write to stdout and
the JSON would corrupt the document. That combination exits 64.

## Piping

```bash
getvect logo.png - > logo.svg
```

`-` writes the document to stdout. Nothing else is printed there, so the stream
is the file.

## What it will not do

- **No network.** No telemetry, no update check, no license check. Nothing about
  your image leaves the machine.
- **No prompts.** It never waits for input. A problem is an exit code, never a
  question.
- **No window.** Even the packaged app traces headlessly when given arguments.
- **No partial writes.** A non-zero exit means no file was written.

## Also available

A browser version at <https://getvect.midwinter.io/app/> for humans without an
install — same engine, no CLI.
