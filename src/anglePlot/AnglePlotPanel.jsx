import { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { formatAngleDegrees } from './AnglePair.js';
import { MIN_CELL_SIZE_PX, MAX_CELL_SIZE_PX, MIN_VISIBLE_GRID_STEPS, ABSOLUTE_MAX_ZOOM_PX_PER_DEGREE } from './renderSamplingPolicy.js';
import { findPointsNearScreenPosition } from './multiSeriesHover.js';

// AnglePlotPanel: draws the scatter of every visible sequence's valid
// (A, B) region and owns all zoom/pan/hover interaction for the graph.
// Implemented with a plain <canvas> instead of SVG because a single
// region can already contain on the order of 10^5 points (the full
// permitted A/B grid at a fine step) — rendering that many individual SVG
// DOM nodes would be far slower than letting the canvas rasterize them
// directly, and that only gets more true with several such regions drawn
// at once. No charting library exists in this project (checked
// package.json before writing this), so this is the "lightweight custom
// panel" option rather than adding a dependency.
//
// Multi-sequence overlap rendering
// -----------------------------------
// Each series in `series` is drawn with its own color at partial opacity
// (OVERLAP_ALPHA below) rather than fully opaque, so two overlapping
// regions blend into a visibly distinct combined color instead of the
// later series completely hiding the earlier one — no point position is
// ever offset to "separate" colors, only the paint's alpha channel
// changes, so the plotted shapes stay mathematically exact. Draw order is
// the order `series` arrives in (stable — AnglePlotWindow builds it from
// the sequence row list's own order), so which series reads as "on top"
// at a given pixel is deterministic and reproducible, not a render-timing
// accident. Hover (see findPointsNearScreenPosition) is what actually
// disambiguates an overlapped point — it reports every series present at
// that spot, not just whichever one is visually on top.

// Zoom/pan model mirrors the main triangle canvas in App.jsx: `zoom` is
// screen pixels per degree (the same value is used for both axes so the
// A/B region is never stretched into a misleading shape), and `pan` is the
// (A, B) point currently centered in the viewport.
const MIN_ZOOM = 2;
// Matches the main triangle canvas's own wheel-zoom factor in App.jsx, so
// zooming feels the same on both canvases.
const WHEEL_ZOOM_FACTOR = 1.1;
const POINT_HIT_RADIUS_PX = 7;
// How close two different series' points must be on screen to be treated
// as "the same spot" for one combined hover, once the nearest point under
// the cursor is found (see findPointsNearScreenPosition's doc comment).
const HOVER_MERGE_RADIUS_PX = 4;
// Estimated on-screen footprint of the hover coordinate tooltip (see
// hoverCoord below), used only to keep it fully inside the plot's own
// bounds near an edge/corner — not an exact measurement, just wide/tall
// enough for "A = 90.000°" / "B = 90.000°" at the largest realistic
// precision without the box needing to reflow.
const COORD_TOOLTIP_WIDTH_PX = 116;
const COORD_TOOLTIP_HEIGHT_PX = 46;
// Offset from the cursor's exact position so the tooltip sits beside/above
// it instead of directly on top, where it would block the cursor itself.
const COORD_TOOLTIP_OFFSET_PX = 14;
// Individual-point marker radius used in POINTS mode (see pickRenderMode
// below) — the "normal" size at that zoom level. DENSE and OCCUPANCY modes
// compute their own, smaller marker size instead (see the draw effect):
// this fixed radius is only right when points are sparse enough to draw as
// distinguishable individual dots in the first place.
const POINT_RADIUS_PX = 2.4;
// Softens OCCUPANCY mode's small filled squares into a smooth-edged blob
// instead of a jagged pixel staircase. Deliberately not applied to POINTS/
// DENSE mode — at those zoom levels the individual samples are still
// meaningful to look at, so they stay crisp; OCCUPANCY only exists once
// samples are sub-pixel-dense anyway, where the exact boundary shape is no
// longer meaningfully visible point-by-point regardless of blur.
//
// Only applied once cells are at least OCCUPANCY_BLUR_MIN_CELL_PX wide, and
// scaled down (never up) from there. At the low end of OCCUPANCY mode, cells
// are already close to a single device pixel — a fixed 2.5px blur applied
// there doesn't smooth a staircase (there isn't one visible yet), it just
// spreads each real, distinct point's mark several pixels past its own
// footprint. With many real points near each other, those spread marks stack
// into one shapeless blob that hides the actual (often thin/curved) region
// boundary instead of revealing it — exactly the zoomed-out blurriness this
// LOD mode exists to avoid. Scaling blur to the cell size keeps it doing
// only the smoothing job it's for.
const OCCUPANCY_BLUR_PX = 2.5;
const OCCUPANCY_BLUR_MIN_CELL_PX = 4;
// Series are drawn semi-transparent so overlapping regions from different
// sequences blend into a visibly distinct combined color instead of the
// topmost series fully hiding the ones under it.
const OVERLAP_ALPHA = 0.72;

// Each series' own committed (Angle A, Angle B) point is marked in a color
// computed to contrast against that series' own point color (not a single
// fixed color for every graph — a graph's own dot color is user-chosen via
// the legend swatch, so the contrast has to be computed per series). See
// pickContrastColor below.
const OWN_ANGLE_MARKER_RING_COLOR = 'rgba(0,0,0,0.55)';

// The view "Reset View" restores — a fixed overview of the whole permitted
// triangle, independent of whatever is currently plotted. Also used as the
// very first view before any generation has completed.
const DEFAULT_ZOOM = 6;
const DEFAULT_PAN = { a: 45, b: 45 };

// Neither axis has any meaning outside [0, 90]: A and B are physical
// triangle angles in degrees, so negative values and anything past 90 are
// never valid regardless of zoom/pan — panning/zooming can't scroll the
// view past these edges.
const AXIS_DOMAIN_MIN = 0;
const AXIS_DOMAIN_MAX = 90;

// Clamps one axis's pan center so the viewport's own edges never cross the
// domain bounds above. If the whole domain already fits within the
// viewport (zoomed out far enough that halfSpan alone covers it), centers
// on the domain's midpoint instead of letting the view drift to one side.
const clampPanAxis = (center, zoomPxPerUnit, viewportPx) => {
  const halfSpan = (viewportPx / 2) / zoomPxPerUnit;
  const domainSpan = AXIS_DOMAIN_MAX - AXIS_DOMAIN_MIN;
  if (domainSpan <= halfSpan * 2) return (AXIS_DOMAIN_MIN + AXIS_DOMAIN_MAX) / 2;
  return Math.max(AXIS_DOMAIN_MIN + halfSpan, Math.min(center, AXIS_DOMAIN_MAX - halfSpan));
};

const clampPanToDomain = (candidatePan, zoomValue, width, height) => ({
  a: clampPanAxis(candidatePan.a, zoomValue, width),
  b: clampPanAxis(candidatePan.b, zoomValue, height),
});

// zoomLevel is always *derived* from `zoom` (zoom / DEFAULT_ZOOM), never
// stored independently, so it can never disagree with the actual visible
// bounds. Exported for diagnostics/tests.
export const MIN_ZOOM_LEVEL = MIN_ZOOM / DEFAULT_ZOOM;

// Mirrors the light/dark values the main triangle canvas already uses
// (THEME_PALETTES in App.jsx) so the two canvases stay visually consistent
// instead of this one always rendering dark regardless of the app's theme
// toggle.
// This plot always renders as a plain white box — background, axes, the
// domain-box border, gridlines, and tick text are all fixed regardless of
// the app's light/dark theme toggle (unlike the main triangle canvas), so
// there is only one palette rather than per-theme variants.
const CANVAS_PALETTE = { gridLine: 'rgba(15,23,42,0.08)', gridAxis: '#000000', tickText: '#64748b' };

// Picks black or white — whichever contrasts more against a given series
// color — using the standard WCAG-style relative luminance formula. Black/
// white is used rather than a computed complementary hue because it is
// guaranteed high-contrast against literally any input color, including
// grays where a hue-based complement would be weak.
const pickContrastColor = (hexColor) => {
  const hex = (hexColor || '#000000').replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? '#000000' : '#ffffff';
};

// The two straight edges of the triangle-angle domain (A < B and A + B <=
// 90 already bound every plotted region) drawn as fixed black guide lines,
// same color as the axes, with light high-contrast labels — requested as
// permanent visual reference rather than something toggled per series.
const REFERENCE_LINE_COLOR = '#000000';
const REFERENCE_LABEL_COLOR = '#f8fafc';
const REFERENCE_LABEL_HALO_COLOR = 'rgba(0,0,0,0.65)';

const niceGridStepDegrees = (zoom) => {
  // Finer grid spacing as the user zooms in, mirroring the main canvas's tiering.
  if (zoom > 220) return 1;
  if (zoom > 90) return 2;
  if (zoom > 35) return 5;
  return 10;
};

// The maximum zoom (px/degree) this panel allows, tied to the *finest*
// visible sequence's Angle Step rather than an arbitrary pixel constant:
// zooming in further than MIN_VISIBLE_GRID_STEPS worth of the finest step
// across the viewport cannot reveal any additional real detail for any
// series (every point on screen would already be adjacent grid points for
// the series that has the most detail), so there is nothing gained by
// allowing it. Falls back to the absolute sanity ceiling when no visible
// series has a valid step yet.
const getMaxZoomPxPerDegree = (finestUserStepDegrees, viewportWidthPx) => {
  if (!Number.isFinite(finestUserStepDegrees) || finestUserStepDegrees <= 0) return ABSOLUTE_MAX_ZOOM_PX_PER_DEGREE;
  const minVisibleWidth = finestUserStepDegrees * MIN_VISIBLE_GRID_STEPS;
  const dynamicMax = Math.max(viewportWidthPx, 1) / Math.max(minVisibleWidth, 1e-12);
  return Math.min(dynamicMax, ABSOLUTE_MAX_ZOOM_PX_PER_DEGREE);
};

const computeFitView = (allPoints, currentPoint, width, height, maxZoom) => {
  const all = currentPoint ? [...allPoints, currentPoint] : allPoints;
  if (all.length === 0) return { zoom: DEFAULT_ZOOM, pan: DEFAULT_PAN };
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  all.forEach((p) => {
    if (p.a < minA) minA = p.a;
    if (p.a > maxA) maxA = p.a;
    if (p.b < minB) minB = p.b;
    if (p.b > maxB) maxB = p.b;
  });
  const spanA = Math.max(maxA - minA, 1);
  const spanB = Math.max(maxB - minB, 1);
  const padding = 60; // px of breathing room around the data
  const zoom = Math.min(
    Math.max((width - padding) / spanA, MIN_ZOOM),
    Math.max((height - padding) / spanB, MIN_ZOOM),
    maxZoom
  );
  return { zoom, pan: { a: (minA + maxA) / 2, b: (minB + maxB) / 2 } };
};

// Level-of-detail mode, chosen per-series from how many screen pixels
// separate adjacent sampled grid points (see pickRenderMode): plenty of
// room draws individually-distinguishable circles; a tight-but-not-
// subpixel spacing draws touching/slightly-overlapping markers sized to
// the gap so the region reads as continuous; sub-pixel spacing switches to
// filled rectangles ("occupancy cells") sized to the sampling cell so the
// region reads as a solid raster instead of a sparse dot lattice with
// visible gaps. Each series can be in a different mode at the same time
// (e.g. one exact-mode series at POINTS while an adaptive one is DENSE).
const RENDER_MODE = { POINTS: 'points', DENSE: 'dense', OCCUPANCY: 'occupancy' };
const pickRenderMode = (projectedSpacingPx) => {
  if (projectedSpacingPx >= 6) return RENDER_MODE.POINTS;
  if (projectedSpacingPx >= 2) return RENDER_MODE.DENSE;
  return RENDER_MODE.OCCUPANCY;
};

// forwardRef exposes imperative view controls (zoomIn/zoomOut/fitToPoints/
// resetToDefaultView) to AnglePlotWindow's toolbar buttons, since "multiply
// whatever the current zoom happens to be" can't be expressed as a plain
// prop the way a one-shot "reset to X" signal can.
//
// `onViewChange` is called (undebounced) every time zoom, pan, or the
// measured canvas size changes, reporting the current world bounds,
// zoomLevel, and viewport pixel size. AnglePlotWindow owns the actual
// debounce/regeneration decision per row — this panel stays a "dumb"
// reporter of its own viewport state so that policy lives in exactly one
// place.
//
// `series` is `{ id, label, color, points, gridStepDegrees, displayScale }[]`
// — one entry per currently *visible* sequence row, already generated by
// AnglePlotWindow. `gridStepDegrees` (per series) picks that series' own
// level-of-detail draw mode; it is never used to decide what to generate
// (that's AnglePlotWindow's job).
const AnglePlotPanel = forwardRef(function AnglePlotPanel({ series, currentPoint, isLocked, followCursor, onViewChange, initialZoom, initialPan }, ref) {
  const palette = CANVAS_PALETTE;
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ width: 600, height: 420 });
  // initialZoom/initialPan let a caller restore a previously saved view
  // (see AnglePlotWindow.jsx's own initialPanelZoom/initialPanelPan props,
  // threaded from App.jsx's workspace restore) — read once, exactly like
  // DEFAULT_ZOOM/DEFAULT_PAN already were, so a caller that never passes
  // them keeps today's exact default-view behavior.
  const [zoom, setZoom] = useState(() => initialZoom ?? DEFAULT_ZOOM);
  const [pan, setPan] = useState(() => initialPan ?? DEFAULT_PAN);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const [hoverMatches, setHoverMatches] = useState([]);
  // Graph coordinates under the cursor while it's inside the [0, 90] x
  // [0, 90] domain box — a live hover readout, not a click-triggered one:
  // updated on every mousemove (see the RAF-coalesced handler below) and
  // cleared immediately on mouse-leave, so it's visible only while the
  // cursor is actually over it, never left showing after moving away. Only
  // updated at all while the "Follow Cursor" toggle (followCursor prop) is
  // on — cleared immediately if it's switched off mid-hover.
  const [hoverCoord, setHoverCoord] = useState(null);
  useEffect(() => {
    if (!followCursor) setHoverCoord(null);
  }, [followCursor]);

  // Track the container's actual pixel size so the canvas drawing buffer
  // (not just its CSS box) stays sharp after the window is resized.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const allPoints = series.flatMap((s) => s.points);
  // Each series' own committed (Angle A, Angle B) point — the exact value
  // that graph was set to, not a computed average of its region — plus a
  // color contrasting that series' own dot color, computed once per series
  // (not every redraw).
  const ownAnglePoints = useMemo(() => (
    series.reduce((acc, s) => {
      const a = Number(s.angleA);
      const b = Number(s.angleB);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return acc;
      acc.push({ id: s.id, a, b, markerColor: pickContrastColor(s.color) });
      return acc;
    }, [])
  ), [series]);
  const finestUserStepDegrees = series.reduce((min, s) => {
    const step = Number(s.angleStepInput);
    return Number.isFinite(step) && step > 0 && step < min ? step : min;
  }, Infinity);
  const displayScale = series.reduce((max, s) => Math.max(max, s.displayScale || 0), 1);

  const maxZoom = getMaxZoomPxPerDegree(Number.isFinite(finestUserStepDegrees) ? finestUserStepDegrees : undefined, size.width);
  const clampZoom = useCallback((value) => Math.max(MIN_ZOOM, Math.min(value, maxZoom)), [maxZoom]);

  // Fit the viewport to every generated point (across every visible
  // series) plus the currently selected A/B pair on mount, and again any
  // time the panel's real measured size changes (the initial size is a
  // placeholder until ResizeObserver reports the actual box). This adjusts
  // state during render (React's documented pattern for "reset state when
  // a value changes") rather than in a useEffect, because the reset must
  // happen before the first paint at this size and must not cascade
  // through an extra render cycle. Explicit re-fits after that go through
  // the fitToPoints() imperative method below (the "Fit" button), which
  // does not touch this signature.
  const sizeSignature = `${size.width}x${size.height}`;
  const [appliedSizeSignature, setAppliedSizeSignature] = useState(null);
  if (sizeSignature !== appliedSizeSignature) {
    setAppliedSizeSignature(sizeSignature);
    const fit = computeFitView(allPoints, currentPoint, size.width, size.height, maxZoom);
    setZoom(fit.zoom);
    setPan(clampPanToDomain(fit.pan, fit.zoom, size.width, size.height));
  }

  const toScreenX = useCallback((a) => size.width / 2 + (a - pan.a) * zoom, [size.width, pan.a, zoom]);
  const toScreenY = useCallback((b) => size.height / 2 - (b - pan.b) * zoom, [size.height, pan.b, zoom]);
  const toDataA = useCallback((x) => pan.a + (x - size.width / 2) / zoom, [size.width, pan.a, zoom]);
  const toDataB = useCallback((y) => pan.b - (y - size.height / 2) / zoom, [size.height, pan.b, zoom]);

  // Imperative view controls used by AnglePlotWindow's Zoom In / Zoom Out /
  // Fit / Reset View buttons. Lock View only blocks interactive mouse-wheel
  // zoom (see the wheel handler below) — drag-to-pan and every explicit
  // toolbar button stay functional, matching the main triangle canvas's own
  // Lock View exactly.
  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const nextZoom = clampZoom(zoom * WHEEL_ZOOM_FACTOR);
      setZoom(nextZoom);
      setPan((prevPan) => clampPanToDomain(prevPan, nextZoom, size.width, size.height));
    },
    zoomOut: () => {
      const nextZoom = clampZoom(zoom / WHEEL_ZOOM_FACTOR);
      setZoom(nextZoom);
      setPan((prevPan) => clampPanToDomain(prevPan, nextZoom, size.width, size.height));
    },
    fitToPoints: () => {
      // Empty-graph state: nothing visible to fit to, fall back to the default overview instead of erroring.
      const fit = computeFitView(allPoints, currentPoint, size.width, size.height, maxZoom);
      setZoom(fit.zoom);
      setPan(clampPanToDomain(fit.pan, fit.zoom, size.width, size.height));
    },
    // "Zoom into graph": fits the view to one specific series' own points
    // only, ignoring every other visible graph — unlike fitToPoints above,
    // which always fits to the union of everything visible. Also anchors on
    // that series' own committed (Angle A, Angle B) point (mirroring
    // currentPoint's role in the all-series fit) so a graph with a tiny or
    // still-computing region still centers sensibly instead of falling back
    // to the full default overview.
    fitToSeries: (seriesId) => {
      const target = series.find((s) => s.id === seriesId);
      const ownA = Number(target?.angleA);
      const ownB = Number(target?.angleB);
      const anchor = Number.isFinite(ownA) && Number.isFinite(ownB) ? { a: ownA, b: ownB } : null;
      const fit = computeFitView(target?.points || [], anchor, size.width, size.height, maxZoom);
      setZoom(fit.zoom);
      setPan(clampPanToDomain(fit.pan, fit.zoom, size.width, size.height));
    },
    resetToDefaultView: () => {
      setZoom(DEFAULT_ZOOM);
      setPan(clampPanToDomain(DEFAULT_PAN, DEFAULT_ZOOM, size.width, size.height));
    },
    // The data-space rectangle currently visible in the canvas, used by
    // AnglePlotWindow's adaptive renderer so it only ever considers points
    // that could actually be seen right now.
    getViewBounds: () => ({
      minA: toDataA(0),
      maxA: toDataA(size.width),
      minB: toDataB(size.height),
      maxB: toDataB(0),
    }),
  }), [allPoints, currentPoint, series, size, maxZoom, clampZoom, zoom, toDataA, toDataB]);

  // Report every zoom/pan/size change (including the very first one, once
  // the real measured canvas size is known) so AnglePlotWindow can debounce
  // a regeneration around it. This effect only *reports* — it never itself
  // decides whether/when to regenerate, keeping that policy in one place.
  //
  // `onViewChange` is read through a ref (updated every render, below)
  // rather than listed in this effect's own dependency array, for the same
  // reason AnglePlotWindow reads several of its own callbacks through refs
  // — the parent rebuilds this callback on nearly every render, and
  // depending on its identity directly would re-fire this effect, call it
  // again, land a state update back in the parent, and repeat forever.
  // Depending only on the actual viewport numbers below breaks that cycle.
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    onViewChangeRef.current?.({
      bounds: { minA: toDataA(0), maxA: toDataA(size.width), minB: toDataB(size.height), maxB: toDataB(0) },
      zoomLevel: zoom / DEFAULT_ZOOM,
      viewportSize: { width: size.width, height: size.height },
      // Raw zoom/pan, for callers that want to restore this exact view
      // later (see AnglePlotWindow.jsx's workspace-persistence reporting)
      // rather than recompute it from zoomLevel/bounds.
      zoom,
      pan,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan.a, pan.b, size.width, size.height]);

  // Redraw whenever the data, viewport, or hover/pin state changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderStartedAt = import.meta.env?.DEV ? performance.now() : 0;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    // Background: always plain white, regardless of app theme — this graph
    // reads as one clean bounded box (A and B in [0, 90]) rather than
    // matching the main triangle canvas's dark/light toggle.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);

    // Grid lines + tick labels, restricted to the domain box: neither axis
    // has meaning outside [0, 90] (see clampPanToDomain), so nothing is
    // drawn past it — no negative axis, no ticks/labels beyond 90. Any
    // margin from being zoomed out past the box is left plain white.
    const step = niceGridStepDegrees(zoom);
    const minA = Math.max(toDataA(0), AXIS_DOMAIN_MIN);
    const maxA = Math.min(toDataA(size.width), AXIS_DOMAIN_MAX);
    const minB = Math.max(toDataB(size.height), AXIS_DOMAIN_MIN);
    const maxB = Math.min(toDataB(0), AXIS_DOMAIN_MAX);
    const boxLeft = toScreenX(AXIS_DOMAIN_MIN);
    const boxRight = toScreenX(AXIS_DOMAIN_MAX);
    const boxTop = toScreenY(AXIS_DOMAIN_MAX);
    const boxBottom = toScreenY(AXIS_DOMAIN_MIN);
    const aLabelY = Math.min(boxBottom, size.height - 14);
    const bLabelX = Math.max(boxLeft, 0) + 4;
    ctx.font = '10px monospace';
    ctx.textBaseline = 'top';
    for (let a = Math.ceil(minA / step) * step; a <= maxA + 1e-9; a += step) {
      const x = toScreenX(a);
      const isAxis = Math.abs(a) < 1e-9;
      ctx.strokeStyle = isAxis ? palette.gridAxis : palette.gridLine;
      ctx.lineWidth = isAxis ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, boxTop);
      ctx.lineTo(x, boxBottom);
      ctx.stroke();
      ctx.fillStyle = palette.tickText;
      ctx.fillText(formatAngleDegrees(a, displayScale), x + 2, aLabelY);
    }
    ctx.textBaseline = 'middle';
    for (let b = Math.ceil(minB / step) * step; b <= maxB + 1e-9; b += step) {
      const y = toScreenY(b);
      const isAxis = Math.abs(b) < 1e-9;
      ctx.strokeStyle = isAxis ? palette.gridAxis : palette.gridLine;
      ctx.lineWidth = isAxis ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(boxLeft, y);
      ctx.lineTo(boxRight, y);
      ctx.stroke();
      ctx.fillStyle = palette.tickText;
      ctx.fillText(formatAngleDegrees(b, displayScale), bLabelX, y - 12);
    }

    // Bounding box border for the domain itself, black to match the axes —
    // this is "the box from 0 to 90 both ways" the graph is meant to read as.
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop);

    // Every visible sequence's region, in row order (stable z-order — see
    // the module comment above for why overlap uses alpha blending instead
    // of offsetting point positions). `pointRadiusById` records each
    // series' own marker size, keyed by series id, so that series' own-angle
    // marker (drawn further below) can match that exact radius.
    const pointRadiusById = new Map();
    for (const s of series) {
      if (s.points.length === 0) continue;
      const projectedSpacingPx = Number.isFinite(s.gridStepDegrees) && s.gridStepDegrees > 0 ? s.gridStepDegrees * zoom : Infinity;
      const mode = pickRenderMode(projectedSpacingPx);
      ctx.save();
      ctx.globalAlpha = OVERLAP_ALPHA;
      ctx.fillStyle = s.color;
      if (mode === RENDER_MODE.OCCUPANCY) {
        // Filled squares sized to the sampling cell (with a hair of
        // overlap so pixel rounding never leaves a one-pixel crack between
        // neighbors), not large circles over a coarse grid — a solid
        // raster built only from cells that actually contain a real valid
        // point. Blurred afterward (see OCCUPANCY_BLUR_PX) so the hard
        // grid-aligned edges of that raster read as one smooth region
        // instead of a jagged pixel staircase.
        const cellPx = Math.min(MAX_CELL_SIZE_PX, Math.max(MIN_CELL_SIZE_PX, projectedSpacingPx));
        const half = cellPx / 2 + 0.5;
        pointRadiusById.set(s.id, Math.max(1, cellPx / 2));
        const blurPx = cellPx >= OCCUPANCY_BLUR_MIN_CELL_PX ? Math.min(OCCUPANCY_BLUR_PX, cellPx * 0.4) : 0;
        if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`;
        s.points.forEach((p) => {
          const x = toScreenX(p.a);
          const y = toScreenY(p.b);
          if (x < -half || x > size.width + half || y < -half || y > size.height + half) return;
          ctx.fillRect(x - half, y - half, cellPx + 1, cellPx + 1);
        });
      } else if (mode === RENDER_MODE.DENSE) {
        // Markers sized to touch/slightly overlap their neighbors instead
        // of leaving the fixed small POINTS-mode radius floating in
        // visible gaps.
        const radius = Math.min(MAX_CELL_SIZE_PX / 2, Math.max(MIN_CELL_SIZE_PX / 2, projectedSpacingPx / 2 + 0.5));
        pointRadiusById.set(s.id, radius);
        s.points.forEach((p) => {
          const x = toScreenX(p.a);
          const y = toScreenY(p.b);
          if (x < -radius - 5 || x > size.width + radius + 5 || y < -radius - 5 || y > size.height + radius + 5) return;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        });
      } else {
        pointRadiusById.set(s.id, POINT_RADIUS_PX);
        s.points.forEach((p) => {
          const x = toScreenX(p.a);
          const y = toScreenY(p.b);
          if (x < -5 || x > size.width + 5 || y < -5 || y > size.height + 5) return;
          ctx.beginPath();
          ctx.arc(x, y, POINT_RADIUS_PX, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      ctx.restore();
    }

    // Two fixed guide lines for the triangle-angle domain's straight edges
    // (A < B and A + B <= 90 already bound every plotted region): A = B and
    // A + B = 90, in the same black as the axes, drawn on top of the
    // plotted regions so they stay visible over dense point clouds, with a
    // dark-haloed light label so the text reads against either background.
    ctx.save();
    ctx.strokeStyle = REFERENCE_LINE_COLOR;
    ctx.lineWidth = 1.5;
    ctx.font = 'bold 11px monospace';
    const drawGuideLabel = (text, x, y) => {
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = REFERENCE_LABEL_HALO_COLOR;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = REFERENCE_LABEL_COLOR;
      ctx.fillText(text, x, y);
      ctx.strokeStyle = REFERENCE_LINE_COLOR;
      ctx.lineWidth = 1.5;
    };
    // A = B
    {
      const aStart = Math.max(minA, minB);
      const aEnd = Math.min(maxA, maxB);
      if (aStart < aEnd) {
        const x1 = toScreenX(aStart), y1 = toScreenY(aStart);
        const x2 = toScreenX(aEnd), y2 = toScreenY(aEnd);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        drawGuideLabel('A = B', x2 - 6, y2 - 6);
      }
    }
    // A + B = 90
    {
      const aStart = Math.max(minA, 90 - maxB);
      const aEnd = Math.min(maxA, 90 - minB);
      if (aStart < aEnd) {
        const x1 = toScreenX(aStart), y1 = toScreenY(90 - aStart);
        const x2 = toScreenX(aEnd), y2 = toScreenY(90 - aEnd);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        drawGuideLabel('A + B = 90', x1 + 6, y1 + 6);
      }
    }
    ctx.restore();

    // Each visible graph's own (Angle A, Angle B) point, drawn in a color
    // computed to contrast against that same graph's own dot color
    // (pickContrastColor — see ownAnglePoints) so it stands out from the
    // rest of that graph's region specifically, not against a fixed
    // reference. Sized to match that series' own point radius so it reads
    // as one of that region's own dots — the odd one out only in color.
    ownAnglePoints.forEach((p) => {
      const x = toScreenX(p.a);
      const y = toScreenY(p.b);
      const radius = pointRadiusById.get(p.id) ?? POINT_RADIUS_PX;
      ctx.save();
      ctx.fillStyle = p.markerColor;
      ctx.strokeStyle = OWN_ANGLE_MARKER_RING_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    // The active row's own (A, B) point is already covered by
    // ownAnglePoints above (every visible row draws its own point there,
    // in a color derived only from that row's own dot color) — no separate
    // "current" marker on top of it, since a fixed extra color tied to
    // *which row is active* meant every row's marker visibly recolored
    // itself the moment selection changed, which read as other graphs'
    // colors changing on their own.

    // Dev-only: this canvas redraws every visible series in one batched
    // pass (never one shape per point/graph — see the module comment on
    // OCCUPANCY/DENSE/POINTS mode), so "Renderer update" below covers every
    // currently-visible graph in a single paint, not one specific graph.
    if (import.meta.env?.DEV) {
      const renderMs = performance.now() - renderStartedAt;
      const totalPoints = series.reduce((sum, s) => sum + s.points.length, 0);
      console.log(`[AnglePlotPanel] Renderer update: ${renderMs.toFixed(1)}ms | visible series: ${series.length} | total points drawn: ${totalPoints}`);
    }
  }, [series, ownAnglePoints, size, zoom, pan, toScreenX, toScreenY, toDataA, toDataB, palette, displayScale]);

  // Every plotted series is searched together so a hover over an overlapped
  // spot reports every sequence present there, not just whichever one
  // happened to draw last. No separate "current (active)" pseudo-entry —
  // the active graph is already one of the real series below, so adding a
  // synthetic duplicate of it here double-counted that one graph as two
  // ("N graphs at this point" reading one higher than the true number of
  // distinct graphs).
  //
  // Each series' own (Angle A, Angle B) point (see ownAnglePoints — the
  // same point its own marker is drawn at) is added as an extra hit-test
  // candidate, not just its real plotted points: a graph with an empty
  // Code Sequence still has a visible marker at its own angle but zero
  // real points to hover, so without this its marker would be unlabeled —
  // unlike every other graph, which "just happens" to have its own point
  // among its real ones. findPointsNearScreenPosition already keeps only
  // the single closest candidate per series, so this never produces a
  // duplicate entry for a series that already has real points there.
  const hitTestSeries = series.map((s) => {
    const ownA = Number(s.angleA);
    const ownB = Number(s.angleB);
    const ownPoint = Number.isFinite(ownA) && Number.isFinite(ownB) ? [{ a: ownA, b: ownB }] : [];
    return { id: s.id, label: s.label, color: s.color, points: [...s.points, ...ownPoint] };
  });

  const findMatchesAt = useCallback((screenX, screenY) => (
    findPointsNearScreenPosition(hitTestSeries, toScreenX, toScreenY, screenX, screenY, POINT_HIT_RADIUS_PX, HOVER_MERGE_RADIUS_PX)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [series, toScreenX, toScreenY]);

  // The wheel listener is attached natively (not via React's onWheel prop)
  // because React registers wheel handlers as passive by default, which
  // silently ignores preventDefault() and lets the page scroll underneath
  // the plot. The main triangle canvas in App.jsx hits the same issue and
  // fixes it the same way — see its "passive:false is required" comment.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const handleWheel = (e) => {
      e.preventDefault();
      // Locking the view disables mouse-wheel zoom entirely.
      if (isLocked) return;
      const direction = e.deltaY > 0 ? -1 : 1;
      setZoom((prevZoom) => {
        const nextZoom = clampZoom(prevZoom * (direction > 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR));
        setPan((prevPan) => clampPanToDomain(prevPan, nextZoom, size.width, size.height));
        return nextZoom;
      });
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [isLocked, clampZoom, size.width, size.height]);

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    // Lock View only disables wheel-zoom (see the wheel handler above),
    // matching the main triangle canvas in App.jsx exactly — drag-to-pan
    // and every toolbar button stay functional while locked.
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
  };

  // The nearest-point hit-test (findMatchesAt) is an O(n) scan over every
  // plotted point across every series — up to MAX_VISIBLE_RENDER_POINTS of
  // them (renderSamplingPolicy.js). Raw mousemove events can fire far more
  // often than the display actually refreshes, so that scan is coalesced to
  // once per animation frame here: multiple mousemove events between two
  // paints only ever run it once, with the latest cursor position.
  const hoverRafRef = useRef(null);
  const pendingHoverRef = useRef(null);
  useEffect(() => () => {
    if (hoverRafRef.current !== null) cancelAnimationFrame(hoverRafRef.current);
  }, []);

  const handleMouseMove = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    if (isDragging) {
      const dx = (e.clientX - dragStart.current.x) / zoom;
      const dy = (e.clientY - dragStart.current.y) / zoom;
      setPan((prev) => clampPanToDomain({ a: prev.a - dx, b: prev.b + dy }, zoom, size.width, size.height));
      dragStart.current = { x: e.clientX, y: e.clientY };
      return;
    }
    pendingHoverRef.current = { screenX, screenY };
    if (hoverRafRef.current === null) {
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = null;
        const pending = pendingHoverRef.current;
        if (!pending) return;
        setHoverMatches(findMatchesAt(pending.screenX, pending.screenY));
        if (followCursor) {
          const hoverA = toDataA(pending.screenX);
          const hoverB = toDataB(pending.screenY);
          const insideDomainBox = hoverA >= AXIS_DOMAIN_MIN && hoverA <= AXIS_DOMAIN_MAX && hoverB >= AXIS_DOMAIN_MIN && hoverB <= AXIS_DOMAIN_MAX;
          setHoverCoord(insideDomainBox ? { a: hoverA, b: hoverB, screenX: pending.screenX, screenY: pending.screenY } : null);
        }
      });
    }
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleMouseLeave = () => {
    setIsDragging(false);
    setHoverMatches([]);
    setHoverCoord(null);
  };

  const tooltipMatches = hoverMatches;
  const tooltipAnchor = tooltipMatches[0];

  // Hover-anchored coordinate tooltip position: offset up-and-right of the
  // cursor by default so it never sits under (and never blocks) it, clamped
  // so it stays fully inside the plot's own bounds even right at an edge/
  // corner instead of spilling outside the graph. Only shown while hovering
  // empty space (no matched point there — see tooltipMatches.length check
  // below), so it never overlaps the matched-points tooltip.
  const coordTooltipLeft = hoverCoord
    ? Math.min(Math.max(hoverCoord.screenX + COORD_TOOLTIP_OFFSET_PX, 4), size.width - COORD_TOOLTIP_WIDTH_PX - 4)
    : 0;
  const coordTooltipTop = hoverCoord
    ? Math.min(Math.max(hoverCoord.screenY - COORD_TOOLTIP_HEIGHT_PX - COORD_TOOLTIP_OFFSET_PX, 4), size.height - COORD_TOOLTIP_HEIGHT_PX - 4)
    : 0;

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0">
      <div className="flex-1 min-h-0 min-w-0 flex">
        {/* Rotated y-axis label. */}
        <div className="flex items-center justify-center px-1 shrink-0">
          <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            Angle B (degrees)
          </span>
        </div>
        <div ref={containerRef} className="relative flex-1 min-w-0 min-h-0 border border-white/10 rounded-md overflow-hidden" style={{ cursor: 'default' }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        >
          <canvas ref={canvasRef} className="block" />
          {series.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-bold uppercase tracking-wider text-slate-600">
              No visible graphs — enable a sequence to plot it here
            </div>
          )}
          {/* Hover coordinate tooltip: live while the cursor is inside the
              [0, 90] x [0, 90] domain box and not already over a matched
              point (that case is covered by the tooltip below instead), and
              gone the instant the cursor leaves — never a click-triggered,
              stays-until-the-next-click readout. Light background + dark
              text regardless of app theme, since this plot's own canvas is
              always a plain white box (see the CANVAS_PALETTE comment
              above) — a dark tooltip here would be hard to read against it. */}
          {hoverCoord && tooltipMatches.length === 0 && (
            <div
              className="pointer-events-none absolute bg-white/95 border border-slate-300 rounded-md px-2 py-1 text-[11px] font-mono font-semibold text-slate-800 shadow-[0_4px_16px_rgba(0,0,0,0.28)] leading-tight"
              style={{ left: coordTooltipLeft, top: coordTooltipTop }}
            >
              <div>A = {formatAngleDegrees(hoverCoord.a, displayScale)}&deg;</div>
              <div>B = {formatAngleDegrees(hoverCoord.b, displayScale)}&deg;</div>
            </div>
          )}
          {tooltipAnchor && (
            <div
              className="pointer-events-none absolute bg-[#101820]/95 border border-white/10 rounded-md px-2.5 py-1.5 text-[11px] font-mono text-slate-200 shadow-[0_8px_24px_rgba(0,0,0,0.32)] space-y-1.5"
              style={{ left: Math.min(toScreenX(tooltipAnchor.a) + 12, size.width - 190), top: Math.max(toScreenY(tooltipAnchor.b) - 16 - tooltipMatches.length * 44, 4) }}
            >
              {tooltipMatches.length > 1 && (
                <div className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">{tooltipMatches.length} graphs at this point</div>
              )}
              {tooltipMatches.map((match) => {
                const sourceSeries = series.find((s) => s.id === match.id);
                return (
                  <div key={match.id} className="border-t border-white/10 first:border-t-0 pt-1 first:pt-0">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: match.color }} />
                      <span className="font-bold">{match.label}</span>
                    </div>
                    <div>A = {formatAngleDegrees(match.a, sourceSeries?.displayScale || displayScale)}&deg;</div>
                    <div>B = {formatAngleDegrees(match.b, sourceSeries?.displayScale || displayScale)}&deg;</div>
                    <div className="text-slate-400">A+B = {formatAngleDegrees(match.a + match.b, sourceSeries?.displayScale || displayScale)}&deg;</div>
                    {sourceSeries && (
                      <div className="text-slate-500">Step {sourceSeries.angleStepInput}&deg;</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {/* x-axis label. */}
      <div className="text-center pt-1 shrink-0">
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Angle A (degrees)</span>
      </div>
    </div>
  );
});

export default AnglePlotPanel;
