# AGENTS.md — illuminable-room-modeler

Operational contract for any AI agent (Antigravity, Claude Code, Copilot, etc.) working in this
repo, across any thread/session/contributor. Read this first. It intentionally does NOT
duplicate existing docs — follow the links below for depth.

## 1. Project Overview

Billiard-path research tool: a React/Vite frontend for visualizing polygon billiard code
sequences, angle regions, and trajectories, backed by a Node/Express API with Postgres- and
GitHub-backed graph storage (browser localStorage is now the *primary* store — server stores
are legacy/secondary, do not remove them).

Read before your first change, in this order:
1. `README.md` — quick start.
2. `CODEBASE_COMMENTARY.md` — architecture rationale.
3. `PROJECT_WORKING_NOTES.md` — running project history/decisions (append here each session —
   see §5).
4. `DEPLOYMENT.md` — only if touching build/deploy config or `render.yaml`.

## 2. Architecture Map

- `src/anglePlot/` — core math + rendering glue: `theta.js`, `angleStep.js`,
  `angleValidation.js`, `graph.js`, `graphHasher.js`, `visibleAnglePointGenerator.js`,
  `backgroundExactWorker.js` (async exact computation), `renderSamplingPolicy.js` /
  `rendererSelection.js` (adaptive-preview vs. exact-brute-force rendering tiers), `remoteGraphRepository.js` (legacy server-backed path).
- `src/graphLibrary/` — graph save/load UI + `browserGraphDatabaseStore.js` (primary store).
- `src/sequences/` — sequence graph setup UI.
- `src/workspace/` — `workspaceManager.js`, autosave/restore of the whole session.
- `server/api/` — Express app (`app.js`, `start.js`) and query parsing.
- `server/models/`, `server/repositories/`, `server/db/`, `server/graphDatabase/` — legacy
  server-side persistence layer (Postgres + GitHub-backed). Still load-bearing; do not delete.
- `tests/` — one `*.test.mjs` per module, mirroring `src`/`server` 1:1. If you add a module,
  add its test file using the existing naming convention.

## 3. Specialized Sub-Agents (`.agents/`)

This repo already defines role-scoped agent playbooks. Consult the matching one before working
in its domain — don't reinvent guidance that already exists there:

- `.agents/geometry-validator.md` — consult before changing anything in `src/anglePlot/` math
  (theta, angle, code-sequence, unfolding logic) or `tests/math-regression.test.mjs`,
  `tests/unfolding-edge-cases.test.mjs`. Geometry bugs here are silent and easy to ship.
- `.agents/ui-viewer.md` — consult before changing canvas rendering, `App.jsx`, or
  `AnglePlotPanel.jsx`.
- `.agents/docs-qa.md` — consult before editing `CODEBASE_COMMENTARY.md`,
  `PROJECT_WORKING_NOTES.md`, or `tests/AGENT_QA_REPORT.md`, or when asked to produce a QA pass.

If a task spans multiple domains, read all relevant `.agents/*.md` files before planning, not
just the closest one.

## 4. Build, Test, Verify

- Install: `npm install`
- Dev server: `npm run dev` (Vite)
- Full test suite: `npm test`
- Lint: `npm run lint` (eslint.config.js)
- Production build: `npm run build`

**Non-negotiable bar before considering any task done** (this is the standard the team already
holds itself to in commit history — keep it, don't lower it): full test suite passing, lint
clean, production build succeeds. State all three explicitly when reporting a change as
complete.

## 5. Session Memory (use existing files, don't create new ones)

- Before starting a task: read the most recent entries in `PROJECT_WORKING_NOTES.md` for
  context from other threads/contributors.
- After finishing a task: append a dated entry to `PROJECT_WORKING_NOTES.md` — what changed,
  files touched, why, and any follow-up needed. This is this repo's existing running-context
  file; use it instead of inventing a parallel log.
- For AI-assisted commits, keep the established `Co-Authored-By: <model name>` trailer
  convention already used throughout this repo's history.

## 6. Known Pitfalls (mined from real bugs already fixed here — do not reintroduce)

- **`Number('')` coercion trap**: a blank/empty input field must not silently resolve to a real
  `0` value (this caused a real bug in angle-driven rows). Always explicitly check for
  blank/invalid before numeric coercion.
- **Global Angle ≠ raw traced angle**: these are two distinct, precisely-defined quantities.
  Global Angle reads the angle to vertex A in the final *rendered* triangle; it is not, in
  general, equal to whatever angle was originally typed/traced. Never conflate them.
- **Trimmed vs. untrimmed sequences**: display-layer trims (dropping the trailing vertex from
  Boundary Intersections, dropping the last reflected triangle from rendering) must NOT leak
  into `codeData.sideSequence` or other data consumed by path-equality/hashing logic. Trim only
  at the display layer.
- **`deriveEffectiveSequenceCode` priority order**: a non-blank Code Sequence always wins over an
  Angle Ray input when both are set on the same row. Preserve this priority rule in any related
  change.
- Browser-local `browserGraphDatabaseStore.js` is now primary; the server-backed stores
  (`server/graphDatabase/`, `src/anglePlot/remoteGraphRepository.js`) are intentionally still present and must
  keep working — do not "clean up" by removing them without an explicit decision.

## 7. PR/Commit Conventions (already established — follow them)

- Branch naming: `<initials>-feature/<short-description>` (e.g. `TAS-feature/...`) or
  `<initials>-<area>` for smaller fixes (e.g. `UI-arthur`).
- Commit messages: explain the root cause/reasoning, not just the change (see existing history
  for the expected level of detail on non-trivial fixes).
- Before opening a PR: confirm the §4 verification bar (tests, lint, build) and state results in
  the PR description, matching existing PR conventions in this repo.
