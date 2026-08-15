import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// loadMathApi below strips every `import` line out of App.jsx's own source
// before eval-ing it (see its own comment), so any App.jsx helper that
// itself imports something (buildPoolshotTowerValidation -> isValidRayAngle)
// needs that dependency imported here instead — direct eval shares this
// module's own top-level scope, so this binding resolves the same way for
// the eval'd code as App.jsx's own top-level import would.
import { isValidRayAngle } from '../src/anglePlot/angleValidation.js';

const APP_SOURCE_URL = new URL('../src/App.jsx', import.meta.url);

const loadMathApi = () => {
  const source = readFileSync(APP_SOURCE_URL, 'utf8');
  const helperSource = source.split('const GraphSimulatorView')[0].replace(/^import .*$/gm, '');
  eval(`${helperSource}
globalThis.__unfolderMathApi = {
  DEFAULT_CLEARANCE_EPSILON,
  buildAngleParamsFromSymbolValues,
  buildBaseTriangle,
  buildCodePathConsistencyValidation,
  // Expose the extracted ray helper to the regression suite.
  buildRayModeData,
  buildCodePathReference,
  buildFanConstraintValidation,
  buildPoolshotTowerValidation,
  // Resolves which of a graph's two alternate shot inputs (typed code vs.
  // Trajectory Angle) actually drives it — see App.jsx's own doc comment.
  deriveEffectiveSequenceCode,
  findStableRegion,
  getAngleAtVertex,
  getGlobalAngle,
  getRenderableActiveTriangles,
  getSymbolAngleValues,
  getSymbolAngleDegreesFromTriangle,
  reflectPoint,
  resolvePositiveInputStep,
  unfoldCodeData
};`);
  const api = globalThis.__unfolderMathApi;
  delete globalThis.__unfolderMathApi;
  return api;
};

const api = loadMathApi();

const DEFAULT_CODE = '3 1 7 2 6 2 8 2 4 2';

const DEFAULT_ANGLE_PARAMS = { a: 15, b: 50, length: 10 };

const degrees = (radians) => radians * 180 / Math.PI;

const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);

const midpoint = (left, right) => ({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });

const signedLineNumerator = (point, lineA, lineB) => (
  (lineB.x - lineA.x) * (point.y - lineA.y) - (lineB.y - lineA.y) * (point.x - lineA.x)
);

const assertAlmostEqual = (actual, expected, tolerance = 1e-10, label = 'value') => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, received ${actual}`);
};

const assertPointAlmostEqual = (actual, expected, tolerance = 1e-10, label = 'point') => {
  assertAlmostEqual(actual.x, expected.x, tolerance, `${label}.x`);
  assertAlmostEqual(actual.y, expected.y, tolerance, `${label}.y`);
};

const buildDefaultCodeData = () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  const codeData = api.unfoldCodeData(DEFAULT_CODE, baseTriangle, true);
  return { baseTriangle, codeData };
};

test('editable native input steps accept a configurable positive increment and safely fall back', () => {
  assert.equal(api.resolvePositiveInputStep('0.0025', 0.0001), 0.0025);
  assert.equal(api.resolvePositiveInputStep('0.0000003', 0.0001), 0.0000003);
  assert.equal(api.resolvePositiveInputStep('', 0.0001), 0.0001);
  assert.equal(api.resolvePositiveInputStep('0', 0.0001), 0.0001);
  assert.equal(api.resolvePositiveInputStep('-1', 0.0001), 0.0001);
});

const validateCandidate = (a, b, referenceData = null) => {
  const baseTriangle = api.buildBaseTriangle({ a, b, length: 10 });
  const codeData = api.unfoldCodeData(DEFAULT_CODE, baseTriangle, true);
  const pathReference = referenceData ? api.buildCodePathReference(referenceData) : null;
  const pathConsistency = pathReference
    ? api.buildCodePathConsistencyValidation({ candidateCodeData: codeData, reference: pathReference })
    : { status: 'valid', violations: [] };
  const validation = api.buildPoolshotTowerValidation({
    simulatorMode: 'code',
    baseTriangle,
    activeTriangles: codeData.triangles,
    labelsMap: codeData.idxToAngle,
    reflectionEdges: codeData.reflectionEdges,
    parsedSequence: codeData.parsedSequence,
    clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON,
    extraViolations: pathConsistency.violations
  });
  return { baseTriangle, codeData, pathConsistency, validation };
};

test('reflectPoint satisfies exact mirror invariants within floating-point tolerance', () => {
  assertPointAlmostEqual(api.reflectPoint({ x: 2, y: 3 }, { x: -5, y: 0 }, { x: 7, y: 0 }), { x: 2, y: -3 }, 1e-12, 'horizontal reflection');
  assertPointAlmostEqual(api.reflectPoint({ x: 4, y: -2 }, { x: 1, y: -5 }, { x: 1, y: 5 }), { x: -2, y: -2 }, 1e-12, 'vertical reflection');

  const lineA = { x: -2.5, y: 0.75 };
  const lineB = { x: 4.25, y: 5.5 };
  const source = { x: 3.2, y: -1.7 };
  const reflected = api.reflectPoint(source, lineA, lineB);
  const reflectedTwice = api.reflectPoint(reflected, lineA, lineB);
  const bisectorPoint = midpoint(source, reflected);

  assertPointAlmostEqual(reflectedTwice, source, 1e-10, 'double reflection');
  assertAlmostEqual(distance(source, lineA), distance(reflected, lineA), 1e-10, 'distance to first line point');
  assertAlmostEqual(distance(source, lineB), distance(reflected, lineB), 1e-10, 'distance to second line point');
  assertAlmostEqual(signedLineNumerator(source, lineA, lineB), -signedLineNumerator(reflected, lineA, lineB), 1e-10, 'opposite signed line distances');
  assertAlmostEqual(signedLineNumerator(bisectorPoint, lineA, lineB), 0, 1e-10, 'midpoint lies on mirror line');
});

test('angle-mode triangle construction preserves requested Euclidean geometry', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  const [vertexA, vertexB, vertexC] = baseTriangle.points;

  assertPointAlmostEqual(vertexA, { x: 0, y: 0 }, 1e-12, 'physical A');
  assertPointAlmostEqual(vertexB, { x: 10, y: 0 }, 1e-12, 'physical B');
  assertAlmostEqual(distance(vertexA, vertexB), 10, 1e-12, 'base length AB');
  assertAlmostEqual(degrees(api.getAngleAtVertex(vertexB, vertexA, vertexC)), 15, 1e-10, 'angle A');
  assertAlmostEqual(degrees(api.getAngleAtVertex(vertexA, vertexB, vertexC)), 50, 1e-10, 'angle B');
  assertAlmostEqual(degrees(api.getAngleAtVertex(vertexA, vertexC, vertexB)), 115, 1e-10, 'angle C');
});

test('default code unfolding keeps x at the source and preserves the side path', () => {
  const { baseTriangle, codeData } = buildDefaultCodeData();

  assert.deepEqual(codeData.idxToAngle, { 0: 'x', 1: 'y', 2: 'z' });
  assert.deepEqual(codeData.angleToIdx, { x: 0, y: 1, z: 2 });
  assert.equal(codeData.triangles.length, 37);
  assert.equal(codeData.sideSequence.length, 37);
  assert.equal(codeData.reflectionEdges.length, 37);
  assert.deepEqual(codeData.parsedSequence.map(step => `${step.count}${step.angle}`), ['3y', '1z', '7x', '2y', '6x', '2y', '8x', '2y', '4x', '2y']);
  assert.deepEqual(
    codeData.parsedSequence.map((step, runIndex) => codeData.triangles.filter(tri => tri.fanRunIndex === runIndex).length),
    codeData.parsedSequence.map(step => step.count)
  );
  for (let runIndex = 0; runIndex < codeData.parsedSequence.length; runIndex++) {
    const runTriangles = codeData.triangles.filter(tri => tri.fanRunIndex === runIndex);
    for (const tri of runTriangles) {
      assert.equal(tri.fanRunCount, codeData.parsedSequence[runIndex].count);
      assert.equal(tri.fanSymbol, codeData.parsedSequence[runIndex].angle);
      assertPointAlmostEqual(tri.fanPoint, runTriangles[0].fanPoint, 1e-10, `fan ${runIndex} point`);
    }
  }
  assert.deepEqual(codeData.sideSequence.slice(0, 15), [3, 1, 3, 2, 1, 2, 1, 2, 1, 2, 1, 3, 1, 2, 1]);
  assert.deepEqual(codeData.reflectionEdges.slice(0, 15), [1, 0, 1, 2, 0, 2, 0, 2, 0, 2, 0, 1, 0, 2, 0]);

  const symbolAngles = api.getSymbolAngleDegreesFromTriangle(baseTriangle, codeData.idxToAngle);
  assertAlmostEqual(symbolAngles.x, 15, 1e-10, 'symbol angle x');
  assertAlmostEqual(symbolAngles.y, 50, 1e-10, 'symbol angle y');
  assertAlmostEqual(symbolAngles.z, 115, 1e-10, 'symbol angle z');
});

test('short code unfoldings always start across the side opposite source x', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  const reversedWinding = {
    ...baseTriangle,
    points: baseTriangle.points.map(point => ({ x: point.x + 20, y: 40 - point.y }))
  };

  for (const triangle of [baseTriangle, reversedWinding]) {
    const codeData = api.unfoldCodeData('2', triangle, true);
    assert.deepEqual(codeData.idxToAngle, { 0: 'x', 1: 'y', 2: 'z' });
    assert.deepEqual(codeData.reflectionEdges, [1, 0]);
  }
});

test('reference code fans advance rightward inside the source wedge', () => {
  const { baseTriangle, codeData } = buildDefaultCodeData();
  const fanCenters = codeData.parsedSequence.map((_, runIndex) => (
    codeData.triangles.find(triangle => triangle.fanRunIndex === runIndex).fanPoint
  ));
  const finalShot = codeData.triangles.at(-1).points[0];
  const shotAngle = api.getGlobalAngle(baseTriangle.points[0], finalShot);

  for (let index = 1; index < fanCenters.length; index++) {
    assert.ok(fanCenters[index].x > fanCenters[index - 1].x, `fan ${index} must advance rightward`);
  }
  assert.ok(shotAngle > 0 && shotAngle < 15, 'shot must remain inside the x-angle wedge');
});

test('fan transitions follow the shared side instead of a centroid direction', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  const codeData = api.unfoldCodeData('2 4 2', baseTriangle, true);

  assert.deepEqual(codeData.parsedSequence.map(step => `${step.count}${step.angle}`), ['2y', '4x', '2y']);
  assert.deepEqual(codeData.reflectionEdges, [1, 0, 2, 0, 2, 0, 1, 0]);
  assert.deepEqual(
    codeData.triangles.map(triangle => triangle.fanVertexIdx),
    [1, 1, 0, 0, 0, 0, 1, 1]
  );
});

test('rendering drops the very last reflected triangle per instructor requirement', () => {
  const { codeData } = buildDefaultCodeData();
  const renderableTriangles = api.getRenderableActiveTriangles(codeData.triangles);

  assert.equal(renderableTriangles.length, codeData.triangles.length - 1);
  assert.equal(renderableTriangles.length, codeData.parsedSequence.reduce((total, step) => total + step.count, 0) - 1);
  assert.strictEqual(renderableTriangles.at(-1), codeData.triangles.at(-2));
  assert.equal(renderableTriangles.at(-1).id, 'Code-T36');
});

test('deriveEffectiveSequenceCode: a non-blank typed code always wins over a Trajectory Angle', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  const effective = api.deriveEffectiveSequenceCode(DEFAULT_CODE, '999', baseTriangle, 15);
  assert.equal(effective, DEFAULT_CODE);
});

test('deriveEffectiveSequenceCode: a blank code falls back to tracing the Trajectory Angle', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  // Same displayed default-code shot angle used elsewhere in this suite —
  // tracing it should reproduce the exact same code the default text is.
  const effective = api.deriveEffectiveSequenceCode('', '3.105204803654', baseTriangle, 50);
  assert.equal(effective, DEFAULT_CODE);
});

test('deriveEffectiveSequenceCode: whitespace-only code is treated as blank, still falls back to the angle', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  const effective = api.deriveEffectiveSequenceCode('   ', '3.105204803654', baseTriangle, 50);
  assert.equal(effective, DEFAULT_CODE);
});

test('deriveEffectiveSequenceCode: neither code nor a parseable angle resolves to empty', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);
  assert.equal(api.deriveEffectiveSequenceCode('', '', baseTriangle, 15), '');
  assert.equal(api.deriveEffectiveSequenceCode('', 'not-a-number', baseTriangle, 15), '');
  assert.equal(api.deriveEffectiveSequenceCode(null, undefined, baseTriangle, 15), '');
});

test('ray mode keeps the terminal reflected triangle when the path ends at the origin after the last bounce', () => {
  // Use a symmetric triangle whose ray returns to a vertex after reflection.
  const baseTriangle = api.buildBaseTriangle({ a: 45, b: 45, length: 10 });
  // Trace enough bounces to include the return-to-origin event.
  const rayData = api.buildRayModeData({
    baseTriangle,
    rayStartVertex: 0,
    rayAngle: 45,
    maxBounces: 5,
    svgSize: { width: 1000, height: 1000 },
    zoom: 1
  });

  // The terminal reflected copy must be retained in the rendered chain.
  assert.ok(rayData.triangles.length >= 1);
  // Ray-triangle identifiers remain stable for consumers and diagnostics.
  assert.match(rayData.triangles.at(-1).id, /^Ray-T\d+$/);
  // Copy points so the terminal geometry can be asserted independently.
  const terminalPoints = rayData.triangles.at(-1).points.map(point => ({ x: point.x, y: point.y }));
  // The fixed base endpoint remains in its expected position.
  assert.equal(terminalPoints[1].x, 10);
  // The fixed base endpoint remains on the horizontal base line.
  assert.equal(terminalPoints[1].y, 0);
  // Reflection may preserve either equivalent endpoint index at x = 0 or x = 10.
  assert.ok(Math.abs(terminalPoints[0].x - 10) < 1e-9 || Math.abs(terminalPoints[0].x - 0) < 1e-9);
  // The apex may occupy either equivalent reflected x-coordinate.
  assert.ok(Math.abs(terminalPoints[2].x - 15) < 1e-9 || Math.abs(terminalPoints[2].x + 10) < 1e-9);
});

test('ray mode resolves rounded vertex hits toward the forward unfolded triangle', () => {
  // Reuse the known code unfolding as the expected terminal geometry.
  const { baseTriangle, codeData } = buildDefaultCodeData();
  // Trace the displayed, rounded shot angle through the same base triangle.
  const rayData = api.buildRayModeData({
    baseTriangle,
    rayStartVertex: 0,
    // This is the displayed default code-shot angle, rounded to 12 decimals.
    rayAngle: 3.105204803654,
    maxBounces: 50,
    svgSize: { width: 1000, height: 1000 },
    zoom: 1
  });

  // Tie-breaking at rounded vertex hits must preserve the full unfolding length.
  assert.equal(rayData.triangles.length, codeData.triangles.length);
  // The final ray triangle must agree with the code unfolding point-for-point.
  rayData.triangles.at(-1).points.forEach((point, index) => {
    assertPointAlmostEqual(point, codeData.triangles.at(-1).points[index], 1e-9, `terminal point ${index}`);
  });
});

test('symbolic angle conversion round-trips through the current physical label map', () => {
  const { codeData } = buildDefaultCodeData();
  const symbols = api.getSymbolAngleValues(DEFAULT_ANGLE_PARAMS, codeData.idxToAngle);
  const rebuilt = api.buildAngleParamsFromSymbolValues(symbols, codeData.idxToAngle, DEFAULT_ANGLE_PARAMS.length);

  assertAlmostEqual(symbols.x, 15, 1e-12, 'symbol x');
  assertAlmostEqual(symbols.y, 50, 1e-12, 'symbol y');
  assertAlmostEqual(symbols.z, 115, 1e-12, 'symbol z');
  assertAlmostEqual(Number(rebuilt.a), 15, 1e-12, 'rebuilt physical A');
  assertAlmostEqual(Number(rebuilt.b), 50, 1e-12, 'rebuilt physical B');
  assertAlmostEqual(Number(rebuilt.length), 10, 1e-12, 'rebuilt length');
});

test('default shot validator excludes endpoint coordinates from line validity and accepts the known valid sample', () => {
  const { baseTriangle, codeData } = buildDefaultCodeData();
  const validation = api.buildPoolshotTowerValidation({
    simulatorMode: 'code',
    baseTriangle,
    activeTriangles: codeData.triangles,
    labelsMap: codeData.idxToAngle,
    reflectionEdges: codeData.reflectionEdges,
    parsedSequence: codeData.parsedSequence,
    clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON
  });

  assert.equal(validation.status, 'valid');
  assert.equal(validation.shotGeometry.shotSymbol, 'x');
  assert.equal(validation.shotGeometry.shotVertexIdx, 0);
  assert.equal(validation.checked, (codeData.triangles.length + 1) * 3);
  assert.equal(validation.checked, 114);
  assert.equal(validation.stats.blue, 66);
  assert.equal(validation.stats.red, 45);
  assert.equal(validation.stats.uncolored, 0);
  assert.equal(validation.stats.endpoints, 3);
  assert.equal(validation.stats.invalid, 0);
  assert.equal(validation.stats.fanChecked, 10);
  assertAlmostEqual(validation.stats.fanMaxCentralAngle, 150, 1e-9, 'max fan angle');
  assertAlmostEqual(validation.stats.lineMargin, 0.27988321468051813, 1e-10, 'line margin');
  assert.equal(validation.violations.length, 0);

  const endpointClassifications = [...validation.byOccurrence.values()].filter(classification => classification.isShotEndpoint);
  assert.equal(endpointClassifications.length, validation.stats.endpoints);
  assert.ok(endpointClassifications.every(classification => classification.valid));
  assert.ok(endpointClassifications.every(classification => Math.abs(classification.score) <= 1e-8));
  assert.equal(
    validation.stats.blue + validation.stats.red + validation.stats.uncolored + validation.stats.endpoints,
    validation.checked
  );
});

test('direct blue/black y-line predicate rejects known invalid angle perturbations before rendering', () => {
  const { codeData: referenceData } = buildDefaultCodeData();

  const knownValidA = validateCandidate(15.1, 50, referenceData);
  assert.equal(knownValidA.pathConsistency.status, 'valid');
  assert.equal(knownValidA.validation.status, 'valid');

  const knownValidB = validateCandidate(15, 50.1, referenceData);
  assert.equal(knownValidB.pathConsistency.status, 'valid');
  assert.equal(knownValidB.validation.status, 'valid');

  const invalidA = validateCandidate(16, 50, referenceData).validation;
  assert.equal(invalidA.status, 'invalid');
  // Found by its own `expected` reason rather than assumed to be
  // violations[0]: this candidate also happens to fail the effective
  // ray-angle < Angle A check (see buildPoolshotTowerValidation), which is
  // reported first, so this specific line-side violation can land at any
  // index once both co-occur.
  const invalidABlackViolation = invalidA.violations.find(v => v.expected === 'black y < line y');
  assert.ok(invalidABlackViolation, 'expected a black y < line y violation');
  assert.equal(invalidABlackViolation.triId, 'T0');
  assert.equal(invalidABlackViolation.vertexName, 'B');
  assert.equal(invalidABlackViolation.symbol, 'y');
  assert.ok(invalidABlackViolation.score > 0);

  const invalidB = validateCandidate(15, 51, referenceData).validation;
  assert.equal(invalidB.status, 'invalid');
  assert.equal(invalidB.violations[0].expected, 'blue y > line y');
  assert.ok(invalidB.violations[0].score < 0);

  const invalidC = validateCandidate(14, 50, referenceData).validation;
  assert.equal(invalidC.status, 'invalid');
  // Same reasoning as invalidA above: found by `expected` rather than
  // assumed to be violations[0], since this candidate also fails the
  // effective ray-angle < Angle A check.
  const invalidCBlueViolation = invalidC.violations.find(v => v.expected === 'blue y > line y');
  assert.ok(invalidCBlueViolation, 'expected a blue y > line y violation');
  assert.equal(invalidCBlueViolation.triId, 'T0');
  assert.equal(invalidCBlueViolation.vertexName, 'C');
  assert.equal(invalidCBlueViolation.symbol, 'z');
  assert.ok(invalidCBlueViolation.score < 0);
});

test('fan central-angle failures are reported independently of the line-side scan', () => {
  const { codeData: referenceData } = buildDefaultCodeData();
  const invalidFan = validateCandidate(23, 50, referenceData).validation;

  assert.equal(invalidFan.status, 'invalid');
  // Found by triId rather than assumed to be violations[0] — see the
  // identical note above; this candidate also fails the effective
  // ray-angle < Angle A check, which is reported first.
  const invalidFanViolation = invalidFan.violations.find(v => v.triId === 'fan-7');
  assert.ok(invalidFanViolation, 'expected a fan-7 violation');
  assert.equal(invalidFanViolation.symbol, 'x');
  assert.equal(invalidFanViolation.vertexName, '8x');
  assert.equal(invalidFanViolation.expected, '8x < 180deg');
  assertAlmostEqual(invalidFan.stats.fanMaxCentralAngle, 184, 1e-9, 'fan overflow angle');
  assert.ok(invalidFan.stats.invalid > 0);

  const directFan = api.buildFanConstraintValidation({
    parsedSequence: [{ count: 8, angle: 'x' }],
    symbolAngles: { x: 23, y: 50, z: 107 }
  });
  assert.equal(directFan.status, 'invalid');
  assert.equal(directFan.violations[0].expected, '8x < 180deg');
});

test('effective ray-angle constraint rejects a code-driven row whose traced ray is >= Angle A', () => {
  // Code "2" (two reflections around vertex B) happens to produce a fixed
  // 40deg global angle at its own trimmed final point regardless of Angle
  // A (with B=50 fixed) — a real, directly-typed Code Sequence that never
  // touches Angle Ray at all, used here to hit the ray == Angle A and ray
  // > Angle A boundaries exactly, proving buildPoolshotTowerValidation
  // enforces this on the shot's own actual traced angle even when Code
  // Sequence (not Angle Ray) is what drives the row. Deliberately at
  // least 2 reflections, not 1: the check is measured against the same
  // *trimmed* chain the displayed Angle Ray field itself uses (dropping
  // the very last reflected triangle — see getRenderableActiveTriangles),
  // which is empty for a 1-reflection code and would degenerate to a
  // zero-length vector instead of exercising the real comparison.
  const buildRayAngleCase = (angleA) => {
    const baseTriangle = api.buildBaseTriangle({ a: angleA, b: 50, length: 10 });
    const codeData = api.unfoldCodeData('2', baseTriangle, true);
    return api.buildPoolshotTowerValidation({
      simulatorMode: 'code',
      baseTriangle,
      activeTriangles: codeData.triangles,
      labelsMap: codeData.idxToAngle,
      reflectionEdges: codeData.reflectionEdges,
      parsedSequence: codeData.parsedSequence,
      clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON,
    });
  };

  // ray == Angle A: traced global angle is ~40deg (floating-point exact to
  // within 1e-14), Angle A is also 40deg.
  const equalCase = buildRayAngleCase(40);
  assert.equal(equalCase.status, 'invalid');
  const equalViolation = equalCase.violations.find(v => v.role === 'ray-angle');
  assert.ok(equalViolation, 'expected a ray-angle violation when ray === Angle A');
  assert.equal(equalViolation.triId, 'trajectory');

  // ray > Angle A: same ~40deg traced global angle, Angle A is 39deg.
  const greaterCase = buildRayAngleCase(39);
  assert.equal(greaterCase.status, 'invalid');
  const greaterViolation = greaterCase.violations.find(v => v.role === 'ray-angle');
  assert.ok(greaterViolation, 'expected a ray-angle violation when ray > Angle A');
});

test('code-path consistency keeps its fixed interpretation across angle changes', () => {
  const { codeData: referenceData } = buildDefaultCodeData();
  const reference = api.buildCodePathReference(referenceData);

  const samePath = validateCandidate(15.1, 50, referenceData).codeData;
  assert.equal(api.buildCodePathConsistencyValidation({ candidateCodeData: samePath, reference }).status, 'valid');

  const changedPath = validateCandidate(50, 15, referenceData).codeData;
  const changedValidation = api.buildCodePathConsistencyValidation({ candidateCodeData: changedPath, reference });
  assert.equal(changedValidation.status, 'valid');
});

test('stable-region search finds a local component around the known valid symbolic point', () => {
  const { codeData } = buildDefaultCodeData();
  const result = api.findStableRegion({
    angleParams: DEFAULT_ANGLE_PARAMS,
    labelsMap: codeData.idxToAngle,
    billiardsCode: DEFAULT_CODE,
    currentCodeData: codeData,
    clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON
  });

  assert.equal(result.status, 'found');
  assert.equal(result.step, 0.001);
  assert.ok(result.visits > 0);
  assert.equal(result.intervals.zMin, undefined);
  assert.equal(result.intervals.zMax, undefined);
  assert.ok(result.intervals.xMin < 15 && result.intervals.xMax > 15);
  assert.ok(result.intervals.yMin < 50 && result.intervals.yMax > 50);
  assert.ok(result.intervals.xMax - result.intervals.xMin > 0.1);
  assert.ok(result.intervals.yMax - result.intervals.yMin > 0.1);
});

test('global angle uses atan2 quadrant logic for horizontal, vertical, and wrapped rays', () => {
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: 1, y: 0 }), 0, 1e-12, 'east');
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: 0, y: 1 }), 90, 1e-12, 'north');
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: -1, y: 0 }), 180, 1e-12, 'west');
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: 0, y: -1 }), 270, 1e-12, 'south');
});
