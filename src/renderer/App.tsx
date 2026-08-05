import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TESTIDS } from '../shared/testids';
import {
  DEFAULT_SETTINGS,
  hexOf,
  isSupportedInput,
  parseHex,
  serialize,
  toDxf,
  type AntiAliasing,
  type DetailLevel,
  type ExportFormat,
  type ModelPreset,
  type NoiseReduction,
  type Overlap,
  type RasterImage,
  type ResultStyle,
  type RgbColor,
  type SortOrder,
  type VectorizePhase,
  type VectorizeResult,
  type VectorizeSettings,
} from '../engine';
import {
  DEFAULT_ENHANCE_PROVIDER,
  ENHANCE_PROVIDERS,
  describeEnhanceError,
  enhanceProvider,
  type EnhanceProviderId,
  type EnhanceQuality,
} from '../shared/aiEnhance';
import { api } from './api';
import { basename, decodeBlob, mimeForName, stemOf } from './lib/decode';
import { vectorizeImage } from './lib/engineClient';
import { hasMeaningfulAlpha, rasterToPngBytes, svgToPngBase64 } from './lib/raster';
import { Preview, fmt, type PreviewMode } from './components/Preview';

/**
 * GetVect workspace — REFERENCE sections A (launch & ingest), B (the control
 * surface), C (preview) and D (export), wired to the engine in src/engine via a
 * worker (see lib/engineClient).
 *
 * The DOM contract this file implements is documented in docs/TESTIDS.md; every
 * `data-testid` comes from src/shared/testids.ts so a rename is a compile error
 * rather than a red suite.
 */

type ImageStatus = 'loading' | 'vectorizing' | 'ready' | 'error';

/**
 * Where this image is in the AI Enhance pass (src/main/aiEnhance.ts).
 *
 * `failed` is a terminal state on purpose: a provider that just refused the key
 * will refuse it again, and re-asking on every settings change would burn the
 * user's quota to keep showing them the same error. Toggling AI Enhance off and
 * on again is the retry.
 */
type AiState = 'idle' | 'running' | 'done' | 'failed';

interface ImageEntry {
  id: string;
  name: string;
  /** Object URL of the source file, used by the original view. */
  url: string;
  raster: RasterImage | null;
  width: number;
  height: number;
  settings: VectorizeSettings;
  status: ImageStatus;
  progress: number;
  /** Phase of the in-flight trace, for the status line. */
  phase: VectorizePhase | null;
  result: VectorizeResult | null;
  error: string | null;
  /**
   * Bumped whenever the image needs (re)tracing. `${id}:${job}` is the key the
   * job effect starts work on, so a settings change during a trace supersedes
   * it instead of racing it.
   */
  job: number;
  /** Debounce for this job, in ms — see `DEBOUNCE_*`. */
  delay: number;

  /**
   * The AI-enhanced bitmap, once a provider has returned one. It *replaces*
   * `raster` as the working image while AI Enhance is on — at the provider's
   * own dimensions, which is what the real product does: the enhanced
   * re-illustration is the picture being traced, not an overlay on the source.
   * Cached for the life of the image so toggling the feature off and on again
   * does not buy a second call.
   */
  aiRaster: RasterImage | null;
  /** Object URL of that PNG, so the ORIGINAL pane shows the working image. */
  aiUrl: string | null;
  aiState: AiState;
}

/**
 * Re-vectorization is debounced by intent, not by a single global constant.
 *
 * A slider emits an `input` event per pixel of travel, so a drag across the
 * detail slider is ~100 settings changes; each one is a full trace if we take
 * it at face value. Discrete controls (a preset button, the enhance switch, a
 * palette edit) are single deliberate acts and should feel instant. Both paths
 * still go through the same queue, so at most one trace is ever in flight (see
 * the job runner below).
 */
const DEBOUNCE_CONTINUOUS = 140;
const DEBOUNCE_DISCRETE = 0;

/** How long a rejection stays up before it dismisses itself (REFERENCE A2). */
const TOAST_MS = 8_000;

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
const ZOOM_STEP = 1.25;
const WHEEL_STEP = 1.0015;
/** Must match `.preview-pane { gap }` in styles.css — used for fit-zoom maths. */
const VIEW_GAP = 10;
/**
 * How far the artwork may be dragged out of the view, as a fraction of the
 * pane. Panning has to be free enough to inspect a corner at 40x and bounded
 * enough that "Fit" is never the only way back (REFERENCE C2).
 */
const PAN_LIMIT = 0.35;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

let idCounter = 0;
const nextImageId = () => `img-${++idCounter}`;

/**
 * The export bar (REFERENCE D1-D3, D5). Order matches the reference product's
 * download menu: the vector formats first, the raster escape hatch last.
 */
const EXPORT_BUTTONS: ReadonlyArray<{ format: ExportFormat; testid: string; title: string }> = [
  { format: 'svg', testid: TESTIDS.exportSvg, title: 'Scalable Vector Graphics — the document in the preview' },
  { format: 'eps', testid: TESTIDS.exportEps, title: 'Encapsulated PostScript — for print workflows' },
  { format: 'dxf', testid: TESTIDS.exportDxf, title: 'AutoCAD DXF — for CAD, laser and vinyl cutters' },
  { format: 'pdf', testid: TESTIDS.exportPdf, title: 'Vector PDF — one page at the source pixel size' },
  { format: 'png', testid: TESTIDS.exportPng, title: 'PNG raster of the vector result' },
];

/** REFERENCE B2 / OBSERVED-UI ①. */
const PRESETS: ReadonlyArray<{ value: ModelPreset; testid: string; label: string; hint: string }> = [
  { value: 'clipart', testid: TESTIDS.presetClipart, label: 'Clipart', hint: 'Few colours — flat artwork' },
  { value: 'photo', testid: TESTIDS.presetPhoto, label: 'Photo', hint: 'Many colours — continuous tone' },
  { value: 'sketch', testid: TESTIDS.presetSketch, label: 'Sketch', hint: 'Grayscale' },
  { value: 'drawing', testid: TESTIDS.presetDrawing, label: 'Drawing', hint: 'Black & white by luminance' },
];

const DETAIL_LEVELS: ReadonlyArray<{ value: DetailLevel; label: string }> = [
  { value: 'maximum', label: 'Maximum' },
  { value: 'ultra', label: 'Ultra' },
  { value: 'very-high', label: 'Very High' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'minimum', label: 'Minimum' },
];

/** OBSERVED-UI ②: the exact candidate palette sizes the reference product offers. */
const PALETTE_SIZES = [1, 2, 3, 4, 5, 6, 8, 12, 15, 16, 18] as const;

const NOISE_LEVELS: ReadonlyArray<{ value: NoiseReduction; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
];

const AA_LEVELS: ReadonlyArray<{ value: AntiAliasing; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'smart', label: 'Smart' },
  { value: 'mid', label: 'Mid' },
];

const ROUNDNESS_LEVELS: ReadonlyArray<{ value: 0 | 1 | 2; label: string }> = [
  { value: 0, label: 'Angular' },
  { value: 1, label: 'Balanced' },
  { value: 2, label: 'Round' },
];

const MIN_AREAS = [0, 5, 90] as const;
const OVERLAPS: ReadonlyArray<{ value: Overlap; label: string }> = [
  { value: 'full', label: 'Full' },
  { value: 'high', label: 'High' },
];
const MERGE_THRESHOLDS = [0, 2, 5, 10, 20] as const;
const SORT_ORDERS: ReadonlyArray<{ value: SortOrder; label: string }> = [
  { value: 'coverage', label: 'Coverage' },
  { value: 'brightness', label: 'Brightness' },
  { value: 'hue', label: 'Hue' },
];

export function App() {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [mode, setMode] = useState<PreviewMode>('vector');
  const [zoomOverride, setZoomOverride] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 });

  /**
   * AI Enhance (optional, bring your own key) — app-level, not per-image, and
   * deliberately *not* part of `VectorizeSettings`: the engine stays a pure
   * function of (bitmap, settings) and never learns that a provider exists.
   *
   * `aiKeyDraft` is the only place key material appears in the renderer, it is
   * a `type="password"` field, and it is cleared the moment the key is handed
   * to the main process. Whether a key exists is a boolean that comes *back*
   * from there; the value never does (src/main/preload.ts).
   */
  const [aiProvider, setAiProvider] = useState<EnhanceProviderId>(DEFAULT_ENHANCE_PROVIDER);
  const [aiQuality, setAiQuality] = useState<EnhanceQuality>('fast');
  const [aiHasKey, setAiHasKey] = useState(false);
  const [aiKeyDraft, setAiKeyDraft] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false);
  /** False when the OS cannot encrypt at rest, in which case we refuse to store. */
  const [aiStorageAvailable, setAiStorageAvailable] = useState(true);

  const [swatchIndex, setSwatchIndex] = useState(0);
  const [mergeTarget, setMergeTarget] = useState(0);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  /** Format currently in the save dialog, so its button can show it. */
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  /**
   * How curved geometry travels in the DXF (REFERENCE E, "DXF lines-vs-splines
   * variants").
   *
   * `splines` is the default because it is what the curve fitting produced —
   * the same drawing as the SVG, at a comparable size. `lines` flattens every
   * curve into POLYLINE vertices for consumers that cannot read a degree-3
   * SPLINE at all (older CAD, some cutter firmware): bigger file, same picture,
   * and the only one those machines will open.
   *
   * It is an *export* choice, not a vectorization setting, so it lives next to
   * the button rather than in the settings panel and never triggers a re-trace.
   */
  const [dxfCurves, setDxfCurves] = useState<'splines' | 'lines'>('splines');

  const paneRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const selected = useMemo(
    () => images.find((image) => image.id === selectedId) ?? null,
    [images, selectedId],
  );

  /** Current list for callbacks that must not close over a stale render. */
  const imagesRef = useRef<ImageEntry[]>(images);
  imagesRef.current = images;

  // --- image bookkeeping ---------------------------------------------------

  const patchImage = useCallback((id: string, patch: Partial<ImageEntry>) => {
    setImages((prev) => prev.map((image) => (image.id === id ? { ...image, ...patch } : image)));
  }, []);

  const requestVectorize = useCallback(
    (id: string, settings?: Partial<VectorizeSettings>, delay: number = DEBOUNCE_DISCRETE) => {
      // The saved file no longer matches what will be on screen (REFERENCE D4).
      setLastExportPath(null);
      setImages((prev) =>
        prev.map((image) =>
          image.id === id
            ? {
                ...image,
                settings: settings ? { ...image.settings, ...settings } : image.settings,
                status: image.raster ? 'vectorizing' : image.status,
                progress: 0,
                phase: null,
                error: null,
                job: image.job + 1,
                delay,
              }
            : image,
        ),
      );
    },
    [],
  );

  /**
   * REFERENCE A1/A2 — the single ingest path. Drag-drop and the file picker
   * both arrive here with real `File` objects; nothing reads `File.path`.
   */
  const ingest = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const supported = isSupportedInput(file.name) || (!!file.type && isSupportedInput(file.type));
      if (supported) accepted.push(file);
      else rejected.push(file.name);
    }

    // A rejection is only cleared by time or by the user (REFERENCE A2): a
    // successful drop must not silently swallow the message about the file that
    // did not make it.
    if (rejected.length > 0) {
      setToast(
        `Unsupported ${rejected.length === 1 ? 'file' : 'files'}: ${rejected.join(', ')} — GetVect accepts PNG, JPEG and BMP images.`,
      );
    }

    if (accepted.length === 0) return;

    const entries: ImageEntry[] = accepted.map((file) => ({
      id: nextImageId(),
      name: file.name,
      url: URL.createObjectURL(file),
      raster: null,
      width: 0,
      height: 0,
      settings: { ...DEFAULT_SETTINGS },
      status: 'loading',
      progress: 0,
      phase: null,
      result: null,
      error: null,
      job: 0,
      delay: DEBOUNCE_DISCRETE,
      aiRaster: null,
      aiUrl: null,
      aiState: 'idle',
    }));

    setImages((prev) => [...prev, ...entries]);
    // The image you just dropped is the one you want to look at. Keeping the
    // previous selection makes a drop look like a no-op: the new file is
    // neither shown nor vectorized (the job runner only traces the selection).
    setSelectedId(entries[0].id);

    // Decode sequentially: the selected image gets its pixels (and therefore
    // its trace) first, and a folder-sized drop cannot swamp the renderer.
    for (let i = 0; i < accepted.length; i++) {
      const entry = entries[i];
      try {
        const raster = await decodeBlob(accepted[i]);
        setImages((prev) =>
          prev.map((image) =>
            image.id === entry.id
              ? {
                  ...image,
                  raster,
                  width: raster.width,
                  height: raster.height,
                  // REFERENCE B1: vectorization starts by itself on load.
                  status: 'vectorizing',
                  progress: 0,
                  phase: null,
                  job: image.job + 1,
                  delay: DEBOUNCE_DISCRETE,
                }
              : image,
          ),
        );
      } catch (error) {
        /**
         * A file that cannot be decoded is a rejected file (REFERENCE A2), and
         * it does not matter that the rejection happened one step later than the
         * extension check: the entry goes, exactly as it would have if the name
         * had ended in `.txt`. Leaving it in the sidebar instead parks the
         * workspace on an image that can never be traced — status stuck at
         * `error`, exports disabled, the byte count still describing whatever
         * was on screen before — and the only way out is to delete it by hand.
         */
        const message = error instanceof Error ? error.message : String(error);
        URL.revokeObjectURL(entry.url);
        setImages((prev) => {
          const next = prev.filter((image) => image.id !== entry.id);
          setSelectedId((current) =>
            current === entry.id ? (next[next.length - 1]?.id ?? null) : current,
          );
          return next;
        });
        setToast(`Could not open ${entry.name}: ${message}`);
      }
    }
  }, []);

  // A rejection nobody dismisses still has to go away on its own.
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openWithPicker = useCallback(async () => {
    const bridge = api();
    if (!bridge) {
      fileInputRef.current?.click();
      return;
    }
    const paths = await bridge.openImages();
    if (!paths.length) return;
    const files: File[] = [];
    for (const filePath of paths) {
      const name = basename(filePath);
      try {
        const bytes = await bridge.readFile(filePath);
        files.push(new File([new Uint8Array(bytes)], name, { type: mimeForName(name) }));
      } catch (error) {
        setToast(`Could not read ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await ingest(files);
  }, [ingest]);

  const removeImage = useCallback((id: string) => {
    const target = imagesRef.current.find((image) => image.id === id);
    if (target) {
      URL.revokeObjectURL(target.url);
      if (target.aiUrl) URL.revokeObjectURL(target.aiUrl);
    }
    const next = imagesRef.current.filter((image) => image.id !== id);
    setImages(next);
    setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current));
    setLastExportPath(null);
  }, []);

  // --- AI Enhance ----------------------------------------------------------
  //
  // Upstream of everything: the provider hands back a bitmap, that bitmap
  // becomes the working image, and the engine below is untouched by any of it.

  const providerInfo = enhanceProvider(aiProvider) ?? ENHANCE_PROVIDERS[0];
  /** The feature is only *on* when it can actually run. */
  const aiOn = aiEnabled && aiHasKey;

  /** Does this machine already hold a key for the selected provider? */
  useEffect(() => {
    const bridge = api();
    if (!bridge) return;
    let live = true;
    void bridge.aiEnhance.hasKey(aiProvider).then((value) => {
      if (live) setAiHasKey(value);
    });
    void bridge.aiEnhance.available().then((value) => {
      if (live) setAiStorageAvailable(value);
    });
    return () => {
      live = false;
    };
  }, [aiProvider]);

  // Losing the key turns the feature off rather than leaving a live switch that
  // silently does nothing.
  useEffect(() => {
    if (!aiHasKey) setAiEnabled(false);
  }, [aiHasKey]);

  /**
   * Run one image through the provider, then re-trace it either way.
   *
   * "Either way" is the contract: a bad key, a dead network, a timeout or a
   * reply with no image in it all end with the *un-enhanced* raster being
   * traced and a specific message on screen. The one outcome that is not
   * allowed is nothing happening.
   */
  const enhanceImageWithAi = useCallback(
    async (id: string) => {
      const bridge = api();
      const image = imagesRef.current.find((entry) => entry.id === id);
      if (!image?.raster) return;
      if (!bridge) {
        patchImage(id, { aiState: 'failed' });
        setToast('AI Enhance is only available in the desktop app.');
        requestVectorize(id);
        return;
      }

      patchImage(id, { aiState: 'running' });
      try {
        const png = await rasterToPngBytes(image.raster);
        const outcome = await bridge.aiEnhance.run({
          provider: aiProvider,
          image: png,
          // A cut-out subject must come back cut out: the prompt asks for a
          // transparent background instead of a white one when the source has
          // real alpha (src/main/aiEnhance.ts `promptFor`).
          transparent: hasMeaningfulAlpha(image.raster),
          quality: aiQuality,
        });
        if (!outcome.ok) {
          throw new Error(describeEnhanceError(outcome.code, providerInfo.label));
        }
        // Copied into a plain ArrayBuffer: what arrives over IPC is a view
        // whose backing buffer TypeScript will not promise is not shared.
        const buffer = new ArrayBuffer(outcome.image.byteLength);
        new Uint8Array(buffer).set(outcome.image);
        // The provider's own format, sniffed from the bytes in the main process
        // — not assumed. The two Gemini tiers answer in different types (flash
        // PNG, pro JPEG), and hard-coding `image/png` here is half of the bug
        // that made every `best` run fail.
        const blob = new Blob([buffer], { type: outcome.mimeType });
        const raster = await decodeBlob(blob);
        const url = URL.createObjectURL(blob);
        setImages((prev) =>
          prev.map((entry) => {
            if (entry.id !== id) return entry;
            if (entry.aiUrl) URL.revokeObjectURL(entry.aiUrl);
            return { ...entry, aiRaster: raster, aiUrl: url, aiState: 'done' };
          }),
        );
      } catch (error) {
        patchImage(id, { aiState: 'failed' });
        setToast(
          `${error instanceof Error ? error.message : String(error)} Tracing the original image instead.`,
        );
      }
      requestVectorize(id);
    },
    [aiProvider, aiQuality, providerInfo.label, patchImage, requestVectorize],
  );

  /**
   * A different model tier is a different result: drop cached enhancements so
   * the next (or current) selection re-runs at the newly chosen quality.
   */
  useEffect(() => {
    setImages((prev) =>
      prev.map((entry) => {
        if (!entry.aiRaster && entry.aiState === 'idle') return entry;
        if (entry.aiUrl) URL.revokeObjectURL(entry.aiUrl);
        return { ...entry, aiRaster: null, aiUrl: null, aiState: 'idle' };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on tier change only
  }, [aiQuality]);

  /**
   * One enhancement per image, for the selected image only — the same rule the
   * trace queue follows, and a stronger one here because every run costs the
   * user money.
   */
  const aiJobKey =
    selected && aiOn && selected.raster && !selected.aiRaster && selected.aiState === 'idle'
      ? selected.id
      : null;

  useEffect(() => {
    if (!aiJobKey) return;
    void enhanceImageWithAi(aiJobKey);
  }, [aiJobKey, enhanceImageWithAi]);

  /**
   * The bitmap the engine actually gets. This is the whole integration: swap
   * the input, change nothing else.
   */
  const workingRaster = selected ? (aiOn && selected.aiRaster ? selected.aiRaster : selected.raster) : null;

  /** True while the image is waiting on (or inside) the provider call. */
  const aiBusy = Boolean(
    selected && aiOn && selected.raster && !selected.aiRaster && selected.aiState !== 'failed',
  );

  // --- the job runner ------------------------------------------------------
  //
  // Only the selected image is traced: a background image nobody is looking at
  // would just compete for the worker. Selecting it starts its job (its `job`
  // counter is already non-zero from decode), which is what keeps
  // "select image 2, export image 2" honest (REFERENCE A3 / D4).

  const jobKey =
    selected && workingRaster && selected.status === 'vectorizing' && !aiBusy
      ? `${selected.id}:${selected.job}`
      : null;

  /**
   * Tail of the trace queue. Every job links onto it, so exactly one trace runs
   * at a time: dragging a slider cannot pile four traces into the worker and
   * then wait for all of them to finish before the last one's SVG appears. A
   * job that is superseded while it waits its turn is dropped rather than
   * computed and thrown away (`cancelled` is checked *inside* the link).
   */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!jobKey || !selected || !workingRaster) return;
    const id = selected.id;
    const raster = workingRaster;
    const settings = selected.settings;
    const delay = selected.delay;
    let cancelled = false;

    // Coalesce continuous input: a value that changes again a frame later
    // should not have cost a full trace.
    const timer = window.setTimeout(() => {
      queueRef.current = queueRef.current.then(() => {
        if (cancelled) return;
        return vectorizeImage(raster, settings, (p) => {
          if (!cancelled) patchImage(id, { progress: p.progress, phase: p.phase });
        })
          .then((result) => {
            if (cancelled) return;
            setImages((prev) =>
              prev.map((image) =>
                image.id === id
                  ? {
                      ...image,
                      result,
                      status: 'ready',
                      progress: 1,
                      phase: 'done',
                      error: null,
                      // An edited palette is re-read from the result's SLOT
                      // table, so the stored override always has exactly one
                      // entry per slot the engine cut — which is what keeps
                      // slot i paired with swatch i across every later
                      // re-vectorize. Storing `result.palette` here instead
                      // wrote back the de-duplicated list, so the first merge
                      // left k-1 colours for k slots and the *next* setting
                      // change shifted every colour past the merge.
                      //
                      // `colorCount` is NOT touched. It is the candidate
                      // palette size the user chose, the radio row shows it,
                      // and "Auto palette" recomputes from it: rewriting it to
                      // the edited palette's length meant editing one swatch of
                      // a 16-candidate palette silently moved the selection to
                      // 10, and Auto then handed back a palette that had never
                      // been on screen.
                      settings: image.settings.palette
                        ? {
                            ...image.settings,
                            palette: (result.slots ?? result.palette).map((c) => ({ ...c })),
                          }
                        : image.settings,
                    }
                  : image,
              ),
            );
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            patchImage(id, {
              status: 'error',
              phase: null,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `selected` is deliberately not a dependency: jobKey identifies the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobKey, patchImage]);

  // --- preview geometry ----------------------------------------------------

  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setPaneSize({ w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * The ORIGINAL pane shows the *working* image, which under AI Enhance is the
   * re-illustration rather than the file on disk — otherwise the side-by-side
   * compares the vector against an image it was not traced from, at a different
   * resolution, and the C2 sync maths is fed the wrong dimensions.
   */
  const previewImage = useMemo(() => {
    if (!selected) return null;
    if (aiOn && selected.aiRaster && selected.aiUrl) {
      return { url: selected.aiUrl, width: selected.aiRaster.width, height: selected.aiRaster.height };
    }
    return selected.width > 0
      ? { url: selected.url, width: selected.width, height: selected.height }
      : null;
  }, [selected, aiOn]);

  /** Zoom that makes the whole image fit the visible view (REFERENCE C2). */
  const fitZoom = useMemo(() => {
    if (!previewImage) return 1;
    const viewW = mode === 'side-by-side' ? (paneSize.w - VIEW_GAP) / 2 : paneSize.w;
    const viewH = paneSize.h;
    if (viewW <= 0 || viewH <= 0) return 1;
    const raw = Math.min(viewW / previewImage.width, viewH / previewImage.height) * 0.94;
    return clamp(raw, MIN_ZOOM, MAX_ZOOM);
  }, [previewImage, mode, paneSize]);

  const zoom = zoomOverride ?? fitZoom;

  /**
   * Is there anything to pan to?
   *
   * `fitZoom` is by definition the largest zoom at which the whole image is
   * inside the view, so anything above it is the only case where dragging can
   * reveal something. Advertising a grab cursor at Fit invites a drag that can
   * only push the artwork away (REFERENCE C2).
   */
  const pannable = previewImage != null && zoom > fitZoom + 1e-6;

  /**
   * Keep the artwork reachable: the pan is measured in image pixels, so the
   * bound is the pane size converted into image pixels. Without it one flick of
   * the mouse throws the picture off screen and "Fit" is the only way back
   * (REFERENCE C2).
   */
  const clampPan = useCallback(
    (next: { x: number; y: number }, atZoom: number) => {
      const limitX = paneSize.w > 0 ? (paneSize.w * PAN_LIMIT) / atZoom : Infinity;
      const limitY = paneSize.h > 0 ? (paneSize.h * PAN_LIMIT) / atZoom : Infinity;
      return { x: clamp(next.x, -limitX, limitX), y: clamp(next.y, -limitY, limitY) };
    },
    [paneSize],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      setZoomOverride((current) => clamp((current ?? fitZoom) * factor, MIN_ZOOM, MAX_ZOOM));
    },
    [fitZoom],
  );
  const zoomToFit = useCallback(() => {
    setZoomOverride(null);
    setPan({ x: 0, y: 0 });
  }, []);
  const panBy = useCallback(
    (dx: number, dy: number) => {
      setPan((current) => clampPan({ x: current.x + dx, y: current.y + dy }, zoom));
    },
    [clampPan, zoom],
  );

  /**
   * Wheel zoom, anchored on the pointer: the image point under the cursor stays
   * under the cursor. `pan' = pan + offset * (1/z' - 1/z)` falls straight out of
   * the stage transform in Preview.tsx.
   */
  const wheelZoom = useCallback(
    (deltaY: number, offsetFromCentre: { x: number; y: number }) => {
      if (!previewImage) return;
      const from = zoom;
      const to = clamp(from * WHEEL_STEP ** -deltaY, MIN_ZOOM, MAX_ZOOM);
      if (to === from) return;
      setZoomOverride(to);
      setPan((current) =>
        clampPan(
          {
            x: current.x + offsetFromCentre.x * (1 / to - 1 / from),
            y: current.y + offsetFromCentre.y * (1 / to - 1 / from),
          },
          to,
        ),
      );
    },
    [zoom, previewImage, clampPan],
  );

  // Switching images starts from a fit view of the new artwork.
  useEffect(() => {
    setZoomOverride(null);
    setPan({ x: 0, y: 0 });
    setSwatchIndex(0);
    setMergeTarget(0);
    // The file on disk describes the image you were looking at a moment ago.
    setLastExportPath(null);
  }, [selectedId]);

  // --- settings & palette (REFERENCE B2/B3) --------------------------------

  const settings = selected?.settings ?? DEFAULT_SETTINGS;
  const palette: RgbColor[] = selected?.result?.palette ?? [];
  /**
   * The engine's colour *slots* — one per segment of its own segmentation,
   * duplicates and all (src/engine/types.ts `slots`).
   *
   * Every palette edit is expressed against this array, because that is what
   * `settings.palette` is positionally matched to. The displayed `palette` is
   * the same list with duplicates collapsed, so sending *it* back after a merge
   * would hand k-1 colours to k slots and shift every colour past the merge one
   * place along — i.e. one merge would silently recolour the rest of the
   * picture.
   */
  const slots: RgbColor[] = selected?.result?.slots ?? palette;
  const activeSwatch = palette.length ? clamp(swatchIndex, 0, palette.length - 1) : 0;
  /** True once the palette in the preview is the user's, not the engine's. */
  const paletteEdited = Boolean(settings.palette);
  /**
   * The Drawing preset thresholds luminance into black and white (REFERENCE
   * B2), so every colour-budget control below is inert while it is selected.
   */
  const twoTone = (settings.preset ?? 'clipart') === 'drawing';
  /**
   * The lowest colour count the current preset will actually use.
   *
   * Photo is the reference product's "Many Colors" model and `presetColorCount`
   * floors it at 16, so a slider parked at 4 delivered sixteen colours while
   * displaying four — the same dishonesty the Drawing preset's dimmed sliders
   * were fixed for, in a control that still looked live. Under Photo the whole
   * colour-budget surface therefore starts at 16: the slider cannot be dragged
   * below it and the candidate sizes under it are not offered.
   */
  const colorFloor = (settings.preset ?? 'clipart') === 'photo' ? 16 : 1;
  /** The count the engine will really use — what every readout must show. */
  const effectiveColorCount = clamp(Math.max(settings.colorCount, colorFloor), 1, 64);
  const activeHex = hexOf(palette[activeSwatch] ?? { r: 0, g: 0, b: 0 });
  const disabledColors = settings.disabledColors ?? [];

  /**
   * The merge destination actually in force. `palette-merge-target` never lists
   * the selected swatch, so a stale state value (the user picked a target, then
   * selected that same swatch) must not silently become "merge into myself" —
   * fall back to the first other entry, which is also what the `<select>` shows.
   */
  const effectiveMergeTarget = useMemo(() => {
    if (palette.length < 2) return -1;
    const wanted = clamp(mergeTarget, 0, palette.length - 1);
    if (wanted !== activeSwatch) return wanted;
    return activeSwatch === 0 ? 1 : 0;
  }, [palette.length, mergeTarget, activeSwatch]);

  /**
   * What the colour-count hint says, and why (docs/TESTIDS.md
   * `color-count-hint`).
   *
   * `result.sourceColors` is the palette the image supplied before any of our
   * folds, so the two shortfalls are distinguishable: fewer source colours than
   * asked for is the image's limit, the same source colours but fewer output
   * ones is a cleanup we turned on. Blaming the image for the second was
   * telling the user to drag a slider that could not help them.
   */
  const colorHint = useMemo(() => {
    const requested = effectiveColorCount;
    const actual = palette.length;
    if (actual === 0) return { requested, actual, shortfall: 'none', text: 'computing colours…' };
    const plural = `colour${actual === 1 ? '' : 's'}`;
    if (actual >= requested) {
      return { requested, actual, shortfall: 'none', text: `${actual} ${plural} in the result` };
    }
    const source = selected?.result?.sourceColors ?? actual;
    if (source < requested) {
      return {
        requested,
        actual,
        shortfall: 'image',
        text: `${actual} ${plural} in the result — the image has no more to give`,
      };
    }
    return {
      requested,
      actual,
      shortfall: 'settings',
      text: `${actual} ${plural} in the result — ${source} were found and the cleanup settings merged the rest`,
    };
  }, [effectiveColorCount, palette.length, selected?.result?.sourceColors]);

  const setSetting = useCallback(
    (patch: Partial<VectorizeSettings>, delay: number = DEBOUNCE_DISCRETE) => {
      if (!selected) return;
      requestVectorize(selected.id, patch, delay);
    },
    [selected, requestVectorize],
  );

  /** Re-vectorize with an explicit colour table (REFERENCE B3). */
  const applyPalette = useCallback(
    (next: RgbColor[]) => {
      if (!selected || next.length === 0) return;
      /**
       * `colorCount` is deliberately left alone. It is the *candidate palette
       * size* the user picked, and the engine does not need it changed — an
       * explicit palette repaints the slots the colour count produced, it does
       * not replace the count (see "6. Repaint" in src/engine/index.ts).
       *
       * Rewriting it to the palette length is what broke "Auto palette":
       * editing one swatch of a 10-entry palette that came from candidate size
       * 16 moved the slider to 10, the 16 chip stopped being selected, and Auto
       * — which only clears `settings.palette` — then recomputed at 10 and
       * landed on a palette the user had never seen. The button advertises an
       * undo; it has to be one.
       */
      requestVectorize(selected.id, { palette: next });
    },
    [selected, requestVectorize],
  );

  /**
   * Repaint one displayed swatch: every slot currently wearing that colour is
   * handed `color`, and the rest of the table is passed through untouched.
   *
   * All three editor operations are this one move — change paints a new colour,
   * merge paints another swatch's colour (the two slots then collapse into one
   * layer), remove paints the nearest surviving colour. None of them changes
   * the number of slots, so none of them re-segments the picture.
   */
  const repaintSwatch = useCallback(
    (entry: number, color: RgbColor) => {
      if (!palette.length || !slots.length) return;
      const want = hexOf(palette[entry] ?? palette[0]);
      applyPalette(slots.map((c) => (hexOf(c) === want ? { ...color } : c)));
    },
    [palette, slots, applyPalette],
  );

  const onSwatchColor = useCallback(
    (hex: string) => {
      const rgb = parseHex(hex);
      if (!rgb || !palette.length) return;
      repaintSwatch(activeSwatch, rgb);
    },
    [palette.length, activeSwatch, repaintSwatch],
  );

  /**
   * Merge the selected swatch into another one: both slots are handed the
   * target's colour, which the engine collapses into a single layer. The
   * clustering is untouched, so the surviving colour keeps the geometry it
   * already had and simply gains the merged region — the survivor lands at
   * `min(selected, target)` once the duplicate is collapsed.
   */
  const onMerge = useCallback(() => {
    if (palette.length < 2 || effectiveMergeTarget < 0 || effectiveMergeTarget === activeSwatch) return;
    repaintSwatch(activeSwatch, palette[effectiveMergeTarget]);
    setSwatchIndex(Math.min(activeSwatch, effectiveMergeTarget));
    setMergeTarget(0);
  }, [palette, activeSwatch, effectiveMergeTarget, repaintSwatch]);

  /**
   * Remove the selected swatch: its pixels go to the closest colour still in
   * the palette, so the removed colour cannot survive anywhere in the output
   * and the palette drops to k-1 entries.
   *
   * "Closest colour" rather than "re-quantize at k-1" on purpose: re-clustering
   * would re-cut every other region too, so deleting one swatch would redraw
   * the whole picture. The pixels an absent colour owned belong with the entry
   * nearest to it, which is what a re-quantization would mostly have done
   * anyway — minus the collateral.
   */
  const onRemove = useCallback(() => {
    if (palette.length < 2) return;
    const gone = palette[activeSwatch];
    let nearest = activeSwatch === 0 ? 1 : 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      if (i === activeSwatch) continue;
      const d =
        Math.abs(palette[i].r - gone.r) +
        Math.abs(palette[i].g - gone.g) +
        Math.abs(palette[i].b - gone.b);
      if (d < bestD) {
        bestD = d;
        nearest = i;
      }
    }
    repaintSwatch(activeSwatch, palette[nearest]);
    setSwatchIndex(Math.max(0, activeSwatch - 1));
    setMergeTarget(0);
  }, [palette, activeSwatch, repaintSwatch]);

  /** Throw the edits away and let the engine compute the palette again. */
  const onAutoPalette = useCallback(() => {
    if (!selected) return;
    setSwatchIndex(0);
    setMergeTarget(0);
    setSetting({ palette: null });
  }, [selected, setSetting]);

  /** Toggle one output colour group on or off (REFERENCE B3). */
  const toggleColorGroup = useCallback(
    (index: number) => {
      const current = new Set(disabledColors);
      if (current.has(index)) current.delete(index);
      else current.add(index);
      setSetting({ disabledColors: [...current].sort((a, b) => a - b) });
    },
    [disabledColors, setSetting],
  );

  // --- AI Enhance controls -------------------------------------------------

  const saveAiKey = useCallback(async () => {
    const bridge = api();
    if (!bridge) return;
    const outcome = await bridge.aiEnhance.setKey(aiProvider, aiKeyDraft);
    if (!outcome.ok) {
      setToast(outcome.error ?? 'The API key could not be saved.');
      return;
    }
    // The field never holds the key after it has been handed over; from here
    // on the renderer's entire knowledge of it is `aiHasKey`.
    setAiKeyDraft('');
    setAiHasKey(true);
  }, [aiProvider, aiKeyDraft]);

  const clearAiKey = useCallback(async () => {
    const bridge = api();
    if (!bridge) return;
    await bridge.aiEnhance.clearKey(aiProvider);
    setAiKeyDraft('');
    setAiHasKey(false);
    setAiEnabled(false);
  }, [aiProvider]);

  /**
   * Turning the feature on or off changes the working image, so it re-traces
   * exactly like any other setting. Turning it *on* also clears a previous
   * failure, which is what makes the switch the retry gesture.
   */
  const toggleAiEnhance = useCallback(
    (checked: boolean) => {
      setAiEnabled(checked);
      if (checked) {
        setImages((prev) =>
          prev.map((image) =>
            image.aiRaster || image.aiState !== 'failed' ? image : { ...image, aiState: 'idle' },
          ),
        );
      }
      if (selected) requestVectorize(selected.id);
    },
    [selected, requestVectorize],
  );

  // --- export (REFERENCE D) ------------------------------------------------

  /**
   * REFERENCE D — every export goes through this one function and out through
   * `window.getvect.saveExport`, i.e. the native save dialog in the main
   * process. There is deliberately no second, dialog-free write path
   * (docs/TESTIDS.md, "Export dialog under test").
   *
   * The bytes come from the engine's converters, run over the result that is
   * *currently in the preview*, so what you see is what you save (C3). The one
   * exception is PNG, which no pure-geometry engine can produce: it is
   * rasterized from that same SVG document by the renderer.
   */
  const doExport = useCallback(
    async (format: ExportFormat) => {
      const bridge = api();
      const image = selected;
      if (!bridge || !image?.result) return;
      // Drop the previous path first: `data-last-export-path` must describe the
      // export in hand, never the one before it (docs/TESTIDS.md D).
      setLastExportPath(null);
      setExporting(format);
      try {
        const contents =
          format === 'png'
            ? await svgToPngBase64(image.result.svg, image.result.width, image.result.height)
            : format === 'dxf'
              ? toDxf(image.result, { curves: dxfCurves })
              : serialize(image.result, format);
        const binary = format === 'png';
        const outcome = await bridge.saveExport({
          // D4: the source filename with the format's extension, e.g.
          // `logo-flat-512.png` → `logo-flat-512.svg`.
          defaultName: `${stemOf(image.name)}.${format}`,
          contents,
          format,
          encoding: binary ? 'base64' : 'utf8',
        });
        if (!outcome.canceled && outcome.filePath) setLastExportPath(outcome.filePath);
      } catch (error) {
        setToast(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setExporting(null);
      }
    },
    [selected, dxfCurves],
  );

  // --- render --------------------------------------------------------------

  /** In-flight provider call for the image on screen — a distinct busy state. */
  const aiRunning = Boolean(selected && aiOn && selected.aiState === 'running');
  /** What `ai-enhance-status` reports (docs/TESTIDS.md B4b). */
  const aiStateAttr: 'off' | AiState = !aiOn ? 'off' : (selected?.aiState ?? 'idle');

  const status: 'idle' | ImageStatus = selected ? selected.status : 'idle';
  const busy = status === 'loading' || status === 'vectorizing';
  const progress = status === 'loading' ? 0 : (selected?.progress ?? 0);
  const ready = status === 'ready';
  const svg = selected?.result?.svg ?? null;

  /**
   * What the preview shows.
   *
   * The current result when there is one, otherwise the last document we had.
   * Switching to a not-yet-traced image must not empty the pane — a blank frame
   * reads as "the app lost my work" (REFERENCE C1). It is replaced the instant
   * the new trace lands, so `ready` still means "this is the export".
   */
  const [lastSvg, setLastSvg] = useState<string | null>(null);
  useEffect(() => {
    if (svg) setLastSvg(svg);
  }, [svg]);
  /**
   * Emptying the workspace has to take the document with it *in the same
   * render*. Clearing it from an effect instead leaves one committed frame in
   * which the status line already says `idle` while `export-size` still reports
   * the removed image's bytes next to disabled buttons — a number describing a
   * document that is not on screen.
   */
  const displaySvg = images.length === 0 ? null : lastSvg;

  const svgBytes = useMemo(
    () => (displaySvg ? new TextEncoder().encode(displaySvg).length : 0),
    [displaySvg],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      const dropped = event.dataTransfer?.files;
      void ingest(dropped ? Array.from(dropped) : []);
    },
    [ingest],
  );
  const allowDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  }, []);
  const onDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  return (
    <main
      data-testid={TESTIDS.appRoot}
      className="app"
      data-dragging={String(dragging)}
      onDragEnter={onDragEnter}
      onDragOver={allowDrop}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <aside className="sidebar">
        <header className="brand">
          <h1>GetVect</h1>
          <p>Raster → vector, locally.</p>
        </header>

        <section
          data-testid={TESTIDS.dropZone}
          className="drop-zone"
          onDragEnter={onDragEnter}
          onDragOver={allowDrop}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <p className="drop-headline">Drop images here</p>
          <p className="drop-hint">PNG · JPEG · BMP</p>
          <button data-testid={TESTIDS.filePickerButton} type="button" onClick={() => void openWithPicker()}>
            Choose files…
          </button>
          <input
            data-testid={TESTIDS.fileInput}
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.bmp,image/png,image/jpeg,image/bmp"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void ingest(files);
            }}
          />
        </section>

        {toast ? (
          <div data-testid={TESTIDS.errorToast} className="error-toast" role="alert">
            <span>{toast}</span>
            <button type="button" className="link" onClick={() => setToast(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ) : null}

        {images.length > 0 ? (
          <ul data-testid={TESTIDS.imageList} className="image-list">
            {images.map((image) => (
              <li
                key={image.id}
                data-testid={TESTIDS.imageListItem}
                data-image-id={image.id}
                data-selected={String(image.id === selectedId)}
                className={`image-item${image.id === selectedId ? ' is-selected' : ''}`}
                onClick={() => setSelectedId(image.id)}
              >
                <img className="thumb" src={image.url} alt="" />
                <span data-testid={TESTIDS.imageListItemName} className="image-name">
                  {image.name}
                </span>
                <button
                  data-testid={TESTIDS.imageRemoveButton}
                  type="button"
                  className="link"
                  aria-label={`Remove ${image.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeImage(image.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </aside>

      <section data-testid={TESTIDS.workspace} className="workspace" data-image-id={selected?.id ?? ''}>
        <div className="toolbar">
          <span data-testid={TESTIDS.statusText} data-status={status} className={`status status-${status}`}>
            {statusLabel(status, selected?.error ?? null, selected?.phase ?? null, aiRunning)}
          </span>

          {busy ? (
            <span
              data-testid={TESTIDS.progressIndicator}
              className="progress"
              data-progress={fmt(clamp(progress, 0, 1))}
              role="progressbar"
            >
              <span className="progress-bar" style={{ width: `${Math.round(clamp(progress, 0, 1) * 100)}%` }} />
            </span>
          ) : null}

          <div className="spacer" />

          {/* REFERENCE B6 — filled layers vs stroked layers. */}
          <div className="button-group">
            <span className="group-label">Style</span>
            {([
              { value: 'filled' as ResultStyle, testid: TESTIDS.resultStyleFilled, label: 'Filled' },
              { value: 'stroked' as ResultStyle, testid: TESTIDS.resultStyleStroked, label: 'Stroked' },
            ]).map(({ value, testid, label }) => (
              <button
                key={value}
                data-testid={testid}
                type="button"
                disabled={!selected}
                data-selected={String((settings.resultStyle ?? 'filled') === value)}
                className={`toggle${(settings.resultStyle ?? 'filled') === value ? ' is-on' : ''}`}
                title={value === 'filled' ? 'Colour-filled vector elements' : 'Colour-bordered vector elements'}
                onClick={() => setSetting({ resultStyle: value })}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="button-group">
            <button
              data-testid={TESTIDS.previewToggle}
              type="button"
              disabled={!selected}
              onClick={() => setMode((current) => (current === 'original' ? 'vector' : 'original'))}
            >
              {mode === 'original' ? 'Show vector' : 'Show original'}
            </button>
            <button
              data-testid={TESTIDS.previewSideBySide}
              type="button"
              disabled={!selected}
              onClick={() => setMode('side-by-side')}
            >
              Side by side
            </button>
          </div>

          <div className="button-group">
            <button data-testid={TESTIDS.zoomOut} type="button" disabled={!selected} onClick={() => zoomBy(1 / ZOOM_STEP)}>
              −
            </button>
            <span data-testid={TESTIDS.zoomLevel} data-zoom={fmt(zoom)} className="zoom-level">
              {Math.round(zoom * 100)}%
            </span>
            <button data-testid={TESTIDS.zoomIn} type="button" disabled={!selected} onClick={() => zoomBy(ZOOM_STEP)}>
              +
            </button>
            <button data-testid={TESTIDS.zoomFit} type="button" disabled={!selected} onClick={zoomToFit}>
              Fit
            </button>
            <span
              data-testid={TESTIDS.panState}
              className="pan-state"
              data-pan-x={fmt(pan.x)}
              data-pan-y={fmt(pan.y)}
            >
              {/*
                A bare "0, 0" in the header of an app with no image loaded is a
                coordinate for a thing that does not exist — the data attributes
                stay (the suite reads pan from them), the text does not.
              */}
              {selected ? `${Math.round(pan.x)}, ${Math.round(pan.y)}` : ''}
            </span>
          </div>

          <div className="button-group export-group">
            <span className="group-label">Export</span>
            {EXPORT_BUTTONS.map(({ format, testid, title }) => (
              <span key={format} className="export-format">
                <button
                  data-testid={testid}
                  type="button"
                  className={exporting === format ? 'is-busy' : undefined}
                  disabled={!ready || exporting !== null}
                  title={title}
                  onClick={() => void doExport(format)}
                >
                  {format.toUpperCase()}
                </button>
                {/*
                  REFERENCE E, "DXF lines-vs-splines variants". It sits on the
                  DXF button because it changes nothing else: the drawing is the
                  same, only how its curves are written down differs, and the
                  machine that needs the flattened form needs it at save time.
                */}
                {format === 'dxf' ? (
                  <select
                    data-testid={TESTIDS.exportDxfCurves}
                    className="export-variant"
                    /*
                      Gated on the same condition as the DXF button it belongs
                      to. A live select in an otherwise greyed-out export row
                      configures an export that cannot happen.
                    */
                    disabled={!ready || exporting !== null}
                    aria-label="DXF curve encoding"
                    title={
                      'How curves are written: SPLINE entities (smaller, what the tracer fitted) ' +
                      'or flattened POLYLINE vertices for consumers that cannot read splines'
                    }
                    value={dxfCurves}
                    onChange={(event) =>
                      setDxfCurves(event.target.value === 'lines' ? 'lines' : 'splines')
                    }
                  >
                    <option value="splines">Splines</option>
                    <option value="lines">Lines</option>
                  </select>
                ) : null}
              </span>
            ))}
            {/*
              Both labels occupy a fixed box whether they have anything to say or
              not. A status line that grows when it appears drags the whole
              right-packed row sideways, and the second click of a two-format
              export lands on a different button than the one under the cursor
              (REFERENCE D4).
            */}
            <span data-testid={TESTIDS.exportSize} className="export-size" data-bytes={String(svgBytes)}>
              {svgBytes > 0 ? formatBytes(svgBytes) : ''}
            </span>
            <span
              data-testid={TESTIDS.exportStatus}
              className="export-status"
              title={lastExportPath ?? ''}
              {...(lastExportPath ? { 'data-last-export-path': lastExportPath } : {})}
            >
              {lastExportPath ? `Saved ${basename(lastExportPath)}` : ''}
            </span>
          </div>
        </div>

        <Preview
          mode={mode}
          zoom={zoom}
          pan={pan}
          onPanBy={panBy}
          onWheelZoom={wheelZoom}
          image={previewImage}
          svg={displaySvg}
          paneRef={paneRef}
          busy={busy}
          pannable={pannable}
        />

        {/*
          The control surface is mounted for the whole life of an image, at a
          fixed height, and every panel inside it scrolls rather than growing.
          A settings row that appears when the first result lands moves the
          artwork twice per image (REFERENCE B1: the UI stays put while it
          works), and a palette that reflows with its own length moves it again
          on every setting change.
        */}
        {selected ? (
          <div data-testid={TESTIDS.settingsPanel} className="settings-panel">
            <div className="settings-column">
              <div className="control-row" role="group" aria-label="Model preset">
                {PRESETS.map(({ value, testid, label, hint }) => (
                  <button
                    key={value}
                    data-testid={testid}
                    type="button"
                    title={hint}
                    data-selected={String((settings.preset ?? 'clipart') === value)}
                    className={`toggle${(settings.preset ?? 'clipart') === value ? ' is-on' : ''}`}
                    onClick={() => setSetting({ preset: value, palette: null })}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <Field label="Detail level">
                <select
                  data-testid={TESTIDS.settingDetailLevel}
                  aria-label="Detail level"
                  value={settings.detailLevel ?? 'high'}
                  onChange={(event) => setSetting({ detailLevel: event.target.value as DetailLevel })}
                >
                  {DETAIL_LEVELS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>

              {(settings.preset ?? 'clipart') === 'drawing' ? (
                <Field label={`B/W threshold ${settings.bwThreshold ?? 128}`}>
                  <input
                    data-testid={TESTIDS.settingBwThreshold}
                    type="range"
                    min={0}
                    max={255}
                    step={1}
                    aria-label="Black and white luminance threshold"
                    value={settings.bwThreshold ?? 128}
                    onChange={(event) =>
                      setSetting({ bwThreshold: Number(event.target.value) }, DEBOUNCE_CONTINUOUS)
                    }
                  />
                </Field>
              ) : null}

              <div className="settings-grid">
                <Slider
                  testid={TESTIDS.settingColorCount}
                  label="Colors"
                  /**
                   * Drawing is two-tone by construction (REFERENCE B2), so the
                   * colour budget has nothing to decide. The real product swaps
                   * these controls out entirely under that preset; disabling
                   * them is the same promise: a live control that cannot change
                   * the result is a lie about the product.
                   */
                  disabled={twoTone}
                  hint={
                    twoTone
                      ? 'Drawing is black & white'
                      : paletteEdited
                        ? 'edited palette'
                        : describeColors(effectiveColorCount)
                  }
                  min={colorFloor}
                  max={64}
                  value={effectiveColorCount}
                  onChange={(value) =>
                    // A colour count is a fresh palette by definition, so an
                    // earlier hand-edit is dropped rather than silently ignored.
                    setSetting(
                      {
                        colorCount: Math.max(value, colorFloor),
                        palette: null,
                        disabledColors: [],
                      },
                      DEBOUNCE_CONTINUOUS,
                    )
                  }
                />
                <Slider
                  testid={TESTIDS.settingDetail}
                  label="Detail"
                  hint={describeDetail(settings.detail)}
                  min={0}
                  max={100}
                  value={settings.detail}
                  onChange={(value) => setSetting({ detail: value }, DEBOUNCE_CONTINUOUS)}
                />
                <Slider
                  testid={TESTIDS.settingSmoothing}
                  label="Smoothing"
                  hint={describeSmoothing(settings.smoothing)}
                  min={0}
                  max={100}
                  value={settings.smoothing}
                  onChange={(value) => setSetting({ smoothing: value }, DEBOUNCE_CONTINUOUS)}
                />
                <Slider
                  testid={TESTIDS.settingDespeckle}
                  label="Despeckle"
                  hint={describeDespeckle(settings.despeckle)}
                  min={0}
                  max={100}
                  value={settings.despeckle}
                  onChange={(value) => setSetting({ despeckle: value }, DEBOUNCE_CONTINUOUS)}
                />
              </div>

              {/*
                The slider asks for a number the image often cannot supply — a
                six-colour logo has six colours however far right you drag. The
                control and the result must not silently disagree, AND the hint
                has to name the right culprit: the shortfall is sometimes the
                image running out and sometimes our own cleanup folding colour
                groups together, and those call for opposite reactions from the
                user (drag the slider back vs. turn a cleanup off).
              */}
              <span
                data-testid={TESTIDS.settingColorCountHint}
                className="hint"
                data-requested={String(colorHint.requested)}
                data-actual={String(colorHint.actual)}
                data-shortfall={colorHint.shortfall}
              >
                {colorHint.text}
              </span>
            </div>

            <div className="settings-column">
              <label className="switch" title="Denoise and simplify colours before tracing">
                <input
                  data-testid={TESTIDS.enhanceToggle}
                  type="checkbox"
                  checked={settings.enhance}
                  onChange={(event) => setSetting({ enhance: event.target.checked })}
                />
                <span>Enhance image (Beta)</span>
              </label>

              {/*
                AI Enhance — the one feature in GetVect that can send anything
                anywhere, so it is its own labelled group, off by default, inert
                without a key, and carries the privacy sentence in the open
                rather than in a tooltip.

                It is deliberately independent of the classical Enhance switch
                above: that one is a local denoise/simplify bundle in the engine
                and keeps its name and its behaviour. With both on, the AI pass
                runs first (it produces the working image) and the classical
                bundle runs second, inside `vectorize()`.
              */}
              <div
                data-testid={TESTIDS.aiEnhanceGroup}
                className="ai-enhance"
                data-provider={aiProvider}
                data-has-key={String(aiHasKey)}
                data-enabled={String(aiOn)}
              >
                <div className="panel-title">AI Enhance — bring your own key</div>

                <Field label="Provider">
                  <select
                    data-testid={TESTIDS.aiProviderSelect}
                    aria-label="AI Enhance provider"
                    value={aiProvider}
                    onChange={(event) => setAiProvider(event.target.value as EnhanceProviderId)}
                  >
                    {ENHANCE_PROVIDERS.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Quality">
                  <select
                    data-testid={TESTIDS.aiQualitySelect}
                    aria-label="AI Enhance quality"
                    value={aiQuality}
                    onChange={(event) => setAiQuality(event.target.value as EnhanceQuality)}
                  >
                    <option value="fast">Fast — ~8s, cheaper</option>
                    <option value="best">Best — ~20s, truly flat fills</option>
                  </select>
                </Field>

                <input
                  data-testid={TESTIDS.aiKeyInput}
                  className="ai-key-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${providerInfo.label} API key`}
                  placeholder={aiHasKey ? 'Saved — type to replace' : `${providerInfo.label} API key`}
                  value={aiKeyDraft}
                  onChange={(event) => setAiKeyDraft(event.target.value)}
                />

                <div className="control-row">
                  <button
                    data-testid={TESTIDS.aiKeySaveButton}
                    type="button"
                    disabled={!aiKeyDraft.trim()}
                    title={`Encrypt and store the key on this machine (${providerInfo.keyUrl})`}
                    onClick={() => void saveAiKey()}
                  >
                    Save key
                  </button>
                  <button
                    data-testid={TESTIDS.aiKeyClearButton}
                    type="button"
                    disabled={!aiHasKey}
                    title="Delete the stored key from this machine"
                    onClick={() => void clearAiKey()}
                  >
                    Clear
                  </button>
                  {/* A boolean, never a value: the renderer has never seen the key. */}
                  <span
                    data-testid={TESTIDS.aiKeyStatus}
                    className={`hint${aiHasKey ? ' is-ok' : ''}`}
                    data-has-key={String(aiHasKey)}
                  >
                    {aiHasKey ? 'Key saved' : 'No key saved'}
                  </span>
                </div>

                {aiStorageAvailable ? null : (
                  <span className="hint is-warn">
                    This machine has no OS keystore, so GetVect will not store a key at all.
                  </span>
                )}

                <label
                  className={`switch${aiHasKey ? '' : ' is-disabled'}`}
                  title={aiHasKey ? undefined : 'Save an API key first'}
                >
                  <input
                    data-testid={TESTIDS.aiEnhanceToggle}
                    type="checkbox"
                    checked={aiOn}
                    disabled={!aiHasKey}
                    onChange={(event) => toggleAiEnhance(event.target.checked)}
                  />
                  <span>Enhance with AI before tracing</span>
                </label>

                {/*
                  REQUIRED and deliberately not a tooltip: the trade this
                  feature makes is the one thing the rest of the product exists
                  to avoid, so it is stated where the switch is.
                */}
                <span data-testid={TESTIDS.aiEnhanceNotice} className="hint ai-notice">
                  Sends this image to {providerInfo.destination} using your key. Everything else in
                  GetVect stays on your machine.
                </span>

                <span
                  data-testid={TESTIDS.aiEnhanceStatus}
                  className="hint"
                  data-ai-state={aiStateAttr}
                >
                  {aiStatusLabel(aiStateAttr, providerInfo.label)}
                </span>
              </div>

              <Field label="Noise reduction">
                <select
                  data-testid={TESTIDS.settingNoiseReduction}
                  aria-label="Noise reduction"
                  value={settings.noiseReduction ?? 'off'}
                  onChange={(event) =>
                    setSetting({ noiseReduction: event.target.value as NoiseReduction })
                  }
                >
                  {NOISE_LEVELS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Anti-aliasing">
                <select
                  data-testid={TESTIDS.settingAntiAliasing}
                  aria-label="Anti-aliasing"
                  value={settings.antiAliasing ?? DEFAULT_SETTINGS.antiAliasing}
                  onChange={(event) => setSetting({ antiAliasing: event.target.value as AntiAliasing })}
                >
                  {AA_LEVELS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Roundness">
                <select
                  data-testid={TESTIDS.settingRoundness}
                  aria-label="Roundness"
                  value={String(settings.roundness ?? 1)}
                  onChange={(event) =>
                    setSetting({ roundness: Number(event.target.value) as 0 | 1 | 2 })
                  }
                >
                  {ROUNDNESS_LEVELS.map(({ value, label }) => (
                    <option key={value} value={String(value)}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Minimum area">
                <select
                  data-testid={TESTIDS.settingMinArea}
                  aria-label="Minimum area"
                  value={String(settings.minArea ?? 5)}
                  onChange={(event) => setSetting({ minArea: Number(event.target.value) })}
                >
                  {MIN_AREAS.map((value) => (
                    <option key={value} value={String(value)}>
                      {value} px²
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Overlap">
                <select
                  data-testid={TESTIDS.settingOverlap}
                  aria-label="Overlap"
                  value={settings.overlap ?? DEFAULT_SETTINGS.overlap}
                  onChange={(event) => setSetting({ overlap: event.target.value as Overlap })}
                >
                  {OVERLAPS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>

              <label className="switch" title="Replace round contours with exact circles">
                <input
                  data-testid={TESTIDS.settingCircleDetection}
                  type="checkbox"
                  checked={Boolean(settings.circleDetection)}
                  onChange={(event) => setSetting({ circleDetection: event.target.checked })}
                />
                <span>Circle detection</span>
              </label>

              <div className="control-row">
                <button
                  data-testid={TESTIDS.revectorizeButton}
                  type="button"
                  onClick={() => requestVectorize(selected.id)}
                >
                  Re-vectorize
                </button>
                <button
                  data-testid={TESTIDS.resetSettingsButton}
                  type="button"
                  onClick={() => {
                    setSwatchIndex(0);
                    setMergeTarget(0);
                    setSetting({ ...DEFAULT_SETTINGS });
                  }}
                >
                  Reset
                </button>
              </div>
              <span className="settings-summary">{summaryOf(selected)}</span>
            </div>

            <div className="settings-column is-input-colors">
              <div className="panel-title">Input palette</div>
              <div className="palette-sizes" role="radiogroup" aria-label="Candidate palettes">
                {PALETTE_SIZES.map((size) => (
                  <button
                    key={size}
                    data-testid={TESTIDS.paletteSizeOption}
                    data-size={String(size)}
                    type="button"
                    role="radio"
                    aria-checked={effectiveColorCount === size}
                    disabled={twoTone || size < colorFloor}
                    className={`chip${effectiveColorCount === size ? ' is-on' : ''}`}
                    onClick={() =>
                      setSetting({ colorCount: size, palette: null, disabledColors: [] })
                    }
                  >
                    {size}
                  </button>
                ))}
              </div>

              <div
                data-testid={TESTIDS.paletteEditor}
                className={`palette-editor${ready ? '' : ' is-stale'}`}
                data-stale={String(!ready)}
                data-palette-size={palette.length}
              >
                <div className="palette-head">
                  <span className="palette-title">
                    Palette<em>{palette.length}</em>
                  </span>
                  {paletteEdited ? (
                    <button
                      data-testid={TESTIDS.paletteAutoButton}
                      type="button"
                      /*
                        Full button chrome, deliberately: this is the only route
                        back from a hand-edited palette, and as unstyled body
                        text beside the PALETTE label it was the one thing on a
                        panel of bordered buttons that did not read as
                        pressable.
                      */
                      className="palette-auto"
                      onClick={onAutoPalette}
                      title="Discard palette edits and recompute from the image"
                    >
                      Auto palette
                    </button>
                  ) : null}
                </div>
                <div className="swatches" role="listbox" aria-label="Computed palette">
                  {palette.map((color, index) => {
                    const hex = hexOf(color);
                    return (
                      <button
                        key={`${hex}-${index}`}
                        data-testid={TESTIDS.paletteSwatch}
                        data-color={hex}
                        data-index={index}
                        type="button"
                        role="option"
                        aria-selected={index === activeSwatch}
                        title={`${hex} — click to edit`}
                        aria-label={`Palette colour ${index + 1}: ${hex}`}
                        className={`swatch${index === activeSwatch ? ' is-active' : ''}`}
                        style={{ background: hex }}
                        onClick={() => {
                          setSwatchIndex(index);
                          setMergeTarget(index === 0 ? (palette.length > 1 ? 1 : 0) : 0);
                        }}
                      />
                    );
                  })}
                </div>
                <div className="palette-actions">
                  <label>
                    Color
                    <input
                      data-testid={TESTIDS.paletteColorInput}
                      type="color"
                      aria-label="Change the selected palette colour"
                      value={activeHex}
                      onChange={(event) => onSwatchColor(event.target.value)}
                    />
                  </label>
                  <label>
                    Merge into
                    <select
                      data-testid={TESTIDS.paletteMergeTarget}
                      aria-label="Merge the selected colour into"
                      value={String(effectiveMergeTarget)}
                      onChange={(event) => setMergeTarget(Number(event.target.value))}
                    >
                      {palette.map((color, index) =>
                        index === activeSwatch ? null : (
                          <option key={`${index}-${hexOf(color)}`} value={String(index)}>
                            {hexOf(color)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <button
                    data-testid={TESTIDS.paletteMergeButton}
                    type="button"
                    disabled={palette.length < 2}
                    onClick={onMerge}
                  >
                    Merge
                  </button>
                  <button
                    data-testid={TESTIDS.paletteRemoveButton}
                    type="button"
                    disabled={palette.length < 2}
                    onClick={onRemove}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>

            <div className="settings-column is-output-colors">
              {/* REFERENCE B3 — output colour groups. */}
              <div data-testid={TESTIDS.colorGroups} className="color-groups">
                <div className="panel-title">Output colours</div>
                <div className="control-row">
                  <Field label="Merge">
                    <select
                      data-testid={TESTIDS.colorMergeThreshold}
                      aria-label="Merge threshold"
                      value={String(settings.mergeThreshold ?? 0)}
                      onChange={(event) => setSetting({ mergeThreshold: Number(event.target.value) })}
                    >
                      {MERGE_THRESHOLDS.map((value) => (
                        <option key={value} value={String(value)}>
                          {value}%
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Sort">
                    <select
                      data-testid={TESTIDS.colorSortOrder}
                      aria-label="Sort order"
                      value={settings.sortOrder ?? 'coverage'}
                      onChange={(event) => setSetting({ sortOrder: event.target.value as SortOrder })}
                    >
                      {SORT_ORDERS.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="group-list">
                  {palette.map((color, index) => {
                    const hex = hexOf(color);
                    return (
                      <label key={`${hex}-${index}`} className="group-row" title={`${hex}`}>
                        <input
                          data-testid={TESTIDS.colorGroupToggle}
                          data-index={String(index)}
                          data-color={hex}
                          type="checkbox"
                          checked={!disabledColors.includes(index)}
                          onChange={() => toggleColorGroup(index)}
                        />
                        <span className="swatch swatch-chip" style={{ background: hex }} />
                        <span className="group-hex">{hex}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function statusLabel(
  status: 'idle' | ImageStatus,
  error: string | null,
  phase: VectorizePhase | null,
  aiRunning: boolean,
): string {
  switch (status) {
    case 'idle':
      return 'Waiting for an image';
    case 'loading':
      return 'Decoding…';
    case 'vectorizing':
      // The provider round-trip is seconds long and is not tracing: saying
      // "Tracing…" while an image is on its way to a server is the one moment
      // the status line must not be vague.
      return aiRunning ? 'Enhancing with AI…' : `${phaseLabel(phase)}…`;
    case 'ready':
      return 'Ready';
    case 'error':
      return error ? `Error: ${error}` : 'Error';
  }
}

/** One line describing where the AI pass is, for `ai-enhance-status`. */
function aiStatusLabel(state: 'off' | AiState, providerLabel: string): string {
  switch (state) {
    case 'off':
      return 'Off — nothing leaves this machine.';
    case 'idle':
      return 'On — the next trace will be enhanced.';
    case 'running':
      return `Sending to ${providerLabel}…`;
    case 'done':
      return 'Enhanced image traced.';
    case 'failed':
      return 'Enhancement failed — tracing the original.';
  }
}

function phaseLabel(phase: VectorizePhase | null): string {
  switch (phase) {
    case 'preprocess':
      return 'Enhancing';
    case 'quantize':
      return 'Reducing colours';
    case 'simplify':
      return 'Removing specks';
    case 'trace':
      return 'Tracing';
    case 'serialize':
      return 'Building SVG';
    default:
      return 'Vectorizing';
  }
}

/** One-line description of what the current result cost (REFERENCE "Economy"). */
function summaryOf(image: ImageEntry): string {
  if (!image.result) return '';
  const { palette, pathCount, durationMs, width, height } = image.result;
  const colors = `${palette.length} colour${palette.length === 1 ? '' : 's'}`;
  const paths = `${pathCount} layer${pathCount === 1 ? '' : 's'}`;
  return `${width}×${height} · ${colors} · ${paths} · ${Math.round(durationMs)} ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Slider hints: the numbers alone say nothing about what the knob does to the
// artwork, and the reference product's own controls are equally opaque. These read out
// the *effect* so a first-time user can aim instead of scrub.

const describeColors = (v: number) => (v <= 4 ? 'poster' : v <= 12 ? 'flat art' : 'shaded');
const describeDetail = (v: number) =>
  v <= 20 ? 'loose shapes' : v <= 45 ? 'simplified' : v <= 75 ? 'faithful' : 'every pixel step';
const describeSmoothing = (v: number) =>
  v <= 5 ? 'polylines' : v <= 40 ? 'gentle curves' : v <= 80 ? 'curve fitted' : 'long sweeps';
const describeDespeckle = (v: number) =>
  v === 0 ? 'keep everything' : v <= 30 ? 'grain' : v <= 70 ? 'small specks' : 'aggressive';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function Slider({
  testid,
  label,
  hint,
  min,
  max,
  value,
  disabled,
  onChange,
}: {
  testid: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  value: number;
  /** A control that cannot affect the result must not look live (REFERENCE B2). */
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`slider${disabled ? ' is-disabled' : ''}`}>
      <span className="slider-label">
        {label}
        <em>{value}</em>
      </span>
      <input
        data-testid={testid}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <span className="slider-hint">{hint}</span> : null}
    </label>
  );
}
