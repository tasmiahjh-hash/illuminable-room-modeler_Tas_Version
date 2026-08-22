// SequenceGraphConfig: one row in the Desmos-style multi-sequence list.
//
// Each row is one complete unfolding configuration (a bounce-code sequence
// plus its own Angle Step and display color) and, when visible, one plotted
// dataset in the shared "Valid Angle A-B Region" graph. `id` is a stable
// identity that survives edits/reordering/renaming; `label` is the display
// name shown in the UI and legend. Keeping them separate means a row's
// identity (used for React keys, cached results, and per-point source
// attribution) never has to change just because its label or contents did.
//
// Deliberately NOT stored on this model: the parsed sequence, generated
// graph points, or render status. Those all depend on the shared base
// triangle (Angle A/B/Length, common to every row) and on live generation
// state, so they live as ephemeral, id-keyed state inside AnglePlotWindow
// (which already owns exactly this kind of cancellable/cacheable job state
// for the single-sequence case) rather than being duplicated onto this
// config object. This keeps SequenceGraphConfig a plain, serializable
// description of "what the user asked for", not a cache.

// Named, accessible colors with enough contrast against both the light and
// dark canvas backgrounds this app already supports (see THEME_PALETTES in
// App.jsx). Assigned in this fixed order so a sequence's color never
// depends on how many other rows currently exist.
export const SEQUENCE_COLOR_PALETTE = [
  { name: 'blue', hex: '#0284c7' },
  { name: 'orange', hex: '#d97706' },
  { name: 'green', hex: '#059669' },
  { name: 'purple', hex: '#7c3aed' },
  { name: 'red', hex: '#dc2626' },
  { name: 'teal', hex: '#0891b2' },
  { name: 'magenta', hex: '#db2777' },
  { name: 'gold', hex: '#b45309' },
];

/** Returns the palette color for the Nth sequence ever created (0-indexed), cycling if exhausted. */
export const colorForSequenceNumber = (number) => (
  SEQUENCE_COLOR_PALETTE[(number - 1) % SEQUENCE_COLOR_PALETTE.length].hex
);

/**
 * Builds a new sequence row. `number` is the monotonically increasing
 * creation index (never reused, even after earlier rows are deleted) — it
 * drives the stable color assignment so a row's color never shifts when
 * unrelated rows are removed. `label` starts as `Graph ${number}` but is
 * NOT stable long-term: see `relabelSequenceRows` below, which is what
 * actually keeps labels matching each row's current position.
 *
 * `angleA`/`angleB` are this row's own physical base angles (degrees) —
 * each row's main-canvas point and graph reference geometry, independent of
 * every other row's. They default to blank (not a guessed number): a new
 * row has no meaningful angle yet, so the main controls show an "Enter
 * Angle A/B" placeholder instead of a pre-filled value the user didn't
 * choose. `draftSequenceText`/`draftAngleA`/`draftAngleB`/
 * `draftAngleStepInput` are the live-typing buffers shown in their
 * respective inputs; the corresponding applied field (`sequenceText`,
 * `angleA`, `angleB`, `angleStepInput`) only changes once a draft is
 * successfully applied (Enter, blur, or pressing that graph's "Plot Valid
 * Angle Region" button), so mid-typing keystrokes never touch the graph or
 * main canvas, and a value that fails its constraints is never silently
 * discarded — the draft stays exactly as typed so it can be corrected.
 * `validationError` holds the last apply rejection reason for this row,
 * cleared on the next successful apply. `validationErrorSource` tags which
 * field's apply function currently owns that message ('angle', 'step', or
 * 'sequence') — each apply function only ever reconsiders or clears an
 * error tagged as its own, so e.g. blurring a valid Angle A/B field while a
 * Step error is showing can never blank out that unrelated Step error.
 *
 * `rayAngleInput`/`draftRayAngleInput` are this row's own optional
 * Trajectory Angle (degrees, as typed text) — an alternate way to give this
 * graph a shot without typing a code: when its own Code Sequence is empty,
 * a non-blank Trajectory Angle is traced against this row's own base
 * triangle and the resulting billiard code is derived and used in its
 * place (see App.jsx's deriveEffectiveSequenceCode). A non-blank Code
 * Sequence always wins over a Trajectory Angle on the same row. Follows
 * the same draft/applied split as every other field here.
 *
 * `title`/`notes`/`tags`/`favorite`/`visibility` mirror the richer metadata
 * fields the file-based GraphDatabase (server/graphDatabase/graphDatabase.js)
 * already stores per graph — carried here purely so a row's full metadata
 * round-trips through workspace persistence and into GraphDatabase's own
 * saved record (see AnglePlotWindow.jsx's saveLocalExactGraph call) rather
 * than being silently dropped. No UI currently edits them (they stay at
 * these defaults until a future feature adds one), matching this project's
 * "don't invent UI ahead of a real need" convention elsewhere.
 */
export const createSequenceRow = ({
  number, sequenceText = '', angleStepInput = '0.1', angleA = '', angleB = '', rayAngleInput = '',
  title = '', notes = '', tags = [], favorite = false, visibility = 'private',
}) => ({
  id: `seq-${number}`,
  label: `Graph ${number}`,
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
  color: colorForSequenceNumber(number),
  visible: true,
  validationError: null,
  validationErrorSource: null,
  title,
  notes,
  tags,
  favorite,
  visibility,
});

/**
 * Reassigns every row's display label to its 1-based position in the list
 * ("Graph 1", "Graph 2", ...) — independent of each row's creation-order id
 * and color, which stay put. Call this after any add/remove/reorder so the
 * top row always reads "Graph 1" etc., instead of labels frozen at
 * creation time (which would leave gaps like "Graph 2, Graph 3" after
 * "Graph 1" is deleted).
 */
export const relabelSequenceRows = (rows) => rows.map((row, index) => ({ ...row, label: `Graph ${index + 1}` }));

/** Whether `hex` is a valid `#rrggbb` color string. */
export const isValidHexColor = (hex) => typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex);

/**
 * Builds new, collision-safe rows for graphs coming from an external
 * source — a loaded Cloud Workspace Library snapshot, or a re-imported
 * JSON file (App.jsx's own handleLoadWorkspaceSnapshot, its one caller).
 * Deliberately never reuses the source's own row ids/labels: those were
 * only ever unique *within the snapshot that produced them*, and could
 * collide with whatever already exists in the destination workspace (or
 * with each other, if the same snapshot is loaded twice — see this
 * feature's own "loading the same saved workspace twice must add both
 * copies" requirement). Every row gets a fresh id/label from `nextNumber`
 * onward instead, exactly like any other newly created row
 * (createSequenceRow's own `seq-${number}`/`Graph ${number}` scheme) —
 * "Load" is additive, never a replacement of the current workspace.
 *
 * Field-level fallbacks mirror normalizeRestoredSequences' own defensive
 * per-field handling for a malformed/partial row (an older/hand-edited
 * export, or a snapshot saved before some field existed), so a corrupted
 * source can never crash the merge or produce an invalid row — it just
 * falls back to the same blank defaults createSequenceRow itself uses.
 *
 * @param {Array} rawSequences - the source's own `sequences` array (raw, untrusted shape).
 * @param {number} nextNumber - the first number to assign; the caller owns
 *   advancing its own counter (e.g. nextSequenceNumberRef.current) by
 *   `rawSequences.length` afterward — this function has no side effects.
 * @returns {Array} newly created rows, ready to be appended (never spliced in place of) the destination workspace's existing rows.
 */
export const buildMergedSequenceRows = (rawSequences, nextNumber) => {
  if (!Array.isArray(rawSequences)) return [];
  return rawSequences.map((row, index) => {
    const number = nextNumber + index;
    const newRow = createSequenceRow({
      number,
      sequenceText: typeof row?.sequenceText === 'string' ? row.sequenceText : '',
      angleStepInput: typeof row?.angleStepInput === 'string' ? row.angleStepInput : '0.1',
      angleA: row?.angleA ?? '',
      angleB: row?.angleB ?? '',
      rayAngleInput: typeof row?.rayAngleInput === 'string' ? row.rayAngleInput : '',
      title: typeof row?.title === 'string' ? row.title : '',
      notes: typeof row?.notes === 'string' ? row.notes : '',
      tags: Array.isArray(row?.tags) ? row.tags : [],
      favorite: typeof row?.favorite === 'boolean' ? row.favorite : false,
      visibility: row?.visibility || 'private',
    });
    return {
      ...newRow,
      color: isValidHexColor(row?.color) ? row.color : newRow.color,
      visible: typeof row?.visible === 'boolean' ? row.visible : true,
    };
  });
};

/**
 * Parses raw sequence-input text into whole-number billiard codes, or
 * explains in plain English why it can't. Whitespace-tolerant per the
 * conceptual rule `rawText.trim().split(/\s+/)`: leading/trailing space is
 * ignored and runs of multiple spaces/tabs/newlines collapse to one
 * separator, so pasted text with tabs or line breaks parses the same way as
 * manually-typed single spaces.
 *
 * On failure, returns a structured `sections` array (heading + text, or
 * heading + list) instead of one flat string, so the error dialog can show
 * "Problem" / "How to fix it" / "Example" as clearly separated blocks — see
 * App.jsx's error-modal renderer. There is no fixed enum of "supported
 * codes" in this program (a code is any positive whole-number run length,
 * not a small closed set), so failures here are only ever about *format*
 * (not whole-number, not positive) — never a fabricated "unsupported code"
 * list that doesn't correspond to a real rule.
 */
export const parseSequenceDraftText = (rawText) => {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      title: 'The sequence cannot be empty',
      sections: [
        { heading: 'Problem', text: 'No codes were entered.' },
        { heading: 'How to fix it', text: 'Enter at least one whole-number code, separated by spaces.' },
        { heading: 'Example', text: '4 4 4' },
      ],
    };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const position = i + 1;
    if (!/^\d+$/.test(token)) {
      return {
        valid: false,
        title: 'Unable to read the sequence',
        sections: [
          { heading: 'Problem', text: `"${token}" at position ${position} is not a valid code.` },
          { heading: 'How to fix it', text: 'Enter whole-number codes separated by spaces (no letters, decimals, or symbols).' },
          { heading: 'Example', text: '4 4 4' },
        ],
      };
    }
    if (Number(token) <= 0) {
      return {
        valid: false,
        title: 'Unable to apply this sequence',
        sections: [
          { heading: 'Problem', text: `Code "${token}" at position ${position} must be a whole number greater than zero.` },
          { heading: 'How to fix it', text: 'Replace it with a positive whole number (1 or higher).' },
          { heading: 'Example', text: '3 1 2 4' },
        ],
      };
    }
  }
  return { valid: true, codes: tokens.map(Number) };
};

/** Truncates a sequence string for compact legend/row display, keeping the full text available via title/tooltip. */
export const truncateSequenceText = (text, maxLength = 28) => {
  const trimmed = (text || '').trim();
  if (trimmed.length <= maxLength) return trimmed || '(empty)';
  return `${trimmed.slice(0, maxLength - 1)}…`;
};
