import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TESTIDS } from '../shared/testids';
import {
  DEFAULT_SETTINGS,
  hexOf,
  isSupportedInput,
  parseHex,
  toDxf,
  toEps,
  type ExportFormat,
  type RasterImage,
  type RgbColor,
  type VectorizePhase,
  type VectorizeResult,
  type VectorizeSettings,
} from '../engine';
import { api } from './api';
import { basename, decodeBlob, mimeForName, stemOf } from './lib/decode';
import { vectorizeImage } from './lib/engineClient';
import { Preview, fmt, type PreviewMode } from './components/Preview';

/**
 * GetVect workspace — REFERENCE sections A (launch & ingest) and C (preview),
 * wired to the engine in src/engine via a worker (see lib/engineClient).
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
 * it at face value. Discrete controls (the enhance switch, a palette edit, the
 * explicit re-vectorize button) are single deliberate acts and should feel
 * instant. Both paths still go through the same queue, so at most one trace is
 * ever in flight (see the job runner below).
 */
const DEBOUNCE_CONTINUOUS = 140;
const DEBOUNCE_DISCRETE = 0;

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
const ZOOM_STEP = 1.25;
/** Must match `.preview-pane { gap }` in styles.css — used for fit-zoom maths. */
const VIEW_GAP = 10;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

let idCounter = 0;
const nextImageId = () => `img-${++idCounter}`;

export function App() {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [mode, setMode] = useState<PreviewMode>('vector');
  const [zoomOverride, setZoomOverride] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 });

  const [swatchIndex, setSwatchIndex] = useState(0);
  const [mergeTarget, setMergeTarget] = useState(0);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);

  const paneRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    setToast(
      rejected.length === 0
        ? null
        : `Unsupported ${rejected.length === 1 ? 'file' : 'files'}: ${rejected.join(', ')} — GetVect accepts PNG, JPEG and BMP images.`,
    );

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
    setSelectedId((current) => current ?? entries[0].id);

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
                            colorCount: Math.max(2, result.palette.length),
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

  const zoomBy = useCallback(
    (factor: number) => setZoomOverride((current) => clamp((current ?? fitZoom) * factor, MIN_ZOOM, MAX_ZOOM)),
    [fitZoom],
  );
  const zoomToFit = useCallback(() => {
    setZoomOverride(null);
    setPan({ x: 0, y: 0 });
  }, []);
  const panBy = useCallback((dx: number, dy: number) => {
    setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
  }, []);

  // Switching images starts from a fit view of the new artwork.
  useEffect(() => {
    setZoomOverride(null);
    setPan({ x: 0, y: 0 });
    setSwatchIndex(0);
    setMergeTarget(0);
  }, [selectedId]);

  // --- settings & palette (REFERENCE B2/B3) --------------------------------

  const palette: RgbColor[] = selected?.result?.palette ?? [];
  const activeSwatch = palette.length ? clamp(swatchIndex, 0, palette.length - 1) : 0;
  /** True once the palette in the preview is the user's, not the engine's. */
  const paletteEdited = Boolean(selected?.settings.palette);
  const activeHex = hexOf(palette[activeSwatch] ?? { r: 0, g: 0, b: 0 });

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
      requestVectorize(selected.id, { palette: next, colorCount: Math.max(2, next.length) });
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

  // --- export (REFERENCE D) ------------------------------------------------

  const doExport = useCallback(
    async (format: ExportFormat) => {
      const bridge = api();
      const image = selected;
      if (!bridge || !image?.result) return;
      const contents =
        format === 'svg' ? image.result.svg : format === 'eps' ? toEps(image.result) : toDxf(image.result);
      // Drop the previous path first: `data-last-export-path` must describe the
      // export in hand, never the one before it (docs/TESTIDS.md D).
      setLastExportPath(null);
      try {
        const outcome = await bridge.saveExport({
          defaultName: `${stemOf(image.name)}.${format}`,
          contents,
          format,
        });
        if (!outcome.canceled && outcome.filePath) setLastExportPath(outcome.filePath);
      } catch (error) {
        setToast(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
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

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const dropped = event.dataTransfer?.files;
      void ingest(dropped ? Array.from(dropped) : []);
    },
    [ingest],
  );
  const allowDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, []);

  return (
    <main data-testid={TESTIDS.appRoot} className="app" onDragOver={allowDrop} onDrop={onDrop}>
      <aside className="sidebar">
        <header className="brand">
          <h1>GetVect</h1>
          <p>Raster → vector, locally.</p>
        </header>

        <section
          data-testid={TESTIDS.dropZone}
          className="drop-zone"
          onDragEnter={allowDrop}
          onDragOver={allowDrop}
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

          <div className="button-group">
            <button
              data-testid={TESTIDS.previewToggle}
              type="button"
              onClick={() => setMode((current) => (current === 'original' ? 'vector' : 'original'))}
            >
              {mode === 'original' ? 'Show vector' : 'Show original'}
            </button>
            <button data-testid={TESTIDS.previewSideBySide} type="button" onClick={() => setMode('side-by-side')}>
              Side by side
            </button>
          </div>

          <div className="button-group">
            <button data-testid={TESTIDS.zoomOut} type="button" onClick={() => zoomBy(1 / ZOOM_STEP)}>
              −
            </button>
            <span data-testid={TESTIDS.zoomLevel} data-zoom={fmt(zoom)} className="zoom-level">
              {Math.round(zoom * 100)}%
            </span>
            <button data-testid={TESTIDS.zoomIn} type="button" onClick={() => zoomBy(ZOOM_STEP)}>
              +
            </button>
            <button data-testid={TESTIDS.zoomFit} type="button" onClick={zoomToFit}>
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

          <div className="button-group">
            <button data-testid={TESTIDS.exportSvg} type="button" disabled={!ready} onClick={() => void doExport('svg')}>
              SVG
            </button>
            <button data-testid={TESTIDS.exportEps} type="button" disabled={!ready} onClick={() => void doExport('eps')}>
              EPS
            </button>
            <button data-testid={TESTIDS.exportDxf} type="button" disabled={!ready} onClick={() => void doExport('dxf')}>
              DXF
            </button>
            <span
              data-testid={TESTIDS.exportStatus}
              className="export-status"
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
          image={previewImage}
          svg={svg}
          paneRef={paneRef}
          busy={busy}
        />

        {selected ? (
          <div data-testid={TESTIDS.settingsPanel} className="settings-panel">
            <div className="settings-grid">
              <Slider
                testid={TESTIDS.settingColorCount}
                label="Colors"
                hint={paletteEdited ? 'edited palette' : describeColors(selected.settings.colorCount)}
                min={2}
                max={64}
                value={clamp(selected.settings.colorCount, 2, 64)}
                onChange={(value) =>
                  // A colour count is a fresh palette by definition, so an
                  // earlier hand-edit is dropped rather than silently ignored.
                  setSetting({ colorCount: value, palette: null }, DEBOUNCE_CONTINUOUS)
                }
              />
              <Slider
                testid={TESTIDS.settingDetail}
                label="Detail"
                hint={describeDetail(selected.settings.detail)}
                min={0}
                max={100}
                value={selected.settings.detail}
                onChange={(value) => setSetting({ detail: value }, DEBOUNCE_CONTINUOUS)}
              />
              <Slider
                testid={TESTIDS.settingSmoothing}
                label="Smoothing"
                hint={describeSmoothing(selected.settings.smoothing)}
                min={0}
                max={100}
                value={selected.settings.smoothing}
                onChange={(value) => setSetting({ smoothing: value }, DEBOUNCE_CONTINUOUS)}
              />
              <Slider
                testid={TESTIDS.settingDespeckle}
                label="Despeckle"
                hint={describeDespeckle(selected.settings.despeckle)}
                min={0}
                max={100}
                value={selected.settings.despeckle}
                onChange={(value) => setSetting({ despeckle: value }, DEBOUNCE_CONTINUOUS)}
              />
            </div>

            <div className="settings-actions">
              <label className="switch" title="Denoise and simplify colours before tracing">
                <input
                  data-testid={TESTIDS.enhanceToggle}
                  type="checkbox"
                  checked={selected.settings.enhance}
                  onChange={(event) => setSetting({ enhance: event.target.checked })}
                />
                <span>Enhance image (experimental)</span>
              </label>
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
              <div className="spacer" />
              <span className="settings-summary">{summaryOf(selected)}</span>
            </div>

            {/*
              The editor stays mounted while a re-trace is in flight — losing the
              swatch you just clicked mid-drag would be hostile — but it is
              flagged `data-stale` so it is obvious the swatches describe the
              picture on screen, not the one being computed.
            */}
            {palette.length > 0 ? (
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
                  <span className="palette-selected">
                    <span className="swatch swatch-chip" style={{ background: activeHex }} />
                    {activeHex}
                  </span>
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
            ) : null}
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
  const paths = `${pathCount} path${pathCount === 1 ? '' : 's'}`;
  return `${width}×${height} · ${colors} · ${paths} · ${Math.round(durationMs)} ms`;
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
