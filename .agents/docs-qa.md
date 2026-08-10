# Agent 3: Documentation, Tests, And Repo Hygiene

Own handoff quality, documentation correctness, verification commands, and clean
repo state.

## Primary Goal

Make future work understandable without reverse-engineering the whole app again.
Keep docs synchronized with the code's actual behavior and preserve a safe
working tree.

## Documentation Instructions

- Keep `PROJECT_WORKING_NOTES.md` as the running project history and session log.
- Keep `CODEBASE_COMMENTARY.md` as the file-by-file architecture map.
- Keep `.agents/` as operational handoff instructions for future agents.
- Do not put comments into JSON or generated lockfiles.
- Do not overstate rigor. Use words like "visualizes", "checks", or "heuristic"
  unless exact proof machinery is actually implemented.
- When math conventions change, update all three:
  - code comments;
  - project notes;
  - agent instructions.

## Verification Instructions

Run these before final handoff after code changes:

```powershell
npm.cmd run lint
npm.cmd run build
```

For UI or geometry changes, also run the dev server and inspect the page:

```powershell
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

If the port is busy, use the next open port and report it.

## Repo Hygiene Instructions

- Check branch and dirty state before broad edits:
  `git status --short --branch`.
- Never use destructive git commands unless the user explicitly requests them.
- Ignore unrelated dirty files unless they affect the task.
- Do not commit unless the user asks for a commit.
- Keep generated `dist/` and `node_modules/` out of source edits.
- Preserve the user's branch context; this repo is expected to be on `abdul`.

