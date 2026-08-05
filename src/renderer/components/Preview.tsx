import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
 * positioned anchor at its centre. The stage hanging off that anchor is
 * *laid out* at `zoom x imageSize` and translated by
 *
 *     translate(zoom * (pan - imageSize / 2))
 *
 * so `pan` is measured in *image pixels* (the unit docs/TESTIDS.md requires for
 * `pan-state`) and zooming keeps the pane centre fixed. Nothing here depends on
 * the view's own pixel size, so the two views cannot drift apart.
 *
 * WHY LAYOUT SIZE AND NOT `transform: scale()`
 * --------------------------------------------
 * This used to be `scale(zoom) translate(...)` on an image-sized stage, which
 * is geometrically the same picture and visually a different product: Chromium
 * rasterizes a scaled layer ONCE at its layout size and then stretches that
 * texture on the GPU. The live `<svg>` in the vector view was therefore shown
 * as an upscaled bitmap — at 258% the "vector" pane was exactly as soft as the
 * raster next to it, which defeats the one comparison the app exists to make.
 *
 * Changing the *layout* size instead forces Chromium to re-rasterize the SVG at
 * the new size, i.e. at device resolution, so curves stay curves at every zoom.
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

/**
 * Above this zoom the ORIGINAL view stops smoothing and shows its true pixels
 * (`image-rendering: pixelated`).
 *
 * The side-by-side exists to say "pixels vs curves", and browser bilinear
 * smoothing quietly argues the opposite: it makes the source look like it has
 * detail it does not have, so the honest half of the comparison is the one that
 * flatters the input. Past 2x every source pixel covers a 2x2 block or more,
 * which is the point at which the smoothing is inventing more than it is
 * showing — and it is also where the smeared version stops reading as "detail"
 * and starts reading as "out of focus".
 *
 * Below the threshold the default stays: `pixelated` at 100% is not a truer
 * picture, it is the same picture with nearest-neighbour resampling artefacts,
 * and at Fit (typically < 100%) it looks plainly broken.
 */
const PIXELATE_ABOVE_ZOOM = 2;

/**
 * Layout ceiling for the stage, per axis, in CSS pixels.
 *
 * A layout box beyond this is where Chromium's raster tiling starts to give up
 * (blank tiles, dropped content), so past it the residual is taken as a
 * transform again: 40x on a 1024px image is a magnifier for looking at one
 * corner, not a crispness comparison, and MAX_ZOOM is 64.
 */
const MAX_STAGE_PX = 16_384;

/**
 * The zoom the stage is currently *laid out* at, which lags `zoom` by at most
 * one frame.
 *
 * Re-laying-out a few thousand `<path>`s is not free, and a wheel gesture
 * changes the zoom on every event. Committing the layout size on a rAF
 * coalesces a burst into one relayout per frame, and the residual
 * `zoom / layoutZoom` scale (below) keeps the picture geometrically exact in
 * the meantime — so a fast gesture may show a stretched texture for a frame or
 * two, and the resting state is always freshly rasterized. Tests can wait on
 * `data-render-zoom === data-zoom` rather than guessing (docs/TESTIDS.md C).
 */
function useLayoutZoom(target: number): number {
  const [layoutZoom, setLayoutZoom] = useState(target);
  useEffect(() => {
    if (layoutZoom === target) return;
    if (typeof requestAnimationFrame !== 'function') {
      setLayoutZoom(target);
      return;
    }
    const handle = requestAnimationFrame(() => setLayoutZoom(target));
    return () => cancelAnimationFrame(handle);
  }, [target, layoutZoom]);
  return layoutZoom;
}

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

  /**
   * How big the stage may be laid out. Below the ceiling this is simply `zoom`,
   * so the residual scale is exactly 1 and nothing is stretched.
   */
  const targetLayoutZoom = image
    ? Math.min(zoom, MAX_STAGE_PX / Math.max(image.width, image.height))
    : zoom;
  const layoutZoom = useLayoutZoom(targetLayoutZoom);
  const residual = layoutZoom > 0 ? zoom / layoutZoom : 1;

  const viewAttrs = {
    'data-zoom': fmt(zoom),
    'data-pan-x': fmt(pan.x),
    'data-pan-y': fmt(pan.y),
    /** The zoom the stage is rasterized at; equals `data-zoom` at rest. */
    'data-render-zoom': fmt(layoutZoom),
  } as const;

  /**
   * `translate` then `scale`: a point p (image px) lands at
   * `zoom * (p + pan - size/2)` either way, but the scale is 1 at rest, so the
   * stage is a plain translated box at its true size and the SVG inside it
   * rasterizes at device resolution.
   */
  const stageStyle: CSSProperties = image
    ? {
        width: `${image.width * layoutZoom}px`,
        height: `${image.height * layoutZoom}px`,
        transform:
          `translate(${zoom * (pan.x - image.width / 2)}px, ${zoom * (pan.y - image.height / 2)}px)` +
          (residual === 1 ? '' : ` scale(${residual})`),
      }
    : {};

  const showOriginal = mode === 'original' || mode === 'side-by-side';
  const showVector = mode === 'vector' || mode === 'side-by-side';
  /** See PIXELATE_ABOVE_ZOOM: past 2x the source shows its pixels, not a blur. */
  const pixelated = image != null && zoom > PIXELATE_ABOVE_ZOOM;

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
        attrs={{ ...viewAttrs, 'data-pixelated': String(pixelated) }}
        stageStyle={stageStyle}
      >
        {image ? (
          <img
            className="raster"
            src={image.url}
            width={image.width}
            height={image.height}
            alt=""
            draggable={false}
          />
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
