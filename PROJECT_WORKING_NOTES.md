# Project Working Notes (Session Memory)

This file maintains a running history of project context, architectural decisions, and tasks completed across different AI agent sessions. The older, long-form mathematical and architectural documentation has been archived to `build_history/PROJECT_WORKING_NOTES_archive.md`.

## [2026-08-07] Multi-Sequence UI Improvements (PR #39 & #40)

**What changed:**
- Renamed "Trace Ray Angle" to "Angle Ray" throughout the UI and added a permanent "Angle Ray" label.
- Added short labels ("Code Seq.", "Side Seq.") to sequence inputs and boxes to improve clarity.
- Introduced `Theta`: the symbolic angle equation for each graph's code. This calculates the equation starting from theta = 90, eliminating Z via Z = 180 - X - Y, and formatting the output cleanly (e.g. `θ = 270 - 26X + 4Y`). The `Theta` box is permanently visible for every Sequence Parser card and Sequence Logs panel.

**Files touched:**
- `src/anglePlot/theta.js` (NEW): Contains `calculateTheta(parsedSequence)` and `formatTheta(...)`.
- `tests/theta.test.mjs` (NEW): Test suite for Theta math, alternating signs by position, Z substitution, empty/invalid input.
- `src/App.jsx` and `src/sequences/` components: Updated to render "Angle Ray" and new short labels, and to include the Theta box.

**Why:**
- To improve usability and explicitly visualize the symbolic equation represented by the code sequences, which is crucial for the mathematical understanding of the periodic billiards logic. UI text was updated for consistency.

**Follow-up needed:**
- Ensure future sequence/angle logic respects the new `Theta` calculations and labels.
