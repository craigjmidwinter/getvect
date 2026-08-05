import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { TESTIDS } from '../../shared/testids';

/**
 * Preview pane — REFERENCE C.
 *
 * One zoom/pan state drives both views, so "synchronised" is structural rather
 * than something that has to be kept in step: the original raster and the
 * traced SVG read the same `zoom`/`pan` props and publish them verbatim as
 * `data-zoom` / `data-pan-x` / `data-pan-y` (docs/TESTIDS.md C).
 *
 * Geometry: each view is an `overflow:hidden` window with an absolutely
 * positioned anchor at its centre. The stage hanging off that anchor is exactly
 * image-sized and transformed with
 *
 *     scale(zoom) translate(pan - imageSize / 2)
 *
 * so `pan` is measured in *image pixels* (the unit docs/TESTIDS.md requires for
 * `pan-state`) and zooming keeps the pane centre fixed. Nothing here depends on
 * the view's own pixel size, so the two views cannot drift apart.
 */

export type PreviewMode = 'original' | 'vector' | 'side-by-side';

export interface PreviewImage {
  url: string;
  width: number;
  height: number;
}

interface PreviewProps {
  mode: PreviewMode;
  zoom: number;
  pan: { x: number; y: number };
  /** Drag delta in CSS pixels; the pane converts to image pixels itself. */
  onPanBy: (dxImage: number, dyImage: number) => void;
  /** Wheel notch + pointer offset from the pane centre, in CSS pixels. */
  onWheelZoom: (deltaY: number, offsetFromCentre: { x: number; y: number }) => void;
  image: PreviewImage | null;
  /** The exact SVG document the engine produced (REFERENCE C3). */
  svg: string | null;
  paneRef: React.RefObject<HTMLDivElement>;
  busy: boolean;
  /**
   * True only when the artwork is larger than the view, i.e. when a drag can
   * actually reveal something. Drives the grab cursor and `data-pannable`.
   */
  pannable: boolean;
}

/** Attribute-safe number formatting — both views must emit identical strings. */
export const fmt = (n: number): string => String(Math.round(n * 1e6) / 1e6);

export function Preview({
  mode,
  zoom,
  pan,
  onPanBy,
  onWheelZoom,
  image,
  svg,
  paneRef,
  busy,
  pannable,
}: PreviewProps) {
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      dragRef.current = { x: event.clientX, y: event.clientY };
      event.preventDefault();
    },
    [],
  );

  /**
   * Wheel zoom (REFERENCE C2). The handler is attached natively rather than
   * through React's synthetic `onWheel` because React registers wheel listeners
   * as passive, and a passive listener cannot `preventDefault()` — the page
   * would scroll under the artwork.
   */
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = pane.getBoundingClientRect();
      onWheelZoom(event.deltaY, {
        x: event.clientX - (rect.x + rect.width / 2),
        y: event.clientY - (rect.y + rect.height / 2),
      });
    };
    pane.addEventListener('wheel', onWheel, { passive: false });
    return () => pane.removeEventListener('wheel', onWheel);
  }, [paneRef, onWheelZoom]);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const start = dragRef.current;
      if (!start) return;
      const scale = zoomRef.current || 1;
      const dx = (event.clientX - start.x) / scale;
      const dy = (event.clientY - start.y) / scale;
      if (dx === 0 && dy === 0) return;
      dragRef.current = { x: event.clientX, y: event.clientY };
      onPanBy(dx, dy);
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onPanBy]);

  const viewAttrs = {
    'data-zoom': fmt(zoom),
    'data-pan-x': fmt(pan.x),
    'data-pan-y': fmt(pan.y),
  } as const;

  const stageStyle: CSSProperties = image
    ? {
        width: `${image.width}px`,
        height: `${image.height}px`,
        transform: `scale(${zoom}) translate(${pan.x - image.width / 2}px, ${pan.y - image.height / 2}px)`,
      }
    : {};

  const showOriginal = mode === 'original' || mode === 'side-by-side';
  const showVector = mode === 'vector' || mode === 'side-by-side';

  return (
    <div
      ref={paneRef}
      data-testid={TESTIDS.previewPane}
      data-mode={mode}
      data-pannable={String(pannable)}
      className={`preview-pane mode-${mode}`}
      onMouseDown={onMouseDown}
    >
      <View
        testid={TESTIDS.previewOriginal}
        label="Original"
        hidden={!showOriginal}
        attrs={viewAttrs}
        stageStyle={stageStyle}
      >
        {image ? (
          <img className="raster" src={image.url} width={image.width} height={image.height} alt="" draggable={false} />
        ) : null}
      </View>
      <View
        testid={TESTIDS.previewVector}
        label="Vector"
        hidden={!showVector}
        attrs={viewAttrs}
        stageStyle={stageStyle}
      >
        {svg ? <div className="svg-host" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
      </View>
      {busy ? (
        <div data-testid={TESTIDS.previewBusy} className="preview-busy" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>Vectorizing…</span>
        </div>
      ) : null}
      {!image ? (
        <p className="preview-empty">Drop an image anywhere — PNG, JPEG or BMP.</p>
      ) : null}
    </div>
  );
}

function View({
  testid,
  label,
  hidden,
  attrs,
  stageStyle,
  children,
}: {
  testid: string;
  label: string;
  hidden: boolean;
  attrs: Record<string, string>;
  stageStyle: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testid}
      className={`preview-view${hidden ? ' is-hidden' : ''}`}
      {...attrs}
    >
      <span data-testid={TESTIDS.previewViewLabel} className="view-label">
        {label}
      </span>
      <div className="view-anchor">
        <div className="view-stage" style={stageStyle}>
          {children}
        </div>
      </div>
    </div>
  );
}
