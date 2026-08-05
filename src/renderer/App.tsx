import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TESTIDS } from '../shared/testids';
import {
  DEFAULT_SETTINGS,
  hexOf,
  isSupportedInput,
  parseHex,
  serialize,
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
import { api } from './api';
import { basename, decodeBlob, mimeForName, stemOf } from './lib/decode';
import { vectorizeImage } from './lib/engineClient';
import { svgToPngBase64 } from './lib/raster';
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

  const [swatchIndex, setSwatchIndex] = useState(0);
  const [mergeTarget, setMergeTarget] = useState(0);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  /** Format currently in the save dialog, so its button can show it. */
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

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
        const message = error instanceof Error ? error.message : String(error);
        setImages((prev) =>
          prev.map((image) =>
            image.id === entry.id ? { ...image, status: 'error', error: message } : image,
          ),
        );
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
    if (target) URL.revokeObjectURL(target.url);
    const next = imagesRef.current.filter((image) => image.id !== id);
    setImages(next);
    setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current));
    setLastExportPath(null);
  }, []);

  // --- the job runner ------------------------------------------------------
  //
  // Only the selected image is traced: a background image nobody is looking at
  // would just compete for the worker. Selecting it starts its job (its `job`
  // counter is already non-zero from decode), which is what keeps
  // "select image 2, export image 2" honest (REFERENCE A3 / D4).

  const jobKey =
    selected && selected.raster && selected.status === 'vectorizing'
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
    if (!jobKey || !selected || !selected.raster) return;
    const id = selected.id;
    const raster = selected.raster;
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
                      // An edited palette is re-read from the result so the
                      // swatch the user clicks is exactly the slot the engine
                      // painted — a merge collapses two slots into one, and the
                      // colour count follows the palette it now describes.
                      settings: image.settings.palette
                        ? {
                            ...image.settings,
                            palette: result.palette.map((c) => ({ ...c })),
                            colorCount: Math.max(1, result.palette.length),
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

  const previewImage = useMemo(
    () =>
      selected && selected.width > 0
        ? { url: selected.url, width: selected.width, height: selected.height }
        : null,
    [selected],
  );

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
  const activeSwatch = palette.length ? clamp(swatchIndex, 0, palette.length - 1) : 0;
  /** True once the palette in the preview is the user's, not the engine's. */
  const paletteEdited = Boolean(settings.palette);
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
      requestVectorize(selected.id, { palette: next, colorCount: Math.max(1, next.length) });
    },
    [selected, requestVectorize],
  );

  const onSwatchColor = useCallback(
    (hex: string) => {
      const rgb = parseHex(hex);
      if (!rgb || !palette.length) return;
      applyPalette(palette.map((color, i) => (i === activeSwatch ? rgb : color)));
    },
    [palette, activeSwatch, applyPalette],
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
    const target = palette[effectiveMergeTarget];
    applyPalette(palette.map((color, i) => (i === activeSwatch ? { ...target } : color)));
    setSwatchIndex(Math.min(activeSwatch, effectiveMergeTarget));
    setMergeTarget(0);
  }, [palette, activeSwatch, effectiveMergeTarget, applyPalette]);

  /**
   * Remove the selected swatch: the palette drops to k-1 entries and the
   * orphaned pixels are re-quantized into whichever colours remain, so the
   * removed colour cannot survive anywhere in the output.
   */
  const onRemove = useCallback(() => {
    if (palette.length < 2) return;
    applyPalette(palette.filter((_, i) => i !== activeSwatch));
    setSwatchIndex(Math.max(0, activeSwatch - 1));
    setMergeTarget(0);
  }, [palette, activeSwatch, applyPalette]);

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
    [selected],
  );

  // --- render --------------------------------------------------------------

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
  const [displaySvg, setDisplaySvg] = useState<string | null>(null);
  useEffect(() => {
    if (svg) setDisplaySvg(svg);
  }, [svg]);
  useEffect(() => {
    if (images.length === 0) setDisplaySvg(null);
  }, [images.length]);

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
            {statusLabel(status, selected?.error ?? null, selected?.phase ?? null)}
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
              {Math.round(pan.x)}, {Math.round(pan.y)}
            </span>
          </div>

          <div className="button-group export-group">
            <span className="group-label">Export</span>
            {EXPORT_BUTTONS.map(({ format, testid, title }) => (
              <button
                key={format}
                data-testid={testid}
                type="button"
                className={exporting === format ? 'is-busy' : undefined}
                disabled={!ready || exporting !== null}
                title={title}
                onClick={() => void doExport(format)}
              >
                {format.toUpperCase()}
              </button>
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
                  hint={paletteEdited ? 'edited palette' : describeColors(settings.colorCount)}
                  min={1}
                  max={64}
                  value={clamp(settings.colorCount, 1, 64)}
                  onChange={(value) =>
                    // A colour count is a fresh palette by definition, so an
                    // earlier hand-edit is dropped rather than silently ignored.
                    setSetting({ colorCount: value, palette: null, disabledColors: [] }, DEBOUNCE_CONTINUOUS)
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
                control and the result must not silently disagree.
              */}
              <span
                data-testid={TESTIDS.settingColorCountHint}
                className="hint"
                data-requested={String(clamp(settings.colorCount, 1, 64))}
                data-actual={String(palette.length)}
              >
                {palette.length > 0
                  ? `${palette.length} colour${palette.length === 1 ? '' : 's'} in the result` +
                    (palette.length < clamp(settings.colorCount, 1, 64)
                      ? ` — the image has no more to give`
                      : '')
                  : 'computing colours…'}
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
                  value={settings.antiAliasing ?? 'off'}
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
                  value={settings.overlap ?? 'high'}
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

            <div className="settings-column">
              <div className="panel-title">Input palette</div>
              <div className="palette-sizes" role="radiogroup" aria-label="Candidate palettes">
                {PALETTE_SIZES.map((size) => (
                  <button
                    key={size}
                    data-testid={TESTIDS.paletteSizeOption}
                    data-size={String(size)}
                    type="button"
                    role="radio"
                    aria-checked={settings.colorCount === size}
                    className={`chip${settings.colorCount === size ? ' is-on' : ''}`}
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
                      className="link"
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
): string {
  switch (status) {
    case 'idle':
      return 'Waiting for an image';
    case 'loading':
      return 'Decoding…';
    case 'vectorizing':
      return `${phaseLabel(phase)}…`;
    case 'ready':
      return 'Ready';
    case 'error':
      return error ? `Error: ${error}` : 'Error';
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
  onChange,
}: {
  testid: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider">
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
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <span className="slider-hint">{hint}</span> : null}
    </label>
  );
}
