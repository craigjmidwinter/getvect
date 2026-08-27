# The GetVect command line — full reference

The contract for calling GetVect as a program. Written for someone who will
never read the source, because that is the actual reader: a script, an agent, or
a person integrating it into a build.

Everything here is enforced by `tests/engine/cli.test.mjs`. If this document and
the binary disagree, the binary is right and the disagreement is a bug — please
report it.

## Invocation

```
getvect <input> [output] [options]
```

Two ways to reach it, and they behave identically:

| | |
|---|---|
| from a clone | `node bin/getvect.mjs …` (run `npm run build:node` once first) |
| installed | `getvect …` — `brew install craigjmidwinter/tap/getvect` |

The packaged macOS app is also a CLI: passing arguments to the binary inside
`GetVect.app` traces and exits without ever opening a window.

## Input

| | |
|---|---|
| accepted | `.png` `.jpg` `.jpeg` `.bmp` |
| chosen by | file extension, case-insensitive |
| not accepted | anything else, including a file whose contents are an image but whose name is not |

A path that does not exist exits **66**. A path with an unrecognised extension
exits **65**. Neither reads the file.

## Output

If you give an output path, it is used. If you do not, the output is the input
path with the format's extension — so `getvect logo.png` writes `logo.svg` **in
the same directory as the input**.

`-` as the output path writes to stdout instead of a file.

### It will not overwrite an existing file

Writing to a path that already exists exits **73**, writes nothing, and prints
the path on stderr. Pass `--force` to replace it.

```
$ getvect logo.png
getvect: /work/logo.svg already exists — pass --force to overwrite it
$ echo $?
73
```

**This applies to the derived default too**, which is the case worth knowing
about: `getvect logo.png` refuses when `logo.svg` exists, and the file at risk
there is one you never named.

The default is refusal because this tool is built to be called by something that
cannot check the filesystem first. To such a caller a silent overwrite is
undetectable — the exit code is 0 and the output looks perfect.

Writing to stdout is never refused: a pipe has nothing to clobber.

Writing to the input path is always refused, even with `--force`, because it
would destroy the source and make a retry impossible.

## Formats

`svg` `eps` `dxf` `pdf` `png`

Chosen in this order:

1. `--format`, if given
2. the output path's extension, if it names a known format
3. `svg`

So `getvect a.png out.dxf` produces DXF with no flag. An output extension that
is not a known format (`out.txt`) does not error — the format falls through to
`svg` and the bytes are written to the path you asked for.

**`png` from the packaged app is not available** and exits **64** with a message.
It needs a rasterizer that the app bundle does not carry. The clone and Homebrew
installs support it.

## Options

Every setting the graphical app exposes is a flag. Ranges are inclusive.

| flag | values | default | notes |
|---|---|---|---|
| `-f`, `--format` | `svg` `eps` `dxf` `pdf` `png` | from output extension, else `svg` | |
| `-c`, `--colors` | 2–64 | `8` | `--colours` also accepted |
| `-p`, `--preset` | `clipart` `photo` `sketch` `drawing` | `clipart` | see below |
| `--detail` | 0–100 | `60` | how closely paths follow pixel edges |
| `--smoothing` | 0–100 | `50` | curve-fitting aggressiveness |
| `--despeckle` | 0–100 | `20` | drop specks below this size |
| `--detail-level` | `maximum` `ultra` `very-high` `high` `medium` `low` `minimum` | `high` | multiplies `--detail` |
| `--anti-aliasing` | `off` `smart` `mid` | `smart` | `--antialiasing` also accepted |
| `--noise-reduction` | `off` `low` `high` | `off` | |
| `--min-area` | 0–10000 | `5` | px², speck removal floor |
| `--roundness` | 0–2 | `1` | curve-fitting level |
| `--threshold` | 0–255 | `128` | luminance cut, `--preset drawing` only |
| `--dxf-lines` | flag | off | emit R12 `POLYLINE` instead of `SPLINE` |
| `--force` | flag | off | overwrite an existing output |
| `--stats` | flag | off | print one JSON object to stdout |
| `-h`, `--help` | flag | | prints to stdout, exits 0 |
| `-v`, `--version` | flag | | prints to stdout, exits 0 |

### Edges

- **An unknown flag is an error**, not a warning: exit **64**. Silently ignoring
  `--colours-please` and returning a default-coloured trace is help nobody asked
  for.
- **A value outside its range is an error**, exit **64**, naming the range.
- **A flag with a missing value is an error**, exit **64**. `--colors` at the end
  of the line, or followed by another flag, does not consume the next flag.
- **Presets override some settings.** `drawing` is two-tone by construction and
  ignores `--colors` — it delivers 2 layers whatever you ask for. `photo` raises
  the *candidate* count to at least 16, so `--colors 4 --preset photo` searches
  for 16; the delivered palette can still be fewer after folding (measured: 7 on
  a flat sticker). Candidate count and delivered count are different numbers.
- **`--colors` is a ceiling on detection, not a promise.** The engine merges
  near-identical colours, and an image may contain fewer. Asking for 52 commonly
  yields fewer; `--stats` reports what you actually got.

## Exit codes

A caller should branch on these. They follow `sysexits`.

| code | name | meaning |
|---|---|---|
| `0` | ok | the file was written |
| `64` | usage | bad arguments: unknown flag, bad value, out of range, no arguments, or `png` from the packaged app |
| `65` | bad input | unsupported extension, or the file could not be decoded |
| `66` | no input | the input path does not exist |
| `69` | not built | run from a clone without `npm run build:node` |
| `70` | trace failed | the engine or an exporter raised |
| `73` | cannot write | the output exists (without `--force`), equals the input, or could not be written |

## stdout and stderr

**stdout is empty unless you ask for something.** No progress, no banner, no
timing. A caller never has to parse around chatter to find the answer.

Written to stdout, and only these:

- the traced document, when the output path is `-`
- `--help` and `--version` text
- one line of JSON, when `--stats` is passed

**stderr carries every diagnostic**, one line, prefixed `getvect: `. A failing
run always writes at least one line there and always exits non-zero.

If a run exits non-zero, assume nothing was written.

### `--stats`

One JSON object, one line, on stdout, after a successful run. Present so a
caller can read a result without a parser.

```json
{"input":"logo.png","output":"/work/logo.svg","format":"svg","width":1195,
 "height":896,"colors":7,"layers":7,"bytes":17844,"ms":595}
```

| field | type | notes |
|---|---|---|
| `input` | string | as you passed it, not resolved |
| `output` | string | absolute path of the written file. Never null: `--stats` cannot be combined with `-` |
| `format` | string | the format actually used |
| `width`, `height` | number | source pixels |
| `colors` | number \| null | palette size delivered — may be below `--colors` |
| `layers` | number | `<g fill>` groups in the SVG |
| `bytes` | number | size of the written document |
| `ms` | number | trace duration |

**`--stats` cannot be combined with `-`.** Both write to stdout, and appending
the JSON to the document corrupts it. The combination exits **64** and names the
fix: write the document to a file, and `--stats` has stdout to itself.

## Failure modes a caller must handle

| situation | code | what to do |
|---|---|---|
| input missing | 66 | check the path; nothing was read |
| input not an accepted format | 65 | convert it first, or pick a real image |
| input unreadable/corrupt | 65 | the decode failed; the file is not a valid PNG/JPEG/BMP |
| output already exists | 73 | choose another name, or pass `--force` if replacing is intended |
| output not writable | 73 | directory missing or permission denied |
| bad flag or value | 64 | the message names the flag and its range |
| engine failed | 70 | report it — this should not happen on a valid image |
| not built | 69 | `npm run build:node` in the clone |

**A trace never produces nothing.** Any successful run writes a document; there
is no "succeeded but empty" outcome to defend against. An image with a single
colour produces a valid one-layer document.

## Guarantees

- **Deterministic.** The same input and settings produce byte-identical output.
- **The same result as the app.** The CLI is a front door onto the same engine,
  not a second implementation, and a test compares its bytes against a direct
  engine call.
- **No network, ever.** No telemetry, no update check, no license check.
- **No prompts.** Nothing waits for input; a failure is an exit code, never a
  question.
- **No window.** Even the packaged app traces headlessly when given arguments.
- **No keychain access.** Nothing touches the OS credential store.

## Examples

```bash
getvect logo.png                          # -> logo.svg, 8 colours, Clipart
getvect logo.png logo.dxf                 # format from the extension
getvect logo.png out.svg --force          # replace an existing out.svg
getvect photo.jpg -p photo -c 24          # photographic source
getvect scan.png -p drawing --threshold 150   # two-tone line art
getvect logo.png flat.dxf --dxf-lines     # R12 POLYLINE for older CAD
getvect logo.png - > logo.svg             # stdout, for a pipe
getvect logo.png out.svg --stats          # document to the file, JSON to stdout
```

Branching on the result:

```bash
if out=$(getvect "$in" "$dst" --stats 2>err.txt); then
  echo "traced $(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["layers"])') layers"
else
  case $? in
    66) echo "no such input: $in" ;;
    73) echo "$dst already exists — not overwriting" ;;
    *)  cat err.txt ;;
  esac
fi
```
