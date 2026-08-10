// React supplies state, refs, effects, and memoization for this client-only tool.
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
// Lucide supplies recognizable control/status icons without custom SVG code.
import { Maximize, RotateCcw, Zap, Settings2, Code2, Compass, ChevronRight, ChevronLeft, Activity, CheckCircle2, XCircle, ShieldCheck, Eye, EyeOff, Search, AlertTriangle, Sun, Moon, ZoomIn, ZoomOut, Lock, Unlock, ScatterChart, Plus, Loader2, Trash2, Library, Database, Save, Copy, RefreshCw, Focus, Crosshair } from 'lucide-react';
// The angle-region plot pop-up lives in its own module (see src/anglePlot) so
// it can be unit-tested without React and does not bloat this file further.
import GraphSetupWindow from './sequences/GraphSetupWindow.jsx';
// The Graph Library panel (browse/search/load previously-computed graphs
// from the shared PostgreSQL library) owns none of its own plotting logic
// — it hands a loaded graph's params/geometry back via onLoadGraph, and
// this file is what actually inserts it into the existing sequences/
// AnglePlotWindow pipeline (see handleLoadGraphFromLibrary below).
import GraphLibraryPanel from './graphLibrary/GraphLibraryPanel.jsx';
// The Graph Database browser (search/sort/rename/delete/duplicate/favorite/
// tags/notes/load for the local, file-based GraphDatabase) follows the
// identical "hands back params/geometry via onLoadGraph" contract as
// GraphLibraryPanel above — see handleLoadGraphFromDatabase below.
import GraphDatabasePanel from './graphLibrary/GraphDatabasePanel.jsx';
import { primeExactGraphCache } from './anglePlot/exactGraphCaching.js';
// The multi-sequence row list (Desmos-style "+ Add Sequence") is a plain
// data model shared between the sidebar row list and the graph pop-up, so
// both stay in sync on id/label/color assignment without duplicating logic.
import { createSequenceRow, relabelSequenceRows, isValidHexColor, parseSequenceDraftText, colorForSequenceNumber } from './sequences/sequenceGraphConfig.js';
// Per-row Angle Step validation/mode reuses the exact same parser the graph
// itself uses, so a row's "Exact"/"Adaptive" badge never disagrees with
// what AnglePlotWindow actually does with that same text.
import { parseAngleStep, displayScaleForStep } from './anglePlot/angleStep.js';
// WorkspaceManager is the only module allowed to touch browser storage for
// workspace persistence — every save/load in this file goes through it
// (see src/workspace/workspaceManager.js for the full design).
import { saveWorkspace, loadWorkspace } from './workspace/workspaceManager.js';
import AnglePlotPanel from './anglePlot/AnglePlotPanel.jsx';
import { generateVisibleAnglePoints } from './anglePlot/visibleAnglePointGenerator.js';
import { generateAngleRegion } from './anglePlot/generateAngleRegion.js';
import { RENDERER_MODE } from './anglePlot/rendererSelection.js';
import { RENDER_DEBOUNCE_MS, MAX_BACKGROUND_EXACT_RENDER_MS } from './anglePlot/renderSamplingPolicy.js';
import { truncateSequenceText } from './sequences/sequenceGraphConfig.js';
import { graphCache, buildGraphCacheKey } from './anglePlot/graphCache.js';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from './anglePlot/graphHasher.js';
import { calculateTheta, formatTheta } from './anglePlot/theta.js';
import { fetchRemoteExactGraph, uploadRemoteExactGraph } from './anglePlot/remoteGraphRepository.js';
import { fetchLocalExactGraph, saveLocalExactGraph } from './anglePlot/localGraphDatabaseClient.js';
import { requestExactComputation, isExactComputationRunning, updateBackgroundJobPriority, getBackgroundJobState, JOB_PRIORITY } from "./anglePlot/backgroundExactWorker.js";

import { GRAPH_STATUS } from './anglePlot/graphStatus.js';
import { graphParamsFromSequence } from './anglePlot/graph.js';

// =============================================================================
// App.jsx architecture note
// =============================================================================
// This file intentionally keeps the prototype in one place while the math is
// still evolving. The top-level constants define visual/side conventions. The
// pure helper functions implement Euclidean geometry. The App component then
// proceeds in this order:
// 1. declare user-editable state;
// 2. measure and control the SVG viewport;
// 3. derive the base triangle;
// 4. derive ray-mode or code-mode reflected triangles;
// 5. derive the shot vector and direct blue/black line validator;
// 6. render the sidebar and SVG canvas.
// When this grows further, the clean split points are: geometry helpers, code
// parser/unfolder, shot-line validator, and presentation components.

// Academic color palette: distinct but slightly muted/professional tones.
// The colors intentionally alternate hue families so long unfoldings remain
// visually separable without turning the app into a one-color dark theme.
const COLORS = [
  '#dc2626', '#d97706', '#059669', '#0284c7', '#4f46e5', 
  '#7c3aed', '#c026d3', '#e11d48', '#ea580c', '#65a30d',
  '#0891b2', '#2563eb', '#db2777', '#b45309', '#16a34a'
];

// Theme-specific SVG colors cannot be handled by Tailwind class overrides.
const THEME_PALETTES = {
  light: {
    baseTriangle: '#334155',
    gridAxis: '#94a3b8',
    gridLine: '#d9e2ee',
    canvasLabel: '#1e293b',
    labelHalo: '#f8fafc',
    midpointFill: '#f8fafc',
    midpointStroke: '#475569',
    midpointText: '#0f172a'
  },
  dark: {
    baseTriangle: '#e2e8f0',
    gridAxis: '#334155',
    gridLine: '#182231',
    canvasLabel: '#cbd5e1',
    labelHalo: '#070b10',
    midpointFill: '#0b1016',
    midpointStroke: '#cbd5e1',
    midpointText: '#e2e8f0'
  }
};

// Mapping triangle edges (0, 1, 2) to their standard Side numbers (1, 2, 3)
// Edge 0 (V0-V1) is opposite V2(C) -> Side 1
// Edge 1 (V1-V2) is opposite V0(A) -> Side 3
// Edge 2 (V2-V0) is opposite V1(B) -> Side 2
const EDGE_TO_SIDE = { 0: 1, 1: 3, 2: 2 };

// The locked/preview switch stores a short machine value instead of display text.
const SHOT_MODE_LOCKED = 'locked';

// The preview mode intentionally allows invalid shots so they can be inspected.
const SHOT_MODE_UNCONSTRAINED = 'preview';

// The triangle renderer uses the unfolding's cycling color palette.
// The previous mono branch has been removed in favor of the single color-based view.

// The paper's formal blue tower vertices render blue in the viewer.
const TOWER_BLUE_COLOR = '#38bdf8';

// The paper's formal black tower vertices render black in the viewer.
const TOWER_BLACK_COLOR = '#000000';

// Singular shot endpoints render red even though they are ignored by the obstruction test.
const ENDPOINT_VERTEX_COLOR = '#ef4444';

// Formal tower coloring uses stable role names instead of geometry-derived top/bottom names.
const TOWER_BLUE_ROLE = 'blue';

// The formal black role is distinct from red endpoint/error states.
const TOWER_BLACK_ROLE = 'black';

// Uncolored vertices use yellow because the formal tower-color graph failed to classify them.
const BAND_VERTEX_COLOR = '#facc15';

// Valid unconstrained shots keep the same guide red used by the live shot line.
const VALID_SHOT_COLOR = '#e03030';

// Invalid unconstrained shots use a lighter, more opaque red to make the mismatch obvious.
const INVALID_SHOT_COLOR = '#ff6b6b';

// Endpoint dots use a darker red to distinguish them from the line itself.
const SHOT_ENDPOINT_FILL_COLOR = '#8b0000';

// Vertices that fall below the guide line are rendered in black.
const SHOT_VERTEX_BELOW_LINE_COLOR = '#000000';

// Vertices above the guide line keep the cyan/blue accent used by the viewer.
const SHOT_VERTEX_ABOVE_LINE_COLOR = '#1ec8f0';

// The default clearance epsilon is a perpendicular-distance tolerance in math units.
const DEFAULT_CLEARANCE_EPSILON = 1e-10;

// Angle A/B number steppers default to one tenth of a degree.
const DEFAULT_ANGLE_INCREMENT = 0.1;

// The Angle Step control itself defaults to changing by one ten-thousandth per native step.
const DEFAULT_ANGLE_STEP_CONTROL_INCREMENT = 0.0001;

// Numeric readouts default to twelve decimal places for precise endpoint/angle inspection.
const DEFAULT_DISPLAY_DECIMALS = 12;

// How long to wait, after the workspace last changed, before autosaving it
// (see buildWorkspaceSnapshot/scheduleAutosave) — long enough that rapid
// changes (typing, dragging, a burst of edits) collapse into one write
// instead of one per keystroke/frame, short enough that closing the tab
// shortly after the last change still saves it.
const WORKSPACE_AUTOSAVE_DEBOUNCE_MS = 800;

// JavaScript numbers carry about fifteen reliable decimal digits, so the UI clamps there.
const MAX_DISPLAY_DECIMALS = 15;

// Fan central angles must stay strictly below 180 degrees; this guards roundoff at the boundary.
const FAN_ANGLE_TOLERANCE_DEGREES = 1e-9;

// Region search refines the grid by one decimal place at each step.
const REGION_SEARCH_STEPS = [0.1, 0.01, 0.001];

// Region search is local and bounded so the browser cannot be locked by a large valid set.
const REGION_SEARCH_RADIUS_DEGREES = 6;

// Each precision step has its own cap so a coarse run cannot starve later reporting.
const REGION_SEARCH_MAX_VISITS_PER_STEP = 12000;

// The code unfolder uses the same hard cap everywhere to keep live and candidate runs aligned.
const MAX_CODE_TRIANGLES = 3000;

// Empty code-mode data keeps UI consumers simple when there is no active code unfolding.
const EMPTY_CODE_DATA = {
  // No reflected copies exist until a valid code is parsed.
  triangles: [],
  // No parsed runs exist until the user provides numeric tokens.
  parsedSequence: [],
  // No boundary sequence exists until reflections are emitted.
  sideSequence: [],
  // No physical reflection edge sequence exists until reflections are emitted.
  reflectionEdges: [],
  // The default physical-to-symbol map preserves the original x/y/z labels.
  idxToAngle: { 0: 'x', 1: 'y', 2: 'z' },
  // The reverse symbol-to-physical map is useful for candidate searches.
  angleToIdx: { x: 0, y: 1, z: 2 }
};

/** Resolves editable native number-input step text to a safe positive value. */
const resolvePositiveInputStep = (rawValue, fallback) => {
  // Native step attributes require a finite positive number to behave predictably.
  const parsed = Number(rawValue);
  // Invalid typing states retain the documented fallback without rewriting the field.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// ==========================================
// MATHEMATICAL CORE FUNCTIONS (Optimized)
// ==========================================

/**
 * Reflects a point perfectly across a line segment using Linear Algebra (IEEE 754 precision)
 */
const reflectPoint = (p, p1, p2) => {
  // Convert the segment through p1/p2 into implicit line form ax + by + c = 0.
  const a = p2.y - p1.y; 
  // b is the negative x component of the segment direction.
  const b = p1.x - p2.x; 
  // c makes the implicit line pass through both segment endpoints.
  const c = p2.x * p1.y - p1.x * p2.y; 
  
  // The squared normal length is the denominator for projection onto the line normal.
  const denom = a * a + b * b;
  // Degenerate edges cannot define a mirror line; copy the point rather than exploding.
  if (denom === 0) return { ...p }; 
  
  // Twice the signed distance in normal-coordinate units gives the mirror offset.
  const factor = 2 * (a * p.x + b * p.y + c) / denom;
  // Subtract the normal component to land on the reflected point.
  return { x: p.x - a * factor, y: p.y - b * factor };
};

/** Calculates the geometric center of a triangle */
const getCentroid = (tri) => ({
  // Average the three x coordinates.
  x: (tri[0].x + tri[1].x + tri[2].x) / 3,
  // Average the three y coordinates.
  y: (tri[0].y + tri[1].y + tri[2].y) / 3
});

/** Peeks at where a triangle's centroid would end up if it were reflected across a specific edge */
const testCentroid = (tri, edge) => {
  // First endpoint of the candidate mirror edge.
  const p1 = tri[edge];
  // Second endpoint of the candidate mirror edge.
  const p2 = tri[(edge + 1) % 3];
  // Opposite vertex that actually moves under this reflection.
  const p3 = tri[(edge + 2) % 3];
  // Reflect only the opposite vertex, because edge endpoints stay fixed.
  const newP3 = reflectPoint(p3, p1, p2);
  // Return the centroid of the triangle that would result from this reflection.
  return { x: (p1.x + p2.x + newP3.x) / 3, y: (p1.y + p2.y + newP3.y) / 3 };
};

/** Builds the reflected-triangle chain used by ray mode. */
const buildRayModeData = ({ baseTriangle, rayStartVertex, rayAngle, maxBounces, svgSize, zoom }) => {
  // Start the unfolding from the immutable base-triangle vertices.
  const T0 = baseTriangle.points;
  // Collect each reflected copy in ray-traversal order.
  const triangles = [];
  // Track the physical edge index crossed at each bounce for sequence-code derivation.
  const reflectionEdges = [];
  // Anchor the ray at the selected physical vertex.
  const O = { ...T0[rayStartVertex] };
  // Convert the displayed angle to radians for trigonometry.
  const rad = (rayAngle * Math.PI) / 180;
  // Use a unit direction vector to parameterize the ray as O + tD.
  const D = { x: Math.cos(rad), y: Math.sin(rad) };

  // Begin intersection checks in the original triangle.
  let currentTri = [...T0];
  // Track the last accepted distance along the ray to prevent repeat hits.
  let currentRayT = 0;

  // Generate at most the requested number of reflected triangles.
  for (let i = 0; i < maxBounces; i++) {
    // Search for the nearest valid future edge intersection.
    let bestT = Infinity;
    // Retain the edge associated with the nearest intersection.
    let bestEdge = null;
    // Break vertex-hit ties using the most forward reflected centroid.
    let bestForwardness = -Infinity;
    // Measure candidate reflection directions from the current triangle.
    const currentCentroid = getCentroid(currentTri);

    // Test the ray against every edge of the current triangle.
    for (let e = 0; e < 3; e++) {
      // Read the first endpoint of the candidate edge.
      const V1 = currentTri[e];
      // Wrap the second endpoint for the final edge.
      const V2 = currentTri[(e + 1) % 3];
      // Form the finite edge direction vector.
      const E = { x: V2.x - V1.x, y: V2.y - V1.y };
      // Compute the two-dimensional ray/edge cross-product denominator.
      const denom = D.x * E.y - D.y * E.x;

      // Parallel ray and edge lines cannot yield a stable intersection.
      if (Math.abs(denom) < 1e-10) continue;

      // Measure the edge start relative to the fixed ray origin.
      const diff = { x: V1.x - O.x, y: V1.y - O.y };
      // Solve for the distance along the ray.
      const t = (diff.x * E.y - diff.y * E.x) / denom;
      // Solve for the normalized position along the finite edge.
      const u = (diff.x * D.y - diff.y * D.x) / denom;

      // Keep only future hits that lie on the edge, allowing small numeric drift.
      if (t > currentRayT + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8) {
        // A rounded angle can make a ray that should pass through a vertex hit
        // either adjoining edge a few ulps apart.  Treat those intersections as
        // one vertex hit and choose the reflection that continues furthest ahead.
        const nextCentroid = testCentroid(currentTri, e);
        // Prefer the reflection whose centroid advances furthest along the ray.
        const forwardness = (nextCentroid.x - currentCentroid.x) * D.x + (nextCentroid.y - currentCentroid.y) * D.y;
        // Scale the tie tolerance for long ray paths while preserving a floor.
        const hitTolerance = Math.max(1e-8, Math.abs(bestT) * 1e-10);
        // Replace the current winner with a nearer hit or a more-forward tie.
        if (t < bestT - hitTolerance || (Math.abs(t - bestT) <= hitTolerance && forwardness > bestForwardness)) {
          bestT = t;
          bestEdge = e;
          bestForwardness = forwardness;
        }
      }
    }

    // Stop when the ray does not reach another triangle edge.
    if (bestEdge === null) break;

    // Convert the selected ray distance back to a Cartesian hit point.
    const hitX = O.x + bestT * D.x;
    // Convert the selected ray distance back to a Cartesian hit point.
    const hitY = O.y + bestT * D.y;
    // Detect a return to the original ray origin after preserving its final copy.
    const hitIsOrigin = (hitX - O.x) ** 2 + (hitY - O.y) ** 2 < 1e-10;

    // Keep the crossed edge's first endpoint fixed during reflection.
    const p1 = currentTri[bestEdge];
    // Keep the crossed edge's second endpoint fixed during reflection.
    const p2 = currentTri[(bestEdge + 1) % 3];
    // Reflect only the vertex opposite the crossed edge.
    const p3 = currentTri[(bestEdge + 2) % 3];
    // Mirror the opposite vertex across the crossed edge.
    const newP3 = reflectPoint(p3, p1, p2);

    // Rebuild the reflected triangle while retaining vertex indices.
    const nextTri = [];
    // Copy the first mirror-edge endpoint into its original index.
    nextTri[bestEdge] = { ...p1 };
    // Copy the second mirror-edge endpoint into its original index.
    nextTri[(bestEdge + 1) % 3] = { ...p2 };
    // Insert the reflected opposite vertex into its original index.
    nextTri[(bestEdge + 2) % 3] = { ...newP3 };

    // Record the crossed edge index for sequence-code derivation.
    reflectionEdges.push(bestEdge);

    // Add the completed reflected triangle before evaluating the terminal hit.
    triangles.push({
      id: `Ray-T${i + 1}`,
      points: nextTri,
      color: COLORS[(i) % COLORS.length]
    });

    // Continue future intersection tests from the newly reflected triangle.
    currentTri = nextTri;
    // Advance past the edge just crossed so it is not selected again.
    currentRayT = bestT;

    // The terminal reflected triangle remains visible when the ray returns home.
    if (hitIsOrigin) break;
  }

  // Use the viewport scale for a ray that has not yet intersected an edge.
  const finalT = currentRayT === 0 ? Math.max(svgSize.width, svgSize.height) / zoom : currentRayT;

  // Return the reflected chain, edge sequence, and the visible ray segment.
  return {
    triangles,
    reflectionEdges,
    rayLine: { x1: O.x, y1: O.y, x2: O.x + finalT * D.x, y2: O.y + finalT * D.y }
  };
};

/** Uses Law of Cosines to measure the exact internal radian angle at vertex p2 */
const getAngleAtVertex = (p1, p2, p3) => {
  // Squared distance across the angle, from first adjacent point to second adjacent point.
  const dist13_sq = (p1.x - p3.x)**2 + (p1.y - p3.y)**2;
  // Squared distance from the measured vertex to the first adjacent point.
  const dist12_sq = (p1.x - p2.x)**2 + (p1.y - p2.y)**2;
  // Squared distance from the measured vertex to the second adjacent point.
  const dist23_sq = (p3.x - p2.x)**2 + (p3.y - p2.y)**2;
  // Degenerate sides have no meaningful interior angle.
  if (dist12_sq === 0 || dist23_sq === 0) return 0;
  // Law of cosines, clamped before acos to absorb tiny floating-point drift.
  let cosVal = (dist12_sq + dist23_sq - dist13_sq) / (2 * Math.sqrt(dist12_sq) * Math.sqrt(dist23_sq));
  return Math.acos(Math.max(-1, Math.min(1, cosVal))); 
};

/** Calculates global angular trajectory securely in 360 space */
const getGlobalAngle = (startP, endP) => {
  // Horizontal component of the oriented segment.
  const dx = endP.x - startP.x;
  // Vertical component of the oriented segment.
  const dy = endP.y - startP.y;
  // atan2 is robust for vertical lines and chooses the correct quadrant.
  let angle = Math.atan2(dy, dx) * (180 / Math.PI);
  // Normalize the usual [-180, 180] output to [0, 360).
  if (angle < 0) angle += 360; 
  return angle;
};

/** Builds the base triangle from the same inputs used by the UI controls. */
const buildBaseTriangle = (baseInputMode, baseCoordsInput, angleParams) => {
  // Local `points` is assigned from exactly one input mode.
  let points;
  // Coordinate mode trusts the three user-editable vertices directly.
  if (baseInputMode === 'coords') {
    // Number() converts text inputs while `|| 0` keeps invalid blanks renderable.
    points = baseCoordsInput.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  } else {
    // Angle mode interprets A and B in degrees and length as side AB.
    const A = Number(angleParams.a) || 0;
    // Angle B is the second physical base angle in degrees.
    const B = Number(angleParams.b) || 0;
    // Base length is the physical length of side AB.
    const L = Number(angleParams.length) || 0;
    // C is determined by the Euclidean triangle angle sum.
    const C = 180 - A - B;

    // Invalid triangles still render a fallback so the UI never goes blank.
    if (A <= 0 || B <= 0 || C <= 0 || L <= 0) {
      // The fallback keeps the same rough scale as the requested base length.
      points = [{ x: 0, y: 0 }, { x: Math.max(L, 1), y: 0 }, { x: Math.max(L, 1) / 2, y: 1 }];
    } else {
      // Convert degrees to radians for Math.sin/cos.
      const radA = A * Math.PI / 180;
      // Convert B for the law-of-sines side calculation.
      const radB = B * Math.PI / 180;
      // Convert C for the law-of-sines denominator.
      const radC = C * Math.PI / 180;
      // Law of sines computes side AC from the chosen base AB.
      const b = L * (Math.sin(radB) / Math.sin(radC));

      // Place A at the origin, B on the x-axis, and C by polar coordinates from A.
      points = [
        // Physical A anchors the shot convention.
        { x: 0, y: 0 },
        // Physical B sets the base scale.
        { x: L, y: 0 },
        // Physical C completes the triangle above the base.
        { x: b * Math.cos(radA), y: b * Math.sin(radA) }
      ];
    }
  }
  // The base triangle uses a neutral color because it is the fixed anchor.
  return { id: 'T0', name: 'T0 (Base)', points, color: '#e2e8f0' };
};

/** Checks whether an angle-input state is complete enough for guarded validation. */
const hasCompleteAngleParams = (angleParams) => {
  // Angle A must parse to a finite number before it can be guarded.
  const A = Number(angleParams.a);
  // Angle B must parse to a finite number before it can be guarded.
  const B = Number(angleParams.b);
  // Base length must parse to a finite number before it can be guarded.
  const L = Number(angleParams.length);
  // Incomplete fields are allowed while the user is typing.
  return Number.isFinite(A) && Number.isFinite(B) && Number.isFinite(L);
};

/** Checks whether numeric angle inputs describe a nondegenerate Euclidean triangle. */
const hasValidAngleTriangle = (angleParams) => {
  // Angle A is parsed once for consistency with `buildBaseTriangle`.
  const A = Number(angleParams.a);
  // Angle B is parsed once for consistency with `buildBaseTriangle`.
  const B = Number(angleParams.b);
  // Base length is parsed once for consistency with `buildBaseTriangle`.
  const L = Number(angleParams.length);
  // The third angle is implicit in the two-input UI.
  const C = 180 - A - B;
  // All side/angle values must be positive for the constructed triangle to matter.
  return A > 0 && B > 0 && C > 0 && L > 0;
};

/** Returns the two physical side indices incident to a physical vertex angle. */
const getEdgesForAngle = (idx) => {
  // Physical A touches edges AB and CA.
  if (idx === 0) return [0, 2];
  // Physical B touches edges AB and BC.
  if (idx === 1) return [0, 1];
  // Physical C touches edges BC and CA.
  return [1, 2];
};

/** Resolves the fixed code-mode frame: x is source A, y is B, and z is C. */
const getCodeModeAngleMaps = () => ({
  // Code paths start at physical A, so labels cannot depend on run counts.
  angleToIdx: { x: 0, y: 1, z: 2 },
  // Keep the inverse map with the same stable convention.
  idxToAngle: { 0: 'x', 1: 'y', 2: 'z' }
});

/** Returns the other endpoint of an edge that is incident to a fan center. */
const getOtherVertexOnEdge = (edge, vertexIdx) => {
  const firstVertexIdx = edge;
  const secondVertexIdx = (edge + 1) % 3;
  if (firstVertexIdx === vertexIdx) return secondVertexIdx;
  if (secondVertexIdx === vertexIdx) return firstVertexIdx;
  return null;
};

/**
 * Derives the billiard sequence code from a list of crossed edge indices.
 *
 * Uses the same initial state and fan-run convention as unfoldCodeData:
 * previousEdge = 0 (AB), fanVertexIdx = 1 (B / symbol y). Each consecutive
 * run of reflections about the same fan vertex produces one integer in the
 * code; fan transitions happen when the crossed edge is no longer incident
 * to the current fan vertex's expected next edge.
 */
const deriveSequenceCodeFromEdges = (reflectionEdges) => {
  if (!reflectionEdges || reflectionEdges.length === 0) {
    return { sequenceCode: '', parsedSequence: [] };
  }

  const { idxToAngle } = getCodeModeAngleMaps();
  const parsedSequence = [];

  // Same initial state as unfoldCodeData: start in the AB/BC wedge.
  let previousEdge = 0;
  let fanVertexIdx = 1;
  let currentCount = 0;

  for (let i = 0; i < reflectionEdges.length; i++) {
    const edge = reflectionEdges[i];

    // The expected next edge within this fan: the incident edge that is NOT previousEdge.
    const incidentEdges = getEdgesForAngle(fanVertexIdx);
    const expectedEdge = incidentEdges[0] === previousEdge ? incidentEdges[1] : incidentEdges[0];

    if (edge === expectedEdge) {
      // This edge continues the current fan run.
      currentCount++;
      previousEdge = edge;
    } else {
      // Close the current fan run (if any) and transition to a new fan center.
      if (currentCount > 0) {
        parsedSequence.push({ count: currentCount, angle: idxToAngle[fanVertexIdx] });
      }

      // Transition: the next fan center is the other endpoint of the last crossed edge.
      fanVertexIdx = getOtherVertexOnEdge(previousEdge, fanVertexIdx);
      if (fanVertexIdx === null) break;

      // Check if this edge matches the new fan's expected first edge.
      const newIncidentEdges = getEdgesForAngle(fanVertexIdx);
      const newExpectedEdge = newIncidentEdges[0] === previousEdge ? newIncidentEdges[1] : newIncidentEdges[0];

      if (edge === newExpectedEdge) {
        currentCount = 1;
        previousEdge = edge;
      } else {
        // The edge does not match any expected fan — stop gracefully.
        break;
      }
    }
  }

  // Close the final fan run.
  if (currentCount > 0) {
    parsedSequence.push({ count: currentCount, angle: idxToAngle[fanVertexIdx] });
  }

  // Build the space-separated integer code string.
  const sequenceCode = parsedSequence.map(s => s.count).join(' ');
  return { sequenceCode, parsedSequence };
};

/**
 * Resolves the one billiard code that actually drives a row's unfolding,
 * from whichever of its two alternate inputs is present: a typed Code
 * Sequence always wins when non-blank; otherwise a non-blank Trajectory
 * Angle is traced (against this row's own base triangle) and the resulting
 * physical path is converted back into its equivalent code. Neither input
 * present (or an angle that fails to parse) resolves to '', matching the
 * existing "no code yet" empty state unfoldCodeData already handles.
 */
const deriveEffectiveSequenceCode = (sequenceText, rayAngleInput, baseTriangle, maxBounces) => {
  const typedCode = (sequenceText || '').trim();
  if (typedCode) return typedCode;
  // Number('') and Number('   ') both coerce to 0 (not NaN), so a blank
  // Angle Ray would otherwise silently resolve to a real 0deg shot
  // instead of "no angle given" — trim and reject blank explicitly first.
  const trimmedAngle = (rayAngleInput ?? '').toString().trim();
  if (!trimmedAngle) return '';
  const rayAngle = Number(trimmedAngle);
  if (!Number.isFinite(rayAngle)) return '';
  // svgSize/zoom only affect buildRayModeData's rayLine visual length (used
  // when the ray never hits anything) — irrelevant here since only
  // reflectionEdges is read, so harmless placeholders.
  const { reflectionEdges } = buildRayModeData({ baseTriangle, rayStartVertex: 0, rayAngle, maxBounces, svgSize: { width: 1, height: 1 }, zoom: 1 });
  return deriveSequenceCodeFromEdges(reflectionEdges).sequenceCode;
};

// Finds an already-existing row with the exact same typed Code Sequence and
// the exact same Angle A/Angle B as the one about to be plotted, so the user
// can be warned before plotting a graph that's already on screen elsewhere
// instead of silently drawing an indistinguishable duplicate on top of it.
// Deliberately compares the literal typed Code Sequence text (not the
// ray-derived effective code, and not angleStepInput) — this is about
// catching "I typed/pasted the same graph twice," not every geometrically
// equivalent path.
const findExactDuplicateSequence = (sequences, candidateId, sequenceText, angleA, angleB) => {
  const trimmedCode = (sequenceText || '').trim();
  if (!trimmedCode) return null;
  const numA = Number(angleA);
  const numB = Number(angleB);
  if (!Number.isFinite(numA) || !Number.isFinite(numB)) return null;
  return sequences.find((row) => (
    row.id !== candidateId
    && (row.sequenceText || '').trim() === trimmedCode
    && Number(row.angleA) === numA
    && Number(row.angleB) === numB
  )) || null;
};

// Groups every row that shares an identical (trimmed) Code Sequence and
// identical Angle A/Angle B — the same match rule as
// findExactDuplicateSequence above, but auditing the whole current set at
// once ("Find Duplicates") rather than checking one row against the rest at
// plot time. Rows with a blank Code Sequence or incomplete/invalid angles
// are never grouped (nothing meaningful to match on). Only groups with 2 or
// more rows are returned — a row matching nothing isn't a duplicate.
const findDuplicateGroups = (sequences) => {
  const rowsByKey = new Map();
  for (const row of sequences) {
    const trimmedCode = (row.sequenceText || '').trim();
    if (!trimmedCode) continue;
    const numA = Number(row.angleA);
    const numB = Number(row.angleB);
    if (!Number.isFinite(numA) || !Number.isFinite(numB)) continue;
    const key = `${trimmedCode}|${numA}|${numB}`;
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push(row);
  }
  return Array.from(rowsByKey.values()).filter((group) => group.length > 1);
};

/** Parses and unfolds the integer code against a supplied base triangle. */
const unfoldCodeData = (billiardsCode, baseTriangle, enabled = true) => {
  // Return a fresh copy so consumers cannot mutate the shared empty constant.
  const defaultData = { ...EMPTY_CODE_DATA, triangles: [], parsedSequence: [], sideSequence: [], reflectionEdges: [], idxToAngle: { ...EMPTY_CODE_DATA.idxToAngle }, angleToIdx: { ...EMPTY_CODE_DATA.angleToIdx } };
  // Inactive or empty code mode should behave like an empty unfolding.
  if (!enabled || !billiardsCode.trim()) return defaultData;

  // Parse all whitespace-separated integers and drop malformed tokens.
  const nums = billiardsCode.trim().split(/\s+/).map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0);
  // If every token was malformed, use the same empty default.
  if (nums.length === 0) return defaultData;

  // Code labels are geometric identities; run lengths only control fan size.
  const { angleToIdx, idxToAngle } = getCodeModeAngleMaps();
  // Parsed runs are built while the deterministic fan chain is traversed.
  const parsedSequence = [];

  // Reflected triangle copies emitted by the code unfolding.
  const triangles = [];
  // Actual side labels crossed during unfolding, used by the sidebar log.
  const sideSequence = [];
  // Physical edge indices crossed during unfolding, used by formal tower coloring.
  const reflectionEdges = [];
  // Begin from a mutable copy of the base triangle's points.
  let currentTri = [...baseTriangle.points];
  // Start in the wedge bounded by AB and BC, so the first reflection is BC.
  let previousEdge = 0;
  // The first fan is centered at y/B, the right acute angle.
  let fanVertexIdx = angleToIdx.y;
  // Count emitted triangles separately from parsed run count.
  let triCount = 0;

  // Expand every code number as one fan in the unique side order it determines.
  for (let stepIndex = 0; stepIndex < nums.length; stepIndex++) {
    const count = nums[stepIndex];
    const fanSymbol = idxToAngle[fanVertexIdx];
    // Record the fan label derived from the preceding reflected side.
    parsedSequence.push({ count, angle: fanSymbol });
    // The fan point is fixed throughout this count block, even as reflected triangles are emitted.
    const fanPoint = currentTri[fanVertexIdx] ? { ...currentTri[fanVertexIdx] } : null;
    // Convert this symbolic angle to its two physical adjacent edges.
    const edges = getEdgesForAngle(fanVertexIdx);

    // Emit exactly `count` reflected triangles, alternating about this fan center.
    for (let i = 0; i < count; i++) {
      // Stop immediately once the hard cap is reached.
      if (triCount >= MAX_CODE_TRIANGLES) break;

      // The next crossed side is the fan side other than the preceding side.
      const currentEdge = edges[0] === previousEdge ? edges[1] : edges[0];

      // Log the conventional side number corresponding to the reflected edge.
      sideSequence.push(EDGE_TO_SIDE[currentEdge]);
      // Log the physical edge index so the validator can reconstruct tower-color propagation.
      reflectionEdges.push(currentEdge);
      // Edge endpoints remain fixed under reflection.
      const p1 = currentTri[currentEdge];
      // The next edge endpoint wraps around for edge 2.
      const p2 = currentTri[(currentEdge + 1) % 3];
      // The opposite vertex is the only point that moves.
      const p3 = currentTri[(currentEdge + 2) % 3];
      // Mirror that opposite vertex across the chosen side.
      const newP3 = reflectPoint(p3, p1, p2);

      // Build the next triangle in the same physical vertex-index order.
      const nextTri = [];
      // Preserve the first endpoint of the reflected side.
      nextTri[currentEdge] = { ...p1 };
      // Preserve the second endpoint of the reflected side.
      nextTri[(currentEdge + 1) % 3] = { ...p2 };
      // Replace the opposite vertex with its reflected copy.
      nextTri[(currentEdge + 2) % 3] = { ...newP3 };

      // Store the reflected triangle with a stable id and cycling visual color.
      triangles.push({
        // The id is used by labels, violation reports, and endpoint exclusion.
        id: `Code-T${triangles.length + 1}`,
        // The reflected points stay in physical A/B/C index order.
        points: nextTri,
        // Preserve the fan metadata used for code-mode inspection and debugging.
        fanVertexIdx,
        // Keep the original fan point so the unfolded path can be inspected.
        fanPoint,
        // The parsed block index groups triangles emitted by the same count.
        fanRunIndex: stepIndex,
        // The number in the code sequence that produced this fan.
        fanRunCount: count,
        // Keep the source symbol for inspection and future UI details.
        fanSymbol,
        // Colors cycle so long unfoldings remain visually separable.
        color: COLORS[(triangles.length) % COLORS.length]
      });

      // Continue from the newly reflected triangle.
      currentTri = nextTri;
      // The emitted side becomes the predecessor for the next fan edge.
      previousEdge = currentEdge;
      // Increase the safety counter.
      triCount++;
    }
    // Stop outer loop too if the safety cap was hit.
    if (triCount >= MAX_CODE_TRIANGLES) break;
    // Consecutive fans meet at the other endpoint of their shared final side.
    fanVertexIdx = getOtherVertexOnEdge(previousEdge, fanVertexIdx);
    if (fanVertexIdx === null) break;
  }

  // Return every code-derived structure consumed by the UI and candidate checks.
  return { triangles, parsedSequence, idxToAngle, angleToIdx, sideSequence, reflectionEdges };
};

/** Returns the reflected chain that belongs on the canvas. */
const getRenderableActiveTriangles = (activeTriangles) => {
  // This is the single seam between "triangle gets a polygon" and "its
  // vertices get colored markers" (see the marker loop in the SVG below,
  // which walks [baseTriangle, ...getRenderableActiveTriangles(...)]),
  // so trimming here keeps every consumer (polygon fill, vertex/side
  // markers, hover) in agreement — none of them ever sees the dropped
  // triangle, so there is no orphaned marker with no polygon under it.
  // Per instructor requirement, the very last reflected triangle in the
  // chain (Code mode's final landing triangle, Ray mode's terminal
  // bounce) is never drawn, in either mode.
  return activeTriangles.slice(0, -1);
};

/** Builds the endpoint-defined shot line used by code-mode validation. */
const getShotGeometry = (baseTriangle, activeTriangles, labelsMap) => {
  // Physical A is the current source/target vertex convention for the shot.
  const shotVertexIdx = 0;
  // Read the symbolic name of physical A so the UI can say "x/A" when relevant.
  const shotSymbol = labelsMap[shotVertexIdx] || 'A';
  // Use the first physical A as the start of the shot line.
  const startShot = baseTriangle.points[shotVertexIdx] || baseTriangle.points[0];
  // Use the last reflected physical A as the end of the shot line.
  const finalShot = activeTriangles.length > 0 ? activeTriangles[activeTriangles.length - 1].points[shotVertexIdx] : startShot;
  // Store the shot vector's x component once for line-equation tests.
  const lineDx = finalShot.x - startShot.x;
  // Store the shot vector's y component once for line-equation tests.
  const lineDy = finalShot.y - startShot.y;
  // Store shot length so endpoint tolerance can scale with the current shot.
  const lineLength = Math.hypot(lineDx, lineDy);
  // Return the full shot geometry bundle used by validation and rendering.
  return { shotVertexIdx, shotSymbol, startShot, finalShot, lineDx, lineDy, lineLength };
};

/** Returns a positive y-coordinate tolerance for direcdt line-side checks. */
const getLineYTolerance = (clearanceEpsilon) => {
  // Invalid or negative epsilon values are clamped to the documented default.
  const safeEpsilon = Number.isFinite(clearanceEpsilon) && clearanceEpsilon >= 0 ? clearanceEpsilon : DEFAULT_CLEARANCE_EPSILON;
  // Keep a small floating-point floor so strict greater-than checks survive roundoff.
  return Math.max(1e-12, safeEpsilon);
};

/** Returns a coordinate tolerance for recognizing the two singular shot endpoints. */
const getShotEndpointTolerance = (vectorLength) => {
  // Endpoint matching should absorb reflection roundoff without swallowing real nearby vertices.
  return Math.max(1e-8, vectorLength * 1e-10);
};

/** Checks whether a point is at the start or final endpoint of the visual shot vector. */
const isShotEndpointCoordinate = (point, shotGeometry, endpointTolerance) => {
  // Squared tolerance avoids square roots in the validation loop.
  const toleranceSq = endpointTolerance * endpointTolerance;
  // Squared distance from this point to the shot start endpoint.
  const startDistSq = (point.x - shotGeometry.startShot.x) ** 2 + (point.y - shotGeometry.startShot.y) ** 2;
  // Squared distance from this point to the shot final endpoint.
  const finalDistSq = (point.x - shotGeometry.finalShot.x) ** 2 + (point.y - shotGeometry.finalShot.y) ** 2;
  // Endpoints are colored for display but ignored as obstructions.
  return startDistSq <= toleranceSq || finalDistSq <= toleranceSq;
};

/** Computes the current physical triangle angles in degrees. */
const getPhysicalAngleDegrees = (baseTriangle) => {
  // Read the triangle points in physical A/B/C order.
  const points = baseTriangle.points;
  // Physical A is measured between CA and AB.
  const angleA = getAngleAtVertex(points[2], points[0], points[1]) * 180 / Math.PI;
  // Physical B is measured between AB and BC.
  const angleB = getAngleAtVertex(points[0], points[1], points[2]) * 180 / Math.PI;
  // Physical C is measured between BC and CA.
  const angleC = getAngleAtVertex(points[1], points[2], points[0]) * 180 / Math.PI;
  // Return the physical angle array in the same index order as triangle points.
  return [angleA, angleB, angleC];
};

/** Computes symbolic x/y/z angle values from the current physical triangle and label map. */
const getSymbolAngleDegreesFromTriangle = (baseTriangle, labelsMap) => {
  // Compute physical angle values directly from geometry so coordinate mode also works.
  const physicalAngles = getPhysicalAngleDegrees(baseTriangle);
  // Build the symbolic angle map from the physical-to-symbol label assignment.
  return {
    // Physical vertex 0 contributes its angle to whichever symbol labels it.
    [labelsMap[0]]: physicalAngles[0],
    // Physical vertex 1 contributes its angle to whichever symbol labels it.
    [labelsMap[1]]: physicalAngles[1],
    // Physical vertex 2 contributes its angle to whichever symbol labels it.
    [labelsMap[2]]: physicalAngles[2]
  };
};

/** Checks every numeric code block against the fan central-angle bound. */
const buildFanConstraintValidation = ({ parsedSequence, symbolAngles, toleranceDegrees = FAN_ANGLE_TOLERANCE_DEGREES }) => {
  // No parsed blocks means there are no fan constraints to apply.
  if (!parsedSequence || parsedSequence.length === 0) {
    // Return an empty valid result with stable fields for consumers.
    return { status: 'valid', checked: 0, invalid: 0, maxCentralAngle: 0, maxRatio: 0, violations: [] };
  }
  // Count invalid fan constraints without relying on the visible violation list.
  let invalid = 0;
  // Track the largest fan central angle encountered.
  let maxCentralAngle = 0;
  // Track the largest central-angle-to-180 ratio encountered.
  let maxRatio = 0;
  // Keep only a short list of visible fan failures for the inspector.
  const violations = [];
  // Walk each code number together with its symbolic fan angle.
  parsedSequence.forEach((step, index) => {
    // Read the actual angle attached to this symbolic fan in the candidate triangle.
    const actualAngle = symbolAngles[step.angle];
    // A malformed symbol-angle lookup makes the code interpretation invalid.
    const hasAngle = Number.isFinite(actualAngle);
    // The central angle of the fan is the code number times the actual triangle angle.
    const centralAngle = hasAngle ? step.count * actualAngle : Infinity;
    // Ratio gives a compact "how close to 180" diagnostic.
    const ratio = hasAngle ? centralAngle / 180 : Infinity;
    // Store the largest central angle for the UI.
    maxCentralAngle = Math.max(maxCentralAngle, centralAngle);
    // Store the largest ratio for the UI.
    maxRatio = Math.max(maxRatio, ratio);
    // Poolshot fans must have central angle strictly below 180 degrees.
    const valid = hasAngle && centralAngle < 180 - toleranceDegrees;
    // Valid fans require no violation record.
    if (valid) return;
    // Count this fan as invalid.
    invalid++;
    // Keep the inspector readable by truncating visible fan violations.
    if (violations.length < 12) {
      // Store enough context to identify the exact numeric code block.
      violations.push({ index, step, actualAngle, centralAngle, ratio, expected: `${step.count}${step.angle} < 180deg` });
    }
  });
  // Return fan constraint status and diagnostics.
  return { status: invalid === 0 ? 'valid' : 'invalid', checked: parsedSequence.length, invalid, maxCentralAngle, maxRatio, violations };
};

/** Builds a compact reference for the current code interpretation. */
const buildCodePathReference = (codeData) => ({
  // Preserve the physical-to-symbol assignment chosen for the starting shot.
  idxToAngle: { ...codeData.idxToAngle },
  // Preserve the rendered/reflected side sequence for the starting shot.
  sideSequence: [...(codeData.sideSequence || [])],
  // Preserve physical reflection edges because they drive tower coloring.
  reflectionEdges: [...(codeData.reflectionEdges || [])]
});

/** Validates that a candidate still represents the same parsed code path. */
const buildCodePathConsistencyValidation = ({ candidateCodeData, reference }) => {
  // Without a reference, the candidate is allowed to define its own path.
  if (!reference) return { status: 'valid', violations: [] };
  // Require the physical-to-symbol assignment to stay exactly fixed.
  const sameLabels = haveSameLabelMap(candidateCodeData.idxToAngle, reference.idxToAngle);
  // Require the displayed side sequence to stay exactly fixed.
  const sameSides = haveSameSideSequence(candidateCodeData.sideSequence, reference.sideSequence);
  // Require the physical reflection edge sequence to stay exactly fixed.
  const sameEdges = haveSameSideSequence(candidateCodeData.reflectionEdges || [], reference.reflectionEdges || []);
  // Accumulate user-readable path consistency failures.
  const violations = [];
  // Report a symbol mapping change separately because it changes what the numbers mean.
  if (!sameLabels) violations.push({ expected: 'same symbolic angle mapping', score: 0, triId: 'code', vertexName: 'map', symbol: 'x/y/z', role: 'code-path' });
  // Report a side sequence change because it changes the unfolded shot.
  if (!sameSides) violations.push({ expected: 'same side sequence from code numbers', score: 0, triId: 'code', vertexName: 'sides', symbol: '1/2/3', role: 'code-path' });
  // Report a physical edge sequence change because it changes tower-color propagation.
  if (!sameEdges) violations.push({ expected: 'same physical reflection edges', score: 0, triId: 'code', vertexName: 'edges', symbol: '0/1/2', role: 'code-path' });
  // The path is valid only if every required sequence matches.
  return { status: violations.length === 0 ? 'valid' : 'invalid', violations };
};

/** Builds a stable occurrence key that survives coordinate changes during perturbation. */
const getClearanceOccurrenceKey = (triId, vertexIdx, symbol) => {
  // Triangle id and physical vertex index track C vertices even when coordinates move.
  return `${triId}:${vertexIdx}:${symbol}`;
};

/** Returns the display name for a physical triangle vertex. */
const getPhysicalVertexName = (vertexIdx) => {
  // The first three physical vertices keep their conventional billiards names.
  return ['A', 'B', 'C'][vertexIdx] || `V${vertexIdx}`;
};

/** Returns the opposite formal color role along a tower side. */
const getOppositeTowerRole = (role) => {
  // Blue side endpoints force the adjacent side endpoint to be formal black.
  if (role === TOWER_BLUE_ROLE) return TOWER_BLACK_ROLE;
  // Black side endpoints force the adjacent side endpoint to be formal blue.
  if (role === TOWER_BLACK_ROLE) return TOWER_BLUE_ROLE;
  // Unknown roles cannot propagate a formal tower color.
  return null;
};

/** Returns the requested blue/black UI color for a formal tower role. */
const getTowerRoleColor = (role) => {
  // Formal blue vertices render blue.
  if (role === TOWER_BLUE_ROLE) return TOWER_BLUE_COLOR;
  // Formal black vertices render black in this workbench.
  if (role === TOWER_BLACK_ROLE) return TOWER_BLACK_COLOR;
  // Uncolored vertices render yellow because the tower-color propagation failed.
  return BAND_VERTEX_COLOR;
};

/** Builds a vertex record shared by coloring, validation, and rendering. */
const buildTowerVertexRecord = (tri, vertexIdx, labelsMap, role, source) => {
  // Pull the symbolic label attached to this physical vertex.
  const symbol = labelsMap[vertexIdx] || getPhysicalVertexName(vertexIdx);
  // Build an occurrence key that does not depend on the vertex coordinates.
  const key = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
  // Read the current geometric point for coloring and line validation.
  const point = tri.points[vertexIdx];
  // Store the conventional physical name for marker text and violation messages.
  const vertexName = getPhysicalVertexName(vertexIdx);
  // Return every stable identifier and visual datum in one object.
  return { key, triId: tri.id, vertexIdx, vertexName, symbol, point, role, color: getTowerRoleColor(role), source };
};

/** Reads a formal color role from the coloring state. */
const getTowerRoleRecord = (state, tri, vertexIdx, labelsMap) => {
  // Pull the symbolic label attached to this physical vertex.
  const symbol = labelsMap[vertexIdx] || getPhysicalVertexName(vertexIdx);
  // Build the same occurrence key used when the role was assigned.
  const key = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
  // Return the existing record when this occurrence has already been colored.
  return state.byOccurrence.get(key) || null;
};

/** Assigns a formal tower color to a single vertex occurrence. */
const setTowerRoleRecord = (state, tri, vertexIdx, labelsMap, role, source) => {
  // Missing points cannot participate in the tower-color graph.
  if (!tri?.points?.[vertexIdx]) return null;
  // Build the new record before checking for conflicts.
  const nextRecord = buildTowerVertexRecord(tri, vertexIdx, labelsMap, role, source);
  // Read any previous assignment for this exact occurrence.
  const previousRecord = state.byOccurrence.get(nextRecord.key);
  // A previous assignment with the same role is already consistent.
  if (previousRecord?.role === role) return previousRecord;
  // A previous assignment with the opposite role means the side sequence is inconsistent.
  if (previousRecord) {
    // Store the conflict for the validator instead of throwing during render.
    state.conflicts.push({ ...nextRecord, expected: previousRecord.role, actual: role, reason: source });
    // Preserve the first role so rendering remains deterministic.
    return previousRecord;
  }
  // Store the new formal role for this occurrence.
  state.byOccurrence.set(nextRecord.key, nextRecord);
  // Return the record so callers can immediately propagate from it.
  return nextRecord;
};

/** Adds a tower-color conflict that is not tied to a pre-existing record. */
const addTowerColorConflict = (state, tri, vertexIdx, labelsMap, expected, actual, reason) => {
  // Build a normal vertex record so the violation renderer has labels and coordinates.
  const record = buildTowerVertexRecord(tri, vertexIdx, labelsMap, actual, reason);
  // Store the expected and actual roles next to the record metadata.
  state.conflicts.push({ ...record, expected, actual, reason });
};

/** Propagates opposite formal colors across the two endpoints of one tower side. */
const propagateTowerEdgeRoles = (state, tri, edge, labelsMap, source) => {
  // The first endpoint of physical edge e is vertex e.
  const firstIdx = edge;
  // The second endpoint of physical edge e wraps around the triangle.
  const secondIdx = (edge + 1) % 3;
  // Read any role already assigned to the first endpoint.
  const firstRecord = getTowerRoleRecord(state, tri, firstIdx, labelsMap);
  // Read any role already assigned to the second endpoint.
  const secondRecord = getTowerRoleRecord(state, tri, secondIdx, labelsMap);
  // If both endpoints are known, they must be opposite formal colors.
  if (firstRecord && secondRecord) {
    // Equal endpoint colors violate the paper's side-color rule.
    if (firstRecord.role === secondRecord.role) addTowerColorConflict(state, tri, secondIdx, labelsMap, getOppositeTowerRole(firstRecord.role), secondRecord.role, source);
    // No propagation is needed when both endpoints are already known.
    return;
  }
  // If the first endpoint is known, the second endpoint gets the opposite role.
  if (firstRecord && !secondRecord) {
    // Assign the second endpoint by the inductive tower-color rule.
    setTowerRoleRecord(state, tri, secondIdx, labelsMap, getOppositeTowerRole(firstRecord.role), source);
    // Propagation for this edge is complete.
    return;
  }
  // If the second endpoint is known, the first endpoint gets the opposite role.
  if (!firstRecord && secondRecord) {
    // Assign the first endpoint by the inductive tower-color rule.
    setTowerRoleRecord(state, tri, firstIdx, labelsMap, getOppositeTowerRole(secondRecord.role), source);
  }
};

/** Copies formal color roles across the shared mirror edge of adjacent triangles. */
const syncTowerEdgeRoles = (state, fromTri, toTri, edge, labelsMap, source) => {
  // Both endpoints of the reflected edge are geometrically shared by the two triangles.
  for (const vertexIdx of [edge, (edge + 1) % 3]) {
    // Read the role on the previous triangle's occurrence.
    const fromRecord = getTowerRoleRecord(state, fromTri, vertexIdx, labelsMap);
    // Read the role on the next triangle's copied occurrence.
    const toRecord = getTowerRoleRecord(state, toTri, vertexIdx, labelsMap);
    // Conflicting shared-edge colors mean the propagation is inconsistent.
    if (fromRecord && toRecord && fromRecord.role !== toRecord.role) addTowerColorConflict(state, toTri, vertexIdx, labelsMap, fromRecord.role, toRecord.role, source);
    // A known previous occurrence colors the copied occurrence in the reflected triangle.
    else if (fromRecord && !toRecord) setTowerRoleRecord(state, toTri, vertexIdx, labelsMap, fromRecord.role, source);
    // A known copied occurrence can also back-fill the previous side occurrence.
    else if (!fromRecord && toRecord) setTowerRoleRecord(state, fromTri, vertexIdx, labelsMap, toRecord.role, source);
  }
};

/** Builds the paper-style formal blue/black coloring for the whole unfolded tower. */
const buildTowerColoring = ({ baseTriangle, activeTriangles, labelsMap, reflectionEdges }) => {
  // The coloring state stores formal roles and any contradictions found while propagating.
  const state = { byOccurrence: new Map(), conflicts: [] };
  // The base plus every reflected copy is the finite tower being tested.
  const allTris = [baseTriangle, ...activeTriangles];
  // A0 is formal blue by the tower-color definition.
  setTowerRoleRecord(state, baseTriangle, 0, labelsMap, TOWER_BLUE_ROLE, 'base A0 is blue');
  // B0 is formal black by the tower-color definition.
  setTowerRoleRecord(state, baseTriangle, 1, labelsMap, TOWER_BLACK_ROLE, 'base B0 is black');
  // The base side AB must have opposite colors at its two endpoints.
  propagateTowerEdgeRoles(state, baseTriangle, 0, labelsMap, 'base side AB');

  // Process each reflection edge in the exact order emitted by the unfolder.
  for (let i = 0; i < activeTriangles.length; i++) {
    // The previous triangle is the one being reflected.
    const previousTri = allTris[i];
    // The next triangle is the reflected mirror image.
    const nextTri = allTris[i + 1];
    // The reflected physical edge was captured during unfolding.
    const edge = reflectionEdges?.[i];
    // Missing edge data means this candidate cannot be validated rigorously.
    if (!Number.isInteger(edge) || edge < 0 || edge > 2) {
      // Store a synthetic conflict so the validator rejects the candidate.
      state.conflicts.push({ triId: nextTri?.id || `Code-T${i + 1}`, vertexName: 'edge', symbol: '?', role: 'missing-edge', expected: 'recorded reflection edge', actual: String(edge), reason: 'missing reflection edge', point: null });
      // Continue so all other available data can still be rendered.
      continue;
    }
    // The side used for reflection also propagates opposite colors within the old triangle.
    propagateTowerEdgeRoles(state, previousTri, edge, labelsMap, `reflection side ${EDGE_TO_SIDE[edge]}`);
    // Shared edge endpoints carry their formal colors into the reflected triangle.
    syncTowerEdgeRoles(state, previousTri, nextTri, edge, labelsMap, `shared reflection side ${EDGE_TO_SIDE[edge]}`);
    // The copied side in the new triangle must also have opposite endpoint colors.
    propagateTowerEdgeRoles(state, nextTri, edge, labelsMap, `reflected side ${EDGE_TO_SIDE[edge]}`);
  }

  // The visual code-mode shot terminates at physical A in the final reflected triangle.
  if (activeTriangles.length > 0) {
    // Read the final reflected triangle once for terminal-side coloring.
    const finalTri = activeTriangles[activeTriangles.length - 1];
    // A singular endpoint at A can touch either side incident to physical A.
    for (const terminalEdge of getEdgesForAngle(0)) {
      // Color terminal-side vertices without letting endpoint coordinates become obstructions.
      propagateTowerEdgeRoles(state, finalTri, terminalEdge, labelsMap, `terminal side ${EDGE_TO_SIDE[terminalEdge]}`);
    }
  }

  // Uncolored occurrences indicate a side sequence that does not define a complete tower strip.
  const uncolored = [];
  // Walk every triangle occurrence, including C vertices, to find missing formal colors.
  for (const tri of allTris) {
    // Every physical A/B/C occurrence should receive a formal color.
    for (let vertexIdx = 0; vertexIdx < 3; vertexIdx++) {
      // Skip malformed triangle points defensively.
      if (!tri.points[vertexIdx]) continue;
      // Build the occurrence record without assigning a role.
      const record = buildTowerVertexRecord(tri, vertexIdx, labelsMap, null, 'uncolored vertex');
      // Missing role records are validator failures rather than silently ignored vertices.
      if (!state.byOccurrence.has(record.key)) uncolored.push(record);
    }
  }

  // Return the formal coloring and any data-quality failures found along the way.
  return { byOccurrence: state.byOccurrence, conflicts: state.conflicts, uncolored };
};

/** Computes the y value of the visual shot line at a point's x coordinate. */
const getShotLineYAtX = (point, shotGeometry) => {
  // A vertical shot line has no single y value for a supplied x coordinate.
  if (Math.abs(shotGeometry.lineDx) < 1e-12) return null;
  // Slope of the visual shot line in mathematical coordinates.
  const slope = shotGeometry.lineDy / shotGeometry.lineDx;
  // Standard point-slope line evaluation at the vertex x coordinate.
  return shotGeometry.startShot.y + slope * (point.x - shotGeometry.startShot.x);
};

/** Validates the unfolded code tower by testing every formal blue/black vertex against the shot line. */
const buildPoolshotTowerValidation = ({ simulatorMode, baseTriangle, activeTriangles, labelsMap, reflectionEdges = [], parsedSequence = [], clearanceEpsilon, extraViolations = [] }) => {
  // The idle state keeps ray mode and empty code mode visually quiet.
  if (simulatorMode !== 'code' || activeTriangles.length === 0) {
    // Return a complete shape so consumers never need null checks.
    return { status: 'idle', checked: 0, violations: [], stats: { blue: 0, red: 0, uncolored: 0, endpoints: 0, invalid: 0, epsilonBand: 0, lineMargin: 0, fanChecked: 0, fanMaxCentralAngle: 0, fanMaxRatio: 0 }, byOccurrence: new Map(), shotGeometry: getShotGeometry(baseTriangle, activeTriangles, labelsMap), lineTolerance: 0 };
  }

  // Build the shot vector once for every direct line calculation.
  const shotGeometry = getShotGeometry(baseTriangle, activeTriangles, labelsMap);
  // Convert the user epsilon into the direct y-coordinate tolerance used below.
  const lineTolerance = getLineYTolerance(clearanceEpsilon);
  // Coordinate endpoint matching excludes singular start/final points from obstruction checks.
  const endpointTolerance = getShotEndpointTolerance(shotGeometry.lineLength);

  // A zero-length vector cannot define a shot line.
  if (shotGeometry.lineLength < 1e-12) {
    // Return an invalid trajectory-level violation for the sidebar.
    return {
      // The vector is invalid because it cannot define a line.
      status: 'invalid',
      // No actual vertices can be checked without a usable vector.
      checked: 0,
      // The synthetic violation explains the failure.
      violations: [{ triId: 'trajectory', symbol: shotGeometry.shotSymbol, vertexName: 'A', expected: 'nonzero shot vector', score: 0, side: 0, point: shotGeometry.startShot, role: 'trajectory' }],
      // Stats remain mostly zero because no point loop ran.
      stats: { blue: 0, red: 0, uncolored: 0, endpoints: 0, invalid: 1, epsilonBand: 0, lineMargin: 0, fanChecked: 0, fanMaxCentralAngle: 0, fanMaxRatio: 0 },
      // Occurrence map stays empty because there are no point classifications.
      byOccurrence: new Map(),
      // The caller still needs the degenerate shot geometry for rendering.
      shotGeometry,
      // The y-line tolerance is exposed for diagnostics.
      lineTolerance
    };
  }

  // A vertical shot line cannot support the requested y_line(x) comparison.
  if (Math.abs(shotGeometry.lineDx) < 1e-12) {
    // Return an invalid trajectory-level violation instead of using a different predicate.
    return {
      // The vector is invalid for this validator because y_line(x) is undefined.
      status: 'invalid',
      // No vertices are checked because the line equation cannot be evaluated by x.
      checked: 0,
      // The synthetic violation explains the failure.
      violations: [{ triId: 'trajectory', symbol: shotGeometry.shotSymbol, vertexName: 'line', expected: 'nonvertical shot line for y-at-x test', score: 0, side: 0, point: shotGeometry.startShot, role: 'trajectory' }],
      // Stats remain mostly zero because no point loop ran.
      stats: { blue: 0, red: 0, uncolored: 0, endpoints: 0, invalid: 1, epsilonBand: 0, lineMargin: 0, fanChecked: 0, fanMaxCentralAngle: 0, fanMaxRatio: 0 },
      // Occurrence map stays empty because there are no point classifications.
      byOccurrence: new Map(),
      // The caller still needs the shot geometry for rendering.
      shotGeometry,
      // The tolerance is still exposed for diagnostics.
      lineTolerance
    };
  }

  // Build formal tower colors from the reflection side sequence.
  const towerColoring = buildTowerColoring({ baseTriangle, activeTriangles, labelsMap, reflectionEdges });
  // Convert the current physical triangle into symbolic x/y/z angle values.
  const symbolAngles = getSymbolAngleDegreesFromTriangle(baseTriangle, labelsMap);
  // Validate every numeric code block as a fan central-angle constraint.
  const fanValidation = buildFanConstraintValidation({ parsedSequence, symbolAngles });
  // Validate the base triangle and every reflected copy.
  const allTris = [baseTriangle, ...activeTriangles];
  // Keep all classifications keyed by occurrence so C vertices are tracked across movement.
  const byOccurrence = new Map();
  // Keep only the first few violations for readable sidebar output.
  const violations = [];
  // Count every A/B/C occurrence inspected.
  let checked = 0;
  // Count formal blue vertices.
  let blue = 0;
  // Count formal black vertices.
  let red = 0;
  // Count vertices that never received a formal tower color.
  let uncolored = 0;
  // Count singular start/final endpoint coordinates ignored by the obstruction test.
  let endpoints = 0;
  // Count invalid classifications without relying on the truncated violation list.
  let invalid = fanValidation.invalid + extraViolations.length;
  // Count vertices that participate in the epsilon overlap band.
  let epsilonBand = 0;
  // Track the smallest absolute valid-side y gap over all checked colored vertices.
  let lineSideMargin = Infinity;
  // Add code-path consistency failures before point-level violations.
  for (const violation of extraViolations) {
    // Keep the inspector readable by truncating visible code-path violations.
    if (violations.length < 12) violations.push({ ...violation, point: null });
  }

  // Add fan central-angle failures before point-level violations.
  for (const violation of fanValidation.violations) {
    // Keep the inspector readable by truncating visible fan violations.
    if (violations.length < 12) {
      // Convert the fan failure into the same visible violation shape.
      violations.push({ triId: `fan-${violation.index + 1}`, symbol: violation.step.angle, vertexName: `${violation.step.count}${violation.step.angle}`, expected: violation.expected, score: violation.centralAngle, side: violation.centralAngle, point: null, role: 'fan-constraint' });
    }
  }

  // Adds a visible violation while keeping the sidebar bounded.
  const addViolation = (classification, expected) => {
    // Count this occurrence as invalid only once.
    if (classification.valid) invalid++;
    // Mark the classification invalid for marker rendering.
    classification.valid = false;
    // Store the human-readable expectation.
    classification.expected = expected;
    // Invalid vertices receive a strong red ring.
    classification.ring = '#7f1d1d';
    // Only keep a short visible list in the inspector.
    if (violations.length < 12) {
      // Preserve enough context to debug the exact offending occurrence.
      violations.push({ triId: classification.triId, symbol: classification.symbol, vertexName: classification.vertexName, expected, score: classification.score, side: classification.score, point: classification.point, role: classification.role });
    }
  };

  // Walk every triangle copy in unfolded order.
  for (const tri of allTris) {
    // Check every physical vertex, not only the symbolic fan endpoints.
    for (let vertexIdx = 0; vertexIdx < 3; vertexIdx++) {
      // Pull the current physical vertex point.
      const point = tri.points[vertexIdx];
      // Skip malformed triangles defensively.
      if (!point) continue;
      // Pull the symbolic label attached to this physical vertex.
      const symbol = labelsMap[vertexIdx] || getPhysicalVertexName(vertexIdx);
      // Occurrence keys do not depend on coordinates, so changed C vertices are still tracked.
      const occurrenceKey = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
      // Read the formal tower color assigned by reflection-side propagation.
      const roleRecord = towerColoring.byOccurrence.get(occurrenceKey);
      // Evaluate the drawn shot line at this vertex's x coordinate.
      const lineY = getShotLineYAtX(point, shotGeometry);
      // Score is positive when the vertex is above the drawn shot line.
      const score = point.y - lineY;
      // Shot endpoints are singular endpoints, not interior vertex obstructions.
      const isShotEndpoint = isShotEndpointCoordinate(point, shotGeometry, endpointTolerance);
      // Endpoint vertices render red; all others render their formal tower role.
      const vertexColor = isShotEndpoint ? ENDPOINT_VERTEX_COLOR : getTowerRoleColor(roleRecord?.role);
      // Black and red markers need light label text for legibility.
      const markerTextColor = isShotEndpoint || roleRecord?.role === TOWER_BLACK_ROLE ? '#fff1f2' : '#07111f';
      // Black markers get a light ring so they remain visible on the dark canvas.
      const markerRing = isShotEndpoint ? '#7f1d1d' : roleRecord?.role === TOWER_BLACK_ROLE ? '#f8fafc' : '#0f172a';
      // Build the renderable classification for this occurrence.
      const classification = {
        // Stable occurrence key used by marker rendering.
        key: occurrenceKey,
        // Triangle id shown in the violation list.
        triId: tri.id,
        // Physical vertex index is retained for future debugging.
        vertexIdx,
        // Physical vertex name keeps A/B/C tracking explicit.
        vertexName: getPhysicalVertexName(vertexIdx),
        // Symbolic label is shown beside the physical vertex name.
        symbol,
        // Current point is stored for marker placement.
        point,
        // Formal role comes from the tower-color graph.
        role: roleRecord?.role || 'uncolored',
        // Score is y(vertex) - y_line(vertex.x), matching the requested direct test.
        score,
        // Store the line y value for debugging and future UI details.
        lineY,
        // Endpoint coordinates remain colored but are ignored by the line-side margin.
        isShotEndpoint,
        // Every occurrence starts valid so one failure path counts it exactly once.
        valid: true,
        // The default expectation is the direct color-vs-line predicate.
        expected: 'blue above line and black below line',
        // Vertex fill color follows formal role, not current side of the drawn line.
        color: vertexColor,
        // Marker label color is chosen against the marker fill color.
        textColor: markerTextColor,
        // Valid vertices get a dark low-emphasis ring until a failure path updates them.
        ring: markerRing
      };
      // Store the classification by stable occurrence for marker rendering.
      byOccurrence.set(occurrenceKey, classification);
      // Count this inspected vertex occurrence.
      checked++;
      // Endpoint coordinates are displayed but do not affect validity.
      if (isShotEndpoint) {
        // Count ignored endpoints for diagnostics.
        endpoints++;
        // Skip line-margin and uncolored checks for singular endpoints.
        continue;
      }
      // Count and track blue vertices.
      if (classification.role === TOWER_BLUE_ROLE) {
        // Increment blue total.
        blue++;
        // Blue vertices must sit strictly above the shot line at their x coordinate.
        if (score <= lineTolerance) {
          // Count near-line and wrong-side blue vertices for diagnostics.
          epsilonBand++;
          // Mark this blue vertex as invalid.
          addViolation(classification, 'blue y > line y');
        } else {
          // Store the tightest positive blue clearance.
          lineSideMargin = Math.min(lineSideMargin, score);
        }
      } else if (classification.role === TOWER_BLACK_ROLE) {
        // Increment formal black total.
        red++;
        // Black vertices must sit strictly below the shot line at their x coordinate.
        if (score >= -lineTolerance) {
          // Count near-line and wrong-side black vertices for diagnostics.
          epsilonBand++;
          // Mark this black vertex as invalid.
          addViolation(classification, 'black y < line y');
        } else {
          // Store the tightest positive black clearance below the line.
          lineSideMargin = Math.min(lineSideMargin, -score);
        }
      } else {
        // Count missing formal colors separately from line-side failures.
        uncolored++;
        // Uncolored vertices are invalid because every tower vertex must be classified.
        addViolation(classification, 'formal blue/black tower color');
      }
    }
  }

  // Report tower-color contradictions as validation failures.
  for (const conflict of towerColoring.conflicts) {
    // A conflict at either singular shot endpoint cannot obstruct or invalidate the line.
    if (conflict.point && isShotEndpointCoordinate(conflict.point, shotGeometry, endpointTolerance)) continue;
    // Count each conflict in the invalid total.
    invalid++;
    // Keep the sidebar readable.
    if (violations.length < 12) {
      // Convert the propagation conflict into the same visible violation shape.
      violations.push({ triId: conflict.triId, symbol: conflict.symbol, vertexName: conflict.vertexName, expected: `tower role ${conflict.expected}`, score: 0, side: 0, point: conflict.point, role: conflict.role || 'tower-conflict' });
    }
  }

  // If no colored non-endpoint vertices were checked, report a zero line margin.
  const lineMargin = Number.isFinite(lineSideMargin) ? lineSideMargin : 0;

  // The shot is valid exactly when every direct color-vs-line predicate passed.
  return {
    // Validity is based on the full invalid count.
    status: invalid === 0 ? 'valid' : 'invalid',
    // Checked counts every A/B/C occurrence in the tower.
    checked,
    // Violations hold the first several failures for the inspector.
    violations,
    // Stats expose category totals without rewalking vertices.
    stats: { blue, red, uncolored, endpoints, invalid, epsilonBand, lineMargin, fanChecked: fanValidation.checked, fanMaxCentralAngle: fanValidation.maxCentralAngle, fanMaxRatio: fanValidation.maxRatio },
    // byOccurrence lets rendering and locked edits track physical A/B/C occurrences.
    byOccurrence,
    // shotGeometry keeps all endpoint-vector data in one place.
    shotGeometry,
    // lineTolerance records the exact epsilon used by the direct y-line predicate.
    lineTolerance
  };
};

// Maps a buildPoolshotTowerValidation `expected` reason to a short section
// heading and a one-line phrase — the Vertex Line Test's own spec rules out
// a generic "Invalid input" message, so every distinct failure reason still
// gets a specific explanation, but grouped by reason (see
// buildVertexLineTestErrorSections below) instead of one paragraph per
// vertex: a real failure often fails 10+ vertices for the exact same root
// cause, and repeating the same explanation 10+ times is unreadable.
const VERTEX_LINE_TEST_CATEGORY = {
  'blue y > line y': { heading: 'Blue vertices on the wrong side', phrase: 'must sit above the shot line' },
  'black y < line y': { heading: 'Black vertices on the wrong side', phrase: 'must sit below the shot line' },
  'formal blue/black tower color': { heading: 'Uncolored vertices', phrase: 'never received a formal blue/black role' },
  'nonzero shot vector': { heading: 'Degenerate shot', phrase: 'the shot has zero length, so no line exists to test against' },
  'nonvertical shot line for y-at-x test': { heading: 'Vertical shot line', phrase: 'this test cannot evaluate a perfectly vertical shot line' },
};
const categorizeVertexLineViolation = (expected) => {
  if (VERTEX_LINE_TEST_CATEGORY[expected]) return VERTEX_LINE_TEST_CATEGORY[expected];
  if (expected?.startsWith('tower role')) return { heading: 'Conflicting tower roles', phrase: `have a contradictory role (${expected})` };
  return { heading: 'Other requirement', phrase: `failed "${expected}"` };
};

// Caps how many individual vertex names are spelled out per group before
// collapsing the rest into "and N more" — keeps each line short even when
// many vertices share the same failure.
const MAX_VERTEX_NAMES_SHOWN = 4;
const formatVertexLabelList = (labels) => (
  labels.length <= MAX_VERTEX_NAMES_SHOWN
    ? labels.join(', ')
    : `${labels.slice(0, MAX_VERTEX_NAMES_SHOWN).join(', ')}, and ${labels.length - MAX_VERTEX_NAMES_SHOWN} more`
);

/**
 * Builds the "Vertex Line Test is invalid." error modal's sections: one
 * short line per distinct failure reason (grouping every vertex that fails
 * for that same reason), plus one shared "How to fix" line — never one
 * block per vertex, so a systemic mismatch that fails many vertices still
 * reads as a couple of lines instead of a wall of repeated text.
 */
const buildVertexLineTestErrorSections = (violations, clearanceEpsilon) => {
  if (!violations || violations.length === 0) {
    return [{ heading: 'Problem', text: 'The Vertex Line Test failed for an unspecified reason.' }];
  }
  const groups = new Map();
  for (const violation of violations) {
    const label = `${violation.triId} ${violation.vertexName}${violation.symbol ? ` (${violation.symbol})` : ''}`;
    if (!groups.has(violation.expected)) groups.set(violation.expected, []);
    groups.get(violation.expected).push(label);
  }
  const sections = [];
  for (const [expected, labels] of groups) {
    const { heading, phrase } = categorizeVertexLineViolation(expected);
    sections.push({ heading, text: `${formatVertexLabelList(labels)} ${phrase}.` });
  }
  // Surfaces the current Separation Epsilon: this test's pass/fail line sits
  // exactly `clearanceEpsilon` away from the shot line (getLineYTolerance),
  // so the same code+angles can pass at a small epsilon and fail at a
  // larger one — a real, working tolerance, not a bug, but invisible
  // without this since Separation Epsilon lives in a different part of the
  // sidebar than this modal.
  const epsilonNote = Number.isFinite(clearanceEpsilon)
    ? ` (current Separation Epsilon: ${clearanceEpsilon})`
    : '';
  sections.push({ heading: 'How to fix', text: `Adjust the code sequence, Angle A/B, or base triangle so every vertex ends up on its required side of the shot line${epsilonNote}.` });
  return sections;
};

/** Compares two physical-to-symbol maps for exact current-mapping preservation. */
const haveSameLabelMap = (left, right) => {
  // All three physical vertices must retain their symbolic labels.
  return [0, 1, 2].every(idx => left[idx] === right[idx]);
};

/** Compares two side sequences for exact unfolding preservation. */
const haveSameSideSequence = (left, right) => {
  // A sequence length change means the same code no longer unfolded the same way.
  if (left.length !== right.length) return false;
  // Every side number must match in order.
  return left.every((side, idx) => side === right[idx]);
};

/** Converts the current physical angle inputs into symbolic x/y/z angle values. */
const getSymbolAngleValues = (angleParams, labelsMap) => {
  // Physical A is directly entered in angle mode.
  const physicalA = Number(angleParams.a);
  // Physical B is directly entered in angle mode.
  const physicalB = Number(angleParams.b);
  // Physical C is implicit from the Euclidean angle sum.
  const physicalC = 180 - physicalA - physicalB;
  // Build the reverse map from symbolic labels to physical angle values.
  const bySymbol = {
    // Physical vertex 0 carries this symbol's angle.
    [labelsMap[0]]: physicalA,
    // Physical vertex 1 carries this symbol's angle.
    [labelsMap[1]]: physicalB,
    // Physical vertex 2 carries this symbol's angle.
    [labelsMap[2]]: physicalC
  };
  // Return numeric values in theorem-style x/y/z naming.
  return { x: bySymbol.x, y: bySymbol.y, z: bySymbol.z };
};

/** Converts symbolic x/y/z angle values back into the physical A/B input fields. */
const buildAngleParamsFromSymbolValues = (symbolAngles, labelsMap, length) => {
  // Physical A should receive whichever symbolic angle label is mapped to vertex 0.
  const physicalA = symbolAngles[labelsMap[0]];
  // Physical B should receive whichever symbolic angle label is mapped to vertex 1.
  const physicalB = symbolAngles[labelsMap[1]];
  // Return angle-input state compatible with the existing base-triangle builder.
  return { a: physicalA, b: physicalB, length };
};

/** Runs a bounded local BFS/DFS-style search for a stable symbolic x/y region. */
const findStableRegion = ({ angleParams, labelsMap, billiardsCode, currentCodeData, clearanceEpsilon }) => {
  // Region search only makes sense when the current angle inputs are numeric.
  if (!hasCompleteAngleParams(angleParams) || !hasValidAngleTriangle(angleParams)) {
    // Report a clean failure instead of searching around malformed inputs.
    return { status: 'error', message: 'Angle mode needs positive A, B, and C before region search.', visits: 0 };
  }

  // Read the current symbolic x/y/z values from the physical angle inputs.
  const center = getSymbolAngleValues(angleParams, labelsMap);
  // Guard against missing labels from malformed code data.
  if (![center.x, center.y, center.z].every(Number.isFinite)) {
    // Report a clean failure if x/y/z cannot be recovered.
    return { status: 'error', message: 'Could not map current physical angles to symbolic x/y/z.', visits: 0 };
  }

  // Preserve the current base length while perturbing only symbolic angles.
  const length = Number(angleParams.length);
  // Cache candidate validity by rounded x/y coordinate so repeated BFS hits are cheap.
  const validityCache = new Map();
  // Count every candidate evaluation across precision steps.
  let visits = 0;
  // Remember whether any precision step hit its visit cap.
  let capped = false;
  // Store the best interval bounds found at the latest completed precision.
  let bestBounds = null;
  // Start with a symmetric local search window around the current sample.
  let searchWindow = {
    // Minimum symbolic x to examine at the current precision.
    minX: center.x - REGION_SEARCH_RADIUS_DEGREES,
    // Maximum symbolic x to examine at the current precision.
    maxX: center.x + REGION_SEARCH_RADIUS_DEGREES,
    // Minimum symbolic y to examine at the current precision.
    minY: center.y - REGION_SEARCH_RADIUS_DEGREES,
    // Maximum symbolic y to examine at the current precision.
    maxY: center.y + REGION_SEARCH_RADIUS_DEGREES
  };

  // Evaluates one symbolic x/y grid point with mapping and side-sequence preservation.
  const isCandidateValid = (x, y, precision) => {
    // The cache key includes precision because snapped coordinates differ by step.
    const cacheKey = `${precision}:${x.toFixed(precision)},${y.toFixed(precision)}`;
    // Return cached results when the BFS reaches the same point again.
    if (validityCache.has(cacheKey)) return validityCache.get(cacheKey);
    // Candidate z is determined by the Euclidean angle sum.
    const z = 180 - x - y;
    // Reject non-triangular symbolic angle triples immediately.
    if (x <= 0 || y <= 0 || z <= 0) {
      // Cache the rejection for duplicate grid visits.
      validityCache.set(cacheKey, false);
      // Return the rejection.
      return false;
    }

    // Convert symbolic angles back to physical A/B controls using the current mapping.
    const candidateParams = buildAngleParamsFromSymbolValues({ x, y, z }, labelsMap, length);
    // Build the candidate triangle without mutating React state.
    const candidateTriangle = buildBaseTriangle('angles', [], candidateParams);
    // Unfold the same code against the candidate triangle.
    const candidateCodeData = unfoldCodeData(billiardsCode, candidateTriangle, true);
    // Require the symbolic-to-physical assignment to remain unchanged.
    const sameLabels = haveSameLabelMap(candidateCodeData.idxToAngle, labelsMap);
    // Require the side sequence to remain unchanged so the same code path is being tested.
    const sameSides = haveSameSideSequence(candidateCodeData.sideSequence, currentCodeData.sideSequence);
    // Candidate validity uses the same direct blue/black line validator as the live view.
    const candidateValidation = buildPoolshotTowerValidation({ simulatorMode: 'code', baseTriangle: candidateTriangle, activeTriangles: candidateCodeData.triangles, labelsMap: candidateCodeData.idxToAngle, reflectionEdges: candidateCodeData.reflectionEdges, parsedSequence: candidateCodeData.parsedSequence, clearanceEpsilon });
    // The sample is valid only when mapping, unfolding, and the line test all agree.
    const valid = sameLabels && sameSides && candidateValidation.status === 'valid';
    // Cache the computed result.
    validityCache.set(cacheKey, valid);
    // Return the computed result to the BFS.
    return valid;
  };

  // Run progressively finer local searches.
  for (const step of REGION_SEARCH_STEPS) {
    // Decimal precision needs enough digits to key snapped grid points.
    const precision = Math.max(0, Math.ceil(-Math.log10(step))) + 3;
    // Snap helper prevents floating drift from creating duplicate grid nodes.
    const snap = (value) => Number(value.toFixed(precision));
    // Seed the search at the current symbolic angle pair.
    const queue = [{ x: snap(center.x), y: snap(center.y) }];
    // Track visited nodes at this precision only.
    const seen = new Set();
    // Bounds collect valid samples found at this precision.
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    // Count valid samples found at this precision.
    let validSamples = 0;
    // Count visited nodes at this precision.
    let stepVisits = 0;

    // Search a connected component of valid grid points around the current sample.
    while (queue.length > 0 && stepVisits < REGION_SEARCH_MAX_VISITS_PER_STEP) {
      // Shift gives BFS order; the bounded connected-component result is what matters.
      const node = queue.shift();
      // Build a stable key for this snapped x/y sample.
      const key = `${node.x.toFixed(precision)},${node.y.toFixed(precision)}`;
      // Skip repeated nodes produced by neighboring samples.
      if (seen.has(key)) continue;
      // Mark this grid node visited.
      seen.add(key);
      // Ignore nodes outside the current local search window.
      if (node.x < searchWindow.minX || node.x > searchWindow.maxX || node.y < searchWindow.minY || node.y > searchWindow.maxY) continue;
      // Count this as an evaluated visit.
      stepVisits++;
      // Count this across all precision steps for reporting.
      visits++;
      // Reject invalid samples without expanding their neighbors.
      if (!isCandidateValid(node.x, node.y, precision)) continue;
      // Count this valid sample.
      validSamples++;
      // Expand the valid x interval.
      bounds.minX = Math.min(bounds.minX, node.x);
      // Expand the valid x interval.
      bounds.maxX = Math.max(bounds.maxX, node.x);
      // Expand the valid y interval.
      bounds.minY = Math.min(bounds.minY, node.y);
      // Expand the valid y interval.
      bounds.maxY = Math.max(bounds.maxY, node.y);
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: snap(node.x + step), y: node.y });
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: snap(node.x - step), y: node.y });
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: node.x, y: snap(node.y + step) });
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: node.x, y: snap(node.y - step) });
    }

    // Mark the result as capped if this precision exhausted its visit allowance.
    if (queue.length > 0 && stepVisits >= REGION_SEARCH_MAX_VISITS_PER_STEP) capped = true;
    // Stop immediately if the current center is not valid at this precision.
    if (validSamples === 0) {
      // Return a no-region result with the precision that failed.
      return { status: 'none', message: `No valid connected region found at step ${step}.`, visits, capped };
    }

    // Store the best bounds from this precision.
    bestBounds = { ...bounds, step };
    // Restrict the next search to a narrow expansion around the latest valid component.
    searchWindow = {
      // Permit one coarse margin around the discovered component for boundary refinement.
      minX: bounds.minX - step,
      // Permit one coarse margin around the discovered component for boundary refinement.
      maxX: bounds.maxX + step,
      // Permit one coarse margin around the discovered component for boundary refinement.
      minY: bounds.minY - step,
      // Permit one coarse margin around the discovered component for boundary refinement.
      maxY: bounds.maxY + step
    };
  }

  // If every precision somehow failed to set bounds, report no region.
  if (!bestBounds) {
    // This is defensive because the loop normally returns earlier.
    return { status: 'none', message: 'No stable samples were found.', visits, capped };
  }

  // Convert closed grid sample bounds into open intervals by stepping just outside them.
  const intervals = {
    // Open x interval lower endpoint.
    xMin: bestBounds.minX - bestBounds.step,
    // Open x interval upper endpoint.
    xMax: bestBounds.maxX + bestBounds.step,
    // Open y interval lower endpoint.
    yMin: bestBounds.minY - bestBounds.step,
    // Open y interval upper endpoint.
    yMax: bestBounds.maxY + bestBounds.step
  };

  // Return the final bounded local region estimate.
  return { status: 'found', intervals, step: bestBounds.step, visits, capped };
};

// Restoring a saved workspace (see App()'s own restoredWorkspace) never
// restores mid-edit state: every row's draft fields are reset to match its
// applied fields exactly (as if freshly committed) and any validationError
// is cleared, so a reload never shows a stale "invalid" indicator or a
// half-typed draft the user never actually submitted. Defensive against a
// saved row missing a field entirely (an older/partial save, or a
// hand-edited localStorage value) by falling back to the same blank
// defaults createSequenceRow itself uses. Returns null (not an empty
// array) for anything that isn't a non-empty array, so callers can use
// `??` to fall back to the normal single-default-row startup state.
const normalizeRestoredSequences = (rawSequences) => {
  if (!Array.isArray(rawSequences) || rawSequences.length === 0) return null;
  return rawSequences.map((row, index) => {
    const sequenceText = typeof row?.sequenceText === 'string' ? row.sequenceText : '';
    const angleStepInput = typeof row?.angleStepInput === 'string' ? row.angleStepInput : '0.1';
    const angleA = row?.angleA ?? '';
    const angleB = row?.angleB ?? '';
    const rayAngleInput = typeof row?.rayAngleInput === 'string' ? row.rayAngleInput : '';
    return {
      id: row?.id || `seq-${index + 1}`,
      label: row?.label || `Graph ${index + 1}`,
      sequenceText,
      draftSequenceText: sequenceText,
      angleStepInput,
      draftAngleStepInput: angleStepInput,
      angleA,
      angleB,
      draftAngleA: angleA,
      draftAngleB: angleB,
      rayAngleInput,
      draftRayAngleInput: rayAngleInput,
      color: isValidHexColor(row?.color) ? row.color : colorForSequenceNumber(index + 1),
      visible: typeof row?.visible === 'boolean' ? row.visible : true,
      validationError: null,
      validationErrorSource: null,
      // Richer GraphDatabase-mirroring metadata (see createSequenceRow's own
      // comment) — same defensive fallback-to-blank-default treatment as
      // every other field above, for an older/partial save or a hand-edited
      // localStorage value.
      title: typeof row?.title === 'string' ? row.title : '',
      notes: typeof row?.notes === 'string' ? row.notes : '',
      tags: Array.isArray(row?.tags) ? row.tags.filter((tag) => typeof tag === 'string') : [],
      favorite: typeof row?.favorite === 'boolean' ? row.favorite : false,
      visibility: typeof row?.visibility === 'string' ? row.visibility : 'private',
    };
  });
};

// ==========================================
// MAIN APPLICATION COMPONENT
// ==========================================




// --- Graph Simulator View (Migrated from AnglePlotWindow) ---
// How many sequence rows may have an in-flight generation task running at
// once. Kept small: each task already time-slices itself to stay
// responsive, but every additional *simultaneous* task means each one gets
// a smaller share of the per-frame budget before the browser needs to
// paint, so a handful of rows all mid-render at once would make all of
// them feel slower rather than any one of them faster.
const MAX_CONCURRENT_SEQUENCE_JOBS = 2;
const WORKSPACE_REPORT_DEBOUNCE_MS = 600;

const emptyRowResult = () => ({ points: [], status: 'idle', renderInfo: null, progress: null, error: null });

// Maps a row's current state to the background exact job queue's priority
// (backgroundExactWorker.js's JOB_PRIORITY) for its brute-force sweep: a
// graph currently on screen is worth computing before one that's merely
// selected for the main canvas but hidden from the plot, which in turn
// beats a graph that was never plotted before this exact request but is
// otherwise hidden/unselected (a fresh, explicit "Plot" click deserves
// more urgency than some other, older hidden graph's re-request) — and any
// other hidden, non-selected, previously-requested graph is lowest.
// `everRequestedIds` is a session-lifetime Set (see everRequestedExactIdsRef
// below), not per-hash, so replotting the *same* row under a *different*
// hash later still correctly reads as HIDDEN rather than NEWLY_PLOTTED
// again.
const jobPriorityForSequence = (seq, activeSequenceId, everRequestedIds) => {
  if (seq.visible) return JOB_PRIORITY.VISIBLE;
  if (seq.id === activeSequenceId) return JOB_PRIORITY.SELECTED;
  if (!everRequestedIds.has(seq.id)) return JOB_PRIORITY.NEWLY_PLOTTED;
  return JOB_PRIORITY.HIDDEN;
};

// How long to wait, after this window's own state (position, size,
// minimize/maximize, view lock, or the shared panel's zoom/pan) last
// changed, before reporting it upward via onWorkspaceStateChange — kept
// separate from RENDER_DEBOUNCE_MS since this drives workspace
// persistence, not rendering, and can tolerate a slightly longer delay to
// keep autosave writes infrequent even during continuous dragging/zooming.

const GraphSimulatorView = ({
  sequences, activeSequenceId, angleParams, baseLength, buildValidateCandidateForSequence, resolveRowEffectiveSequenceText, refreshToken,
  onRowStatusChange, forceGenerateRequest, maxBounces,
  onShowAllGraphs, onHideAllGraphs, onToggleSequenceVisible, onSequenceColorChange, onRefreshVisible, onRemoveSequence, onSelectSequence,
  initialIsViewLocked, initialLegendCollapsed, initialFollowCursor,
  initialPanelZoom, initialPanelPan,
  onWorkspaceStateChange
}) => {
// Minimized collapses the whole window down to just its title bar (like a
  // normal OS window minimize) without closing it or losing any state —
  // every job/result/view setting below is untouched and reappears exactly
  // as it was on restore.
    // Maximized fills the available viewport (minus a small margin) instead
  // of the window's normal draggable/resizable box. `preMaximizeRef` holds
  // the pos/size to restore exactly on un-maximize, so toggling it off
  // never leaves the window at a different spot/size than before.
          // Keeps the maximized window filling the viewport if the browser window
  // itself is resized, instead of leaving it sized to the old viewport.
    // Closing this window unmounts it, which discards `results` (every
  // row's generated points) entirely — unlike minimizing, which keeps
  // everything and just hides the body. Confirmed once before actually
  // calling onClose, so that isn't lost by an accidental click.
    
  // Per-sequence-id render results/status. Never cleared on hide, only on delete.
  const [results, setResults] = useState({});
  const [isViewLocked, setIsViewLocked] = useState(() => initialIsViewLocked ?? false);
  const [legendCollapsed, setLegendCollapsed] = useState(() => initialLegendCollapsed ?? false);
  // "Follow Cursor": toggles the live hover coordinate readout on the Graph
  // Plot canvas (see AnglePlotPanel's own followCursor prop/hoverCoord) —
  // an explicit opt-in/out instead of it always tracking the cursor.
  const [followCursor, setFollowCursor] = useState(() => initialFollowCursor ?? true);
  // "Find Duplicates" scan result: null while nothing's been scanned yet
  // (or after being dismissed), { groupIds: [] } for "scanned, none found"
  // (still rendered as a brief banner so the click visibly did something),
  // { groupIds: [[id,...], ...] } for one or more duplicate sets. Row IDs
  // only, not row objects — see liveDuplicateGroups below for why.
  const [duplicateScanResult, setDuplicateScanResult] = useState(null);
  const panelRef = useRef(null);

  // Draw-order recency stack: oldest-selected id first, most-recently-
  // selected id last, so the actively selected graph draws on top of every
  // other one and the previously selected graph draws immediately behind
  // it (not just "somewhere behind" — see orderedVisibleSequences below,
  // which reads this list back-to-front for z-order). Tracks
  // activeSequenceId directly (not a click handler) so every way a row
  // becomes active — the legend, the sidebar card, adding/loading a new
  // row — all feed the same stack.
  // Adjusts state during render (React's documented pattern for "reset/
  // derive state when a prop changes" — same approach AnglePlotPanel.jsx
  // already uses for its own sizeSignature) rather than in a useEffect, so
  // the draw order below always reflects this same render's activeSequenceId
  // instead of lagging one render cycle behind it.
  const [selectionOrder, setSelectionOrder] = useState(() => (activeSequenceId ? [activeSequenceId] : []));
  if (activeSequenceId && selectionOrder[selectionOrder.length - 1] !== activeSequenceId) {
    setSelectionOrder((prev) => [...prev.filter((id) => id !== activeSequenceId), activeSequenceId]);
  }

  const currentPoint = { a: Number(angleParams.a), b: Number(angleParams.b) };

  // Live refs so job-scheduling callbacks always see the latest props
  // without needing them in dependency arrays (which would otherwise
  // re-fire effects on every parent render, since `sequences` and the
  // validator factory are new references each render — see
  // AnglePlotPanel's onViewChangeRef comment for the same pattern already
  // established in this module). Synced in an effect (not inline during
  // render) so render itself stays a pure read.
  const sequencesRef = useRef(sequences);
  const buildValidateCandidateForSequenceRef = useRef(buildValidateCandidateForSequence);
  const resolveRowEffectiveSequenceTextRef = useRef(resolveRowEffectiveSequenceText);
  const resultsRef = useRef(results);
  const onRowStatusChangeRef = useRef(onRowStatusChange);
  const onWorkspaceStateChangeRef = useRef(onWorkspaceStateChange);
  useEffect(() => {
    sequencesRef.current = sequences;
    buildValidateCandidateForSequenceRef.current = buildValidateCandidateForSequence;
    resolveRowEffectiveSequenceTextRef.current = resolveRowEffectiveSequenceText;
    resultsRef.current = results;
    onRowStatusChangeRef.current = onRowStatusChange;
    onWorkspaceStateChangeRef.current = onWorkspaceStateChange;
  }, [sequences, buildValidateCandidateForSequence, resolveRowEffectiveSequenceText, results, onRowStatusChange, onWorkspaceStateChange]);

  // Workspace persistence (see App.jsx's WorkspaceManager integration):
  // reports this window's own position/size/minimize/maximize/view-lock
  // state, plus the shared panel's zoom/pan (captured via handleViewChange
  // below — the panel itself owns that state, this window only mirrors
  // it), debounced so continuous dragging/zooming doesn't trigger a write
  // on every frame. panelViewRef starts from whatever was last restored,
  // so a workspace save that happens before the panel ever reports its own
  // view change (e.g. the window opens but nothing is dragged/zoomed) still
  // reports the correct, previously-restored view instead of some default.
  const panelViewRef = useRef({ panelZoom: initialPanelZoom, panelPan: initialPanelPan });
  const workspaceReportTimeoutRef = useRef(null);
  const scheduleWorkspaceReport = useCallback(() => {
    if (!onWorkspaceStateChangeRef.current) return;
    if (workspaceReportTimeoutRef.current) clearTimeout(workspaceReportTimeoutRef.current);
    workspaceReportTimeoutRef.current = setTimeout(() => {
      workspaceReportTimeoutRef.current = null;
      onWorkspaceStateChangeRef.current?.({
        isViewLocked, legendCollapsed, followCursor,
        panelZoom: panelViewRef.current.panelZoom, panelPan: panelViewRef.current.panelPan,
      });
    }, WORKSPACE_REPORT_DEBOUNCE_MS);
  }, [isViewLocked, legendCollapsed, followCursor]);
  useEffect(() => {
    scheduleWorkspaceReport();
  }, [scheduleWorkspaceReport]);
  useEffect(() => () => {
    if (workspaceReportTimeoutRef.current) clearTimeout(workspaceReportTimeoutRef.current);
  }, []);

  const debounceTimersRef = useRef({}); // id -> timeout handle
  const jobTaskRef = useRef({}); // id -> { promise, cancel }
  const jobRequestIdRef = useRef({}); // id -> number, bumped on every (re)start or cancel
  const runningIdsRef = useRef(new Set());
  // id -> unsubscribe function for that row's currently-pending background
  // exact job listener, and id -> the hash it's listening to (the latter
  // purely so stopListeningForBackgroundExact below can log whether this
  // row's unsubscribe was the one that actually cancelled the job, vs. one
  // of several subscribers on a still-wanted job). See
  // backgroundExactWorker.js's own module comment: since its last
  // subscriber's unsubscribe now cancels the underlying computation and
  // evicts it from the registry, calling this for a row that's being
  // edited/deleted/unmounted is what satisfies "an outdated computation
  // must immediately stop" — a job with other subscribers still keeps
  // running for them, untouched.
  const backgroundUnsubscribersRef = useRef({});
  const backgroundJobHashRef = useRef({});
  // Row ids that have ever made a background-exact request this session —
  // purely for jobPriorityForSequence's NEWLY_PLOTTED tier (see its own
  // comment above). Never cleared on delete: a deleted row's id isn't
  // reused, so a stale entry is inert, not a correctness risk.
  const everRequestedExactIdsRef = useRef(new Set());
  // Exact hashes already confirmed absent from BOTH the permanent local
  // GraphDatabase (localGraphDatabaseClient.js) and the shared PostgreSQL
  // library (remoteGraphRepository.js) this session — checked at most once
  // per hash so a row still on PREVIEW status doesn't re-query either one
  // on every pan/zoom-driven re-render (handleViewChange keeps
  // rescheduling non-EXACT rows exactly as before). A hash that later gets
  // saved by this same session's own background-exact completion never
  // needs this invalidated: that save's own local GraphCache.set happens
  // first, so any row sharing that hash hits GraphCache (STEP 2) before
  // ever reaching this set's check again.
  const remoteMissesRef = useRef(new Set());
  // Exact hashes this session has already attempted to upload — set the
  // moment an upload is attempted (not once it succeeds), so a hash shared
  // by several rows only ever triggers one upload call between them, even
  // though each row's own onResult callback fires when their shared
  // background job completes (see startBackgroundExact below).
  const uploadAttemptedHashesRef = useRef(new Set());
  const stopListeningForBackgroundExact = useCallback((id, label) => {
    const previousHash = backgroundJobHashRef.current[id];
    const unsubscribe = backgroundUnsubscribersRef.current[id];
    delete backgroundUnsubscribersRef.current[id];
    delete backgroundJobHashRef.current[id];
    if (!unsubscribe) return;
    const wasRunning = previousHash ? isExactComputationRunning(previousHash) : false;
    unsubscribe();
    if (import.meta.env?.DEV && wasRunning && previousHash && !isExactComputationRunning(previousHash)) {
      console.log(`Renderer: Background Exact cancelled (superseded) — ${label}`);
    }
  }, []);
  const pendingQueueRef = useRef([]); // [{ seq, viewState }]
  const lastViewStateRef = useRef(null);
  const prevSequenceSnapshotRef = useRef({}); // id -> { sequenceText, angleStepInput, visible }
  const lastRefreshTokenRef = useRef(refreshToken);
  // Deliberately initialized to null (never to forceGenerateRequest's
  // current token) even though this window can mount with a
  // forceGenerateRequest already set — clicking a row's "Plot Valid Angle
  // Region" button for the first time opens this window AND sets
  // forceGenerateRequest in the same click, so on that first mount the prop
  // already carries the token the effect below is supposed to detect as
  // new. Seeding the ref from the prop would make that initial token look
  // already-seen, and the effect would skip scheduling the very job the
  // click was meant to start.
  const lastForceGenerateTokenRef = useRef(null);

  // Mirrors each row's plot lifecycle out to App.jsx so a graph's card can
  // show "Not plotted / Calculating.../Plotted/Error" even while this
  // window itself is minimized or the card is scrolled off-screen in the
  // sidebar — this window is the only place `results` actually lives.
  const setRowResult = useCallback((id, patch) => {
    setResults((prev) => {
      const next = { ...(prev[id] || emptyRowResult()), ...patch };
      onRowStatusChangeRef.current?.(id, next);
      return { ...prev, [id]: next };
    });
  }, []);

  // Cancels a row's in-flight/queued job (if any) without touching its
  // cached points. Bumping the request id makes any already-in-flight
  // `.then` a no-op for the results write (still runs onDone to free the
  // concurrency slot) — this is what lets a hidden or deleted row's stale
  // completion never overwrite newer state.
  const cancelSequenceJob = useCallback((id) => {
    if (debounceTimersRef.current[id]) {
      clearTimeout(debounceTimersRef.current[id]);
      delete debounceTimersRef.current[id];
    }
    jobTaskRef.current[id]?.cancel();
    jobRequestIdRef.current[id] = (jobRequestIdRef.current[id] || 0) + 1;
    pendingQueueRef.current = pendingQueueRef.current.filter((job) => job.seq.id !== id);
    runningIdsRef.current.delete(id);
  }, []);

  // `startSequenceJob` closes over baseLength/activeSequenceId/currentPoint
  // and so gets a new identity whenever those change; `tryStartNextQueuedJob`
  // needs to always call the *current* one without itself needing to change
  // identity every time (it's called from cancelSequenceJob/finishSlot,
  // which do want a stable reference) — so it's read through a ref, same
  // pattern as sequencesRef/buildValidateCandidateForSequenceRef above.
  const startSequenceJobRef = useRef(null);

  const tryStartNextQueuedJob = useCallback(() => {
    while (runningIdsRef.current.size < MAX_CONCURRENT_SEQUENCE_JOBS && pendingQueueRef.current.length > 0) {
      const job = pendingQueueRef.current.shift();
      startSequenceJobRef.current(job.seq, job.viewState);
    }
  }, []);

  // Instant preview + silent background exact upgrade, now backed by a
  // shared PostgreSQL library (Phase 5)
  // -----------------------------------------------------------------------
  // STEP 1/2 (see the module's own architecture doc above the imports):
  // every request first checks GraphCache for this graph's EXACT (viewport-
  // independent) entry. A hit is used immediately and nothing is computed
  // at all — not adaptive, not a background job, not even a network call —
  // since the full, permanent answer already exists locally.
  // STEP 2b (new): on a local (browser) GraphCache miss, ask the two
  // server-side stores — the permanent local GraphDatabase
  // (localGraphDatabaseClient.js's fetchLocalExactGraph, the file-based
  // points.json cache) and the shared PostgreSQL library
  // (remoteGraphRepository.js's fetchRemoteExactGraph, never SQL directly —
  // see server/repositories/graphRepository.js for the only module that
  // executes any) — CONCURRENTLY (Promise.all), so a miss on both waits for
  // only the slower of the two, not their sum. Either one resolving is
  // enough: its points are written into GraphCache (so a replot, or a
  // different row sharing this hash, never asks again) and displayed
  // immediately, skipping adaptive and brute-force entirely — the whole
  // point of a permanent, content-addressed hash (requirement: a hash that
  // already has cached points must never be recomputed). A miss, timeout,
  // or any failure (API not running, database/disk unavailable) from
  // either check is indistinguishable from "not found" — see each client's
  // own comment — and simply falls through to STEP 3 exactly as if this
  // feature didn't exist, which is what keeps either store being
  // unavailable from ever breaking plotting. remoteMissesRef bounds this to
  // at most one check of each store per hash per session, so a row still on
  // PREVIEW status doesn't re-ask on every pan/zoom-driven re-render.
  // STEP 3: on a local *and* remote miss, the existing viewport-scoped
  // adaptive path runs exactly as before (own cache key, own generator, own
  // progress reporting) so the user sees *something* as fast as this app
  // has ever shown one, regardless of how expensive the exact sweep (or the
  // network round trip) would be.
  // STEP 4: once that preview is on screen, a background exact computation
  // is requested (backgroundExactWorker.js) — deduped by hash, so N rows
  // (or N re-renders of the same row) sharing one hash only ever pay for
  // one sweep between them. It reports no progress and never touches this
  // row's `status`/`progress` fields (those already read "done" from the
  // preview) — only `points`/`renderInfo` are swapped, silently, when it
  // resolves, which is what makes the exact result feel like a seamless
  // upgrade rather than a second visible loading cycle. See
  // backgroundExactWorker.isExactComputationRunning(hash) for how a future
  // "still refining…" indicator would read the in-between COMPUTING state
  // without this needing to push it into per-row state at all. When that
  // sweep finishes as a genuine, complete result (never cancelled — a
  // cancelled job's subscribers are already empty by the time it settles,
  // see backgroundExactWorker.js — and never timeLimited, since a sweep
  // truncated by MAX_BACKGROUND_EXACT_RENDER_MS is not the true exact
  // geometry for this permanent hash), it's uploaded to the shared library
  // the same way a download failure is handled: fire, log, never block or
  // break plotting if it fails.
  const startSequenceJob = useCallback(async (seq, viewState) => {
    runningIdsRef.current.add(seq.id);
    const requestId = (jobRequestIdRef.current[seq.id] = (jobRequestIdRef.current[seq.id] || 0) + 1);
    const parsed = parseAngleStep(seq.angleStepInput);

    const finishSlot = () => {
      runningIdsRef.current.delete(seq.id);
      tryStartNextQueuedJob();
    };

    if (!parsed.valid) {
      setRowResult(seq.id, { status: 'invalid', error: parsed.error, points: [] });
      finishSlot();
      return;
    }

    // This row's own effective Code Sequence — its typed code, or (for an
    // Angle-Ray-only row, where sequenceText is genuinely blank) the code
    // its own Angle Ray derives against its own committed Angle A/B. Used
    // for BOTH the validator and the identity hash below so an Angle-Ray-
    // only row's generation and its permanent hash always agree on the same
    // real code, instead of hashing/validating the blank sequenceText
    // directly (which made every candidate fail with "sequence is empty").
    const effectiveSequenceText = resolveRowEffectiveSequenceTextRef.current(seq.sequenceText, seq.rayAngleInput, { a: seq.angleA, b: seq.angleB, length: baseLength });
    const seqForIdentity = { ...seq, sequenceText: effectiveSequenceText };
    const validateCandidate = buildValidateCandidateForSequenceRef.current(effectiveSequenceText, { a: seq.angleA, b: seq.angleB, length: baseLength });
    const startedAt = performance.now();
    setRowResult(seq.id, { status: 'running', error: null, progress: { cellsChecked: 0, found: 0 } });

    // A graph's exact identity never depends on the viewport or on which
    // row happens to be active — see graphHasher.js's own comment on why
    // `excludePoint` (a display-only concern), like zoom/pan, is
    // deliberately excluded here even though the adaptive/preview cache key
    // below still includes it. This is also the permanent identifier a
    // future PostgreSQL-backed cache would look a graph up by (see
    // server/repositories/graphRepository.js), so every exact-identity hash
    // in this file goes through hashGraph, never a one-off computation.
    const exactHash = hashGraph(graphParamsFromSequence(seqForIdentity, baseLength));

    // STEP 2: an exact hit is final and needs nothing further — no
    // adaptive preview, no background job, no further cache writes.
    const cachedExact = graphCache.get(exactHash);
    if (cachedExact) {
      if (import.meta.env?.DEV) console.log(`Renderer: Cache Hit (exact) — ${seq.label} (${cachedExact.renderInfo.pointCount} points reused)`);
      setRowResult(seq.id, { points: cachedExact.points, status: 'done', renderInfo: { ...cachedExact.renderInfo, fromCache: true } });
      finishSlot();
      return;
    }

    // STEP 2b: no local (browser) exact entry — ask the permanent local
    // GraphDatabase and the shared PostgreSQL library concurrently before
    // falling back to adaptive/brute-force (see this function's own module
    // comment). Bounded to one check of each per hash per session via
    // remoteMissesRef; any failure (down, unreachable, timed out) is
    // indistinguishable from "not found" here, by each client's own design,
    // so this always safely falls through to STEP 3.
    if (!remoteMissesRef.current.has(exactHash)) {
      const [localResult, remoteResult] = await Promise.all([
        fetchLocalExactGraph(exactHash),
        fetchRemoteExactGraph(exactHash),
      ]);
      // This row may have been edited (or deleted/hidden) while the network
      // call was in flight — jobRequestIdRef's usual staleness guard (see
      // the adaptive task's own `.then` below) applies here too; a newer
      // invocation for this row already owns finishing it.
      if (jobRequestIdRef.current[seq.id] !== requestId) {
        finishSlot();
        return;
      }
      // Local (the permanent points.json cache) wins on a double hit — it's
      // this feature's own primary cache, and preferring it costs nothing
      // since both checks already ran concurrently.
      const cacheHit = localResult || remoteResult;
      if (cacheHit) {
        // primeExactGraphCache (exactGraphCaching.js) builds renderInfo and
        // writes GraphCache in one call — the same helper the Graph
        // Library's "Load Graph" action uses, so a cache-sourced graph's
        // cache entry has one shape regardless of which of the
        // ever-diverging call sites (or, now, which store) populated it.
        const renderInfo = primeExactGraphCache(exactHash, seq.angleStepInput, cacheHit);
        const source = localResult ? 'local GraphDatabase' : 'PostgreSQL';
        if (import.meta.env?.DEV) console.log(`Renderer: Cache Hit (${source}) — ${seq.label} (${cacheHit.points.length} points reused)`);
        setRowResult(seq.id, { points: cacheHit.points, status: 'done', renderInfo: { ...renderInfo, fromCache: true } });
        finishSlot();
        return;
      }
      remoteMissesRef.current.add(exactHash);
    }

    if (!viewState) {
      // No viewport reported yet (panel hasn't mounted/measured). This row
      // will be picked up by the next handleViewChange call once it does.
      finishSlot();
      return;
    }

    const excludePoint = seq.id === activeSequenceId ? currentPoint : undefined;

    // Kicks off (or joins) the background exact sweep for this graph once
    // a preview is already showing — shared by both the preview-cache-hit
    // path and the freshly-computed-preview path below so neither has to
    // duplicate this.
    const startBackgroundExact = () => {
      // Priority reflects this row's *current* state (visible/selected),
      // read fresh via sequencesRef rather than the closed-over `seq` —
      // this callback can run well after startSequenceJob was first
      // invoked (e.g. after a slow adaptive preview), by which time the
      // row's visibility or selection could have changed.
      const currentSeq = sequencesRef.current.find((s) => s.id === seq.id) ?? seq;
      const priority = jobPriorityForSequence(currentSeq, activeSequenceId, everRequestedExactIdsRef.current);
      everRequestedExactIdsRef.current.add(seq.id);

      // This row can be re-scheduled for reasons that never actually change
      // its exact hash — e.g. a view/fit change re-running the *adaptive*
      // preview after the panel auto-fits to a fresh (but content-identical)
      // result — and each of those still reaches this same point. If the
      // row is already subscribed to this exact hash's job, there is
      // nothing stale to cancel: unsubscribing and immediately
      // resubscribing here would needlessly cancel-and-restart an already-
      // correct, still-running (or still-queued) computation for no reason,
      // discarding whatever progress it had made. Its priority can still
      // have changed, though (e.g. the row just became visible), so that
      // gets refreshed either way. Only when the hash has genuinely changed
      // is the previous subscription actually stale.
      if (backgroundJobHashRef.current[seq.id] === exactHash) {
        updateBackgroundJobPriority(exactHash, priority);
        return;
      }
      // A previous background job this row was subscribed to (e.g. a
      // still-in-flight sweep for whatever this row's *last* configuration
      // was) is no longer relevant to this row once it's been replotted
      // under a new hash — stop listening to it, which cancels it outright
      // (or drops it from the queue if it hadn't started yet) if this row
      // was its only remaining subscriber (see backgroundExactWorker.js and
      // stopListeningForBackgroundExact above).
      stopListeningForBackgroundExact(seq.id, seq.label);
      const existedAlready = isExactComputationRunning(exactHash);
      const bgStartedAt = performance.now();
      let bgTimeLimited = false;
      const unsubscribe = requestExactComputation(
        exactHash,
        () => generateAngleRegion({
          validateCandidate, baseLength, scale: parsed.scale, stepUnits: parsed.stepUnits,
          maxRenderMs: MAX_BACKGROUND_EXACT_RENDER_MS,
          onProgress: (p) => { if (p.timeLimited) bgTimeLimited = true; },
        }),
        (points, error) => {
          if (error) {
            if (import.meta.env?.DEV) console.warn(`Renderer: Background Exact failed — ${seq.label}`, error);
            return;
          }
          const renderInfo = {
            renderer: RENDERER_MODE.BRUTE_FORCE, graphStatus: GRAPH_STATUS.EXACT,
            userStepDegrees: parsed.stepDegrees, gridStepDegrees: parsed.stepDegrees, requestedStepDegrees: parsed.stepDegrees,
            displayScale: displayScaleForStep(parsed.scale), pointCount: points.length,
            durationMs: performance.now() - bgStartedAt, budgetLimited: false, timeLimited: bgTimeLimited,
          };
          // This callback only ever runs for a job that reached a genuine
          // finish, not a cancelled one: if this row was the *only*
          // subscriber, editing/deleting it already cancelled and evicted
          // the job via stopListeningForBackgroundExact above, and a
          // cancelled job's subscriber set is empty by the time it settles
          // (see backgroundExactWorker.js), so this simply never fires for
          // it. Reaching here means either this row is still current, or a
          // *different* still-live row shares this exact hash — either way
          // the cache write below is safe and useful.
          graphCache.set(exactHash, { points, renderInfo });
          if (import.meta.env?.DEV) console.log(`Renderer: Background Exact complete — ${seq.label} (${points.length} points, ${renderInfo.durationMs.toFixed(0)}ms)`);
          // Save to the permanent local GraphDatabase AND upload to the
          // shared PostgreSQL library — but only once per hash per session
          // (uploadAttemptedHashesRef; a hash shared by several rows would
          // otherwise fire one save/upload attempt per subscriber, since
          // each gets its own onResult call for the same completed job —
          // see backgroundExactWorker.js), and only for a genuinely
          // complete sweep: `bgTimeLimited` means
          // MAX_BACKGROUND_EXACT_RENDER_MS cut this sweep short before it
          // covered the whole domain, so it is not the true exact geometry
          // for this permanent hash — persisting it would store a wrong
          // answer under a hash nothing can ever correct later. This is the
          // point this feature's own permanent cache is written: once
          // brute-force finishes (uncancelled, untruncated), its points
          // become the permanent cached version for this hash, so any
          // future request for it (this session or a later one) hits STEP
          // 2b instead of recomputing. Both calls are fire-and-forget from
          // this call site's perspective: neither ever throws or blocks the
          // UI (see localGraphDatabaseClient.js/remoteGraphRepository.js's
          // own comments), so a failed or slow save/upload can never affect
          // this row's already-displayed result.
          // Read fresh row state (title/color/notes/tags/favorite/
          // visibility can all have changed while this sweep was running)
          // for both the metadata save below and the display guard further
          // down — falls back to the closed-over `seq` if the row was
          // deleted in the meantime, matching startBackgroundExact's own
          // fresh-read pattern above.
          const currentSeqForSave = sequencesRef.current.find((s) => s.id === seq.id) ?? seq;
          if (!bgTimeLimited && !uploadAttemptedHashesRef.current.has(exactHash)) {
            uploadAttemptedHashesRef.current.add(exactHash);
            const graphParams = graphParamsFromSequence(seqForIdentity, baseLength);
            // The row's own richer metadata (title/color/notes/tags/
            // favorite/visibility) rides along to the local GraphDatabase
            // only — the PostgreSQL shared-library schema has no room for
            // it (see localGraphDatabaseClient.js's own comment), so
            // uploadRemoteExactGraph keeps its existing params/points-only
            // call unchanged.
            saveLocalExactGraph(graphParams, GRAPH_HASH_ALGORITHM_VERSION, points, renderInfo.durationMs, {
              title: currentSeqForSave.title, graphColorHex: currentSeqForSave.color, notes: currentSeqForSave.notes,
              tags: currentSeqForSave.tags, favorite: currentSeqForSave.favorite, visibility: currentSeqForSave.visibility,
              maxBounces,
            });
            uploadRemoteExactGraph(graphParams, GRAPH_HASH_ALGORITHM_VERSION, points, renderInfo.durationMs);
          }
          // Still guard the *display* update on this row's own current
          // params, since a shared job's result is only this row's to show
          // when it's actually still the row that asked for it.
          const currentSeq = sequencesRef.current.find((s) => s.id === seq.id);
          if (!currentSeq) return;
          const currentEffectiveSequenceText = resolveRowEffectiveSequenceTextRef.current(currentSeq.sequenceText, currentSeq.rayAngleInput, { a: currentSeq.angleA, b: currentSeq.angleB, length: baseLength });
          const currentHash = hashGraph(graphParamsFromSequence({ ...currentSeq, sequenceText: currentEffectiveSequenceText }, baseLength));
          if (currentHash !== exactHash) return;
          setRowResult(seq.id, { points, status: 'done', renderInfo });
        },
        priority,
      );
      backgroundUnsubscribersRef.current[seq.id] = unsubscribe;
      backgroundJobHashRef.current[seq.id] = exactHash;
      if (import.meta.env?.DEV) {
        // getBackgroundJobState is read *after* requestExactComputation, so
        // it reflects whatever the queue actually did with this request —
        // 'running' if a slot was free, 'queued' if both were already busy
        // with higher-or-equal priority work.
        const state = getBackgroundJobState(exactHash);
        console.log(existedAlready
          ? `Renderer: Background Exact joined (${state}) — ${seq.label}`
          : `Renderer: Background Exact ${state} — ${seq.label}`);
      }
    };

    // STEP 3: the existing adaptive, viewport-scoped preview path —
    // unchanged from before this feature, including its own cache key and
    // generator call. Keyed on the same effective code as the validator
    // above (not the possibly-blank seq.sequenceText), so two Angle-Ray-
    // only rows with different rays never collide on this key just because
    // they share a blank typed code.
    const previewCacheKey = buildGraphCacheKey({
      sequenceText: effectiveSequenceText, angleA: seq.angleA, angleB: seq.angleB,
      angleStepInput: seq.angleStepInput, baseLength, excludePoint,
      viewBounds: viewState.bounds, viewportSize: viewState.viewportSize,
    });
    const cachedPreview = graphCache.get(previewCacheKey);
    if (cachedPreview) {
      if (import.meta.env?.DEV) console.log(`Renderer: Cache Hit (preview) — ${seq.label} (${cachedPreview.renderInfo.pointCount} points reused)`);
      setRowResult(seq.id, { points: cachedPreview.points, status: 'done', renderInfo: { ...cachedPreview.renderInfo, fromCache: true } });
      finishSlot();
      startBackgroundExact();
      return;
    }
    if (import.meta.env?.DEV) console.log(`Renderer: Adaptive — ${seq.label}`);

    const task = generateVisibleAnglePoints({
      validateCandidate, baseLength, scale: parsed.scale, stepUnits: parsed.stepUnits,
      viewBounds: viewState.bounds, viewportSize: viewState.viewportSize, zoomLevel: viewState.zoomLevel,
      excludePoint,
      onProgress: (p) => {
        if (jobRequestIdRef.current[seq.id] !== requestId) return;
        setRowResult(seq.id, { progress: p });
      },
    });
    jobTaskRef.current[seq.id] = task;
    task.promise.then((result) => {
      if (jobRequestIdRef.current[seq.id] === requestId) {
        const renderInfo = {
          renderer: RENDERER_MODE.ADAPTIVE, graphStatus: GRAPH_STATUS.PREVIEW,
          zoomLevel: viewState.zoomLevel, userStepDegrees: parsed.stepDegrees, gridStepDegrees: result.effectiveStepDegrees,
          requestedStepDegrees: result.requestedStepDegrees, displayScale: displayScaleForStep(parsed.scale),
          pointCount: result.points.length, durationMs: performance.now() - startedAt,
          budgetLimited: result.budgetLimited, timeLimited: result.timeLimited,
        };
        // A genuinely cancelled/superseded job never reaches here at all —
        // the requestId check above already guards this whole block.
        graphCache.set(previewCacheKey, { points: result.points, renderInfo });
        setRowResult(seq.id, { points: result.points, status: 'done', renderInfo });
        finishSlot();
        startBackgroundExact();
      } else {
        finishSlot();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseLength, activeSequenceId, currentPoint.a, currentPoint.b, setRowResult, tryStartNextQueuedJob]);
  useEffect(() => {
    startSequenceJobRef.current = startSequenceJob;
  }, [startSequenceJob]);

  const enqueueSequenceJob = useCallback((seq, viewState) => {
    pendingQueueRef.current = pendingQueueRef.current.filter((job) => job.seq.id !== seq.id);
    pendingQueueRef.current.push({ seq, viewState });
    if (!runningIdsRef.current.has(seq.id)) tryStartNextQueuedJob();
  }, [tryStartNextQueuedJob]);

  const scheduleRenderForSequence = useCallback((seq, viewState, { immediate = false } = {}) => {
    if (debounceTimersRef.current[seq.id]) {
      clearTimeout(debounceTimersRef.current[seq.id]);
      delete debounceTimersRef.current[seq.id];
    }
    if (immediate) {
      enqueueSequenceJob(seq, viewState);
    } else {
      debounceTimersRef.current[seq.id] = setTimeout(() => {
        delete debounceTimersRef.current[seq.id];
        enqueueSequenceJob(seq, viewState);
      }, RENDER_DEBOUNCE_MS);
    }
  }, [enqueueSequenceJob]);

  // Diffs the incoming `sequences` prop against the last snapshot this
  // effect saw, and schedules a render only for rows whose sequence text,
  // Angle Step, or visibility actually changed (or that are brand new) —
  // this is the "don't regenerate every graph if only one row changed"
  // requirement. `refreshToken` bumps (mount, or the parent's
  // Generate/Refresh Plot button) force an immediate re-render of every
  // currently visible row, matching the original single-sequence behavior.
  //
  // The whole body runs inside a setTimeout(fn, 0), exactly like the
  // original single-sequence version's mount effect — not for a debounce
  // (RENDER_DEBOUNCE_MS handles that separately), but so React StrictMode's
  // development-only mount -> cleanup -> mount replay never gets a chance
  // to actually *start* a real generation task on the first (throwaway)
  // pass. Without this, that first pass calls scheduleRenderForSequence
  // synchronously, which starts a real generation task and stores
  // it in jobTaskRef; StrictMode's immediate replay-cleanup then cancels
  // that very task after only its first chunk, and the "result" that
  // resolves is an incomplete, near-empty point set — reproducible locally
  // by removing this deferral and watching a fresh exact-mode sweep finish
  // instantly with 0 points. Deferring past the synchronous double-invoke
  // window means the throwaway pass's cleanup only clears a pending
  // timeout (a no-op it was always safe to run twice), and the real task
  // only ever starts once, on the surviving pass.
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const prevSnapshot = prevSequenceSnapshotRef.current;
      const currentIds = new Set(sequences.map((s) => s.id));
      for (const id of Object.keys(prevSnapshot)) {
        if (!currentIds.has(id)) {
          cancelSequenceJob(id);
          // Unlike hiding a row (which keeps listening so an exact upgrade
          // still lands once it's shown again — see this effect's own
          // module comment), a deleted row is gone for good: stop listening
          // for its background exact job so a later-arriving result never
          // calls setResults for an id that no longer exists — and, if this
          // row was the job's last subscriber, this cancels the underlying
          // computation outright (see stopListeningForBackgroundExact and
          // backgroundExactWorker.js), satisfying "deleting a graph cancels
          // its brute-force computation."
          stopListeningForBackgroundExact(id, id);
          setResults((r) => {
            if (!(id in r)) return r;
            const next = { ...r };
            delete next[id];
            return next;
          });
        }
      }

      const isForcedRefresh = refreshToken !== lastRefreshTokenRef.current;
      lastRefreshTokenRef.current = refreshToken;

      const nextSnapshot = {};
      for (const seq of sequences) {
        const prevEntry = prevSnapshot[seq.id];
        // rayAngleInput is tracked alongside sequenceText — for an Angle-
        // Ray-only row (blank sequenceText), the ray is the only thing that
        // actually determines its effective code, so a ray-only edit must
        // count as "content changed" too, not just an edit to the typed
        // code/angles.
        nextSnapshot[seq.id] = { sequenceText: seq.sequenceText, rayAngleInput: seq.rayAngleInput, angleStepInput: seq.angleStepInput, visible: seq.visible, angleA: seq.angleA, angleB: seq.angleB };

        if (!seq.visible) {
          cancelSequenceJob(seq.id);
          continue;
        }

        const isNew = !prevEntry;
        const contentChanged = !isNew && (prevEntry.sequenceText !== seq.sequenceText || prevEntry.rayAngleInput !== seq.rayAngleInput || prevEntry.angleStepInput !== seq.angleStepInput || prevEntry.angleA !== seq.angleA || prevEntry.angleB !== seq.angleB);
        const justBecameVisible = !isNew && !prevEntry.visible;
        const hasCachedResult = !!resultsRef.current[seq.id] && resultsRef.current[seq.id].status === 'done';

        // `isNew` deliberately does NOT trigger a schedule on its own: every
        // graph now has its own "Plot Valid Angle Region" button (see
        // forceGenerateRequest below), so simply mounting this window (or a
        // brand-new row appearing in `sequences`) must never auto-compute
        // anything — otherwise clicking Plot on one card would also kick
        // off every *other* visible-but-never-plotted card the first time
        // the window opens, which is exactly the "recalculates graphs you
        // didn't ask for" behavior this feature must avoid. A row only
        // starts computing when its own button is pressed, its already-
        // tracked content changes, or an explicit global refresh happens.
        if (isForcedRefresh || contentChanged || (justBecameVisible && !hasCachedResult)) {
          scheduleRenderForSequence(seq, lastViewStateRef.current, { immediate: isForcedRefresh || contentChanged });
        }
        // justBecameVisible with a valid cached result and no content change: reuse the cache, no job scheduled.
      }
      prevSequenceSnapshotRef.current = nextSnapshot;
    }, 0);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequences, refreshToken]);

  // Per-graph "Plot Valid Angle Region" button (in each sequence card, not
  // just this window's own toolbar): forces exactly that one row to
  // (re)generate now, regardless of whether its inputs changed since last
  // time — replotting the same graph should still work, and still checks
  // the cache first via startSequenceJob's own cache lookup. Every other
  // row's job/results are untouched.
  useEffect(() => {
    if (!forceGenerateRequest || forceGenerateRequest.token === lastForceGenerateTokenRef.current) return;
    lastForceGenerateTokenRef.current = forceGenerateRequest.token;
    const seq = sequences.find((s) => s.id === forceGenerateRequest.id);
    if (!seq) return;
    scheduleRenderForSequence(seq, lastViewStateRef.current, { immediate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceGenerateRequest, sequences]);

  // Cancel every outstanding job on unmount so a closed window never calls
  // setState after it stops existing. Background exact jobs are stopped via
  // stopListeningForBackgroundExact, same as a row deletion: a hash with no
  // other subscriber left anywhere is cancelled outright (see
  // backgroundExactWorker.js); one still shared with another still-open
  // window/row is merely left running for that other subscriber.
  useEffect(() => () => {
    Object.keys(jobTaskRef.current).forEach((id) => jobTaskRef.current[id]?.cancel());
    Object.values(debounceTimersRef.current).forEach((t) => clearTimeout(t));
    Object.keys(backgroundUnsubscribersRef.current).forEach((id) => stopListeningForBackgroundExact(id, id));
  }, [stopListeningForBackgroundExact]);

  // AnglePlotPanel reports every zoom/pan/resize here, undebounced. Every
  // currently visible row gets a debounced re-render, since the adaptive
  // sampler's stride and sampled cells both depend on the current viewport.
  const handleViewChange = useCallback((viewState) => {
    lastViewStateRef.current = viewState;
    // Workspace persistence: AnglePlotPanel's onViewChange reports its own
    // raw zoom/pan alongside the derived zoomLevel/bounds it always has, so
    // this can just take them directly instead of reconstructing anything.
    panelViewRef.current = { panelZoom: viewState.zoom, panelPan: viewState.pan };
    scheduleWorkspaceReport();
    for (const seq of sequencesRef.current) {
      if (!seq.visible) continue;
      const parsed = parseAngleStep(seq.angleStepInput);
      if (!parsed.valid) continue;
      // An EXACT row's geometry is the full-domain brute-force sweep, which
      // never depends on the viewport — scheduling an adaptive re-render for
      // one here would only ever recompute a worse (preview) approximation
      // of an answer this row already has permanently, so skip it. A row
      // still on PREVIEW keeps re-rendering on every pan/zoom exactly as
      // before, since what's tractable to compute there depends on what's
      // currently on screen.
      if (resultsRef.current[seq.id]?.renderInfo?.graphStatus === GRAPH_STATUS.EXACT) continue;
      scheduleRenderForSequence(seq, viewState);
    }
  }, [scheduleRenderForSequence, scheduleWorkspaceReport]);
  // Build the drawable series list (visible rows only) and the aggregate status line.
  const visibleSequences = sequences.filter((s) => s.visible);
  // Draw order follows the selection recency stack (selectionOrder above):
  // the actively selected graph draws last (on top) of every other one,
  // and each previously selected graph draws immediately behind whichever
  // one was selected after it — a full most-recent-first stack, not just
  // "the active one is on top." Rows never selected this session keep
  // their original relative order at the very bottom (least recent).
  const neverSelectedVisible = visibleSequences.filter((s) => !selectionOrder.includes(s.id));
  const selectedVisibleInRecencyOrder = selectionOrder
    .map((id) => visibleSequences.find((s) => s.id === id))
    .filter(Boolean);
  const orderedVisibleSequences = [...neverSelectedVisible, ...selectedVisibleInRecencyOrder];
  const series = orderedVisibleSequences.map((seq) => {
    const result = results[seq.id] || emptyRowResult();
    return {
      id: seq.id, label: seq.label, color: seq.color, sequenceText: seq.sequenceText,
      angleStepInput: seq.angleStepInput, points: result.points || [],
      gridStepDegrees: result.renderInfo?.gridStepDegrees, displayScale: result.renderInfo?.displayScale ?? 1,
      status: result.status,
      // This row's own committed Angle A/B — the exact point AnglePlotPanel
      // marks (in a color contrasting this series' own dot color), distinct
      // from the plotted region itself.
      angleA: seq.angleA, angleB: seq.angleB,
    };
  });
  const totalPoints = series.reduce((sum, s) => sum + s.points.length, 0);
  const calculatingCount = visibleSequences.filter((seq) => (results[seq.id] || emptyRowResult()).status === 'running').length;
  const summaryLine = visibleSequences.length === 0
    ? 'No visible graphs'
    : `${visibleSequences.length} visible graph${visibleSequences.length === 1 ? '' : 's'} · ${totalPoints.toLocaleString()} total displayed point${totalPoints === 1 ? '' : 's'}${calculatingCount > 0 ? ` · ${calculatingCount} calculating` : ''}`;

  const rowStatusText = (seq) => {
    if (!seq.visible) return 'Hidden';
    const parsed = parseAngleStep(seq.angleStepInput);
    if (!parsed.valid) return `Invalid: ${parsed.error}`;
    const result = results[seq.id] || emptyRowResult();
    if (result.status === 'invalid') return `Invalid: ${result.error}`;
    if (result.status === 'running') {
      const p = result.progress;
      return `Calculating… ${(p?.cellsChecked || 0).toLocaleString()} checked`;
    }
    if (result.status === 'idle') return 'Waiting to generate…';
    return `${(result.points.length || 0).toLocaleString()} points`;
  };

  // "Find Duplicates": audits every current row at once (not just one row
  // against the rest at plot time — see findExactDuplicateSequence) and
  // surfaces the result, whether that's "none found" or one or more
  // duplicate sets — see the duplicateScanResult banner/panel below. Stores
  // row IDs only (not the row objects themselves) — liveDuplicateGroups
  // below re-resolves those IDs against the current `sequences` on every
  // render, so deleting (or editing away) a row out of a group updates the
  // panel immediately instead of leaving a stale reference to a row that no
  // longer exists.
  const handleFindDuplicates = () => {
    setDuplicateScanResult({ groupIds: findDuplicateGroups(sequences).map((group) => group.map((row) => row.id)) });
  };
  const liveDuplicateGroups = duplicateScanResult
    ? duplicateScanResult.groupIds
        .map((ids) => ids.map((id) => sequences.find((row) => row.id === id)).filter(Boolean))
        .filter((group) => group.length > 1)
    : null;

  return (
    <div className="flex flex-col h-full w-full overflow-hidden select-none bg-[#070b10]">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <div className="flex bg-[#101820]/95 rounded-md border border-white/10 overflow-hidden">
          <button type="button" onClick={() => panelRef.current?.zoomIn()} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Zoom In">
            <ZoomIn className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold">Zoom In</span>
          </button>
          <button type="button" onClick={() => panelRef.current?.zoomOut()} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Zoom Out">
            <ZoomOut className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold">Zoom Out</span>
          </button>
          <button type="button" onClick={() => panelRef.current?.fitToPoints()} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Fit View">
            <Maximize className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold">Fit View</span>
          </button>
          <button
            type="button"
            onClick={() => activeSequenceId && panelRef.current?.fitToSeries(activeSequenceId)}
            disabled={!activeSequenceId}
            className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-300"
            title="Zoom the view to fit only the currently selected graph's own plotted region, ignoring every other graph"
          >
            <Focus className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold">Zoom Into Graph</span>
          </button>
          <button type="button" onClick={() => panelRef.current?.resetToDefaultView()} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Reset View">
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold">Reset</span>
          </button>
          <button
            type="button"
            onClick={() => setIsViewLocked((locked) => !locked)}
            className={`px-2.5 py-2 transition-colors flex items-center gap-1.5 ${isViewLocked ? 'bg-cyan-500/20 text-cyan-200' : 'hover:bg-[#172230] text-slate-300 hover:text-cyan-200'}`}
            title={isViewLocked ? 'Unlock View' : 'Lock View'}
          >
            {isViewLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            <span className="text-[10px] font-bold">{isViewLocked ? 'Unlock View' : 'Lock View'}</span>
          </button>
          <button
            type="button"
            onClick={() => setFollowCursor((on) => !on)}
            className={`px-2.5 py-2 transition-colors flex items-center gap-1.5 border-l border-white/10 ${followCursor ? 'bg-cyan-500/20 text-cyan-200' : 'hover:bg-[#172230] text-slate-300 hover:text-cyan-200'}`}
            title={followCursor ? 'Coordinates follow the cursor while hovering — click to turn off' : 'Turn on to show live A/B coordinates following the cursor while hovering'}
          >
            <Crosshair className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold">Follow Cursor</span>
          </button>
          <button
            type="button"
            onClick={onRefreshVisible}
            className="px-2.5 py-2 transition-colors flex items-center gap-1.5 border-l border-white/10 hover:bg-[#172230] text-slate-300 hover:text-cyan-200"
            title="Replot every visible graph now — fast adaptive preview first, brute-force exact result following, in case a plot isn't showing for some reason"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold">Refresh</span>
          </button>
        </div>
      </div>

      {/* Status */}
      <div className="px-3 py-1.5 border-b border-white/10 shrink-0 text-[11px] font-mono text-slate-400 whitespace-nowrap overflow-x-auto">
        {summaryLine}
      </div>
      <div className="h-1 bg-[#0c1117] shrink-0 overflow-hidden">
        {calculatingCount > 0 && <div className="h-full w-1/3 bg-cyan-400/70 animate-pulse" />}
      </div>

      {/* Legend */}
      <div className="border-b border-white/10 shrink-0">
        <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          <button
            type="button"
            onClick={() => setLegendCollapsed((c) => !c)}
            className="flex items-center gap-1.5 hover:text-slate-200 transition-colors"
          >
            <span>Legend ({sequences.length})</span>
            <span className="font-normal text-[9px] text-slate-500">({legendCollapsed ? 'Show' : 'Hide'})</span>
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onShowAllGraphs}
              className="flex items-center gap-1 rounded-md border border-cyan-400/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-bold text-cyan-100 transition-colors hover:bg-cyan-500/30"
              title="Show all graphs in the plot"
            >
              <Eye className="w-3 h-3" /> Show All
            </button>
            <button
              type="button"
              onClick={onHideAllGraphs}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b1016] px-2 py-0.5 text-[10px] font-bold text-slate-300 transition-colors hover:bg-[#172230]"
              title="Hide all graphs from the plot"
            >
              <EyeOff className="w-3 h-3" /> Hide All
            </button>
            <button
              type="button"
              onClick={handleFindDuplicates}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b1016] px-2 py-0.5 text-[10px] font-bold text-slate-300 transition-colors hover:bg-[#172230]"
              title="Scan every graph for identical Code Sequence + Angle A/B combinations"
            >
              <Search className="w-3 h-3" /> Find Duplicates
            </button>
          </div>
        </div>
        {/* Find Duplicates result: a brief dismissible banner for "none
            found", or a per-group list (each row gets Jump To/Delete) for
            one or more duplicate sets — shown regardless of the legend's
            own collapsed state, since this is its own independent report. */}
        {liveDuplicateGroups && liveDuplicateGroups.length === 0 && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] bg-emerald-500/10 border-t border-emerald-300/20 text-emerald-100">
            <span>No duplicate graphs found.</span>
            <button type="button" onClick={() => setDuplicateScanResult(null)} className="text-emerald-300 hover:text-emerald-100 font-bold">
              Dismiss
            </button>
          </div>
        )}
        {liveDuplicateGroups && liveDuplicateGroups.length > 0 && (
          <div className="border-t border-amber-300/20 bg-amber-500/10 px-3 py-2 max-h-40 overflow-y-auto custom-scrollbar">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-200">
                {liveDuplicateGroups.length} duplicate set{liveDuplicateGroups.length === 1 ? '' : 's'} found
              </span>
              <button type="button" onClick={() => setDuplicateScanResult(null)} className="text-[10px] font-bold text-amber-300 hover:text-amber-100">
                Dismiss
              </button>
            </div>
            <div className="space-y-1.5">
              {liveDuplicateGroups.map((group, groupIdx) => (
                <div key={groupIdx} className="rounded-md border border-amber-300/20 bg-[#0b1016] px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wider text-amber-300/80 font-bold mb-1">
                    Group {groupIdx + 1} · &ldquo;{truncateSequenceText(group[0].sequenceText, 20)}&rdquo; · A={group[0].angleA} B={group[0].angleB}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.map((row) => (
                      <div key={row.id} className="flex items-center gap-1 rounded border border-white/10 bg-[#151c24] pl-2 pr-1 py-0.5 text-[10px]">
                        <span className="font-bold text-slate-200">{row.label}</span>
                        <button
                          type="button"
                          onClick={() => onSelectSequence?.(row.id)}
                          className="text-cyan-300 hover:text-cyan-100 font-bold px-1"
                          title={`Select ${row.label} and jump to its card`}
                        >
                          Jump To
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveSequence?.(row.id)}
                          className="text-red-300 hover:text-red-100 font-bold px-1"
                          title={`Delete ${row.label}`}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!legendCollapsed && (
          <div className="flex flex-wrap content-start gap-1.5 px-3 pb-2 h-24 overflow-y-auto custom-scrollbar">
            {sequences.map((seq) => {
              // Legend text always reflects the code actually driving this
              // graph — its own typed code, or (for an Angle-Ray-only row)
              // the code its own ray derives — never the possibly-blank
              // seq.sequenceText directly, so an angle-driven graph never
              // misleadingly reads "(empty)" here.
              const effectiveSequenceText = resolveRowEffectiveSequenceText(seq.sequenceText, seq.rayAngleInput, { a: seq.angleA, b: seq.angleB, length: baseLength });
              return (
              <div
                key={seq.id}
                onClick={() => onSelectSequence?.(seq.id)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSequence?.(seq.id); } }}
                title={`${seq.label}: ${effectiveSequenceText || '(empty)'} · Step ${seq.angleStepInput} · ${seq.id === activeSequenceId ? 'active in main view · ' : ''}${rowStatusText(seq)} · Click to select and jump to this graph's card`}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-mono transition-colors cursor-pointer ${seq.id === activeSequenceId ? 'border-amber-400/60 bg-amber-500/20 text-amber-100' : seq.visible ? 'border-white/10 bg-[#0b1016] text-slate-200' : 'border-white/10 bg-[#0b1016]/60 text-slate-400 opacity-80'}`}
              >
                <input
                  type="checkbox"
                  checked={seq.visible}
                  onChange={() => onToggleSequenceVisible?.(seq.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Show ${seq.label} in the graph`}
                  title={seq.visible ? `Hide ${seq.label} from the graph` : `Show ${seq.label} in the graph`}
                  className="w-3.5 h-3.5 shrink-0 accent-cyan-400 cursor-pointer"
                />
                <input
                  type="color"
                  value={seq.color}
                  onChange={(e) => onSequenceColorChange?.(seq.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`${seq.label} graph color`}
                  title={`Choose ${seq.label}'s dot/legend color`}
                  style={{ opacity: seq.visible ? 1 : 0.5 }}
                  className="w-3 h-3 shrink-0 rounded-full border border-black/30 p-0 bg-transparent cursor-pointer appearance-none overflow-hidden"
                />
                <span className="font-bold shrink-0">{seq.label}{seq.id === activeSequenceId ? ' •' : ''}</span>
                <span className={seq.visible ? 'text-slate-400' : 'text-slate-500'}>&ldquo;{truncateSequenceText(effectiveSequenceText, 16)}&rdquo;</span>
                <span className={seq.visible ? 'text-slate-400' : 'text-slate-500'}>step {seq.angleStepInput}</span>
                <span className="text-slate-500">{rowStatusText(seq)}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRemoveSequence?.(seq.id); }}
                  title={`Delete ${seq.label}`}
                  aria-label={`Delete ${seq.label}`}
                  className="shrink-0 text-slate-500 hover:text-red-300 p-0.5"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Graph */}
      <div className="flex-1 min-h-0 min-w-0 p-3 bg-white">
        <AnglePlotPanel
          ref={panelRef}
          series={series}
          currentPoint={currentPoint}
          isLocked={isViewLocked}
          followCursor={followCursor}
          onViewChange={handleViewChange}
          initialZoom={initialPanelZoom}
          initialPan={initialPanelPan}
        />
      </div>
    </div>
  );
};


export default function App() {
  // --- WORKSPACE RESTORE ---
  // Loaded exactly once (useState's initializer runs only on the very first
  // render — see WorkspaceManager's own doc comment on why this is safe
  // even under StrictMode's double-invoke). null when there is nothing
  // saved yet (first visit, storage disabled, or a corrupt payload —
  // WorkspaceManager itself collapses all of those to null), in which case
  // every piece of state below falls back to exactly the default it always
  // had. Every `restoredWorkspace?.x ?? default` below is this feature's
  // entire "restore" half; the "save" half is buildWorkspaceSnapshot/the
  // autosave effect, further down.
  const [restoredWorkspace] = useState(() => loadWorkspace());

  // --- APP STATE VARIABLES ---
  // Light mode is the default; a saved theme choice is honored after the user picks one.
  const [theme, setTheme] = useState(() => (restoredWorkspace?.theme === 'dark' ? 'dark' : 'light'));
  // A boolean keeps toggle rendering readable.
  const isDarkTheme = theme === 'dark';
  // SVG presentation attributes need direct palette values.
  const themePalette = THEME_PALETTES[theme];
  // Hides the whole left sidebar to give the canvas full width. A floating
  // button takes its place when hidden, so it's always reachable again.
  const [isSidebarVisible, setIsSidebarVisible] = useState(() => restoredWorkspace?.isSidebarVisible ?? true);
  // Two modes share the same viewer: geometric ray tracing and code unfolding.
  const [simulatorMode, setSimulatorMode] = useState(() => (
    // 'ray' was a separate tab in older saved workspaces, since merged into
    // 'code' (a graph's Angle Ray now lives beside its own Code
    // Sequence) — fall back to 'code' so a restored save never lands on a
    // mode that no longer exists.
    restoredWorkspace?.simulatorMode === 'graph' ? 'graph' : 'code'
  ));
  // The base triangle can be entered as coordinates or as two angles plus length.
  const [baseInputMode, setBaseInputMode] = useState(() => restoredWorkspace?.baseInputMode ?? 'angles');
  // Base length is the only piece of the old "angleParams" that is still
  // genuinely shared across every row — Angle A/B now live per-row (see
  // `sequences` below) so each row can have its own main-canvas point.
  const [baseTriangleLength, setBaseTriangleLength] = useState(() => restoredWorkspace?.baseTriangleLength ?? 10);
  // Increment for the Angle A/B number-stepper arrows, and the default
  // Angle Step given to newly-added sequences. No longer user-editable (the
  // visible "A/B Spinner" control was removed as confusing); fixed at its
  // default rather than left as dead state.
  const angleIncrementInput = String(DEFAULT_ANGLE_INCREMENT);
  // Native spinner-arrow increment shared by every card's Angle Step field
  // (and Graph Setup's). Editable again in both places — same single
  // shared value/behavior as the old top-level "Step Increment" field, just
  // relocated next to each card's own Angle Step instead of living at the
  // top of the sidebar.
  const [angleStepControlIncrementInput, setAngleStepControlIncrementInput] = useState(() => restoredWorkspace?.angleStepControlIncrementInput ?? String(DEFAULT_ANGLE_STEP_CONTROL_INCREMENT));
  // Coordinate defaults create a right-ish triangle for immediate manual testing.
  const [baseCoordsInput, setBaseCoordsInput] = useState(() => (
    Array.isArray(restoredWorkspace?.baseCoordsInput) && restoredWorkspace.baseCoordsInput.length === 3
      ? restoredWorkspace.baseCoordsInput
      : [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]
  ));

  // A Angle Ray (per-row, see rayAngleInput on the sequence row
  // model) is traced from vertex A every time — no separate Origin Vertex
  // choice. Max Bounces stays a single shared safety cap (like Base Length)
  // rather than a per-row value, since it bounds computation rather than
  // describing any one graph's own shot.
  const [maxBounces, setMaxBounces] = useState(() => restoredWorkspace?.maxBounces ?? 300);
  // Bumped by the Graph Plot toolbar's own "Refresh" button — GraphSimulatorView
  // treats any change to this as "replot every currently visible graph now"
  // (see its own refreshToken effect), exactly like its Generate/Refresh
  // Plot button always could; this just exposes that existing mechanism
  // through a visible button instead of leaving refreshToken permanently at 0.
  const [graphPlotRefreshToken, setGraphPlotRefreshToken] = useState(0);

  // --- CODE UNFOLDER SPECIFIC STATE ---
  // Desmos-style sequence list: each row is one independent bounce-code
  // unfolding (its own text, Angle Step, color, visibility). The row that
  // was previously the app's only sequence becomes "Graph 1" here so no
  // existing work is lost when this feature is introduced. A ref (not
  // state) tracks the next creation number so labels/colors stay stable
  // and never renumber when an earlier row is deleted. initialSequences is
  // its own (lazy, one-time) state purely so both nextSequenceNumberRef and
  // `sequences` below can read the exact same resolved array without
  // normalizing the restored data twice.
  const [initialSequences] = useState(() => (
    normalizeRestoredSequences(restoredWorkspace?.sequences)
    ?? [createSequenceRow({ number: 1, sequenceText: "3 1 7 2 6 2 8 2 4 2", angleStepInput: String(DEFAULT_ANGLE_INCREMENT), angleA: 15, angleB: 50 })]
  ));
  const nextSequenceNumberRef = useRef(Math.max(restoredWorkspace?.nextSequenceNumber ?? 2, initialSequences.length + 1));
  const [sequences, setSequences] = useState(initialSequences);
  // The active row drives the main unfolding canvas, the Angle A/B guarded
  // edits, and the Constrained/Unconstrained/Search tools below — exactly what
  // `billiardsCode` alone used to drive before this row list existed.
  // Falls back to the first restored row if the saved active id doesn't
  // match any restored row (e.g. that row was since deleted in a save this
  // version of the app no longer recognizes).
  const [activeSequenceId, setActiveSequenceId] = useState(() => (
    initialSequences.some((row) => row.id === restoredWorkspace?.activeSequenceId)
      ? restoredWorkspace.activeSequenceId
      : initialSequences[0].id
  ));
  const activeSequence = sequences.find(s => s.id === activeSequenceId) || sequences[0];
  // `angleParams` is derived, not stored: Angle A/B come from whichever row
  // is active (so the main canvas always reflects that row's own angles)
  // while base length stays the one value every row shares. Every existing
  // reader of `angleParams` (buildBaseTriangle, the guarded-edit
  // validators, findStableRegion, etc.) keeps working unchanged against
  // this same {a, b, length} shape.
  const angleParams = useMemo(() => ({
    a: activeSequence?.angleA ?? 15,
    b: activeSequence?.angleB ?? 50,
    length: baseTriangleLength,
  }), [activeSequence, baseTriangleLength]);
  // Constrained rejects invalid guarded edits; Unconstrained allows invalid inspection.
  const [shotEditMode, setShotEditMode] = useState(() => (restoredWorkspace?.shotEditMode === SHOT_MODE_UNCONSTRAINED ? SHOT_MODE_UNCONSTRAINED : SHOT_MODE_LOCKED));
  // Epsilon is stored as text so scientific notation remains editable.
  const [clearanceEpsilonInput, setClearanceEpsilonInput] = useState(() => restoredWorkspace?.clearanceEpsilonInput ?? String(DEFAULT_CLEARANCE_EPSILON));
  // A rejected locked edit reports what was blocked without changing geometry.
  const [lockedShotNotice, setLockedShotNotice] = useState(null);
  // Plain-English pop-up for a rejected sequence/angle apply: { title, message, focusId }.
  const [errorModal, setErrorModal] = useState(null);
  // Yes/no confirmation shown when Plot Valid Angle Region would plot a
  // Code Sequence + Angle A/B combination that's already an existing row —
  // { id: the row about to be plotted, matchLabel: the existing row's own
  // label ("Graph 2") it exactly matches }. null when nothing is pending.
  const [duplicateSequenceConfirm, setDuplicateSequenceConfirm] = useState(null);
  // Sequence-text <input> elements by row id, so the error modal can return
  // focus to the exact row that was rejected once it's dismissed.
  const sequenceInputRefsRef = useRef({});
  // Which row's Angle Ray field is currently focused, if any — while
  // focused, that field shows the raw draft being typed (see the field's
  // own value expression) so numbers don't jump under the user's cursor;
  // at rest it always mirrors Global Angle, per the root-cause note there.
  const [focusedRayAngleRowId, setFocusedRayAngleRowId] = useState(null);
  // Which row's Code Sequence field is currently focused, if any — mirrors
  // focusedRayAngleRowId above: while focused, that field shows the raw
  // draft being typed (so a click-to-type doesn't start from pre-filled
  // text); at rest, an angle-driven row's field shows its own Angle Ray's
  // derived code instead of staying blank (see showComputedSequenceText).
  const [focusedSequenceRowId, setFocusedSequenceRowId] = useState(null);
  // The graph-card list's own scroll container, so a newly added card can
  // be scrolled into view automatically instead of requiring a manual
  // scroll to find it below the existing cards.
  const sequenceListRef = useRef(null);
  const prevSequenceCountRef = useRef(0);
  // Per-row card DOM nodes, so selecting a row from the Graph Plot legend
  // (see handleSelectSequenceAndScrollToCard) can scroll that exact card
  // into view here too, not just make it active — the legend and this list
  // are both visible at once, but the card can easily be scrolled off-screen.
  const sequenceCardRefsRef = useRef({});
  useEffect(() => {
    // Only scroll when a graph was actually *added* (the count grew) — new
    // rows are always appended at the end, so scrolling this container to
    // its bottom reveals the new one. Never fires on delete/edit, since
    // the count either shrinks or stays the same for those.
    if (sequences.length > prevSequenceCountRef.current && sequenceListRef.current) {
      sequenceListRef.current.scrollTop = sequenceListRef.current.scrollHeight;
    }
    prevSequenceCountRef.current = sequences.length;
  }, [sequences.length]);
  // The latest stable-region search result is shown until inputs change.
  const [stableRegionResult, setStableRegionResult] = useState(null);
  // unconstrained mode compares edits against the constrained path captured when Unconstrained starts.
  const [shotPathReference, setShotPathReference] = useState(null);
  // Persistent labels are useful for debugging dense unfolded fans.
  const [showAllLabels, setShowAllLabels] = useState(() => restoredWorkspace?.showAllLabels ?? false);
  // Display decimals are editable text so the field can be cleared/retyped without fighting React.
  const [displayPrecisionInput, setDisplayPrecisionInput] = useState(() => restoredWorkspace?.displayPrecisionInput ?? String(DEFAULT_DISPLAY_DECIMALS));
  // Controls whether the "Valid Angle A-B Region" pop-up is mounted.
  // This window's own position/size/minimize/maximize/view-lock state, plus
  // the shared panel's zoom/pan — a ref (not state) since App.jsx never
  // needs to re-render when these change; it only needs the latest values
  // on hand when building a workspace snapshot to save, and to pass down as
  // AnglePlotWindow's initial* props the one time it (re)mounts. Restored
  // once from the saved workspace; kept current via AnglePlotWindow's own
  // onWorkspaceStateChange callback (see its render call below).
  const anglePlotWindowStateRef = useRef(restoredWorkspace?.anglePlotWindow ?? null);
  // Graph Setup is an optional multi-row editor; it shares the existing row
  // model and never replaces the sidebar's established active-row workflow.
  const [isGraphSetupOpen, setIsGraphSetupOpen] = useState(false);
  // Graph Library: browse/search the shared PostgreSQL library and load a
  // previously-computed graph into a brand-new row. Not persisted across
  // reloads (matching isGraphSetupOpen's own choice) — it's an optional
  // browsing tool, not part of "the workspace" being restored.
  const [isGraphLibraryOpen, setIsGraphLibraryOpen] = useState(false);
  // Graph Database: the fuller browser for the local, file-based
  // GraphDatabase — same "not part of the restored workspace" treatment as
  // isGraphLibraryOpen, and a completely separate panel/store from it (see
  // GraphDatabasePanel.jsx's own module comment on why rename/delete/
  // favorite/tags/notes only make sense for this single-user local library,
  // not the multi-user shared one).
  const [isGraphDatabaseOpen, setIsGraphDatabaseOpen] = useState(false);
  // Row ids currently mid-way through an explicit "Save Graph" click (see
  // handleSaveGraphNow) — drives that row's own button showing "Saving…"
  // and being disabled. Never persisted: a save either finishes or fails
  // within seconds, so there's nothing meaningful to restore across a reload.
  const [savingGraphIds, setSavingGraphIds] = useState(() => new Set());
  // A small, transient success/failure banner for "Save Graph" — this app
  // has no existing toast system to reuse, so this is the one new small
  // piece of UI state the button needs. Auto-dismisses itself; see
  // showSaveToast/saveToastTimeoutRef below.
  const [saveToast, setSaveToast] = useState(null); // { message, isError } | null
  const saveToastTimeoutRef = useRef(null);
  // Bumped on every "Plot Valid Angle Region" click so an already-open window
  // regenerates and comes to the front instead of a duplicate window opening.
  // Per-row plot lifecycle, mirrored out of AnglePlotWindow (the only place
  // `results` actually lives) so each graph's own card can show its status
  // ("Not plotted"/"Calculating…"/"Plotted"/"Error") even while that window
  // is closed, minimized, or the card is scrolled elsewhere in the sidebar.
  const [plotStatusById, setPlotStatusById] = useState({});
  // A graph card's own "Plot Valid Angle Region" button sets this to force
  // *only* that row to (re)generate now, independent of whichever row is
  // active and without touching any other row's already-plotted geometry.
  const [forceGenerateRequest, setForceGenerateRequest] = useState(null);
  // A plain incrementing counter (not Date.now()) so token generation stays
  // a pure, synchronous ref mutation rather than calling an impure API from
  // code reachable during render.
  const forceGenerateTokenRef = useRef(0);

  // --- VIEWPORT & INTERACTION STATE ---
  // Ref to the canvas container lets us measure available SVG pixels.
  const containerRef = useRef(null); 
  // SVG size mirrors the measured container and drives viewport math.
  const [svgSize, setSvgSize] = useState({ width: 800, height: 600 }); 
  // Pan stores the mathematical coordinate at the center of the canvas.
  const [pan, setPan] = useState(() => restoredWorkspace?.pan ?? { x: 5, y: 4 });
  // Zoom stores pixels per mathematical unit.
  const [zoom, setZoom] = useState(() => restoredWorkspace?.zoom ?? 35);
  // When locked, trackpad/mouse-wheel gestures no longer change zoom (avoids accidental large jumps).
  const [isZoomLocked, setIsZoomLocked] = useState(() => restoredWorkspace?.isZoomLocked ?? false);
  // User-entered multiplier applied when the manual zoom button is clicked.
  const [zoomMagnification, setZoomMagnification] = useState(() => restoredWorkspace?.zoomMagnification ?? '2');

  // Drag state controls panning and cursor feedback.
  const [isDragging, setIsDragging] = useState(false); 
  // The previous mouse point is a ref because it should not cause re-renders.
  const lastMouse = useRef({ x: 0, y: 0 }); 
  // Screen-space mouse position drives hover labels.
  const [mousePos, setMousePos] = useState({ x: -1000, y: -1000 }); 

  // Expose the theme choice for browser color-scheme defaults. Persisting
  // the choice itself is the autosave effect's job now (see
  // buildWorkspaceSnapshot/scheduleAutosave below) — WorkspaceManager is
  // the only module allowed to touch storage directly, so this no longer
  // writes localStorage on its own the way it used to.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // --- WORKSPACE AUTOSAVE ---
  // Assembles the full, plain, JSON-serializable snapshot WorkspaceManager
  // persists. Deliberately excludes anything transient/derived rather than
  // trying to save "everything": open modals (errorModal, isGraphSetupOpen),
  // drag/hover state, in-flight search results, and per-row plot status are
  // either meaningless after a reload or get naturally rebuilt once the
  // restored graphs replot — restoring them would either do nothing useful
  // or restore a stuck-looking transient UI state. `sequences` is saved
  // as-is (including its draft fields) since normalizeRestoredSequences
  // resets those to match the applied fields on the way back in regardless,
  // so there's nothing to gain by stripping them here.
  const buildWorkspaceSnapshot = () => ({
    theme,
    isSidebarVisible,
    simulatorMode,
    baseInputMode,
    baseTriangleLength,
    angleStepControlIncrementInput,
    baseCoordsInput,
    maxBounces,
    sequences,
    nextSequenceNumber: nextSequenceNumberRef.current,
    activeSequenceId,
    shotEditMode,
    clearanceEpsilonInput,
    showAllLabels,
    displayPrecisionInput,
        pan,
    zoom,
    isZoomLocked,
    zoomMagnification,
    anglePlotWindow: anglePlotWindowStateRef.current,
  });

  // Debounced so a burst of changes (typing, dragging, a rapid series of
  // edits) collapses into one write instead of one per keystroke/frame —
  // "the user should never need to press Save", but also should never
  // cause excessive storage writes either. Recreated every render (cheap: a
  // few field reads and a closure) rather than memoized, since the whole
  // point is to always capture the *current* render's state when the
  // debounce timer actually fires; only the timer handle itself needs to
  // persist across renders, which is what the ref is for.
  const workspaceSaveTimeoutRef = useRef(null);
  const scheduleAutosave = () => {
    if (workspaceSaveTimeoutRef.current) clearTimeout(workspaceSaveTimeoutRef.current);
    workspaceSaveTimeoutRef.current = setTimeout(() => {
      workspaceSaveTimeoutRef.current = null;
      saveWorkspace(buildWorkspaceSnapshot());
    }, WORKSPACE_AUTOSAVE_DEBOUNCE_MS);
  };
  useEffect(() => () => {
    if (workspaceSaveTimeoutRef.current) clearTimeout(workspaceSaveTimeoutRef.current);
  }, []);

  // Autosave trigger: every piece of state buildWorkspaceSnapshot reads
  // (other than anglePlotWindowStateRef, which is a ref and reports its own
  // changes via AnglePlotWindow's onWorkspaceStateChange callback instead —
  // see its render call below) is listed here, so any actual workspace
  // change schedules a save.
  useEffect(() => {
    scheduleAutosave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    theme, isSidebarVisible, simulatorMode, baseInputMode, baseTriangleLength,
    angleStepControlIncrementInput, baseCoordsInput, maxBounces,
    sequences, activeSequenceId, shotEditMode, clearanceEpsilonInput, showAllLabels,
    displayPrecisionInput, pan, zoom, isZoomLocked, zoomMagnification,
  ]);

  // Mount/Resize observer. A plain `window` "resize" listener only fires
  // when the browser viewport itself changes size — it never fires when
  // this container's own width changes for a layout reason instead (e.g.
  // toggling the sidebar: the canvas panel widens via flexbox, but the
  // window doesn't resize), which left the SVG's transform centered on a
  // stale width and the newly-freed space simply blank. A ResizeObserver
  // on the container itself fires for either cause, matching the same
  // pattern AnglePlotPanel.jsx already uses for its own canvas.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      // Browser layout is authoritative for the final canvas dimensions.
      const { width, height } = el.getBoundingClientRect();
      // Store dimensions in React state so grid and transforms recompute.
      if (width > 0 && height > 0) {
        setSvgSize({ width, height });
      }
    };
    // Measure immediately, then on every subsequent size change.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Hardware-accelerated zoom block 
  useEffect(() => {
    // The wheel listener must be attached directly so it can prevent default scroll.
    const container = containerRef.current;
    // Skip setup until the DOM node exists.
    if (!container) return;
    // Wheel zoom changes only the scale; it does not recenter around the mouse yet.
    const handleWheel = (e) => {
      // Prevent the page from scrolling while the user zooms the canvas.
      e.preventDefault();
      // Locked mode ignores trackpad/wheel gestures entirely to avoid accidental large zoom jumps.
      if (isZoomLocked) return;
      // Constant multiplicative zoom feels natural over large coordinate ranges.
      const zoomFactor = 1.1;
      // Browser wheel deltas are positive for scroll down, which we treat as zoom out.
      const direction = e.deltaY > 0 ? -1 : 1;
      // Clamp zoom to keep SVG stroke math and interaction usable.
      setZoom(prev => Math.max(0.5, Math.min(prev * (direction > 0 ? zoomFactor : 1 / zoomFactor), 5000)));
    };
    // passive:false is required because handleWheel calls preventDefault.
    container.addEventListener('wheel', handleWheel, { passive: false });
    // Remove the exact listener when dependencies change or the app unmounts.
    return () => container.removeEventListener('wheel', handleWheel);
  }, [isZoomLocked]);


  // --- DYNAMIC GEOMETRY GENERATION ---

  const clearanceEpsilon = useMemo(() => {
    // Parse the editable text field into a numeric perpendicular-distance tolerance.
    const parsed = Number(clearanceEpsilonInput);
    // Invalid or negative input falls back to the documented default.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CLEARANCE_EPSILON;
  }, [clearanceEpsilonInput]);

  const displayPrecision = useMemo(() => {
    // Parse integer decimal places from the editable display precision field.
    const parsed = Number(displayPrecisionInput);
    // Blank or malformed precision falls back to the documented twelve-decimal default.
    if (!Number.isFinite(parsed)) return DEFAULT_DISPLAY_DECIMALS;
    // Fractional decimal counts are rounded down because toFixed() expects an integer.
    const integerPrecision = Math.trunc(parsed);
    // Clamp to the useful range for IEEE-754 browser numbers.
    return Math.max(0, Math.min(integerPrecision, MAX_DISPLAY_DECIMALS));
  }, [displayPrecisionInput]);

  const angleInputStep = useMemo(() => {
    // Nonpositive or malformed step sizes fall back without mutating what the user typed.
    return resolvePositiveInputStep(angleIncrementInput, DEFAULT_ANGLE_INCREMENT);
  }, [angleIncrementInput]);

  const angleStepControlIncrement = useMemo(() => {
    // Resolve the independently configurable native increment for the Angle Step control.
    return resolvePositiveInputStep(angleStepControlIncrementInput, DEFAULT_ANGLE_STEP_CONTROL_INCREMENT);
  }, [angleStepControlIncrementInput]);

  const formatFixed = (value) => {
    // Non-finite geometry values should be visible instead of throwing in toFixed().
    if (!Number.isFinite(value)) return String(value);
    // Use the current user-selected decimal count for ordinary scalar readouts.
    return value.toFixed(displayPrecision);
  };

  // Global Angle and Angle Ray specifically: a whole-number angle
  // (typed as plain "3", or landing on exactly 3.0 after computation) shows
  // as "3.0", not the full displayPrecision run of trailing zeros — every
  // other numeric readout keeps using formatFixed's full precision.
  const formatAngleDisplay = (value) => {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? value.toFixed(1) : formatFixed(value);
  };

  const formatExponential = (value) => {
    // Non-finite diagnostics should be visible instead of throwing in toExponential().
    if (!Number.isFinite(value)) return String(value);
    // Exponential readouts use the same selected decimal count for consistency.
    return value.toExponential(displayPrecision);
  };

  const formatPoint = (point) => {
    // Points are consistently shown as x, y pairs throughout the inspector and hover labels.
    return `${formatFixed(point.x)}, ${formatFixed(point.y)}`;
  };
  
  const baseTriangle = useMemo(() => {
    // Use the shared pure builder so live rendering and candidate validation match.
    return { ...buildBaseTriangle(baseInputMode, baseCoordsInput, angleParams), color: themePalette.baseTriangle };
  }, [baseCoordsInput, baseInputMode, angleParams, themePalette.baseTriangle]);

  // The active row's own Code Sequence always wins when non-blank;
  // otherwise its Angle Ray (if set) is traced against this same
  // baseTriangle and converted back into its equivalent code — see
  // deriveEffectiveSequenceCode. Kept as "billiardsCode" so every existing
  // reader keeps working against "whichever code is actually driving the
  // active row", typed or angle-derived, exactly as before this merge.
  const billiardsCode = useMemo(() => (
    deriveEffectiveSequenceCode(activeSequence?.sequenceText, activeSequence?.rayAngleInput, baseTriangle, maxBounces)
  ), [activeSequence?.sequenceText, activeSequence?.rayAngleInput, baseTriangle, maxBounces]);

  const codeData = useMemo(() => {
    // Use the shared pure unfolder so live rendering and candidate validation match.
    return unfoldCodeData(billiardsCode, baseTriangle, simulatorMode === 'code');
  }, [simulatorMode, billiardsCode, baseTriangle]);

  // Each Sequence Parser card shows its own Boundary Intersections readout
  // below its own code sequence, computed against that row's own committed
  // Angle A/B (not the shared angleParams/baseTriangle above, which only
  // ever reflects the active row) — and, same as the active row above,
  // falls back to that row's own Angle Ray when its Code Sequence is
  // blank.
  const codeDataByRowId = useMemo(() => {
    const map = {};
    for (const row of sequences) {
      const params = { a: row.angleA, b: row.angleB, length: baseTriangleLength };
      if (!hasCompleteAngleParams(params) || !hasValidAngleTriangle(params)) { map[row.id] = null; continue; }
      const rowTriangle = buildBaseTriangle('angles', baseCoordsInput, params);
      const effectiveCode = deriveEffectiveSequenceCode(row.sequenceText, row.rayAngleInput, rowTriangle, maxBounces);
      if (!effectiveCode) { map[row.id] = null; continue; }
      const rowCodeData = unfoldCodeData(effectiveCode, rowTriangle, true);
      // The Angle Ray field displays this (instead of its own raw
      // draft text) whenever a Code Sequence is actually driving the row,
      // so it always reads the true angle of the rendered shot — matching
      // the active row's own Shot Vector "Global Angle" readout exactly
      // (same trimmed chain, same physical-A-at-origin start point).
      const renderableRowTriangles = getRenderableActiveTriangles(rowCodeData.triangles);
      const rowFinalShot = renderableRowTriangles.length > 0 ? renderableRowTriangles.at(-1).points[0] : rowTriangle.points[0];
      // This row's own Vertex Line Test result — computed for every row
      // (not just the active one), using the exact same validator the
      // active row's own Sequence Logs panel shows, so a row's plot-status
      // pill can correctly read "Error" instead of "Plotted" regardless of
      // which row happens to be active or which tab is showing.
      const rowShotValidation = buildPoolshotTowerValidation({
        simulatorMode: 'code', baseTriangle: rowTriangle, activeTriangles: rowCodeData.triangles,
        labelsMap: rowCodeData.idxToAngle, reflectionEdges: rowCodeData.reflectionEdges,
        parsedSequence: rowCodeData.parsedSequence, clearanceEpsilon,
      });
      map[row.id] = {
        ...rowCodeData, effectiveCode, globalAngleDegrees: getGlobalAngle(rowTriangle.points[0], rowFinalShot),
        shotStatus: rowShotValidation.status, shotViolations: rowShotValidation.violations,
      };
    }
    return map;
  }, [sequences, baseCoordsInput, baseTriangleLength, maxBounces, clearanceEpsilon]);


  // --- GEOMETRY ROUTER ---
  // Pick the triangle chain produced by the currently selected mode.
  const activeTriangles = codeData.triangles;
  // Map physical vertex indices back to symbolic labels for UI and validation.
  const labelsMap = codeData.idxToAngle;

  const livePathConsistency = useMemo(() => {
    // Only unconstrained mode needs to compare against a captured constrained path.
    if (simulatorMode !== 'code' || shotEditMode !== SHOT_MODE_UNCONSTRAINED || !shotPathReference) return { status: 'valid', violations: [] };
    // Validate that the current Unconstrained geometry still represents the captured code path.
    return buildCodePathConsistencyValidation({ candidateCodeData: codeData, reference: shotPathReference });
  }, [simulatorMode, shotEditMode, shotPathReference, codeData]);

  const shotClearanceValidation = useMemo(() => {
    // Use the shared direct blue/black line validator so live rendering, locked edits, and search agree.
    return buildPoolshotTowerValidation({ simulatorMode, baseTriangle, activeTriangles, labelsMap, reflectionEdges: codeData.reflectionEdges, parsedSequence: codeData.parsedSequence, clearanceEpsilon, extraViolations: livePathConsistency.violations });
  }, [simulatorMode, baseTriangle, activeTriangles, labelsMap, codeData.reflectionEdges, codeData.parsedSequence, clearanceEpsilon, livePathConsistency.violations]);

  // Store the current shot-vector geometry derived by the validator.
  const shotGeometry = shotClearanceValidation.shotGeometry;
  // Keep the current symbolic endpoint label available to sidebar text.
  const shotSymbol = shotGeometry.shotSymbol;
  // Keep the first endpoint available to the SVG shot line.
  const startShot = shotGeometry.startShot;
  // Keep line length available for text and degenerate guards.
  const lineLength = shotGeometry.lineLength;
  // Preview mode unconstraineding activates only for an invalid code-mode shot.
  const isUnconstrainedShot = simulatorMode === 'code' && shotEditMode === SHOT_MODE_UNCONSTRAINED && shotClearanceValidation.status === 'invalid';
  // Unconstrained-mode shots keep the base guide color when valid and switch to a lighter red when invalid.
  const shotLineVisualColor = isUnconstrainedShot && shotClearanceValidation.status === 'invalid' ? INVALID_SHOT_COLOR : VALID_SHOT_COLOR;

  // Render the reflected chain minus its very last triangle (per instructor
  // requirement — see getRenderableActiveTriangles).
  const renderableActiveTriangles = getRenderableActiveTriangles(activeTriangles);
  // The dashed shot line/dot and its "Shot Vector" readout must always land
  // on a vertex of a triangle that is actually drawn, so they read from the
  // trimmed chain here — deliberately separate from shotGeometry.finalShot,
  // which the blue/black line validator (and its endpoint-exclusion check)
  // must keep reading from the full untrimmed chain regardless of what's
  // currently visible on screen.
  const renderedFinalShot = renderableActiveTriangles.length > 0
    ? renderableActiveTriangles[renderableActiveTriangles.length - 1].points[shotGeometry.shotVertexIdx]
    : startShot;

  const getTriangleRenderStyle = (tri) => ({
    color: tri.color,
    strokeColor: '#000000',
    fillOpacity: isUnconstrainedShot ? 0.035 : 0.1,
    strokeOpacity: isUnconstrainedShot ? 0.35 : 1
  });

  // Lookup a rendered point's validation classification without recomputing the scan.
  const getClearancePointValidation = (triId, vertexIdx, symbol) => {
    // Clearance classification applies only to active code-mode shots.
    if (simulatorMode !== 'code' || activeTriangles.length === 0 || lineLength < 1e-12) return null;
    // Build the stable occurrence key used by the validator.
    const occurrenceKey = getClearanceOccurrenceKey(triId, vertexIdx, symbol);
    // Return the existing classification when this occurrence was part of the scan.
    return shotClearanceValidation.byOccurrence.get(occurrenceKey) || null;
  };

  const getShotVertexRenderColor = (validation, fallbackColor = SHOT_VERTEX_ABOVE_LINE_COLOR) => {
    if (!validation) return fallbackColor;
    if (validation.isShotEndpoint) return SHOT_ENDPOINT_FILL_COLOR;
    return validation.score < 0 ? SHOT_VERTEX_BELOW_LINE_COLOR : fallbackColor;
  };

  const clearShotFeedback = () => {
    // Accepted input changes invalidate the previously displayed region search.
    setStableRegionResult(null);
    // Accepted input changes also clear stale locked-shot rejection text.
    setLockedShotNotice(null);
  };

  const resetShotConstraintReference = () => {
    // Input changes that redefine the code or base triangle invalidate the Unconstrained reference path.
    setShotPathReference(null);
    // Input changes outside the guarded angle path should clear stale feedback.
    // Shared feedback cleanup keeps the inspector from showing stale results.
    clearShotFeedback();
  };

  const validateLockedAngleCandidate = (candidateParams) => {
    // unconstrained mode never blocks candidate angle edits.
    if (shotEditMode !== SHOT_MODE_LOCKED) return { allowed: true };
    // Ray mode has no code-mode endpoint shot to protect.
    if (simulatorMode !== 'code') return { allowed: true };
    // Coordinate mode is not the symbolic x/y angle workflow.
    if (baseInputMode !== 'angles') return { allowed: true };
    // Empty code mode has no unfolded shot to protect.
    if (!billiardsCode.trim()) return { allowed: true };
    // Incomplete typing states would replace the constrained geometry with a fallback triangle.
    if (!hasCompleteAngleParams(candidateParams)) return { allowed: false, reason: 'angle input is incomplete' };
    // Non-triangular inputs are rejected in Constrained mode because they destroy the shot.
    if (!hasValidAngleTriangle(candidateParams)) return { allowed: false, reason: 'triangle angles are invalid' };
    // Same A < B, A + B <= 90 domain restriction the "Valid Angle A-B
    // Region" graph already enforces (see angleValidation.js), now applied
    // to live edits too so the two notions of "valid A/B" never disagree.
    const candidateA = Number(candidateParams.a);
    const candidateB = Number(candidateParams.b);
    if (candidateA >= candidateB) return { allowed: false, reason: 'Angle A must be smaller than Angle B' };
    if (candidateA + candidateB > 90) return { allowed: false, reason: 'Angle A and Angle B must sum to at most 90°' };

    // Build the candidate triangle without committing it to React state.
    const candidateTriangle = buildBaseTriangle('angles', baseCoordsInput, candidateParams);
    // Unfold the current code against the candidate triangle.
    const candidateCodeData = unfoldCodeData(billiardsCode, candidateTriangle, true);
    // Preserve the current finite code interpretation instead of accepting a fresh reinterpretation.
    const pathConsistency = buildCodePathConsistencyValidation({ candidateCodeData, reference: buildCodePathReference(codeData) });
    // Validate the candidate against the direct blue/black line rule before render.
    const candidateSelfValidation = buildPoolshotTowerValidation({ simulatorMode: 'code', baseTriangle: candidateTriangle, activeTriangles: candidateCodeData.triangles, labelsMap: candidateCodeData.idxToAngle, reflectionEdges: candidateCodeData.reflectionEdges, parsedSequence: candidateCodeData.parsedSequence, clearanceEpsilon, extraViolations: pathConsistency.violations });
    // Reject any candidate ray that is intrinsically invalid.
    if (candidateSelfValidation.status === 'invalid') {
      // Use the first self-validation violation to explain the rejection.
      const firstViolation = candidateSelfValidation.violations[0];
      // Build a concise human-readable rejection message.
      const reason = firstViolation ? `${firstViolation.triId} ${firstViolation.vertexName || firstViolation.symbol} expected ${firstViolation.expected}` : 'candidate ray failed blue/black line test';
      // Reject before the angle state can render the bad ray.
      return { allowed: false, reason };
    }
    // Valid candidate rays may be committed.
    return { allowed: true };
  };

  // Guards the active row's own sequence-code edits the same way
  // validateLockedAngleCandidate guards its angle edits: in Constrained mode,
  // a new code must still pass the direct blue/black Vertex Line Test against
  // the *current* base triangle/angles before it is ever committed, so an
  // invalid shot is never rendered even for a moment. unconstrained mode is left
  // alone (its whole purpose is exploring otherwise-invalid geometry), and a
  // path-consistency check against the old code makes no sense here (the
  // code itself is what's changing), so this only runs the direct line test.
  //
  // `candidateAngleParams` defaults to the memoized `angleParams` (the
  // active row's already-committed angles) but callers that just committed
  // a fresh Angle A/B draft in the *same* handler must pass those draft
  // values explicitly instead: `setSequences` queues a state update rather
  // than applying it synchronously, so `angleParams` (derived from
  // `activeSequence`, itself read from the `sequences` state variable)
  // would still reflect the pre-commit angles until the next render — using
  // it here would validate the new code against the wrong triangle.
  const validateLockedCodeCandidate = (candidateSequenceText, candidateAngleParams = angleParams) => {
    if (shotEditMode !== SHOT_MODE_LOCKED) return { allowed: true };
    if (simulatorMode !== 'code') return { allowed: true };
    if (baseInputMode !== 'angles') return { allowed: true };
    if (!candidateSequenceText.trim()) return { allowed: true };
    if (!hasCompleteAngleParams(candidateAngleParams) || !hasValidAngleTriangle(candidateAngleParams)) return { allowed: true };

    const candidateBaseTriangle = buildBaseTriangle('angles', baseCoordsInput, candidateAngleParams);
    const candidateCodeData = unfoldCodeData(candidateSequenceText, candidateBaseTriangle, true);
    const candidateValidation = buildPoolshotTowerValidation({
      simulatorMode: 'code', baseTriangle: candidateBaseTriangle, activeTriangles: candidateCodeData.triangles,
      labelsMap: candidateCodeData.idxToAngle, reflectionEdges: candidateCodeData.reflectionEdges,
      parsedSequence: candidateCodeData.parsedSequence, clearanceEpsilon,
    });
    if (candidateValidation.status === 'invalid') {
      return { allowed: false, violations: candidateValidation.violations };
    }
    return { allowed: true };
  };

  // Per-sequence-row equivalent of validateLockedAngleCandidate above, used
  // by the multi-sequence graph pop-up to test an arbitrary (A, B) pair
  // against *any* row's sequence text. Since Angle A/B are now per-row (not
  // one shared value), `referenceAngleParams` lets each row validate
  // candidates against *its own* committed angles as the reference geometry
  // — defaulting to the active row's when omitted, which preserves the
  // single-row behavior this closure originally had. Unlike
  // validateLockedAngleCandidate this intentionally ignores shotEditMode
  // (Unconstrained/Constrained) — that toggle exists to guard *live edits* to the
  // active row, not to redefine what "valid" means for a plotted region,
  // so every row's graph uses the same Constrained-style validity
  // definition regardless of which mode the active row happens to be in.
  // The reference triangle/codeData/path (this row's own committed
  // unfolding) is the same for every candidate a given sweep tests — it
  // only depends on (sequenceText, referenceAngleParams), never on the
  // candidate (A, B) being checked. Building it here, once per sweep,
  // instead of inside the returned per-candidate closure removes a
  // redundant unfoldCodeData + buildCodePathReference call from every
  // single candidate. Measured on a real 202k-candidate sweep (step=0.1,
  // 10-run sequence): this alone saved ~3s of an ~18-21s sweep, with
  // identical points found — a pure duplicate-work removal, not an
  // approximation.
  // A row's own effective Code Sequence for identity/hashing/generation
  // purposes — its typed code if non-blank, otherwise the code its own
  // Angle Ray derives against its own committed Angle A/B (the same
  // resolution codeDataByRowId/billiardsCode/findExactDuplicateSequence
  // already use for display). Used everywhere a row's code needs hashing or
  // validating (GraphSimulatorView's startSequenceJob, handleSaveGraphNow)
  // instead of ever reading row.sequenceText directly there — an Angle-Ray-
  // only row has a genuinely blank sequenceText, and validating/hashing
  // that blank string is exactly why such a row could never actually plot
  // (every candidate (A, B) was rejected with "sequence is empty" before
  // this existed).
  const resolveRowEffectiveSequenceText = (sequenceText, rayAngleInput, referenceAngleParams) => {
    const referenceTriangle = buildBaseTriangle('angles', baseCoordsInput, referenceAngleParams);
    return deriveEffectiveSequenceCode(sequenceText, rayAngleInput, referenceTriangle, maxBounces);
  };

  const buildValidateCandidateForSequence = (sequenceText, referenceAngleParams = angleParams) => {
    if (!sequenceText || !sequenceText.trim()) return () => ({ allowed: false, reason: 'sequence is empty' });
    // The reference path is this row's own current committed unfolding
    // (same sequence text, against that row's own committed angles), not
    // necessarily the active row's — each row is validated against itself.
    const referenceTriangle = buildBaseTriangle('angles', baseCoordsInput, referenceAngleParams);
    const committedCodeData = unfoldCodeData(sequenceText, referenceTriangle, true);
    const reference = buildCodePathReference(committedCodeData);
    return (candidateParams) => {
      if (!hasCompleteAngleParams(candidateParams)) return { allowed: false, reason: 'angle input is incomplete' };
      if (!hasValidAngleTriangle(candidateParams)) return { allowed: false, reason: 'triangle angles are invalid' };

      const candidateTriangle = buildBaseTriangle('angles', baseCoordsInput, candidateParams);
      const candidateCodeData = unfoldCodeData(sequenceText, candidateTriangle, true);
      const pathConsistency = buildCodePathConsistencyValidation({ candidateCodeData, reference });
      const candidateSelfValidation = buildPoolshotTowerValidation({ simulatorMode: 'code', baseTriangle: candidateTriangle, activeTriangles: candidateCodeData.triangles, labelsMap: candidateCodeData.idxToAngle, reflectionEdges: candidateCodeData.reflectionEdges, parsedSequence: candidateCodeData.parsedSequence, clearanceEpsilon, extraViolations: pathConsistency.violations });
      if (candidateSelfValidation.status === 'invalid') {
        const firstViolation = candidateSelfValidation.violations[0];
        const reason = firstViolation ? `${firstViolation.triId} ${firstViolation.vertexName || firstViolation.symbol} expected ${firstViolation.expected}` : 'candidate ray failed blue/black line test';
        return { allowed: false, reason };
      }
      return { allowed: true };
    };
  };

  // Builds the detailed, plain-English explanation shown inline when a live
  // Angle A/B/Length edit is rejected. Deliberately NOT a modal: these
  // inputs commit on every keystroke (for immediate visual feedback), and a
  // typical multi-digit edit passes through several transiently-invalid
  // states (e.g. typing "23" one digit at a time) — a pop-up on every one
  // of those would make the fields nearly unusable. The full detail still
  // needs to be visible, just without blocking typing.
  const describeAngleRejection = (field, value, reason) => {
    const isLengthField = field === 'length';
    const currentA = Number(field === 'a' ? value : angleParams.a);
    const currentB = Number(field === 'b' ? value : angleParams.b);
    const knownReasonFixes = {
      'angle input is incomplete': 'Finish entering a numeric value for every field.',
      'triangle angles are invalid': 'Enter positive angles whose sum stays under 180°, with a positive base length.',
      'Angle A must be smaller than Angle B': 'Increase Angle B or decrease Angle A so Angle A is smaller.',
      'Angle A and Angle B must sum to at most 90°': 'Reduce Angle A or Angle B so their sum is at most 90°.',
    };
    const requiredConstraints = isLengthField
      ? ['Base Length must be a positive number.']
      : ['Angle A must be greater than 0°.', 'Angle B must be greater than 0°.', 'Angle A must be smaller than Angle B.', 'Angle A + Angle B must be at most 90°.'];
    if (!isLengthField && !(reason in knownReasonFixes)) {
      requiredConstraints.push(`This sequence also requires: ${reason}.`);
    }
    const howToFix = knownReasonFixes[reason] || `Adjust the value so this sequence's unfolding stays valid (${reason}).`;
    return { field, value, reason, isLengthField, currentA, currentB, requiredConstraints, howToFix };
  };

  // Edits the shared Base Length field. Angle A/B are edited per-row now
  // (see each Sequence Parser card's own draft/apply handlers below), so
  // this only ever runs with field === 'length' — still routed through the
  // same Constrained-mode guard/rejection-notice path as every other
  // locked-edit field for consistency.
  const handleAngleParamChange = (field, value) => {
    // Candidate state mirrors what React would store if the edit is accepted.
    const candidateParams = { ...angleParams, [field]: value };
    // Ask Constrained mode whether this candidate can be committed.
    const guard = validateLockedAngleCandidate(candidateParams);
    // Reject invalid candidates before they change the rendered geometry.
    if (!guard.allowed) {
      // Store the full structured explanation of the blocked edit.
      setLockedShotNotice(describeAngleRejection(field, value, guard.reason));
      // Leave angleParams unchanged so the last valid geometry remains active.
      return;
    }
    // Commit accepted edits to the normal angle state.
    clearShotFeedback();
    setBaseTriangleLength(value);
  };

  const handleOpenAnglePlot = () => {
    // Mounting is idempotent (isAnglePlotOpen is already true after the first
    // click), so this can never create a second window; bumping the request
    // id is what makes a second click on an already-open window refresh and
    // surface it instead of doing nothing.
    setSimulatorMode('graph');
  };

  // Error messages always show the typed value rounded to a fixed 3
  // decimal places matching whatever the user actually typed (14 -> 0
  // decimals, 14.1 -> 1, 14.06 -> 2, 14.067 -> 3, ...), determined from the
  // raw typed text rather than a fixed precision, so the error always
  // reads at the same precision the user is already working in.
  const countDecimalPlaces = (rawText) => {
    const text = String(rawText ?? '');
    const dotIndex = text.indexOf('.');
    if (dotIndex === -1) return 0;
    return text.slice(dotIndex + 1).replace(/[^0-9]/g, '').length;
  };
  const formatToDecimals = (value, decimals) => {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(decimals) : String(value ?? '');
  };

  // Given a candidate (A, B) pair, works out — from the existing geometric
  // constraints alone (A > 0, B > 0, A < B, A + B <= 90; see
  // angleValidation.js's isValidAnglePair, which the "Valid Angle A-B
  // Region" graph already uses) — the closed-form allowed range for
  // whichever field(s) are out of range, one independent check per field
  // so a simultaneous problem with both A and B reports both instead of
  // stopping at the first. This intentionally does NOT attempt to compute
  // the tighter, sequence-specific sub-range (that region has no closed
  // form — it's whatever the adaptive region sweep finds — so
  // reporting it as a single min/max pair would just be wrong); the deeper
  // sequence-specific check still runs separately once the pair passes
  // these geometric bounds, exactly as it always did.
  const computeAngleRangeFailures = (candidateA, candidateB, decimalsA, decimalsB) => {
    const failures = [];
    // Clamped at 0 so a wildly out-of-range B (e.g. 466, itself already
    // reported as its own failure below) can never make this read as a
    // backwards range like "0 <= Angle A <= -376" — once B is that far off,
    // no A value works yet either, which a degenerate 0-to-0 range still
    // communicates correctly without the confusing negative upper bound.
    const upperForA = Math.max(0, Math.min(candidateB, 90 - candidateB));
    const aOk = Number.isFinite(candidateA) && candidateA > 0 && candidateA < upperForA;
    if (!aOk) {
      failures.push({
        heading: 'Angle A',
        text: `Angle A = ${formatToDecimals(candidateA, decimalsA)}°\n\nAllowed range:\n${formatToDecimals(0, decimalsA)}° ≤ Angle A ≤ ${formatToDecimals(upperForA, decimalsA)}°`,
      });
    }
    // Same backwards-range guard as upperForA above: an out-of-range A
    // (e.g. negative, or past 90) must never turn this into "500 <= Angle B
    // <= -410". Clamped so lowerForB is never negative and upperForB never
    // ends up below it.
    const lowerForB = Math.max(0, candidateA);
    const upperForB = Math.max(lowerForB, 90 - candidateA);
    const bOk = Number.isFinite(candidateB) && candidateB > candidateA && candidateB <= 90 - candidateA;
    if (!bOk) {
      failures.push({
        heading: 'Angle B',
        text: `Angle B = ${formatToDecimals(candidateB, decimalsB)}°\n\nAllowed range:\n${formatToDecimals(lowerForB, decimalsB)}° ≤ Angle B ≤ ${formatToDecimals(upperForB, decimalsB)}°`,
      });
    }
    return failures;
  };

  // Draft-only: typing into Angle A/B never validates or recalculates
  // anything — see applyAngleDrafts below for when it actually does.
  const handleAngleDraftChange = (id, field, value) => {
    const draftField = field === 'a' ? 'draftAngleA' : 'draftAngleB';
    setSequences((rows) => rows.map((row) => {
      if (row.id !== id) return row;
      const nextRow = { ...row, [draftField]: value };
      if (row.validationErrorSource === 'angle') {
        const nextA = Number(field === 'a' ? value : row.draftAngleA);
        const nextB = Number(field === 'b' ? value : row.draftAngleB);
        const nextDraftA = field === 'a' ? value : row.draftAngleA;
        const nextDraftB = field === 'b' ? value : row.draftAngleB;
        const bothProvided = nextDraftA !== '' && nextDraftB !== '';
        const unconstrainedBypass = row.id === activeSequenceId && shotEditMode !== SHOT_MODE_LOCKED;
        const failures = !unconstrainedBypass && bothProvided
          ? computeAngleRangeFailures(nextA, nextB, countDecimalPlaces(nextDraftA), countDecimalPlaces(nextDraftB))
          : [];
        if (failures.length === 0) {
          nextRow.validationError = null;
          nextRow.validationErrorSource = null;
        }
      }
      return nextRow;
    }));
  };

  // Escape discards in-progress Angle A/B edits and restores the last applied values.
  const handleCancelAngleDraft = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, draftAngleA: row.angleA, draftAngleB: row.angleB, validationError: null, validationErrorSource: null } : row));
  };

  // Validates this row's pending Angle A/B draft — as a *pair*, together,
  // rather than one field at a time, so editing both before applying is
  // checked against the new combination instead of one field's fresh draft
  // against the other's stale committed value — and, only if valid,
  // commits both. An invalid pair is left exactly as typed (the draft is
  // never silently reverted); the shared error modal lists every failing
  // field with its own computed allowed range, at that field's own typed
  // decimal precision. Nothing about the graph or main canvas changes
  // until this succeeds. Used by each field's own Enter/blur, and by the
  // "Plot Valid Angle Region" button before it calculates, so both act as
  // the same trigger.
  const applyAngleDrafts = (id) => {
    const row = sequences.find(r => r.id === id);
    if (!row) return true;
    const draftA = row.draftAngleA;
    const draftB = row.draftAngleB;
    // The draft matching what's already committed means there is nothing
    // NEW to commit, but it does NOT mean a currently-displayed angle
    // validationError is still accurate — e.g. the user broke this row's
    // angles, saw an error, and then retyped the exact value that was
    // already committed. Falling through in that case re-runs the checks
    // below against the current (still-committed, still-valid) values,
    // which is what actually clears the stale error instead of short-
    // circuiting past it. Gated on validationErrorSource === 'angle' (not
    // just any validationError) so an unrelated Step or Sequence error
    // showing at the same time is never touched by this field's own apply.
    if (draftA === row.angleA && draftB === row.angleB && !(row.validationError && row.validationErrorSource === 'angle')) return true;

    const isActiveRow = id === activeSequenceId;
    // unconstrained mode's whole purpose is inspecting otherwise-invalid geometry
    // without being blocked — that established behavior is preserved here
    // exactly as it was for the active row's live edits.
    const unconstrainedBypass = isActiveRow && shotEditMode !== SHOT_MODE_LOCKED;
    const bothProvided = draftA !== '' && draftB !== '';

    let failures = [];
    if (!unconstrainedBypass && bothProvided) {
      const candidateA = Number(draftA);
      const candidateB = Number(draftB);
      const decimalsA = countDecimalPlaces(draftA);
      const decimalsB = countDecimalPlaces(draftB);
      failures = computeAngleRangeFailures(candidateA, candidateB, decimalsA, decimalsB);
      // The deeper blue/black-line check only makes sense once this row
      // actually has a code to validate against — a brand-new row's code
      // is itself gated on having angles set first, so skipping this when
      // there's no code yet (not rejecting with "sequence is empty") is
      // what breaks that chicken-and-egg deadlock: angles can always be
      // set on their own geometric merits, and the deep check kicks in
      // automatically as soon as a code exists to check. It only runs once
      // the geometric range checks above already pass, since a candidate
      // outside the simple range has no code-specific triangle to build.
      if (failures.length === 0 && row.sequenceText.trim()) {
        const validateCandidate = buildValidateCandidateForSequence(row.sequenceText, { a: row.angleA, b: row.angleB, length: baseTriangleLength });
        const result = validateCandidate({ a: candidateA, b: candidateB, length: baseTriangleLength });
        if (!result.allowed) {
          failures = [{ heading: `Additional requirement for ${row.label}'s sequence`, text: result.reason }];
        }
      }
    }

    if (failures.length > 0) {
      const sections = [
        { heading: 'Problem', text: `Angle A and/or Angle B are not valid for ${row.label}.` },
        ...failures,
      ];
      const flat = sections.map(s => `${s.heading}:\n${s.text}`).join('\n\n');
      setSequences(rows => rows.map(r => r.id === id ? { ...r, validationError: flat, validationErrorSource: 'angle' } : r));
      setErrorModal({ title: 'Invalid angles', sections, focusId: null });
      return false;
    }

    setSequences(rows => rows.map(r => r.id === id ? { ...r, angleA: draftA, angleB: draftB, validationError: null, validationErrorSource: null } : r));
    if (isActiveRow) resetShotConstraintReference();
    return true;
  };

  // Draft-only: typing into Angle Step never validates or recalculates
  // anything — see applyAngleStepDraft below for when it actually does.
  const handleAngleStepDraftChange = (id, value) => {
    setSequences((rows) => rows.map((row) => {
      if (row.id !== id) return row;
      if (row.validationErrorSource === 'step') {
        const parsed = parseAngleStep(value);
        if (parsed.valid) {
          return { ...row, draftAngleStepInput: value, validationError: null, validationErrorSource: null };
        }
      }
      return { ...row, draftAngleStepInput: value };
    }));
  };

  // Escape discards an in-progress Angle Step edit and restores the last applied value.
  const handleCancelAngleStepDraft = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, draftAngleStepInput: row.angleStepInput, validationError: null, validationErrorSource: null } : row));
  };

  // Same draft/apply contract as applyAngleDrafts, for the Angle Step field.
  const applyAngleStepDraft = (id) => {
    const row = sequences.find(r => r.id === id);
    if (!row) return true;
    // See applyAngleDrafts' identical comment: matching the committed value
    // means nothing NEW to commit, but a stale Step error from an earlier
    // rejected draft (since retyped back to the last-valid text) still needs
    // to be cleared here, not left showing. Gated to this field's own
    // 'step'-tagged errors so an unrelated Angle/Sequence error is untouched.
    if (row.draftAngleStepInput === row.angleStepInput && !(row.validationError && row.validationErrorSource === 'step')) return true;
    const parsed = parseAngleStep(row.draftAngleStepInput);
    if (!parsed.valid) {
      const message = `Angle Step "${row.draftAngleStepInput}" is not valid.\n${parsed.error}`;
      setSequences(rows => rows.map(r => r.id === id ? { ...r, validationError: message, validationErrorSource: 'step' } : r));
      setErrorModal({
        title: 'Invalid Angle Step',
        sections: [
          { heading: 'Problem', text: `"${row.draftAngleStepInput}" is not a valid Angle Step for ${row.label}.` },
          { heading: 'How to fix it', text: parsed.error },
        ],
        focusId: null,
      });
      return false;
    }
    setSequences(rows => rows.map(r => r.id === id ? { ...r, angleStepInput: r.draftAngleStepInput, validationError: null, validationErrorSource: null } : r));
    return true;
  };

  // A graph card's own "Plot Valid Angle Region" button: applies any
  // pending Angle A/B, Angle Step, and sequence code drafts first (the
  // same validation each field's own Enter triggers — see the functions
  // above), stopping at the first failure so an invalid value never
  // silently reaches the calculation. Only once everything applies does it
  // open the shared window (if needed), make this row visible (so its new
  // result is actually seen on the shared canvas), and force *only* this
  // row to (re)generate — every other row's already-plotted geometry is
  // untouched.
  // `skipDuplicateCheck` is set only when re-invoked from the "Continue"
  // button below, after the user has already been warned and chosen to
  // plot the duplicate anyway — the check itself compares each row's own
  // DRAFT Code Sequence/Angle A/B (not yet applied) against every other
  // row's already-committed values, since that's the exact comparison this
  // call is about to commit.
  const handlePlotSequenceNow = (id, { skipDuplicateCheck = false } = {}) => {
    if (!skipDuplicateCheck) {
      const row = sequences.find((r) => r.id === id);
      const duplicate = row && findExactDuplicateSequence(sequences, id, row.draftSequenceText, row.draftAngleA, row.draftAngleB);
      if (duplicate) {
        setDuplicateSequenceConfirm({ id, matchLabel: duplicate.label });
        return;
      }
    }
    if (!applyAngleDrafts(id)) return;
    if (!applyAngleStepDraft(id)) return;
    handleApplyRayAngleDraft(id);
    if (!handleApplySequenceDraft(id)) return;

    // Warn (without blocking the plot — the region sweep below is still
    // useful even when this row's own current point isn't itself valid)
    // whenever this row's own just-committed code+angles fail their own
    // Vertex Line Test. handleApplySequenceDraft above already blocks this
    // for the active row in Constrained mode (never reaches here), but
    // every other row — and the active row in Unconstrained mode — was
    // never checked at all, letting the status pill read "Plotted" with no
    // warning of any kind. Reads the row's own DRAFT fields directly
    // (codeDataByRowId, a useMemo, hasn't recomputed from the applies above
    // yet this same tick) — mirrors codeDataByRowId's own per-row
    // computation exactly.
    const committedRow = sequences.find((r) => r.id === id);
    if (committedRow) {
      const candidateParams = { a: committedRow.draftAngleA, b: committedRow.draftAngleB, length: baseTriangleLength };
      if (hasCompleteAngleParams(candidateParams) && hasValidAngleTriangle(candidateParams)) {
        const rowTriangle = buildBaseTriangle('angles', baseCoordsInput, candidateParams);
        const effectiveCode = deriveEffectiveSequenceCode(committedRow.draftSequenceText, committedRow.draftRayAngleInput, rowTriangle, maxBounces);
        if (effectiveCode) {
          const rowCodeData = unfoldCodeData(effectiveCode, rowTriangle, true);
          const rowShotValidation = buildPoolshotTowerValidation({
            simulatorMode: 'code', baseTriangle: rowTriangle, activeTriangles: rowCodeData.triangles,
            labelsMap: rowCodeData.idxToAngle, reflectionEdges: rowCodeData.reflectionEdges,
            parsedSequence: rowCodeData.parsedSequence, clearanceEpsilon,
          });
          if (rowShotValidation.status === 'invalid') {
            const sections = buildVertexLineTestErrorSections(rowShotValidation.violations, clearanceEpsilon);
            setErrorModal({ title: `${committedRow.label}'s Vertex Line Test is invalid.`, sections, focusId: null });
          }
        }
      }
    }

    setSimulatorMode('graph');
    setSequences(rows => rows.map(row => row.id === id ? { ...row, visible: true } : row));
    // A row sharing the exact same sequenceText/angleA/angleB/angleStepInput/
    // baseLength as an already-EXACT row hashes identically (hashGraph) and
    // hits GraphCache instantly in startSequenceJob's own STEP 2 — no new
    // caching logic needed here for the "should plot fast" half of this
    // confirmation, it already falls out of the existing content-addressed
    // cache once this request is issued.
    setForceGenerateRequest({ id, token: ++forceGenerateTokenRef.current });
  };

  const handleOpenPlotFromGraphSetup = () => {
    sequences.forEach((row) => {
      applyAngleDrafts(row.id);
      applyAngleStepDraft(row.id);
      handleApplyRayAngleDraft(row.id);
      handleApplySequenceDraft(row.id);
    });
    setIsGraphSetupOpen(false);
    handleOpenAnglePlot();
    if (activeSequenceId) {
      setForceGenerateRequest({ id: activeSequenceId, token: ++forceGenerateTokenRef.current });
    }
  };

  // Graph Library's "Load Graph" button (see GraphLibraryPanel.jsx and
  // useGraphLibrary.js) hands back a library graph's metadata plus its
  // already-fetched-or-locally-cached geometry — this is the one place
  // that turns that into a normal new row, exactly like any other newly
  // plotted graph. AnglePlotWindow.jsx never learns (and never needs to)
  // that this row's first result came from PostgreSQL instead of a fresh
  // computation.
  const handleLoadGraphFromLibrary = (graph, geometry) => {
    const { params } = graph;
    // baseLength is the one setting still shared by every row (see its own
    // declaration comment) — if the loaded graph was computed under a
    // different Base Length than the app's current one, syncing it here is
    // what keeps the loaded row's geometry actually correct, at the cost
    // of every *other* existing row needing a manual replot to pick up the
    // new length too — the same tradeoff editing Base Geometry directly
    // already carries today, not a new one this introduces.
    const graphBaseLength = Number(params.baseLength);
    if (Number.isFinite(graphBaseLength) && graphBaseLength !== baseTriangleLength) {
      setBaseTriangleLength(graphBaseLength);
    }

    const number = nextSequenceNumberRef.current++;
    const newRow = createSequenceRow({
      number,
      sequenceText: params.sequenceText,
      angleStepInput: params.angleStepInput,
      angleA: params.angleA,
      angleB: params.angleB,
    });

    // Pre-populate GraphCache under the library's own authoritative hash
    // *before* this row's first plot job runs, so that job's own STEP 2
    // (AnglePlotWindow.jsx) is an instant local hit — never a second
    // download, never a recompute (this feature's own "avoid duplicate
    // downloads").
    primeExactGraphCache(graph.hash, newRow.angleStepInput, geometry);

    setSequences(rows => relabelSequenceRows([...rows, newRow]));
    setActiveSequenceId(newRow.id);
    setSimulatorMode('graph');
    setForceGenerateRequest({ id: newRow.id, token: ++forceGenerateTokenRef.current });
    setIsGraphLibraryOpen(false);
  };

  // The Graph Database browser's "Load Graph"/"Duplicate"/double-click-to-
  // open actions (see GraphDatabasePanel.jsx and useLocalGraphDatabase.js)
  // all funnel through this same one handler — mirrors
  // handleLoadGraphFromLibrary above exactly, just reading the local
  // GraphDatabase's flat metadata shape (graph.codeSequence/angleStep,
  // not graph.params.sequenceText/angleStepInput) instead of the
  // PostgreSQL-backed one's. Deliberately does NOT carry the loaded
  // graph's own title/color/tags/favorite onto the new row — like
  // handleLoadGraphFromLibrary, a loaded/duplicated row starts as a
  // normal new row (its own next-in-sequence color, blank title/tags),
  // free to diverge from the library entry it came from.
  //
  // `closePanel` (useLocalGraphDatabase.js's own loadGraphIntoSession) is
  // false for a quick "Duplicate" click or an instant-open double-click —
  // both are meant to be repeatable while still browsing — and true for
  // the deliberate "Load Graph" button, which signals "I'm done browsing."
  const handleLoadGraphFromDatabase = (graph, geometry, { closePanel = true } = {}) => {
    const graphBaseLength = Number(graph.baseLength);
    if (Number.isFinite(graphBaseLength) && graphBaseLength !== baseTriangleLength) {
      setBaseTriangleLength(graphBaseLength);
    }

    const number = nextSequenceNumberRef.current++;
    const newRow = createSequenceRow({
      number,
      sequenceText: graph.codeSequence,
      angleStepInput: graph.angleStep,
      angleA: graph.angleA,
      angleB: graph.angleB,
    });

    // Pre-populate GraphCache under the database's own authoritative hash
    // *before* this row's first plot job runs, so that job's own STEP 2
    // (AnglePlotWindow.jsx) is an instant local hit — never a second
    // fetch, never a recompute ("Load graph should... Draw immediately.
    // No recomputation.").
    primeExactGraphCache(graph.hash, newRow.angleStepInput, geometry);

    setSequences(rows => relabelSequenceRows([...rows, newRow]));
    setActiveSequenceId(newRow.id);
    setSimulatorMode('graph');
    setForceGenerateRequest({ id: newRow.id, token: ++forceGenerateTokenRef.current });
    if (closePanel) setIsGraphDatabaseOpen(false);
  };

  // Shows a small, self-dismissing banner for the "Save Graph" button's
  // own success/failure result — see saveToast's own declaration comment
  // for why this exists (no pre-existing toast system to reuse).
  const showSaveToast = (message, isError = false) => {
    if (saveToastTimeoutRef.current) clearTimeout(saveToastTimeoutRef.current);
    setSaveToast({ message, isError });
    saveToastTimeoutRef.current = setTimeout(() => setSaveToast(null), 3000);
  };
  useEffect(() => () => {
    if (saveToastTimeoutRef.current) clearTimeout(saveToastTimeoutRef.current);
  }, []);

  // The explicit "Save Graph" button, next to "Plot Valid Angle Region" on
  // each row's own card: persists THIS row's already-computed points to
  // the shared GraphDatabase (GitHub-backed on the deployed site, local
  // disk in local dev — see server/graphDatabase/graphDatabase.js's own
  // resolveDefaultGraphDatabase) right now, on demand, rather than waiting
  // for the automatic save AnglePlotWindow.jsx's own background-exact-
  // complete handler already performs once a row's brute-force sweep
  // finishes uninterrupted. Deliberately calls that EXACT SAME
  // saveLocalExactGraph function (never a second save pathway) with the
  // row's own current points/renderInfo, already sitting in
  // plotStatusById — mirrored out of AnglePlotWindow's own results state
  // by its onRowStatusChange callback — so this never touches, re-runs, or
  // waits on any plotting/generation logic of its own; it only ever
  // persists a result that's already on screen.
  //
  // Requires graphStatus === EXACT, not just status === 'done': a row can
  // be "done" from the fast adaptive preview alone, well before its
  // background brute-force sweep finishes — saving THAT into the
  // permanent library would store an incomplete geometry under a hash
  // nothing could ever correct later, exactly the failure mode the
  // automatic save already guards against (see AnglePlotWindow.jsx's own
  // `!bgTimeLimited` check). This button enforces the identical rule.
  const handleSaveGraphNow = async (row) => {
    const plotInfo = plotStatusById[row.id];
    if (!plotInfo || plotInfo.renderInfo?.graphStatus !== GRAPH_STATUS.EXACT || !plotInfo.points?.length) return;
    setSavingGraphIds(prev => new Set(prev).add(row.id));
    const effectiveSequenceText = resolveRowEffectiveSequenceText(row.sequenceText, row.rayAngleInput, { a: row.angleA, b: row.angleB, length: baseTriangleLength });
    const ok = await saveLocalExactGraph(
      graphParamsFromSequence({ ...row, sequenceText: effectiveSequenceText }, baseTriangleLength),
      GRAPH_HASH_ALGORITHM_VERSION,
      plotInfo.points,
      plotInfo.renderInfo?.durationMs ?? null,
      { title: row.title, graphColorHex: row.color, notes: row.notes, tags: row.tags, favorite: row.favorite, visibility: row.visibility, maxBounces },
    );
    setSavingGraphIds(prev => { const next = new Set(prev); next.delete(row.id); return next; });
    showSaveToast(
      ok ? '✓ Graph saved successfully.' : `Couldn't save ${row.label} — the graph database may be unavailable right now.`,
      !ok,
    );
  };

  // --- SEQUENCE ROW LIST HANDLERS ---
  // "+ Add Sequence": appends a new, empty, visible row and makes it active
  // (matches "click a row to edit it" — a freshly added row is the one the
  // user almost certainly wants to type into next).
  const handleAddSequence = () => {
    const number = nextSequenceNumberRef.current++;
    const newRow = createSequenceRow({ number, angleStepInput: angleIncrementInput });
    setSequences(rows => relabelSequenceRows([...rows, newRow]));
    setActiveSequenceId(newRow.id);
  };

  // Deletes a row. At least one row always exists: deleting the last
  // remaining row replaces it with a fresh blank one instead of leaving an
  // empty list. Deleting the active row hands "active" to a neighbor
  // (prefer the next row, fall back to the previous one) so the main
  // unfolding view always has something to show. Reads `sequences` directly
  // (a plain value, not a setSequences(rows => ...) functional updater)
  // rather than inside the updater — React StrictMode intentionally invokes
  // functional updaters twice in development to catch exactly this class of
  // bug: mutating a ref or calling other setState functions *inside* an
  // updater would run that side effect twice per click.
  const handleRemoveSequence = (id) => {
    const index = sequences.findIndex(row => row.id === id);
    if (index === -1) return;
    const remaining = sequences.filter(row => row.id !== id);
    const nextRows = relabelSequenceRows(
      remaining.length > 0
        ? remaining
        : [createSequenceRow({ number: nextSequenceNumberRef.current++, angleStepInput: angleIncrementInput })]
    );
    setSequences(nextRows);
    if (activeSequenceId === id) {
      const fallback = remaining[index] || remaining[index - 1] || nextRows[0];
      setActiveSequenceId(fallback.id);
      resetShotConstraintReference();
    }
  };

  // Visibility only hides a row from the graph and skips its background
  // generation — it never discards the row's text/step/cached points.
  const handleToggleSequenceVisible = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, visible: !row.visible } : row));
  };

  // Free typing only ever touches the draft buffer — never the applied
  // `sequenceText` that drives the main canvas/graph — so keystrokes
  // (including spaces) never trigger a redraw or get rewritten mid-edit.
  const handleSequenceDraftChange = (id, text) => {
    setSequences((rows) => rows.map((row) => {
      if (row.id !== id) return row;
      // If this row is currently showing a sequence-parse error, clear it
      // as soon as the draft is corrected (or intentionally emptied for
      // Angle-Ray-driven mode) so stale text does not linger at the bottom.
      if (row.validationErrorSource === 'sequence') {
        const trimmed = text.trim();
        if (!trimmed) {
          return { ...row, draftSequenceText: text, validationError: null, validationErrorSource: null };
        }
        const parsed = parseSequenceDraftText(text);
        if (parsed.valid) {
          return { ...row, draftSequenceText: text, validationError: null, validationErrorSource: null };
        }
      }
      return { ...row, draftSequenceText: text };
    }));
  };

  // Validates the row's draft and, only if valid, commits it as the applied
  // sequence (Enter — see the code field's own onKeyDown; blur no longer
  // triggers this). An invalid draft is left exactly as typed — this row's
  // validationError is set (for the "Invalid sequence" row status) and the
  // shared error modal explains why in plain English; nothing about the
  // graph or main canvas changes for an invalid apply.
  const handleApplySequenceDraft = (id) => {
    const row = sequences.find(r => r.id === id);
    if (!row) return true;
    // The code field unlocks as soon as Angle A/B are non-blank DRAFTS (see
    // anglesIncomplete), which can happen without either angle draft ever
    // having been applied — pressing Enter here first, before the angle
    // fields' own Enter. Apply those pending drafts now so they're
    // committed too, mirroring the same chain handlePlotSequenceNow already
    // runs. Note this does NOT make row.angleA/angleB reliable for the rest
    // of this function: setSequences queues an update rather than applying
    // it synchronously, so `row` (read once above) stays exactly as it was
    // — the Vertex Line Test check below explicitly passes the just-applied
    // draft angle values instead of relying on the (still stale-this-render)
    // angleParams memo.
    if (!applyAngleDrafts(id) || !applyAngleStepDraft(id)) return false;
    // See applyAngleDrafts' identical comment: matching the committed text
    // means nothing NEW to commit, but a stale Sequence error from an
    // earlier rejected draft (since retyped back to the last-valid text)
    // still needs to be cleared here. Gated to this field's own
    // 'sequence'-tagged errors so an unrelated Angle/Step error is untouched.
    if (row.draftSequenceText === row.sequenceText && !(row.validationError && row.validationErrorSource === 'sequence')) return true;
    // An intentionally-cleared code is now a valid state (this row may be
    // relying on its own Angle Ray instead — see
    // deriveEffectiveSequenceCode), so only a non-blank draft goes through
    // format validation; blank always commits straight through.
    if (row.draftSequenceText.trim()) {
      const parsed = parseSequenceDraftText(row.draftSequenceText);
      if (!parsed.valid) {
        const flat = parsed.sections.map(s => `${s.heading}:\n${s.text || (s.list || []).map(item => `• ${item}`).join('\n')}`).join('\n\n');
        setSequences(rows => rows.map(r => r.id === id ? { ...r, validationError: flat, validationErrorSource: 'sequence' } : r));
        setErrorModal({ title: parsed.title, sections: parsed.sections, focusId: id });
        return false;
      }
    }

    // Only the active row's code ever reaches the main canvas (billiardsCode
    // is derived from it — see its own definition), so only that row's edits
    // need the Vertex Line Test gate: committing must never let the main
    // canvas render, even briefly, a shot that fails it. Other rows' code
    // only feeds the "Valid Angle A-B Region" graph, which already validates
    // every candidate it plots before ever drawing a point (see
    // buildValidateCandidateForSequence) — nothing there is ever "partially
    // plotted" either.
    if (id === activeSequenceId) {
      // Pass the row's own (just-applied-above) draft angles explicitly —
      // see validateLockedCodeCandidate's comment on why the angleParams
      // memo can't be trusted here.
      const check = validateLockedCodeCandidate(row.draftSequenceText, { a: row.draftAngleA, b: row.draftAngleB, length: baseTriangleLength });
      if (!check.allowed) {
        const sections = buildVertexLineTestErrorSections(check.violations, clearanceEpsilon);
        const flat = sections.map(s => `${s.heading}:\n${s.text}`).join('\n\n');
        setSequences(rows => rows.map(r => r.id === id ? { ...r, validationError: flat, validationErrorSource: 'sequence' } : r));
        // focusId intentionally left unset: a Vertex Line Test failure can
        // be fixed via the code OR the angles, so forcibly refocusing the
        // code field on close (like a code *syntax* error does) would be a
        // guess at which one the user actually wants to edit next — and
        // risks stealing focus back from whichever field they've already
        // clicked into by the time the close-triggered refocus fires.
        setErrorModal({ title: 'Vertex Line Test is invalid.', sections, focusId: null });
        return false;
      }
    }

    setSequences(rows => rows.map(r => r.id === id ? { ...r, sequenceText: r.draftSequenceText, validationError: null, validationErrorSource: null } : r));
    if (id === activeSequenceId) resetShotConstraintReference();
    return true;
  };

  // Escape discards the in-progress edit and restores the last applied text.
  const handleCancelSequenceDraft = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, draftSequenceText: row.sequenceText, validationError: null, validationErrorSource: null } : row));
  };

  // Angle Ray needs none of the Code Sequence field's heavy
  // Vertex Line Test gating: it's only ever consulted when this row's own
  // Code Sequence is blank (see deriveEffectiveSequenceCode), and the code
  // it derives is traced from a real reflection path, so it can never fail
  // that test. A non-numeric or blank draft simply resolves to "no shot"
  // for this row rather than needing its own rejection/error path.
  const handleRayAngleDraftChange = (id, text) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, draftRayAngleInput: text } : row));
  };
  const handleApplyRayAngleDraft = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, rayAngleInput: row.draftRayAngleInput } : row));
  };
  const handleCancelRayAngleDraft = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, draftRayAngleInput: row.rayAngleInput } : row));
  };

  // Native color inputs always yield a valid #rrggbb value, but the guard
  // keeps this handler safe if it's ever driven by something else (e.g. a
  // pasted/typed value) — an invalid color is simply ignored, keeping the
  // row's previous valid color. Only the edited row's color changes.
  const handleSequenceColorChange = (id, hex) => {
    if (!isValidHexColor(hex)) return;
    setSequences(rows => rows.map(row => row.id === id ? { ...row, color: hex } : row));
  };

  const closeErrorModal = () => {
    const focusId = errorModal?.focusId;
    setErrorModal(null);
    if (focusId) {
      // Deferred so it runs after the modal has actually unmounted.
      setTimeout(() => sequenceInputRefsRef.current[focusId]?.focus(), 0);
    }
  };

  // "Active" (which row drives the main canvas) is a distinct concept from
  // "visible" (which rows are plotted in the graph) — selecting a row here
  // never touches any row's visibility.
  const handleSelectActiveSequence = (id) => {
    if (id === activeSequenceId) return;
    setActiveSequenceId(id);
    resetShotConstraintReference();
  };

  // Selecting a row from the Graph Plot legend does everything clicking its
  // own sidebar card already does, plus scrolls that card into view — the
  // legend can be scrolled independently of the sidebar list, so the two
  // don't stay in sync on their own.
  const handleSelectSequenceAndScrollToCard = (id) => {
    handleSelectActiveSequence(id);
    sequenceCardRefsRef.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const handleStableRegionSearch = () => {
    // Store a running state immediately so the button gives feedback during computation.
    setStableRegionResult({ status: 'running', message: 'Searching local x/y region...' });
    // Compute the bounded local stability region synchronously from the current state.
    const result = findStableRegion({ angleParams, labelsMap, billiardsCode, currentCodeData: codeData, clearanceEpsilon });
    // Store the result for the inspector panel.
    setStableRegionResult(result);
  };

  // --- INTERACTION HANDLERS ---
  const handleMouseDown = (e) => {
    // Only left-click drags should pan the mathematical viewport.
    if (e.button !== 0) return; 
    // Enter dragging mode so mousemove updates pan instead of hover labels.
    setIsDragging(true);
    // Remember the starting screen point for delta calculations.
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };
  
  const handleMouseMove = (e) => {
    // During drag, translate screen-pixel deltas back into math-unit deltas.
    if (isDragging) {
      // Divide by zoom because zoom is pixels per math unit.
      const dx = (e.clientX - lastMouse.current.x) / zoom;
      // SVG screen y grows downward while math y grows upward.
      const dy = (e.clientY - lastMouse.current.y) / zoom;
      // Move the center opposite the drag direction for natural canvas panning.
      setPan(prev => ({ x: prev.x - dx, y: prev.y + dy }));
      // Update the previous mouse point for the next delta.
      lastMouse.current = { x: e.clientX, y: e.clientY };
    } else {
      // Hover labels use screen coordinates and are disabled when all labels are pinned.
      if (containerRef.current && !showAllLabels) {
        // Convert page coordinates into coordinates relative to the SVG container.
        const rect = containerRef.current.getBoundingClientRect();
        setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
    }
  };
  
  // Any mouse release or canvas leave ends pan mode.
  const handleMouseUp = () => setIsDragging(false);

  const handleFitScreen = () => {
    // Include the base triangle and whatever reflected chain is active.
    const allTris = [baseTriangle, ...activeTriangles];
    // Defensive guard: there is normally always at least the base triangle.
    if (allTris.length === 0) return;
    
    // Initialize bounds so the first point always expands them.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Sweep every vertex in mathematical coordinates.
    allTris.forEach(tri => tri.points.forEach(p => {
        // Expand left bound.
        if (p.x < minX) minX = p.x;
        // Expand right bound.
        if (p.x > maxX) maxX = p.x;
        // Expand bottom bound.
        if (p.y < minY) minY = p.y;
        // Expand top bound.
        if (p.y > maxY) maxY = p.y;
    }));
    
    // Avoid zero-width fit boxes for degenerate inputs.
    const w = Math.max(maxX - minX, 1);
    // Avoid zero-height fit boxes for degenerate inputs.
    const h = Math.max(maxY - minY, 1);
    // Center the viewport on the geometry bounds.
    setPan({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
    // Choose the largest zoom that leaves about 50 px padding per side.
    setZoom(Math.min((svgSize.width - 100) / w, (svgSize.height - 100) / h));
  };

  // Manual zoom-in click applies the user-entered magnification, ignoring wheel/trackpad input entirely.
  const handleManualZoomIn = () => {
    const factor = parseFloat(zoomMagnification);
    if (!Number.isFinite(factor) || factor <= 0) return;
    setZoom(prev => Math.max(0.5, Math.min(prev * factor, 5000)));
  };

  // Manual zoom-out click divides by the same user-entered magnification.
  const handleManualZoomOut = () => {
    const factor = parseFloat(zoomMagnification);
    if (!Number.isFinite(factor) || factor <= 0) return;
    setZoom(prev => Math.max(0.5, Math.min(prev / factor, 5000)));
  };

  // --- RENDERING HELPERS ---
  // The SVG group transform maps mathematical coordinates into screen pixels.
  const transformStr = `translate(${svgSize.width / 2}, ${svgSize.height / 2}) scale(${zoom}, ${-zoom}) translate(${-pan.x}, ${-pan.y})`;
  // Convert a math x coordinate to screen-space x for unscaled annotations.
  const toSvgX = (x) => svgSize.width / 2 + (x - pan.x) * zoom;
  // Convert a math y coordinate to screen-space y; sign flips because SVG y points down.
  const toSvgY = (y) => svgSize.height / 2 - (y - pan.y) * zoom; 
  
  const grid = useMemo(() => {
    // Use finer grid spacing as the user zooms in.
    const step = zoom > 150 ? 1 : zoom > 50 ? 2 : zoom > 15 ? 10 : 50;
    
    // Left visible math coordinate.
    const minMathX = pan.x - (svgSize.width / 2) / zoom;
    // Right visible math coordinate.
    const maxMathX = pan.x + (svgSize.width / 2) / zoom;
    // Bottom visible math coordinate.
    const minMathY = pan.y - (svgSize.height / 2) / zoom;
    // Top visible math coordinate.
    const maxMathY = pan.y + (svgSize.height / 2) / zoom;

    // Separate arrays drive vertical and horizontal SVG line generation.
    const linesX = [], linesY = [];
    // Start on the first visible multiple of the chosen step.
    for (let x = Math.floor(minMathX / step) * step; x <= maxMathX; x += step) linesX.push(x);
    // Do the same for horizontal grid coordinates.
    for (let y = Math.floor(minMathY / step) * step; y <= maxMathY; y += step) linesY.push(y);
    // Return both line coordinates and visible bounds for SVG line endpoints.
    return { linesX, linesY, minMathX, maxMathX, minMathY, maxMathY };
  }, [pan, zoom, svgSize]);


  return (
    <div data-theme={theme} className={`app-theme app-theme-${theme} relative flex h-screen w-full min-w-0 bg-[#080b0f] text-slate-200 font-sans overflow-hidden`}>

      {/* Floating "show sidebar" button — only rendered while the sidebar
          itself is hidden, so there's always exactly one way to reach it. */}
      {!isSidebarVisible && (
        <button
          type="button"
          onClick={() => setIsSidebarVisible(true)}
          title="Show sidebar"
          aria-label="Show sidebar"
          className="absolute top-3 left-3 z-20 flex items-center gap-1 bg-[#10151c] border border-white/10 text-slate-300 hover:text-cyan-200 hover:border-cyan-300/30 px-2 py-2 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.4)] transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}

      {/* LEFT PANEL - CONTROLS & INSPECTOR */}
      {isSidebarVisible && (
      <div className="w-[340px] 2xl:w-[360px] border-r border-white/10 flex flex-col bg-[#10151c] shadow-[12px_0_36px_rgba(0,0,0,0.32)] z-10 overflow-hidden shrink-0">

        {/* App Header & Tabs */}
        <div className="pt-8 pb-0 px-5 border-b border-white/10 bg-[#0c1117] shrink-0">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-100 tracking-tight flex items-center gap-2 mb-1">
                <Activity className="w-5 h-5 text-cyan-300" /> illuminable-room-modeler
              </h1>
              <p className="text-[11px] font-medium text-slate-500 uppercase tracking-widest">illuminable-room-modeler</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setIsSidebarVisible(false)}
                title="Hide sidebar"
                aria-label="Hide sidebar"
                className="flex items-center justify-center bg-[#0b1016] hover:bg-[#172230] border border-white/10 text-slate-400 hover:text-cyan-200 rounded-md px-2 transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}
                className="theme-toggle"
                aria-pressed={isDarkTheme}
                aria-label={`Switch to ${isDarkTheme ? 'light' : 'dark'} mode`}
                title={`Switch to ${isDarkTheme ? 'light' : 'dark'} mode`}
              >
                {isDarkTheme ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                <span>{isDarkTheme ? 'Light' : 'Dark'}</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-[#070b10] p-1">
            <button
              onClick={() => setSimulatorMode('code')}
              title="Unfold a code sequence or a traced Angle Ray, per graph."
              className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-all flex items-center justify-center gap-1 whitespace-nowrap ${simulatorMode === 'code' ? 'bg-cyan-300/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
            >
              <Code2 className="w-4 h-4"/> Unfold Code
            </button>
          
            <button 
              onClick={() => setSimulatorMode('graph')}
              title="View the region of valid angle pairs."
              className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-all flex items-center justify-center gap-1 whitespace-nowrap ${simulatorMode === 'graph' ? 'bg-violet-400/20 text-violet-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
            >
              <Activity className="w-4 h-4"/> Graph Plot
            </button></div>
        </div>

        {/* Scrollable Inspector Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar bg-[#0f141a]">
          
          {/* BASE GEOMETRY CONFIG */}
          <div className="p-4 bg-[#151c24] m-3 rounded-lg shadow-[0_8px_28px_rgba(0,0,0,0.28)] border border-white/10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs uppercase tracking-wider font-bold text-slate-400 flex items-center gap-1.5">
                <Settings2 className="w-3.5 h-3.5"/> Base Geometry
              </h2>
              <div className="flex bg-[#0b1016] p-0.5 rounded-md border border-white/10">
                <button
                  onClick={() => { resetShotConstraintReference(); setBaseInputMode('coords'); }}
                  title="Enter all three triangle vertices as coordinates."
                  className={`px-2 py-1 text-[10px] font-bold rounded ${baseInputMode === 'coords' ? 'bg-cyan-400/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200'}`}
                >
                  Coordinates
                </button>
                <button
                  onClick={() => { resetShotConstraintReference(); setBaseInputMode('angles'); }}
                  title="Enter two angles and a base length."
                  className={`px-2 py-1 text-[10px] font-bold rounded ${baseInputMode === 'angles' ? 'bg-cyan-400/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200'}`}
                >
                  Angles
                </button>
              </div>
            </div>

            {baseInputMode === 'coords' ? (
              <div className="space-y-2.5">
                {[0, 1, 2].map(i => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-slate-500 w-12 text-right mr-1">{['A', 'B', 'C'][i]} (V{i})</span>
                    <input type="text" value={baseCoordsInput[i].x} onChange={e => {
                      const newCoords = [...baseCoordsInput];
                      newCoords[i].x = e.target.value;
                      resetShotConstraintReference();
                      setBaseCoordsInput(newCoords);
                    }} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 placeholder:text-slate-600 transition-all" placeholder="x" />
                    <input type="text" value={baseCoordsInput[i].y} onChange={e => {
                      const newCoords = [...baseCoordsInput];
                      newCoords[i].y = e.target.value;
                      resetShotConstraintReference();
                      setBaseCoordsInput(newCoords);
                    }} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 placeholder:text-slate-600 transition-all" placeholder="y" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2.5">
                {/* Angle A, Angle B, Angle Step, Angle Ray, and Plot
                    Valid Angle Region all live on each graph's own card
                    (Sequence Parser list below) so every graph keeps fully
                    independent values —
                    Base Length is the only geometry value every graph
                    still shares. Its input lives in the compact row below,
                    beside Display Decimals. */}
                {lockedShotNotice && lockedShotNotice.isLengthField && (
                  <div className="text-[10px] text-amber-100 mt-1 font-medium bg-amber-500/10 rounded py-1.5 px-2 border border-amber-300/20 space-y-1">
                    <div className="font-bold">Base Length of {lockedShotNotice.value} was not applied.</div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {lockedShotNotice.requiredConstraints.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                    <div><span className="font-bold">How to fix it:</span> {lockedShotNotice.howToFix}</div>
                  </div>
                )}
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Angle A, Angle B, Angle Step, Angle Ray, and Plot Valid Angle Region are set per graph in the Sequence Parser list below.
                </p>
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-white/10 flex items-end gap-3">
              {baseInputMode === 'angles' && (
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Base Length</span>
                  <input
                    type="number"
                    step="any"
                    value={angleParams.length}
                    onChange={e => handleAngleParamChange('length', e.target.value)}
                    placeholder="Length"
                    className="w-16 bg-[#0b1016] border border-white/10 rounded-md px-2 py-1 text-xs text-center focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 placeholder:text-slate-600 transition-all"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Display Decimals</span>
                <input
                  type="number"
                  min="0"
                  max={MAX_DISPLAY_DECIMALS}
                  step="1"
                  value={displayPrecisionInput}
                  onChange={e => setDisplayPrecisionInput(e.target.value)}
                  title={`Number of decimal places shown in readouts, clamped from 0 to ${MAX_DISPLAY_DECIMALS}.`}
                  className="w-16 bg-[#0b1016] border border-white/10 rounded-md px-2 py-1 text-xs text-center focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Max Bounces</span>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  value={maxBounces}
                  onChange={e => setMaxBounces(parseInt(e.target.value))}
                  title="Safety cap on how many reflections a graph's Angle Ray is traced through before giving up."
                  className="w-16 bg-[#0b1016] border border-white/10 rounded-md px-2 py-1 text-xs text-center focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all"
                />
              </label>
            </div>
          </div>

          {/* SIMULATOR PARAMETERS */}
          <div className="p-4 bg-[#151c24] m-3 rounded-lg shadow-[0_8px_28px_rgba(0,0,0,0.28)] border border-white/10">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs uppercase tracking-wider font-bold text-cyan-200 flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5" /> Graphs
                </h2>
                <span className="text-[10px] font-mono text-slate-500">{sequences.length} graph{sequences.length === 1 ? '' : 's'}</span>
              </div>
              <p className="text-[10px] text-slate-500 mb-2 leading-relaxed">
                Each card is one independent graph with its own code, Angle A/B, Angle Step, Angle Ray, and color, plotted together on the shared Valid Angle A-B Region graph. A graph needs either a Code Sequence or a Angle Ray (Code Sequence wins if both are given). Click a card to make it the active unfolding shown on the main canvas.
              </p>
              <div className="mb-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsGraphSetupOpen(true)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-cyan-300/35 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-bold text-cyan-100 transition-colors hover:bg-cyan-500/25"
                >
                  <Settings2 className="w-3.5 h-3.5" /> Graph Setup
                </button>
                <button
                  type="button"
                  onClick={() => setIsGraphLibraryOpen(true)}
                  title="Browse, search, and load graphs already computed and shared to the library"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-cyan-300/35 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-bold text-cyan-100 transition-colors hover:bg-cyan-500/25"
                >
                  <Library className="w-3.5 h-3.5" /> Graph Library
                </button>
                <button
                  type="button"
                  onClick={() => setIsGraphDatabaseOpen(true)}
                  title="Search, sort, rename, tag, favorite, annotate, and instantly reload every graph permanently cached on this machine"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-emerald-300/35 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-bold text-emerald-100 transition-colors hover:bg-emerald-500/25"
                >
                  <Database className="w-3.5 h-3.5" /> Graph Database
                </button>
              </div>

              {/* One independent card per graph. Bounded height + its own
                  scrollbar (not the whole sidebar's) so adding many graphs
                  can never push Constrained/Unconstrained/Search or the rest of the
                  sidebar off screen. */}
              <div ref={sequenceListRef} className="space-y-2 max-h-[32rem] overflow-y-auto custom-scrollbar pr-0.5 -mr-0.5">
                {sequences.map(row => {
                  const isActive = row.id === activeSequenceId;
                  const parsedStep = parseAngleStep(row.angleStepInput);
                  // A sequence code is meaningless without a base triangle,
                  // so typing is blocked entirely until this row's own
                  // Angle A and B are both set — see the sequence input
                  // below. Reads the DRAFTS, not the applied values: since
                  // nothing auto-commits on blur anymore (validation only
                  // fires on Enter/Plot), gating this on the applied value
                  // would leave the code field locked forever once you type
                  // A and B and move on without pressing Enter on either —
                  // exactly the "my input isn't working" deadlock this
                  // avoids. Whatever's typed still only actually validates
                  // at Enter/Plot time, same as every other field.
                  const anglesIncomplete = row.draftAngleA === '' || row.draftAngleB === '';
                  // Whenever this row's own Code Sequence is set (Code
                  // Sequence always wins — see deriveEffectiveSequenceCode),
                  // its Angle Ray field shows that code's own Global
                  // Angle (computed in codeDataByRowId) instead of an
                  // editable draft, since the typed angle is ignored anyway.
                  const isRowCodeDriven = row.sequenceText.trim().length > 0;
                  const rowGlobalAngle = codeDataByRowId[row.id]?.globalAngleDegrees;
                  // The code actually driving this row right now — typed
                  // verbatim when code-driven, or the code traced back from
                  // this row's own Angle Ray otherwise (see
                  // deriveEffectiveSequenceCode). Used so the Angle Ray's
                  // generated angle and the Angle Ray's derived code can both
                  // be copied straight out of this card, in either direction.
                  const rowEffectiveCode = codeDataByRowId[row.id]?.effectiveCode || '';
                  // The Code Sequence field itself shows this row's own
                  // Angle-Ray-derived code whenever it's angle-driven (the
                  // typed field is genuinely blank in that case) and not the
                  // one currently being typed into — mirrors
                  // showComputedRayAngle's exact same pattern, just for the
                  // other field. A code-driven row never needs this: its
                  // draft already holds the real typed text.
                  const showComputedSequenceText = !isRowCodeDriven && !!rowEffectiveCode && focusedSequenceRowId !== row.id;
                  // Angle Ray must always read back the same value as
                  // Global Angle (see codeDataByRowId's own comment on why
                  // the two previously disagreed for angle-driven rows): at
                  // rest it mirrors the computed Global Angle unconditionally
                  // — code-driven or angle-driven — falling back to the raw
                  // draft only while this exact field is being actively
                  // typed into (so the number a user is mid-typing doesn't
                  // get overwritten under their cursor) or when there's no
                  // valid computed result yet.
                  const showComputedRayAngle = Number.isFinite(rowGlobalAngle) && (isRowCodeDriven || focusedRayAngleRowId !== row.id);
                  const plotInfo = plotStatusById[row.id];
                  const isPlotting = plotInfo?.status === 'running';
                  // codeDataByRowId's own shotStatus (the Vertex Line Test,
                  // computed for THIS row specifically — see its own
                  // comment) is a *geometric* check of this row's own
                  // current committed code+angles, a completely separate
                  // concern from plotInfo.status (whether the region SWEEP
                  // finished generating). A sweep can finish fine
                  // ("Plotted") while this row's own exact point still
                  // fails its own Vertex Line Test, which must never read
                  // as "Plotted" — checked for every row, not just the
                  // active one, and regardless of which tab is showing.
                  const isRowShotInvalid = codeDataByRowId[row.id]?.shotStatus === 'invalid';
                  // Status line uses the professor's requested vocabulary
                  // (Not plotted / Calculating.../Plotted/Hidden/Error),
                  // with "Needs angles" as a more actionable, more specific
                  // stand-in for the "can't plot yet" case than a bare
                  // "Error" would be.
                  const plotPhase = !row.visible ? 'Hidden'
                    : anglesIncomplete ? 'Needs angles'
                    : row.validationError ? 'Error'
                    : isRowShotInvalid ? 'Error'
                    : isPlotting ? 'Calculating…'
                    : plotInfo?.status === 'invalid' ? 'Error'
                    : plotInfo?.status === 'done' ? 'Plotted'
                    : 'Not plotted';
                  const plotPhaseColor = plotPhase === 'Plotted' ? 'text-emerald-300'
                    : plotPhase === 'Calculating…' ? 'text-amber-300'
                    : plotPhase === 'Hidden' ? 'text-slate-600'
                    : plotPhase === 'Not plotted' ? 'text-slate-500'
                    : 'text-red-300';
                  // Also reads the sequence DRAFT, not the applied text, for
                  // the same reason as anglesIncomplete above: a freshly
                  // typed code that was never separately committed must
                  // still be able to enable this button, since clicking it
                  // (handlePlotSequenceNow) is exactly what applies every
                  // pending draft — angles, step, and code together — before
                  // plotting.
                  const canPlotNow = !anglesIncomplete && (!!row.draftSequenceText.trim() || !!row.draftRayAngleInput.trim()) && !isPlotting;
                  // "Save Graph" needs the row's *exact* (brute-force-complete)
                  // geometry, not just any "done" status — see
                  // handleSaveGraphNow's own comment on why an adaptive-only
                  // preview must never be persisted as if it were permanent.
                  const isExactlyPlotted = plotInfo?.renderInfo?.graphStatus === GRAPH_STATUS.EXACT;
                  const canSaveGraphNow = isExactlyPlotted && !!plotInfo?.points?.length && !savingGraphIds.has(row.id);
                  return (
                    <div
                      key={row.id}
                      ref={el => { sequenceCardRefsRef.current[row.id] = el; }}
                      onClick={() => handleSelectActiveSequence(row.id)}
                      role="radio"
                      aria-checked={isActive}
                      tabIndex={0}
                      onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectActiveSequence(row.id); } }}
                      title={row.sequenceText ? `${row.label}: ${row.sequenceText}` : `${row.label}: (empty sequence)`}
                      className={`rounded-md border px-2 py-1.5 cursor-pointer transition-colors ${isActive ? 'border-amber-400/60 bg-amber-500/20' : 'border-white/10 bg-[#0b1016]'}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 border ${isActive ? 'bg-cyan-300 border-cyan-300' : 'bg-transparent border-slate-600'}`}
                          aria-hidden="true"
                          title={isActive ? `${row.label} is active in the main canvas` : `Click to make ${row.label} active in the main canvas`}
                        />
                        <input
                          type="checkbox"
                          checked={row.visible}
                          onChange={() => handleToggleSequenceVisible(row.id)}
                          onClick={e => e.stopPropagation()}
                          aria-label={`Show ${row.label} in the graph`}
                          title={row.visible ? `Hide ${row.label} from the graph` : `Show ${row.label} in the graph`}
                          className="w-3 h-3 shrink-0 accent-cyan-400"
                        />
                        <input
                          type="color"
                          value={row.color}
                          onChange={e => handleSequenceColorChange(row.id, e.target.value)}
                          onClick={e => e.stopPropagation()}
                          aria-label={`${row.label} graph color`}
                          title={`Choose ${row.label}'s dot/legend color`}
                          className="w-3.5 h-3.5 shrink-0 rounded-full border border-black/30 p-0 bg-transparent cursor-pointer appearance-none overflow-hidden"
                        />
                        <span className={`text-[10px] font-bold shrink-0 ${isActive ? 'text-cyan-200' : 'text-slate-400'}`}>{row.label}</span>
                        <span className="flex-1" />
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleRemoveSequence(row.id); }}
                          title={`Delete ${row.label}`}
                          aria-label={`Delete ${row.label}`}
                          className="shrink-0 text-slate-500 hover:text-red-300 p-0.5"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {/* Angle A / Angle B: Type freely, Enter or blur applies it. */}
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <label className="flex items-center gap-1 flex-1 min-w-0">
                          <span className="text-[10px] font-bold text-slate-500 shrink-0">A</span>
                          <input
                            type="number"
                            step={angleInputStep}
                            value={row.draftAngleA}
                            onFocus={() => handleSelectActiveSequence(row.id)}
                            onBlur={() => applyAngleDrafts(row.id)}
                            onChange={e => { e.stopPropagation(); handleAngleDraftChange(row.id, 'a', e.target.value); }}
                            onKeyDown={e => {
                              e.stopPropagation();
                              if (e.key === 'Enter') { e.preventDefault(); applyAngleDrafts(row.id); }
                              else if (e.key === 'Escape') { e.preventDefault(); handleCancelAngleDraft(row.id); e.currentTarget.blur(); }
                            }}
                            onClick={e => e.stopPropagation()}
                            placeholder="e.g. 15"
                            aria-label={`${row.label} Angle A`}
                            title="Press Enter or click away to apply, Escape to discard the edit."
                            className="w-full min-w-0 bg-[#080b0f] border border-white/10 rounded px-1.5 py-1 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
                          />
                        </label>
                        <label className="flex items-center gap-1 flex-1 min-w-0">
                          <span className="text-[10px] font-bold text-slate-500 shrink-0">B</span>
                          <input
                            type="number"
                            step={angleInputStep}
                            value={row.draftAngleB}
                            onFocus={() => handleSelectActiveSequence(row.id)}
                            onBlur={() => applyAngleDrafts(row.id)}
                            onChange={e => { e.stopPropagation(); handleAngleDraftChange(row.id, 'b', e.target.value); }}
                            onKeyDown={e => {
                              e.stopPropagation();
                              if (e.key === 'Enter') { e.preventDefault(); applyAngleDrafts(row.id); }
                              else if (e.key === 'Escape') { e.preventDefault(); handleCancelAngleDraft(row.id); e.currentTarget.blur(); }
                            }}
                            onClick={e => e.stopPropagation()}
                            placeholder="e.g. 50"
                            aria-label={`${row.label} Angle B`}
                            title="Press Enter or click away to apply, Escape to discard the edit."
                            className="w-full min-w-0 bg-[#080b0f] border border-white/10 rounded px-1.5 py-1 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
                          />
                        </label>
                      </div>
                      {/* Angle Step and Step Increment each get a full half
                          of the card's width (not a third shared with A/B)
                          so a long/precise step value is actually readable
                          instead of clipped in a cramped box. Angle Step
                          follows the same type-freely/apply-on-Enter model
                          as A/B above. */}
                      <div className="flex items-center gap-1.5 mt-1">
                        <label className="flex items-center gap-1 flex-1 min-w-0">
                          <span className="text-[10px] font-bold text-slate-500 shrink-0">Step</span>
                          <input
                            type="number"
                            min="0"
                            step={angleStepControlIncrement}
                            value={row.draftAngleStepInput}
                            onChange={e => { e.stopPropagation(); handleAngleStepDraftChange(row.id, e.target.value); }}
                            onKeyDown={e => {
                              e.stopPropagation();
                              if (e.key === 'Enter') { e.preventDefault(); applyAngleStepDraft(row.id); }
                              else if (e.key === 'Escape') { e.preventDefault(); handleCancelAngleStepDraft(row.id); e.currentTarget.blur(); }
                            }}
                            onClick={e => e.stopPropagation()}
                            title="Press Enter to apply, Escape to discard the edit."
                            aria-label={`${row.label} Angle Step`}
                            className="w-full min-w-0 bg-[#080b0f] border border-white/10 rounded px-1.5 py-1 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
                          />
                        </label>
                        <label className="flex items-center gap-1 flex-1 min-w-0">
                          <span className="text-[10px] font-bold text-slate-500 shrink-0">Increment</span>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={angleStepControlIncrementInput}
                            onChange={e => { e.stopPropagation(); setAngleStepControlIncrementInput(e.target.value); }}
                            onClick={e => e.stopPropagation()}
                            title="Native spinner/arrow increment used by every graph's Angle Step field."
                            aria-label="Angle Step spinner increment"
                            className="w-full min-w-0 bg-[#080b0f] border border-white/10 rounded px-1.5 py-1 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
                          />
                        </label>
                      </div>
                      {/* Full-width sequence field on its own line so long
                          codes are actually readable instead of clipped
                          beside other controls. Kept `readOnly` (not
                          `disabled`) while angles are incomplete so a click
                          still fires and can explain why, instead of the
                          browser silently swallowing it. */}
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-500">Code Seq.</span>
                        {rowEffectiveCode && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(rowEffectiveCode); }}
                            title={isRowCodeDriven ? 'Copy this code sequence' : `Copy the code sequence derived from ${row.label}'s Angle Ray`}
                            className="text-[9px] font-bold text-slate-500 hover:text-cyan-200 transition-colors flex items-center gap-0.5"
                          >
                            <Copy className="w-2.5 h-2.5" /> Copy
                          </button>
                        )}
                      </div>
                      <input
                        type="text"
                        ref={el => { sequenceInputRefsRef.current[row.id] = el; }}
                        value={showComputedSequenceText ? rowEffectiveCode : row.draftSequenceText}
                        readOnly={anglesIncomplete}
                        onChange={e => handleSequenceDraftChange(row.id, e.target.value)}
                        onMouseDown={e => {
                          if (!anglesIncomplete) { e.stopPropagation(); return; }
                          e.preventDefault();
                          e.stopPropagation();
                          handleSelectActiveSequence(row.id);
                          setErrorModal({
                            title: 'Enter Angle A and Angle B first',
                            sections: [
                              { heading: 'Problem', text: `${row.label} does not have Angle A and Angle B set yet, so it has no base triangle to unfold a code against.` },
                              { heading: 'How to fix it', text: `Enter Angle A and Angle B above on ${row.label}'s own card. Once both are set, you can type this sequence's code.` },
                            ],
                            focusId: null,
                          });
                        }}
                        onFocus={() => { handleSelectActiveSequence(row.id); setFocusedSequenceRowId(row.id); }}
                        onBlur={() => setFocusedSequenceRowId(null)}
                        onKeyDown={e => {
                          e.stopPropagation();
                          if (anglesIncomplete) { e.preventDefault(); return; }
                          if (e.key === 'Enter') { e.preventDefault(); handleApplySequenceDraft(row.id); }
                          else if (e.key === 'Escape') { e.preventDefault(); handleCancelSequenceDraft(row.id); e.currentTarget.blur(); }
                        }}
                        placeholder={anglesIncomplete ? 'Enter Angle A/B above first' : 'Enter Code Sequence'}
                        aria-label={`${row.label} sequence text`}
                        aria-disabled={anglesIncomplete}
                        title={anglesIncomplete ? `Set ${row.label}'s Angle A and Angle B above before entering a code.` : showComputedSequenceText ? `Derived from ${row.label}'s Angle Ray — type here to override with your own code instead.` : 'Type freely, including spaces. Press Enter to apply, Escape to discard the edit.'}
                        className={`mt-1.5 w-full bg-[#080b0f] border rounded px-2 py-1 text-[11px] font-mono outline-none placeholder:text-slate-600 ${anglesIncomplete ? 'border-white/5 text-slate-600 cursor-not-allowed' : 'border-white/10 text-slate-100 focus:border-cyan-300/50'}`}
                      />
                      {/* Angle Ray: an alternate way to give this
                          graph a shot without typing a code — only
                          consulted when the Code Sequence above is blank
                          (see deriveEffectiveSequenceCode; a non-blank Code
                          Sequence always wins). Traced from vertex A, same
                          as the old standalone Trace Ray tab. At rest, this
                          field always mirrors this shot's own Global Angle
                          (see showComputedRayAngle) rather than the raw
                          typed value, so it can never disagree with the
                          Shot Vector panel's own "Global Angle" readout. */}
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-500">Angle Ray</span>
                        {showComputedRayAngle && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(formatAngleDisplay(rowGlobalAngle)); }}
                            title={isRowCodeDriven ? `Copy the angle generated by ${row.label}'s Code Sequence` : 'Copy this angle'}
                            className="text-[9px] font-bold text-slate-500 hover:text-amber-200 transition-colors flex items-center gap-0.5"
                          >
                            <Copy className="w-2.5 h-2.5" /> Copy
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="relative flex-1">
                          <input
                            type="number"
                            step={angleInputStep}
                            readOnly={anglesIncomplete || isRowCodeDriven}
                            value={showComputedRayAngle ? formatAngleDisplay(rowGlobalAngle) : row.draftRayAngleInput}
                            onChange={e => handleRayAngleDraftChange(row.id, e.target.value)}
                            onFocus={() => { handleSelectActiveSequence(row.id); setFocusedRayAngleRowId(row.id); }}
                            onBlur={() => { handleApplyRayAngleDraft(row.id); setFocusedRayAngleRowId(null); }}
                            onKeyDown={e => {
                              e.stopPropagation();
                              if (anglesIncomplete || isRowCodeDriven) { e.preventDefault(); return; }
                              if (e.key === 'Enter') { e.preventDefault(); handleApplyRayAngleDraft(row.id); }
                              else if (e.key === 'Escape') { e.preventDefault(); handleCancelRayAngleDraft(row.id); e.currentTarget.blur(); }
                            }}
                            onClick={e => e.stopPropagation()}
                            placeholder="Enter Angle Ray"
                            aria-label={`${row.label} angle ray`}
                            title={isRowCodeDriven ? `${row.label}'s Code Sequence above is set, so this shows that code's own Global Angle instead of an editable value.` : `Traced from vertex A; used only while ${row.label}'s Code Sequence above is empty. Shows this shot's own Global Angle once applied.`}
                            className={`w-full bg-[#080b0f] border rounded px-2 py-1 pr-5 text-[11px] font-mono outline-none placeholder:text-slate-600 ${anglesIncomplete || isRowCodeDriven ? 'border-white/5 text-slate-600 cursor-not-allowed' : 'border-white/10 text-slate-100 focus:border-amber-300/50'}`}
                          />
                          <span className="absolute right-1.5 top-1 text-slate-500 font-mono text-[10px]">&deg;</span>
                        </div>
                      </div>
                      {/* Unfolded Sequence + Boundary Intersections: this
                          row's own derived readouts, shown right below its
                          own Code Sequence/Angle Ray in the same card
                          — mirrors the active row's Sequence Logs panel, but
                          computed against this row's own Angle A/B/length
                          (see codeDataByRowId) and, critically, from
                          whichever of the two inputs is actually driving
                          this row (deriveEffectiveSequenceCode): typing a
                          Code Sequence shows its Unfolded Sequence here just
                          as before, and typing a Angle Ray now shows
                          the exact same thing for the code that angle
                          derives — both directions always show both
                          readouts. Hidden until there's a real sequence to
                          report against a valid triangle. */}
                      {codeDataByRowId[row.id]?.parsedSequence?.length > 0 && (
                        <>
                          <div className="mt-1 flex items-center justify-between">
                            <span className="text-[10px] font-bold text-slate-500">Code Seq.</span>
                            {rowEffectiveCode && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(rowEffectiveCode); }}
                                title={isRowCodeDriven ? 'Copy this code sequence' : `Copy the code sequence derived from ${row.label}'s Angle Ray`}
                                className="text-[9px] font-bold text-slate-500 hover:text-cyan-200 transition-colors flex items-center gap-0.5"
                              >
                                <Copy className="w-2.5 h-2.5" /> Copy
                              </button>
                            )}
                          </div>
                          <div className="bg-[#080b0f] border border-white/10 rounded px-2 py-1 flex flex-wrap gap-1">
                            {codeDataByRowId[row.id].parsedSequence.map((step, idx) => (
                              <span key={idx} className="bg-[#151c24] text-slate-200 text-[9px] font-mono px-1 py-0.5 rounded border border-white/10 flex items-center">
                                {step.count}<span className="text-cyan-300 font-bold ml-0.5">{step.angle}</span>
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                      {/* Boundary Intersections: the trailing entry is
                          dropped for the same reason the active row's own
                          Sequence Logs panel drops it (the unfolded path's
                          last landing is a vertex, not a genuine side
                          crossing) — must always match that panel's own
                          count exactly for the same graph. */}
                      {codeDataByRowId[row.id]?.sideSequence?.length > 0 && (
                        <>
                          <span className="mt-1 block text-[10px] font-bold text-slate-500">Side Seq.</span>
                          <div className="bg-[#080b0f] border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-slate-400 tracking-widest break-words">
                            {codeDataByRowId[row.id].sideSequence.slice(0, -1).join('')}
                          </div>
                        </>
                      )}
                      {/* Theta: this row's own symbolic angle equation,
                          reusing the exact same X/Y/Z classification as
                          Code Seq./Side Seq. above (codeDataByRowId's own
                          parsedSequence — never a separately-guessed
                          classification) with alternating signs applied by
                          position (see theta.js). Always shown, unlike
                          Code Seq./Side Seq./Unfolded Sequence, since an
                          invalid/empty code still has a well-defined
                          "θ = —" per this feature's own requirement. */}
                      <span className="mt-1 block text-[10px] font-bold text-slate-500">Theta</span>
                      <div className="bg-[#080b0f] border border-white/10 rounded px-2 py-1 text-[11px] font-mono text-slate-200">
                        {formatTheta(calculateTheta(codeDataByRowId[row.id]?.parsedSequence))}
                      </div>
                      {/* Per-graph "Plot Valid Angle Region": validates and
                          calculates only this graph, on the same shared
                          coordinate system as every other graph — see
                          handlePlotSequenceNow. */}
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); handlePlotSequenceNow(row.id); }}
                        disabled={!canPlotNow}
                        title={anglesIncomplete ? 'Set Angle A and Angle B first' : (!row.draftSequenceText.trim() && !row.draftRayAngleInput.trim()) ? 'Enter a Code Sequence or a Angle Ray first' : `Calculate and plot ${row.label} on the shared Valid Angle A-B Region graph`}
                        className="mt-1.5 w-full flex items-center justify-center gap-1.5 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed border border-cyan-300/30 text-cyan-100 px-2.5 py-1 rounded-md text-[10px] font-bold transition-colors"
                      >
                        {isPlotting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScatterChart className="w-3 h-3" />}
                        {isPlotting ? 'Calculating…' : 'Plot Valid Angle Region'}
                      </button>
                      {/* "Save Graph": persists this row's already-plotted
                          points to the shared GraphDatabase right now (see
                          handleSaveGraphNow — reuses the exact same
                          saveLocalExactGraph call the automatic
                          background-exact save already makes). "Open Graph
                          Database": the same browser the sidebar's own
                          "Graph Database" button opens (see
                          setIsGraphDatabaseOpen below), placed here too so
                          saving and browsing the result are one click apart. */}
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleSaveGraphNow(row); }}
                          disabled={!canSaveGraphNow}
                          title={canSaveGraphNow ? `Save ${row.label} to the Graph Database now` : `Plot ${row.label} and wait for its exact computation to finish before it can be saved`}
                          className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed border border-emerald-300/30 text-emerald-100 px-2.5 py-1 rounded-md text-[10px] font-bold transition-colors"
                        >
                          {savingGraphIds.has(row.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                          {savingGraphIds.has(row.id) ? 'Saving…' : 'Save Graph'}
                        </button>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setIsGraphDatabaseOpen(true); }}
                          title="Open the Graph Database browser"
                          className="flex-1 flex items-center justify-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 px-2.5 py-1 rounded-md text-[10px] font-bold transition-colors"
                        >
                          <Database className="w-3 h-3" />
                          Open Graph Database
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-1.5 mt-1">
                        <span className={`text-[9px] font-bold ${plotPhaseColor}`}>{plotPhase}</span>
                        {plotPhase === 'Plotted' && Number.isFinite(plotInfo?.renderInfo?.durationMs) && (
                          <span className="text-[9px] text-slate-500 font-mono">
                            {plotInfo.renderInfo.durationMs < 1 ? '<1' : Math.round(plotInfo.renderInfo.durationMs).toLocaleString()}ms
                            {plotInfo.renderInfo.fromCache ? ' (cached)' : ''} &middot; {(plotInfo.renderInfo.pointCount ?? 0).toLocaleString()} pts
                          </span>
                        )}
                      </div>
                      {row.validationError && (
                        <div className="mt-1 text-[9px] text-red-300">{row.validationError}</div>
                      )}
                      {!parsedStep.valid && (
                        <div className="mt-1 text-[9px] text-red-300">Angle Step error: {parsedStep.error}</div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleAddSequence}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-[#0b1016] hover:bg-[#172230] border border-white/10 hover:border-cyan-300/30 text-slate-300 hover:text-cyan-200 px-2.5 py-1.5 rounded-md text-[11px] font-bold transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Graph
                </button>
              </div>

              {simulatorMode !== 'graph' && (
                <>
                  <div className="mt-3 pt-3 border-t border-white/10 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    Active: <span className="text-cyan-200">{activeSequence?.label}</span> — Constrained/Unconstrained, Separation Epsilon, and Search below apply to it.
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-[#0b1016] p-1">
                    <button
                      onClick={() => { setShotPathReference(null); setLockedShotNotice(null); setShotEditMode(SHOT_MODE_LOCKED); }}
                      title="Reject angle edits before they can make the current code-mode shot invalid."
                      className={`rounded-md px-2 py-1.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${shotEditMode === SHOT_MODE_LOCKED ? 'bg-emerald-400/15 text-emerald-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5" /> Constrained
                    </button>
                    <button
                      onClick={() => { setShotPathReference(simulatorMode === 'code' ? buildCodePathReference(codeData) : null); setLockedShotNotice(null); setShotEditMode(SHOT_MODE_UNCONSTRAINED); }}
                      title="Allow invalid shots and render them in unconstrained mode."
                      className={`rounded-md px-2 py-1.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${shotEditMode === SHOT_MODE_UNCONSTRAINED ? 'bg-slate-300/15 text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
                    >
                      <Eye className="w-3.5 h-3.5" /> Unconstrained
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 items-end">
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 block mb-1">Separation Epsilon</span>
                      <input
                        type="number"
                        min="0"
                        step="0.0000000001"
                        value={clearanceEpsilonInput}
                        onChange={e => { resetShotConstraintReference(); setClearanceEpsilonInput(e.target.value); }}
                        className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-xs focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all"
                      />
                    </label>
                    <button
                      onClick={handleStableRegionSearch}
                      disabled={baseInputMode !== 'angles' || shotClearanceValidation.status !== 'valid'}
                      title="Search the local symbolic x/y angle region that preserves the current valid shot."
                      className="h-[34px] px-2.5 rounded-md border border-cyan-300/25 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                    >
                      <Search className="w-4 h-4" />
                    </button>
                  </div>
                  {stableRegionResult && (
                    <div className={`mt-3 rounded-md border px-2.5 py-2 text-[10px] leading-relaxed ${stableRegionResult.status === 'found' ? 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100' : stableRegionResult.status === 'running' ? 'border-slate-300/20 bg-slate-400/10 text-slate-200' : 'border-amber-300/20 bg-amber-500/10 text-amber-100'}`}>
                      {stableRegionResult.status === 'found' ? (
                        <div className="font-mono">
                          x in ({formatFixed(stableRegionResult.intervals.xMin)}, {formatFixed(stableRegionResult.intervals.xMax)})<br />
                          y in ({formatFixed(stableRegionResult.intervals.yMin)}, {formatFixed(stableRegionResult.intervals.yMax)})
                          <span className="block mt-1 text-slate-400">step={formatFixed(stableRegionResult.step)} visits={stableRegionResult.visits}{stableRegionResult.capped ? ' capped' : ''}</span>
                        </div>
                      ) : (
                        <div className="flex gap-1.5 items-start">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{stableRegionResult.message || 'Stable region search did not return an interval.'}</span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
          </div>

          {/* ANALYTICS & DATA LOGS */}
          <div className="px-3 pb-8">
            
            {/* Code-mode shot vector, matching the colored endpoint segment drawn on the canvas. */}
            {simulatorMode === 'code' && activeTriangles.length > 0 && (
              <div className="mb-3 bg-[#151c24] p-4 rounded-lg border border-white/10 shadow-[0_8px_28px_rgba(0,0,0,0.22)]">
                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-3 flex items-center gap-1.5">
                  <Compass className="w-3 h-3 text-cyan-300"/> Shot Vector ({shotSymbol}/A)
                </h3>
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center border-b border-white/10 pb-2">
                    <span className="text-[11px] text-slate-500 font-medium">Final endpoint</span>
                    <span className="text-xs font-mono text-slate-100 font-semibold bg-[#0b1016] px-2 py-0.5 rounded border border-white/10 text-right break-all max-w-[210px]">
                      {formatPoint(renderedFinalShot)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] text-slate-500 font-medium">Global Angle <span className="font-mono text-[9px] text-slate-600 ml-1">atan2</span></span>
                    <span className="text-xs font-mono text-cyan-100 font-bold bg-cyan-400/10 px-2 py-0.5 rounded border border-cyan-300/20 text-right break-all max-w-[210px]">
                      {formatAngleDisplay(getGlobalAngle(startShot, renderedFinalShot))}&deg;
                    </span>
                  </div>
                </div>
              </div>
            )}

            {simulatorMode === 'code' && activeTriangles.length > 0 && (
              <div className={`mb-3 p-4 rounded-lg border shadow-[0_8px_28px_rgba(0,0,0,0.22)] ${shotClearanceValidation.status === 'valid' ? 'bg-emerald-500/10 border-emerald-300/25' : 'bg-red-500/10 border-red-300/25'}`}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-300 mb-2 flex items-center gap-1.5">
                    {shotClearanceValidation.status === 'valid' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-300" />
                    )}
                    Vertex Line Test
                  </h3>
                  <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${shotClearanceValidation.status === 'valid' ? 'text-emerald-100 border-emerald-300/25 bg-emerald-400/10' : 'text-red-100 border-red-300/25 bg-red-400/10'}`}>
                    {shotClearanceValidation.status === 'valid' ? 'VALID' : 'INVALID'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  Checked <span className="font-mono text-slate-200">{shotClearanceValidation.checked}</span> A/B/C occurrences:
                  <span className="font-mono text-sky-300"> blue {shotClearanceValidation.stats.blue}</span>,
                  <span className="font-mono text-slate-300"> black {shotClearanceValidation.stats.red}</span>,
                  <span className="font-mono text-yellow-300"> uncolored {shotClearanceValidation.stats.uncolored}</span>,
                  <span className="font-mono text-slate-500"> endpoints {shotClearanceValidation.stats.endpoints}</span>.
                  <div className="mt-1 text-[10px] text-slate-500">
                    Vector: <span className="font-mono text-slate-300">first {shotSymbol}/A to final {shotSymbol}/A</span>
                    <span className="font-mono text-slate-500"> | min gap {formatExponential(shotClearanceValidation.stats.lineMargin)}</span>
                    <span className="font-mono text-slate-500"> | max fan {formatFixed(shotClearanceValidation.stats.fanMaxCentralAngle)}&deg;</span>
                    <span className="font-mono text-slate-500"> | epsilon hits {shotClearanceValidation.stats.epsilonBand}</span>
                    <span className="font-mono text-slate-500"> | {shotEditMode === SHOT_MODE_LOCKED ? 'Constrained' : 'Unconstrained'}</span>
                  </div>
                </div>
                {shotClearanceValidation.violations.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {shotClearanceValidation.violations.slice(0, 3).map((violation, idx) => (
                      <div key={`${violation.triId}-${violation.symbol}-${idx}`} className="rounded-md border border-red-300/20 bg-[#0b1016]/80 px-2 py-1.5 text-[10px] text-red-100">
                        <span className="font-mono font-bold">{violation.triId}</span>
                        <span className="font-mono"> {violation.symbol}</span> expected {violation.expected}; dy =
                        <span className="font-mono"> {formatExponential(violation.score)}</span>
                        {violation.point && (
                          <span className="font-mono">; vertex = ({formatPoint(violation.point)})</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SEQUENCE LOGS (Code Sim Only) */}
            {simulatorMode === 'code' && codeData.parsedSequence.length > 0 && (
              <div className="mb-3 bg-[#151c24] p-4 rounded-lg border border-white/10 shadow-[0_8px_28px_rgba(0,0,0,0.22)]">
                {/* Only shown when the active row's own Code Sequence is
                    blank, i.e. it's being driven by its Angle Ray
                    instead (see billiardsCode/deriveEffectiveSequenceCode) —
                    lets that derived code be inspected or promoted into an
                    explicit, editable one via Copy. */}
                {!activeSequence?.sequenceText?.trim() && billiardsCode && (
                  <div className="mb-3 pb-3 border-b border-white/10">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-[10px] uppercase tracking-wider font-bold text-amber-200 flex items-center gap-1.5">
                        <Zap className="w-3 h-3" /> Derived From Angle Ray
                      </h3>
                      <button
                        onClick={() => navigator.clipboard.writeText(billiardsCode)}
                        title="Copy the derived code sequence to clipboard"
                        className="text-[10px] font-bold text-slate-500 hover:text-amber-200 transition-colors flex items-center gap-1"
                      >
                        <Copy className="w-3 h-3" /> Copy
                      </button>
                    </div>
                    <div className="bg-[#0b1016] p-2.5 rounded-md border border-white/10 font-mono text-sm text-slate-100 break-words leading-relaxed shadow-inner select-all">
                      {billiardsCode}
                    </div>
                  </div>
                )}
                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-2 flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3" /> Unfolded Sequence
                </h3>
                <div className="bg-[#0b1016] p-2 rounded-md border border-white/10 max-h-24 overflow-y-auto flex flex-wrap gap-1.5 custom-scrollbar shadow-inner">
                  {codeData.parsedSequence.map((step, idx) => (
                    <span key={idx} className="bg-[#17212b] text-slate-200 text-[10px] font-mono px-1.5 py-0.5 rounded border border-white/10 shadow-sm flex items-center">
                      {step.count}<span className="text-cyan-300 font-bold ml-0.5">{step.angle}</span>
                    </span>
                  ))}
                </div>
                
                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mt-4 mb-2 flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3" /> Side Seq.
                </h3>
                <div className="bg-[#0b1016] p-2.5 rounded-md border border-white/10 max-h-24 overflow-y-auto font-mono text-[11px] font-medium text-slate-300 custom-scrollbar break-words leading-relaxed shadow-inner tracking-widest">
                  {/* The final entry is where the unfolded path lands exactly
                      on a vertex, not a genuine side crossing, so it is
                      dropped from the displayed boundary count. The
                      underlying codeData.sideSequence itself stays intact —
                      it still feeds haveSameSideSequence's path-equality
                      checks, which must keep comparing the full path. */}
                  {codeData.sideSequence?.slice(0, -1).join('')}
                </div>

                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mt-4 mb-2 flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3" /> Theta
                </h3>
                <div className="bg-[#0b1016] p-2.5 rounded-md border border-white/10 font-mono text-sm text-slate-100">
                  {formatTheta(calculateTheta(codeData.parsedSequence))}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
      )}

      {/* RIGHT PANEL - SVG CANVAS */}
      <div className="flex-1 min-w-0 relative bg-[#070b10] overflow-hidden">
        
        {/* Floating Canvas Toolbar */}
        
        {/* Graph Plot Canvas — always mounted, hidden when not active */}
        <div style={{ display: simulatorMode === 'graph' ? 'flex' : 'none' }}
             className="w-full h-full flex-col absolute inset-0">
          <GraphSimulatorView
            sequences={sequences}
            activeSequenceId={activeSequenceId}
            angleParams={angleParams}
            baseLength={Number(angleParams.length) || 0}
            buildValidateCandidateForSequence={buildValidateCandidateForSequence}
            resolveRowEffectiveSequenceText={resolveRowEffectiveSequenceText}
            refreshToken={graphPlotRefreshToken}
            onRowStatusChange={(id, info) => setPlotStatusById(prev => ({ ...prev, [id]: info }))}
            forceGenerateRequest={forceGenerateRequest}
            maxBounces={maxBounces}
            onShowAllGraphs={() => setSequences(rows => rows.map(r => ({ ...r, visible: true })))}
            onHideAllGraphs={() => setSequences(rows => rows.map(r => ({ ...r, visible: false })))}
            onToggleSequenceVisible={handleToggleSequenceVisible}
            onSequenceColorChange={handleSequenceColorChange}
            onRefreshVisible={() => setGraphPlotRefreshToken((t) => t + 1)}
            onRemoveSequence={handleRemoveSequence}
            onSelectSequence={handleSelectSequenceAndScrollToCard}
            initialIsViewLocked={restoredWorkspace?.anglePlotWindow?.isViewLocked}
            initialLegendCollapsed={restoredWorkspace?.anglePlotWindow?.legendCollapsed}
            initialFollowCursor={restoredWorkspace?.anglePlotWindow?.followCursor}
            initialPanelZoom={restoredWorkspace?.anglePlotWindow?.panelZoom}
            initialPanelPan={restoredWorkspace?.anglePlotWindow?.panelPan}
            onWorkspaceStateChange={(state) => { anglePlotWindowStateRef.current = state; scheduleAutosave(); }}
          />
        </div>

        {/* SVG Canvas + Toolbar — always mounted, hidden when graph mode is active */}
        <div style={{ display: simulatorMode !== 'graph' ? 'block' : 'none' }}
             className="w-full h-full">
        <div className="absolute top-4 right-4 z-10 flex gap-2">
           {activeSequence && (
             <div
               className="bg-[#101820]/95 text-slate-400 px-3 py-2 text-[11px] rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 font-mono font-bold flex items-center gap-2 backdrop-blur"
               title="The graph currently drawn on this canvas"
             >
               <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: activeSequence.color }} />
               GRAPH: <span className="text-amber-200">{activeSequence.title || activeSequence.label}</span>
             </div>
           )}
           {simulatorMode === 'code' && (
             <div className="bg-[#101820]/95 text-slate-400 px-3 py-2 text-[11px] rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 font-mono font-bold flex items-center backdrop-blur">
                GENERATED: <span className="text-cyan-200 ml-2">{renderableActiveTriangles.length}</span>
             </div>
           )}
          <div className="flex bg-[#101820]/95 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 backdrop-blur overflow-hidden">
            <div className="px-3 py-2 text-[11px] border-r border-white/10 text-slate-300 font-mono font-bold flex items-center gap-2" title="Current magnification (pixels per unit).">
              <span className="text-slate-500">ZOOM</span>
              <span className="text-cyan-200">{zoom.toFixed(1)}x</span>
            </div>
            <input
              type="number"
              min="0.01"
              step="0.1"
              value={zoomMagnification}
              onChange={(e) => setZoomMagnification(e.target.value)}
              aria-label="Zoom magnification multiplier"
              className="w-14 bg-transparent hover:bg-white/5 text-slate-200 px-2 py-2 text-xs font-bold text-center border-r border-white/10 outline-none transition-colors focus:ring-1 focus:ring-cyan-300"
              title="Magnification multiplier applied by the Zoom In/Out buttons."
            />
            <button onClick={handleManualZoomIn} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Zoom In">
              <ZoomIn className="w-3.5 h-3.5" />
              <span className="text-[10px] font-bold">Zoom In</span>
            </button>
            <button onClick={handleManualZoomOut} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Zoom Out">
              <ZoomOut className="w-3.5 h-3.5" />
              <span className="text-[10px] font-bold">Zoom Out</span>
            </button>
            <button onClick={handleFitScreen} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Fit View">
              <Maximize className="w-3.5 h-3.5" />
              <span className="text-[10px] font-bold">Fit View</span>
            </button>
            <button onClick={() => { setZoom(35); setPan({ x: 5, y: 4 }); }} className="px-2.5 py-2 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-r border-white/10 transition-colors flex items-center gap-1.5" title="Reset View">
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="text-[10px] font-bold">Reset</span>
            </button>
            <button
              onClick={() => setIsZoomLocked(current => !current)}
              className={`px-2.5 py-2 transition-colors flex items-center gap-1.5 ${isZoomLocked ? 'bg-cyan-500/20 text-cyan-200' : 'hover:bg-[#172230] text-slate-300 hover:text-cyan-200'}`}
              title={isZoomLocked ? 'Unlock View' : 'Lock View'}
            >
              {isZoomLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              <span className="text-[10px] font-bold">{isZoomLocked ? 'Unlock View' : 'Lock View'}</span>
            </button>
            <button
              onClick={() => setShowAllLabels(current => !current)}
              className={`px-2.5 py-2 transition-colors flex items-center gap-1.5 border-l border-white/10 ${showAllLabels ? 'bg-cyan-500/20 text-cyan-200' : 'hover:bg-[#172230] text-slate-300 hover:text-cyan-200'}`}
              title="Keep all vertex labels visible on the canvas."
            >
              <span className="text-[10px] font-bold">Labels</span>
            </button>
          </div>
        </div>

        {/* Interactive SVG Area */}
        <div 
          ref={containerRef}
          className="w-full h-full cursor-default"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { handleMouseUp(); setMousePos({ x: -1000, y: -1000 }); }}
        >
          <svg width="100%" height="100%" className="block bg-[#070b10]">
            
            {/* HARDWARE ACCELERATED RENDER LAYER */}
            <g transform={transformStr}>
              
              {/* Academic Graph Paper Grid */}
              <g opacity="1">
                {grid.linesX.map(x => <line key={`gx-${x}`} x1={x} y1={grid.minMathY} x2={x} y2={grid.maxMathY} stroke={x === 0 ? themePalette.gridAxis : themePalette.gridLine} strokeWidth={(x === 0 ? 2 : 1) / zoom} />)}
                {grid.linesY.map(y => <line key={`gy-${y}`} x1={grid.minMathX} y1={y} x2={grid.maxMathX} y2={y} stroke={y === 0 ? themePalette.gridAxis : themePalette.gridLine} strokeWidth={(y === 0 ? 2 : 1) / zoom} />)}
              </g>

              {/* Generated Reflections - Glassy geometry look */}
              {renderableActiveTriangles.map(tri => {
                const triangleStyle = getTriangleRenderStyle(tri);
                return (
                  <polygon
                    key={tri.id}
                    points={`${tri.points[0].x},${tri.points[0].y} ${tri.points[1].x},${tri.points[1].y} ${tri.points[2].x},${tri.points[2].y}`}
                    fill="#ffffff"
                    fillOpacity={triangleStyle.fillOpacity}
                    stroke={triangleStyle.strokeColor}
                    strokeOpacity={triangleStyle.strokeOpacity}
                    strokeWidth={2.2 / zoom}
                    strokeLinejoin="round"
                  />
                );
              })}

              {/* Base Triangle - Prominent Anchor */}
              <polygon
                points={`${baseTriangle.points[0].x},${baseTriangle.points[0].y} ${baseTriangle.points[1].x},${baseTriangle.points[1].y} ${baseTriangle.points[2].x},${baseTriangle.points[2].y}`}
                fill="#ffffff"
                fillOpacity="0.08"
                stroke="#000000"
                strokeWidth={3 / zoom}
                strokeLinejoin="round"
              />

              {simulatorMode === 'code' && activeTriangles.length > 0 && (
                <g pointerEvents="none">
                  <line
                    x1={startShot.x} y1={startShot.y}
                    x2={renderedFinalShot.x} y2={renderedFinalShot.y}
                    stroke={shotLineVisualColor} strokeWidth={2.5 / zoom} strokeDasharray={`${8 / zoom},${8 / zoom}`} strokeLinecap="round" opacity={isUnconstrainedShot ? 0.9 : 1}
                  />
                  <circle cx={startShot.x} cy={startShot.y} r={5 / zoom} fill={SHOT_ENDPOINT_FILL_COLOR} stroke={shotLineVisualColor} strokeWidth={1.5 / zoom} />
                  <circle cx={renderedFinalShot.x} cy={renderedFinalShot.y} r={5 / zoom} fill={SHOT_ENDPOINT_FILL_COLOR} stroke={shotLineVisualColor} strokeWidth={1.5 / zoom} />
                </g>
              )}
            </g>

            {/* UNSCALED SCREEN-SPACE ANNOTATIONS */}
            <g pointerEvents="none">
              {simulatorMode === 'code' && activeTriangles.length > 0 && (() => {
                const markers = [];
                const seen = new Set();
                // Mark every triangle occurrence that participates in the rendered tower.
                const allTris = [baseTriangle, ...renderableActiveTriangles];

                for (const tri of allTris) {
                  for (const vertexIdx of [0, 1, 2]) {
                    const symbol = labelsMap[vertexIdx];
                    const p = tri.points[vertexIdx];
                    if (!p) continue;

                    const key = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const validation = getClearancePointValidation(tri.id, vertexIdx, symbol);
                    if (!validation) continue;

                    const cx = toSvgX(p.x);
                    const cy = toSvgY(p.y);
                    const radius = validation.valid ? 4 : 6;
                    const showLabel = true;
                    const markerColor = getShotVertexRenderColor(validation);

                    markers.push(
                      <g key={`clearance-mark-${key}`}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={radius + 2}
                          fill={markerColor}
                          opacity={validation.valid ? 0.28 : 0.85}
                        />
                        <circle
                          cx={cx}
                          cy={cy}
                          r={radius}
                          fill={markerColor}
                          opacity={validation.valid ? 0.82 : 1}
                        />
                        {showLabel && (
                          <text
                            x={cx}
                            y={cy + 0.5}
                            fill={markerColor}
                            fontSize="8"
                            fontWeight="900"
                            textAnchor="middle"
                            alignmentBaseline="middle"
                            className="font-mono"
                          >
                            {validation.vertexName}
                          </text>
                        )}
                      </g>
                    );
                  }
                }

                return markers;
              })()}
              
              {/* Base Triangle Corner Variables (x, y, z) dynamically mapped */}
              {(() => {
                const bPoints = baseTriangle.points;
                const mathCentroidX = (bPoints[0].x + bPoints[1].x + bPoints[2].x) / 3;
                const mathCentroidY = (bPoints[0].y + bPoints[1].y + bPoints[2].y) / 3;
                const svgCentroidX = toSvgX(mathCentroidX);
                const svgCentroidY = toSvgY(mathCentroidY);

                return [0, 1, 2].map((vertexIdx) => {
                  const angleLabel = labelsMap[vertexIdx];
                  const p = bPoints[vertexIdx];
                  const cx = toSvgX(p.x);
                  const cy = toSvgY(p.y);
                  
                  const vx = svgCentroidX - cx;
                  const vy = svgCentroidY - cy;
                  const dist = Math.sqrt(vx*vx + vy*vy) || 1;
                  
                  const offsetPx = Math.min(22, dist * 0.4); 
                  const labelX = cx + (vx / dist) * offsetPx;
                  const labelY = cy + (vy / dist) * offsetPx;

                  return (
                    <text 
                      key={`angle-lbl-${vertexIdx}`}
                      x={labelX} 
                      y={labelY} 
                      fill={themePalette.canvasLabel} 
                      fontSize="14" 
                      fontWeight="700"
                      textAnchor="middle"
                      alignmentBaseline="middle"
                      className="font-mono" 
                      style={{ 
                        textShadow: `0 0 5px ${themePalette.labelHalo}, 0 0 5px ${themePalette.labelHalo}, 0 0 8px ${themePalette.labelHalo}`,
                        fontStyle: 'italic'
                      }}
                    >
                      {angleLabel}
                    </text>
                  );
                });
              })()}

              {/* Dynamic Annotation Engine (Proximity Hover & Vertex Coloring).
                  Persistent Labels (showAllLabels) intentionally still shows
                  every vertex + edge-midpoint label of every triangle. A
                  plain hover (no Persistent Labels) instead shows only the
                  single nearest vertex under the cursor, not the whole
                  triangle's vertices and edge midpoints. */}
              {showAllLabels && (() => {
                const labelsToRender = [];
                const renderedCoords = new Set();
                const renderedMidpoints = new Set();

                const processTriangles = (triangles, isDerived) => {
                  for (const tri of triangles) {
                    {
                      const triDisplayColor = isDerived ? getTriangleRenderStyle(tri).color : themePalette.baseTriangle;

                      // 1. Vertex Coordinates Annotation
                      for (let i = 0; i < 3; i++) {
                        const p = tri.points[i];
                        const cx = toSvgX(p.x);
                        const cy = toSvgY(p.y);
                        const coordKey = `${p.x.toFixed(5)},${p.y.toFixed(5)}`;

                        if (!renderedCoords.has(coordKey)) {
                          renderedCoords.add(coordKey);
                          const vertexName = ['A', 'B', 'C'][i];
                          
                          // Dynamic vertex coloring logic based on the all-vertex tower validator.
                          let vColor = triDisplayColor;
                          let vTextColor = vColor;
                          let vertexRadius = isDerived ? 4 : 5;

                          if (simulatorMode === 'code' && activeTriangles.length > 0) {
                            const symbol = labelsMap[i];
                            const clearancePointValidation = getClearancePointValidation(tri.id, i, symbol);
                            
                            if (clearancePointValidation) {
                              vColor = getShotVertexRenderColor(clearancePointValidation, isDerived ? tri.color : themePalette.baseTriangle);
                              vertexRadius = clearancePointValidation.valid ? vertexRadius : 6;
                            }
                          }

                          labelsToRender.push(
                            <g key={`lbl-${isDerived ? 'derived-' : ''}${tri.id}-${i}`}>
                              <circle cx={cx} cy={cy} r={vertexRadius} fill={vColor} opacity={1} />
                              <text 
                                x={cx + 8} 
                                y={cy - 6} 
                                fill={vTextColor} 
                                fontSize="11" 
                                fontWeight="700"
                                className="font-mono tracking-tight" 
                                style={{ textShadow: `0 0 5px ${themePalette.labelHalo}, 0 0 5px ${themePalette.labelHalo}, 0 0 8px ${themePalette.labelHalo}` }}
                              >
                                {vertexName}: ({formatPoint(p)})
                              </text>
                            </g>
                          );
                        }
                      }

                      // 2. Edge Midpoints Annotation (Sides 1, 2, 3)
                      for (let e = 0; e < 3; e++) {
                        const p1 = tri.points[e];
                        const p2 = tri.points[(e + 1) % 3];
                        
                        const midX = (p1.x + p2.x) / 2;
                        const midY = (p1.y + p2.y) / 2;
                        const midKey = `${midX.toFixed(5)},${midY.toFixed(5)}`;

                        if (!renderedMidpoints.has(midKey)) {
                          renderedMidpoints.add(midKey);
                          const cx = toSvgX(midX);
                          const cy = toSvgY(midY);
                          const sideName = EDGE_TO_SIDE[e].toString();

                          labelsToRender.push(
                            <g key={`elbl-${isDerived ? 'derived-' : ''}${tri.id}-${e}`}>
                              <circle cx={cx} cy={cy} r={9} fill={themePalette.midpointFill} stroke={isDerived ? triDisplayColor : themePalette.midpointStroke} strokeWidth={1.5} opacity={0.95} />
                              <text
                                x={cx}
                                y={cy}
                                fill={isDerived ? triDisplayColor : themePalette.midpointText}
                                fontSize="10"
                                fontWeight="800"
                                textAnchor="middle"
                                alignmentBaseline="central"
                                className="font-mono"
                              >
                                {sideName}
                              </text>
                            </g>
                          );
                        }
                      }
                    }
                  }
                };

                processTriangles([baseTriangle], false);
                // Hover annotations cover the same complete reflected chain as the polygons.
                processTriangles(renderableActiveTriangles, true);

                return labelsToRender;
              })()}

              {/* Plain hover (Persistent Labels off): show only the single
                  nearest vertex's coordinate under the cursor instead of the
                  whole triangle's vertices and edge midpoints. */}
              {!showAllLabels && !isDragging && (() => {
                let nearest = null;
                let nearestDistSq = 900; // 30px hit radius, matches the persistent-mode threshold above.

                const considerTriangles = (triangles, isDerived) => {
                  for (const tri of triangles) {
                    for (let i = 0; i < 3; i++) {
                      const p = tri.points[i];
                      const cx = toSvgX(p.x);
                      const cy = toSvgY(p.y);
                      const distSq = (cx - mousePos.x) ** 2 + (cy - mousePos.y) ** 2;
                      if (distSq < nearestDistSq) {
                        nearestDistSq = distSq;
                        nearest = { tri, isDerived, index: i, cx, cy, p };
                      }
                    }
                  }
                };
                considerTriangles([baseTriangle], false);
                considerTriangles(renderableActiveTriangles, true);
                if (!nearest) return null;

                const { tri, isDerived, index, cx, cy, p } = nearest;
                const triDisplayColor = isDerived ? getTriangleRenderStyle(tri).color : themePalette.baseTriangle;
                const vertexName = ['A', 'B', 'C'][index];

                // Dynamic vertex coloring logic based on the all-vertex tower validator.
                let vColor = triDisplayColor;
                let vertexRadius = isDerived ? 4 : 5;
                if (simulatorMode === 'code' && activeTriangles.length > 0) {
                  const symbol = labelsMap[index];
                  const clearancePointValidation = getClearancePointValidation(tri.id, index, symbol);
                  if (clearancePointValidation) {
                    vColor = getShotVertexRenderColor(clearancePointValidation, isDerived ? tri.color : themePalette.baseTriangle);
                    vertexRadius = clearancePointValidation.valid ? vertexRadius : 6;
                  }
                }

                return (
                  <g key={`lbl-${isDerived ? 'derived-' : ''}${tri.id}-${index}`}>
                    <circle cx={cx} cy={cy} r={vertexRadius} fill={vColor} opacity={1} />
                    <text
                      x={cx + 8}
                      y={cy - 6}
                      fill={vColor}
                      fontSize="11"
                      fontWeight="700"
                      className="font-mono tracking-tight"
                      style={{ textShadow: `0 0 5px ${themePalette.labelHalo}, 0 0 5px ${themePalette.labelHalo}, 0 0 8px ${themePalette.labelHalo}` }}
                    >
                      {vertexName}: ({formatPoint(p)})
                    </text>
                  </g>
                );
              })()}
            </g>
          </svg>
        </div>
      </div>
      </div>

      {/* Valid Angle A-B Region pop-up. A single boolean controls mounting,
          so re-clicking "Plot Valid Angle Region" can never spawn a second
          window; it just bumps anglePlotRequestId to refresh the one that
          exists. Every sequence row is passed through so every visible one
          can be plotted together; `buildValidateCandidateForSequence` lets
          the window build the same constraint check the Angle A/B inputs
          above use, for any row's own sequence text. */}
      

      {/* One place to configure all plot rows without changing the existing
          Base Geometry sidebar or the AnglePlotWindow's rendering pipeline. */}
      {isGraphSetupOpen && (
        <GraphSetupWindow
          sequences={sequences}
          activeSequenceId={activeSequenceId}
          onAdd={handleAddSequence}
          onRemove={handleRemoveSequence}
          onSelect={handleSelectActiveSequence}
          onToggleVisible={handleToggleSequenceVisible}
          onColorChange={handleSequenceColorChange}
          onAngleDraftChange={handleAngleDraftChange}
          onApplyAngleDraft={applyAngleDrafts}
          onCancelAngleDraft={handleCancelAngleDraft}
          onAngleStepDraftChange={handleAngleStepDraftChange}
          onApplyAngleStepDraft={applyAngleStepDraft}
          onCancelAngleStepDraft={handleCancelAngleStepDraft}
          angleStepControlIncrement={angleStepControlIncrement}
          stepIncrementInput={angleStepControlIncrementInput}
          onStepIncrementChange={setAngleStepControlIncrementInput}
          onDraftChange={handleSequenceDraftChange}
          onApplyDraft={handleApplySequenceDraft}
          onCancelDraft={handleCancelSequenceDraft}
          onClose={() => setIsGraphSetupOpen(false)}
          onOpenPlot={handleOpenPlotFromGraphSetup}
        />
      )}

      {/* Graph Library: browse/search/load previously-computed graphs from
          the shared PostgreSQL library. Owns no plotting state itself —
          handleLoadGraphFromLibrary is what actually creates a new row and
          feeds it into the existing AnglePlotWindow pipeline. */}
      {isGraphLibraryOpen && (
        <GraphLibraryPanel
          isOpen={isGraphLibraryOpen}
          onClose={() => setIsGraphLibraryOpen(false)}
          onLoadGraph={handleLoadGraphFromLibrary}
        />
      )}

      {/* Graph Database: the fuller browser for the local, file-based
          GraphDatabase — search/sort/rename/delete/duplicate/favorite/
          tags/notes, plus load-instantly-with-no-recompute. A completely
          separate panel and store from the Graph Library above (see
          GraphDatabasePanel.jsx's own module comment). Owns no plotting
          state itself — handleLoadGraphFromDatabase is what actually
          creates a new row and feeds it into the existing AnglePlotWindow
          pipeline. */}
      {isGraphDatabaseOpen && (
        <GraphDatabasePanel
          isOpen={isGraphDatabaseOpen}
          onClose={() => setIsGraphDatabaseOpen(false)}
          onLoadGraph={handleLoadGraphFromDatabase}
        />
      )}

      {/* "Save Graph" result banner — self-dismissing (see showSaveToast),
          no app-provided toast system existed to reuse. High z-index so it
          stays visible even over the Graph Database browser (z-[83]),
          since saving and then immediately opening that browser is exactly
          the flow the buttons beside each other are meant to support. */}
      {saveToast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-4 right-4 z-[95] flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-bold shadow-[0_12px_40px_rgba(0,0,0,0.5)] ${
            saveToast.isError
              ? 'border-red-400/40 bg-red-500/20 text-red-100'
              : 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100'
          }`}
        >
          {saveToast.message}
        </div>
      )}

      {/* Plain-English error pop-up for a rejected sequence/angle apply
          (Feature 6): no console-only feedback, and no app-provided modal
          system existed to reuse, so this is a small self-contained one. */}
      {errorModal && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
          onClick={closeErrorModal}
          onKeyDown={e => { if (e.key === 'Escape') closeErrorModal(); }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sequence-error-title"
            aria-describedby="sequence-error-message"
            onClick={e => e.stopPropagation()}
            className="w-full max-w-sm max-h-[85vh] flex flex-col bg-[#151c24] border border-red-400/30 rounded-lg shadow-[0_20px_60px_rgba(0,0,0,0.55)] p-4"
          >
            <h3 id="sequence-error-title" className="text-sm font-bold text-red-200 mb-3 flex items-center gap-1.5 shrink-0">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {errorModal.title}
            </h3>
            {/* Scrolls independently of the title/OK button so a long list of
                sections (e.g. many distinct Vertex Line Test failure
                categories) can never push the OK button off-screen. */}
            <div id="sequence-error-message" className="text-xs text-slate-300 leading-relaxed mb-4 space-y-3 overflow-y-auto custom-scrollbar flex-1 min-h-0">
              {errorModal.sections.map((section, i) => (
                <div key={i}>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-0.5">{section.heading}</div>
                  {section.list ? (
                    <ul className="list-disc pl-4 space-y-0.5">
                      {section.list.map((item, j) => <li key={j}>{item}</li>)}
                    </ul>
                  ) : (
                    <div className="whitespace-pre-line">{section.text}</div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 shrink-0">
              <button
                type="button"
                autoFocus
                onClick={closeErrorModal}
                className="bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-100 px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate Code Sequence + Angle A/B confirmation: warns before
          plotting a graph that already exists as another row, rather than
          silently drawing an indistinguishable duplicate on top of it. See
          findExactDuplicateSequence/handlePlotSequenceNow. */}
      {duplicateSequenceConfirm && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setDuplicateSequenceConfirm(null)}
          onKeyDown={e => { if (e.key === 'Escape') setDuplicateSequenceConfirm(null); }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="duplicate-sequence-title"
            aria-describedby="duplicate-sequence-message"
            onClick={e => e.stopPropagation()}
            className="w-full max-w-sm flex flex-col bg-[#151c24] border border-amber-400/30 rounded-lg shadow-[0_20px_60px_rgba(0,0,0,0.55)] p-4"
          >
            <h3 id="duplicate-sequence-title" className="text-sm font-bold text-amber-200 mb-3 flex items-center gap-1.5 shrink-0">
              <AlertTriangle className="w-4 h-4 shrink-0" /> Duplicate graph
            </h3>
            <div id="duplicate-sequence-message" className="text-xs text-slate-300 leading-relaxed mb-4">
              This Code Sequence and Angle A/B are exactly the same as the existing <span className="font-bold text-amber-200">{duplicateSequenceConfirm.matchLabel}</span>. Would you like to continue and plot it anyway?
            </div>
            <div className="flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setDuplicateSequenceConfirm(null)}
                className="bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  const { id } = duplicateSequenceConfirm;
                  setDuplicateSequenceConfirm(null);
                  handlePlotSequenceNow(id, { skipDuplicateCheck: true });
                }}
                className="bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100 px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
