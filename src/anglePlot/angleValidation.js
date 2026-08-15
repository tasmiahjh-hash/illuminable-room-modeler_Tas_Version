// AnglePairValidator equivalent: pure, framework-free rules for whether a
// physical (A, B) base-angle pair belongs on the "Valid Angle A-B Region"
// plot. This module intentionally knows nothing about React, SVG, or the
// billiards code parser — the expensive, app-specific validation (does the
// rest of the program actually accept this pair?) is injected as the
// `validateCandidate` callback rather than duplicated here. See
// visibleAnglePointGenerator.js for how this is driven across a whole grid (using
// an arbitrary decimal step from angleStep.js, not a fixed increment), and
// App.jsx for how `validateCandidate` is wired to the exact same
// `validateLockedAngleCandidate` closure the live A/B number inputs use.

// Tolerance used when comparing raw floating point degrees, e.g. a value
// arriving as 89.999999999 that should be treated as exactly 90 rather than
// incorrectly rejected. This default is sized for ordinary floating-point
// noise, not for the user's chosen grid step — a step smaller than this
// (e.g. 0.0000003) would make two genuinely-adjacent grid points look
// "equal" under this tolerance, so visibleAnglePointGenerator.js passes a smaller,
// step-scaled epsilon instead of relying on this default. See its
// `epsilon` computation for why.
export const ANGLE_EPSILON_DEGREES = 1e-6;

// --- Third-angle "obtuse" rule -------------------------------------------
// The implicit third triangle angle is C = 180 - A - B, and A + B <= 90
// keeps C at or above 90 degrees (a right or obtuse third angle). The
// task currently asks for A + B <= 90 exactly. If the intent later
// becomes "the third angle must be *strictly* obtuse", change ONLY the
// comparison below from `<=` to `<` (and drop the epsilon on this side of
// the comparison, since a strict rule should not treat 90 + epsilon as
// passing). Nothing else in this file or in visibleAnglePointGenerator.js needs
// to change.
export const OBTUSE_THIRD_ANGLE_LIMIT_DEGREES = 90;

export const isWithinObtuseSumLimit = (angleA, angleB, epsilon = ANGLE_EPSILON_DEGREES) =>
  angleA + angleB <= OBTUSE_THIRD_ANGLE_LIMIT_DEGREES + epsilon;

/**
 * boolean isValidRayAngle(rayAngle, angleA)
 *
 * The traced Angle Ray must stay strictly inside the A-side wedge, which means
 * it must be smaller than Angle A itself. This is a separate geometric rule from
 * the A/B triangle validity checks and is enforced in the app when a row is
 * angle-driven.
 */
export const isValidRayAngle = (rayAngle, angleA, epsilon = ANGLE_EPSILON_DEGREES) => {
  if (!Number.isFinite(rayAngle) || !Number.isFinite(angleA)) return false;
  return rayAngle < angleA - epsilon;
};

/**
 * boolean isValidAnglePair(angleA, angleB)
 *
 * Checks, in order from cheapest to most expensive:
 *   1. Both angles are finite and strictly positive (minimum bound).
 *   2. A < B.
 *   3. A + B <= 90 (see isWithinObtuseSumLimit above).
 *   4. Whatever the rest of the program already requires, via the injected
 *      `validateCandidate` callback — this is the same check the app runs
 *      when a user types a new A or B value, so a point is never marked
 *      valid here unless the main program would also accept it.
 *
 * `validateCandidate` is optional so this module (and its tests) can run
 * without any app wiring; the plot generator always supplies it in
 * production so step 4 is never skipped for real.
 *
 * `epsilon` defaults to ANGLE_EPSILON_DEGREES but should be overridden by
 * callers stepping a grid finer than that (see visibleAnglePointGenerator.js) so
 * the tolerance never swallows a real, intentional gap between points.
 */
export const isValidAnglePair = (angleA, angleB, { validateCandidate, baseLength, epsilon = ANGLE_EPSILON_DEGREES } = {}) => {
  if (!Number.isFinite(angleA) || !Number.isFinite(angleB)) return false;
  // Minimum positive-angle bound. The reused app validator re-checks this
  // too (via hasValidAngleTriangle), but failing fast here skips the
  // expensive call for angles that can never be valid.
  if (angleA <= 0 || angleB <= 0) return false;
  // A must be strictly less than B.
  if (angleA >= angleB - epsilon) return false;
  // Third-angle limit, kept in its own named method so it is easy to find
  // and change later (see comment above isWithinObtuseSumLimit).
  if (!isWithinObtuseSumLimit(angleA, angleB, epsilon)) return false;

  if (typeof validateCandidate !== 'function') return true;
  // Reuse the exact same constraint-validation logic the main program
  // applies when the user edits A/B directly, instead of re-implementing
  // triangle/unfolding rules here.
  const result = validateCandidate({ a: angleA, b: angleB, length: baseLength });
  return !!(result && result.allowed);
};
