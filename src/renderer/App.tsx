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
  result: VectorizeResult | null;
  error: string | null;
  /**
   * Bumped whenever the image needs (re)tracing. `${id}:${job}` is the key the
   * job effect starts work on, so a settings change during a trace supersedes
   * it instead of racing it.
   */
  job: number;
}

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
    (id: string, settings?: Partial<VectorizeSettings>) => {
      setImages((prev) =>
        prev.map((image) =>
          image.id === id
            ? {
                ...image,
                settings: settings ? { ...image.settings, ...settings } : image.settings,
                status: image.raster ? 'vectorizing' : image.status,
                progress: 0,
                error: null,
                job: image.job + 1,
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
      result: null,
      error: null,
      job: 0,
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
                  job: image.job + 1,
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

  useEffect(() => {
    if (!jobKey || !selected || !selected.raster) return;
    const image = selected;
    const raster = selected.raster;
    const settings = selected.settings;
    let cancelled = false;

    // Coalesce slider drags: a value that changes again within a frame or two
    // should not cost a full trace.
    const timer = window.setTimeout(() => {
      vectorizeImage(raster, settings, (p) => {
        if (!cancelled) patchImage(image.id, { progress: p.progress });
      })
        .then((result) => {
          if (cancelled) return;
          patchImage(image.id, { result, status: 'ready', progress: 1, error: null });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          patchImage(image.id, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, 80);

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

  const setSetting = useCallback(
    (patch: Partial<VectorizeSettings>) => {
      if (!selected) return;
      requestVectorize(selected.id, patch);
    },
    [selected, requestVectorize],
  );

  const applyPalette = useCallback(
    (next: RgbColor[]) => {
      if (!selected || next.length === 0) return;
      requestVectorize(selected.id, { palette: next, colorCount: next.length });
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

  const onMerge = useCallback(() => {
    if (palette.length < 2) return;
    // The merged-away slot's pixels are absorbed by the remaining clusters —
    // dropping the slot is exactly the "merge" the engine documents.
    applyPalette(palette.filter((_, i) => i !== activeSwatch));
    setSwatchIndex(0);
    setMergeTarget(0);
  }, [palette, activeSwatch, applyPalette]);

  const onRemove = useCallback(() => {
    if (palette.length < 2) return;
    applyPalette(palette.filter((_, i) => i !== activeSwatch));
    setSwatchIndex(0);
    setMergeTarget(0);
  }, [palette, activeSwatch, applyPalette]);

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
            {statusLabel(status, selected?.error ?? null)}
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
                min={2}
                max={64}
                value={selected.settings.colorCount}
                onChange={(value) => setSetting({ colorCount: value, palette: null })}
              />
              <Slider
                testid={TESTIDS.settingDetail}
                label="Detail"
                min={0}
                max={100}
                value={selected.settings.detail}
                onChange={(value) => setSetting({ detail: value })}
              />
              <Slider
                testid={TESTIDS.settingSmoothing}
                label="Smoothing"
                min={0}
                max={100}
                value={selected.settings.smoothing}
                onChange={(value) => setSetting({ smoothing: value })}
              />
              <Slider
                testid={TESTIDS.settingDespeckle}
                label="Despeckle"
                min={0}
                max={100}
                value={selected.settings.despeckle}
                onChange={(value) => setSetting({ despeckle: value })}
              />
            </div>

            <div className="settings-actions">
              <label className="switch">
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
                onClick={() => setSetting({ ...DEFAULT_SETTINGS })}
              >
                Reset
              </button>
            </div>

            {ready && palette.length > 0 ? (
              <div data-testid={TESTIDS.paletteEditor} className="palette-editor">
                <div className="swatches">
                  {palette.map((color, index) => {
                    const hex = hexOf(color);
                    return (
                      <button
                        key={`${hex}-${index}`}
                        data-testid={TESTIDS.paletteSwatch}
                        data-color={hex}
                        data-index={index}
                        type="button"
                        title={hex}
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
                      value={hexOf(palette[activeSwatch] ?? { r: 0, g: 0, b: 0 })}
                      onChange={(event) => onSwatchColor(event.target.value)}
                    />
                  </label>
                  <label>
                    Merge into
                    <select
                      data-testid={TESTIDS.paletteMergeTarget}
                      value={String(mergeTarget)}
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

function statusLabel(status: 'idle' | ImageStatus, error: string | null): string {
  switch (status) {
    case 'idle':
      return 'Waiting for an image';
    case 'loading':
      return 'Decoding…';
    case 'vectorizing':
      return 'Vectorizing…';
    case 'ready':
      return 'Ready';
    case 'error':
      return error ? `Error: ${error}` : 'Error';
  }
}

function Slider({
  testid,
  label,
  min,
  max,
  value,
  onChange,
}: {
  testid: string;
  label: string;
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
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
