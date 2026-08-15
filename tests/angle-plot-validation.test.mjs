import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidAnglePair,
  isWithinObtuseSumLimit,
  isValidRayAngle,
  ANGLE_EPSILON_DEGREES,
  OBTUSE_THIRD_ANGLE_LIMIT_DEGREES,
} from '../src/anglePlot/angleValidation.js';

test('isValidAnglePair accepts a normal in-range pair with no app validator wired up', () => {
  assert.equal(isValidAnglePair(15, 50), true);
});

test('isValidAnglePair rejects A >= B', () => {
  assert.equal(isValidAnglePair(45, 45), false);
  assert.equal(isValidAnglePair(50, 45), false);
});

test('isValidAnglePair rejects sums over the obtuse limit', () => {
  assert.equal(isValidAnglePair(40, 51), false);
});

test('isValidAnglePair accepts a sum exactly at the obtuse limit', () => {
  assert.equal(isValidAnglePair(40, 50), true); // 40 + 50 === 90
});

test('isValidAnglePair rejects non-positive angles', () => {
  assert.equal(isValidAnglePair(0, 50), false);
  assert.equal(isValidAnglePair(-5, 50), false);
  assert.equal(isValidAnglePair(15, 0), false);
});

test('isValidRayAngle requires the ray to be strictly smaller than Angle A', () => {
  assert.equal(isValidRayAngle(10, 15), true);
  assert.equal(isValidRayAngle(14.999, 15), true);
  assert.equal(isValidRayAngle(15, 15), false);
  assert.equal(isValidRayAngle(15.000001, 15), false);
  assert.equal(isValidRayAngle(NaN, 15), false);
  assert.equal(isValidRayAngle(10, NaN), false);
});

test('isValidAnglePair tolerates floating-point noise around the 90-degree sum boundary', () => {
  // Mirrors the "89.999999999" example from the task: a sum that lands a
  // hair below 90 due to float representation must still read as valid.
  assert.equal(isWithinObtuseSumLimit(44.9, 45 - 1e-10), true);
  // A sum that is genuinely, meaningfully over 90 must still be rejected.
  assert.equal(isWithinObtuseSumLimit(45, 45.01), false);
  assert.ok(ANGLE_EPSILON_DEGREES < 0.01, 'epsilon must be small enough to not mask real violations');
});

test('isValidAnglePair defers to the injected validateCandidate for app-level rules', () => {
  const rejectEverything = () => ({ allowed: false, reason: 'stubbed rejection' });
  assert.equal(isValidAnglePair(15, 50, { validateCandidate: rejectEverything }), false);

  const acceptEverything = () => ({ allowed: true });
  assert.equal(isValidAnglePair(15, 50, { validateCandidate: acceptEverything }), true);

  // A pair that fails the cheap math constraints must never even reach the
  // (expensive, app-specific) validateCandidate callback.
  let called = false;
  const spy = () => { called = true; return { allowed: true }; };
  assert.equal(isValidAnglePair(50, 45, { validateCandidate: spy }), false);
  assert.equal(called, false, 'validateCandidate should not be called for pairs that already fail A < B');
});

test('validateCandidate receives the exact angle values and the supplied base length', () => {
  let received = null;
  const capture = (candidate) => { received = candidate; return { allowed: true }; };
  isValidAnglePair(12.3, 60.4, { validateCandidate: capture, baseLength: 10 });
  assert.deepEqual(received, { a: 12.3, b: 60.4, length: 10 });
});

test('isValidAnglePair accepts a caller-supplied epsilon smaller than the default', () => {
  // Fine grid steps (e.g. 0.0000003) are smaller than ANGLE_EPSILON_DEGREES,
  // so the region generator passes a tighter epsilon; two points exactly one
  // such tiny step apart must still be treated as A < B.
  // Sum stays safely under 90 regardless of epsilon, so this isolates the
  // A < B comparison from the separate sum-limit comparison.
  const tinyGap = 3e-7;
  const a = 10;
  const b = 10 + tinyGap;
  // With the default epsilon (1e-6 > tinyGap) the pair is wrongly rejected.
  assert.equal(isValidAnglePair(a, b), false);
  // With an epsilon scaled to the step, the same pair is correctly accepted.
  assert.equal(isValidAnglePair(a, b, { epsilon: tinyGap / 1000 }), true);
});

test('OBTUSE_THIRD_ANGLE_LIMIT_DEGREES is the single named place governing <=90 vs <90', () => {
  // This is a documentation-style regression test: it pins the constant's
  // current value and the "<=" behavior so a future change to "< 90" (see
  // the comment above isWithinObtuseSumLimit in angleValidation.js) is a
  // deliberate, visible change to this test rather than a silent drift.
  assert.equal(OBTUSE_THIRD_ANGLE_LIMIT_DEGREES, 90);
  assert.equal(isWithinObtuseSumLimit(45, 45), true); // sum === 90 currently allowed
});
