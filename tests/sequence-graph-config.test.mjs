import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEQUENCE_COLOR_PALETTE,
  colorForSequenceNumber,
  createSequenceRow,
  truncateSequenceText,
  buildMergedSequenceRows,
  relabelSequenceRows,
} from '../src/sequences/sequenceGraphConfig.js';

test('colorForSequenceNumber assigns palette colors in a fixed, cycling order', () => {
  assert.equal(colorForSequenceNumber(1), SEQUENCE_COLOR_PALETTE[0].hex);
  assert.equal(colorForSequenceNumber(2), SEQUENCE_COLOR_PALETTE[1].hex);
  assert.equal(colorForSequenceNumber(SEQUENCE_COLOR_PALETTE.length), SEQUENCE_COLOR_PALETTE.at(-1).hex);
  // Cycles back to the first color once the palette is exhausted, rather than erroring or repeating undefined.
  assert.equal(colorForSequenceNumber(SEQUENCE_COLOR_PALETTE.length + 1), SEQUENCE_COLOR_PALETTE[0].hex);
});

test('createSequenceRow builds a stable id/label pair from the creation number', () => {
  const row = createSequenceRow({ number: 3, sequenceText: '1 2 3', angleStepInput: '0.05' });
  assert.equal(row.id, 'seq-3');
  assert.equal(row.label, 'Graph 3');
  assert.equal(row.sequenceText, '1 2 3');
  assert.equal(row.angleStepInput, '0.05');
  assert.equal(row.color, colorForSequenceNumber(3));
  assert.equal(row.visible, true);
});

test('createSequenceRow defaults to an empty sequence and a usable Angle Step', () => {
  const row = createSequenceRow({ number: 1 });
  assert.equal(row.sequenceText, '');
  assert.equal(row.angleStepInput, '0.1');
});

test('createSequenceRow defaults the richer GraphDatabase-mirroring metadata to blank/false/private', () => {
  const row = createSequenceRow({ number: 1 });
  assert.equal(row.title, '');
  assert.equal(row.notes, '');
  assert.deepEqual(row.tags, []);
  assert.equal(row.favorite, false);
  assert.equal(row.visibility, 'private');
});

test('createSequenceRow accepts explicit title/notes/tags/favorite/visibility', () => {
  const row = createSequenceRow({
    number: 1, title: 'My Graph', notes: 'some notes', tags: ['a', 'b'], favorite: true, visibility: 'public',
  });
  assert.equal(row.title, 'My Graph');
  assert.equal(row.notes, 'some notes');
  assert.deepEqual(row.tags, ['a', 'b']);
  assert.equal(row.favorite, true);
  assert.equal(row.visibility, 'public');
});

test('two rows created with different numbers never collide on id or default color pairing', () => {
  const first = createSequenceRow({ number: 1 });
  const second = createSequenceRow({ number: 2 });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.color, second.color);
});

test('truncateSequenceText leaves short text untouched and marks empty text explicitly', () => {
  assert.equal(truncateSequenceText('1 2 3'), '1 2 3');
  assert.equal(truncateSequenceText(''), '(empty)');
  assert.equal(truncateSequenceText('   '), '(empty)');
});

test('truncateSequenceText shortens long text and keeps it under the requested length', () => {
  const long = '3 1 7 2 6 2 8 2 4 2 5 5 5 5 5 5 5 5 5';
  const truncated = truncateSequenceText(long, 10);
  assert.ok(truncated.length <= 10);
  assert.ok(truncated.endsWith('…'));
  assert.ok(long.startsWith(truncated.slice(0, -1)));
});

// --- buildMergedSequenceRows: "Load" is additive, never a replacement ------

const loadedRow = (overrides = {}) => ({
  sequenceText: '3 1 7 2', angleStepInput: '0.05', angleA: 15, angleB: 50, rayAngleInput: '',
  color: '#ff00ff', visible: false, title: 'Loaded Graph', notes: 'some notes', tags: ['a', 'b'],
  favorite: true, visibility: 'shared',
  ...overrides,
});

test('a workspace with 3 existing graphs plus a 10-graph snapshot ends up with 13 total', () => {
  const existing = [createSequenceRow({ number: 1 }), createSequenceRow({ number: 2 }), createSequenceRow({ number: 3 })];
  const loadedRows = Array.from({ length: 10 }, () => loadedRow());
  const merged = buildMergedSequenceRows(loadedRows, 4);
  const combined = relabelSequenceRows([...existing, ...merged]);
  assert.equal(combined.length, 13);
});

test('existing rows are returned completely untouched by a merge (buildMergedSequenceRows never reads or mutates them)', () => {
  const existing = [createSequenceRow({ number: 1, sequenceText: 'my original' })];
  const existingSnapshot = JSON.stringify(existing);
  buildMergedSequenceRows([loadedRow()], 2);
  assert.equal(JSON.stringify(existing), existingSnapshot, 'buildMergedSequenceRows must never be handed (or touch) the existing array at all');
});

test('loaded rows preserve their own code/A/B/step/color/visibility/tags/notes/favorite data', () => {
  const [merged] = buildMergedSequenceRows([loadedRow()], 1);
  assert.equal(merged.sequenceText, '3 1 7 2');
  assert.equal(merged.angleStepInput, '0.05');
  assert.equal(merged.angleA, 15);
  assert.equal(merged.angleB, 50);
  assert.equal(merged.color, '#ff00ff');
  assert.equal(merged.visible, false);
  assert.equal(merged.title, 'Loaded Graph');
  assert.equal(merged.notes, 'some notes');
  assert.deepEqual(merged.tags, ['a', 'b']);
  assert.equal(merged.favorite, true);
  assert.equal(merged.visibility, 'shared');
});

test('loaded rows never reuse the source snapshot\'s own id/label — every merged row gets a fresh id/label from nextNumber', () => {
  const merged = buildMergedSequenceRows([loadedRow(), loadedRow()], 5);
  assert.equal(merged[0].id, 'seq-5');
  assert.equal(merged[0].label, 'Graph 5');
  assert.equal(merged[1].id, 'seq-6');
  assert.equal(merged[1].label, 'Graph 6');
});

test('merged rows never collide with existing rows\' ids, even when the caller advances its own counter correctly', () => {
  const existing = [createSequenceRow({ number: 1 }), createSequenceRow({ number: 2 }), createSequenceRow({ number: 3 })];
  let nextNumber = 4;
  const merged = buildMergedSequenceRows([loadedRow(), loadedRow()], nextNumber);
  nextNumber += merged.length;
  const allIds = [...existing, ...merged].map((row) => row.id);
  assert.equal(new Set(allIds).size, allIds.length, 'no duplicate ids across existing + merged rows');
  assert.equal(nextNumber, 6);
});

test('loading the exact same snapshot twice adds both copies, each with its own unique id — never deduplicated', () => {
  const snapshotRows = [loadedRow(), loadedRow()];
  const firstLoad = buildMergedSequenceRows(snapshotRows, 1);
  const secondLoad = buildMergedSequenceRows(snapshotRows, 1 + firstLoad.length);
  const allIds = [...firstLoad, ...secondLoad].map((row) => row.id);
  assert.equal(allIds.length, 4);
  assert.equal(new Set(allIds).size, 4, 'both loads of the identical snapshot must produce 4 distinct ids, not 2');
});

test('multiple sequential loads keep accumulating rows without ever dropping earlier ones (simulates App.jsx\'s own nextSequenceNumberRef bookkeeping)', () => {
  let sequences = [createSequenceRow({ number: 1 })]; // start: 1 graph
  let nextNumber = 2;

  const loadNick = buildMergedSequenceRows(Array.from({ length: 2 }, () => loadedRow()), nextNumber); // +2
  nextNumber += loadNick.length;
  sequences = relabelSequenceRows([...sequences, ...loadNick]);
  assert.equal(sequences.length, 3);

  const loadProfessor = buildMergedSequenceRows(Array.from({ length: 5 }, () => loadedRow()), nextNumber); // +5
  nextNumber += loadProfessor.length;
  sequences = relabelSequenceRows([...sequences, ...loadProfessor]);
  assert.equal(sequences.length, 8);

  const loadSarah = buildMergedSequenceRows(Array.from({ length: 3 }, () => loadedRow()), nextNumber); // +3
  nextNumber += loadSarah.length;
  sequences = relabelSequenceRows([...sequences, ...loadSarah]);
  assert.equal(sequences.length, 11);

  const allIds = sequences.map((row) => row.id);
  assert.equal(new Set(allIds).size, allIds.length, 'still no id collisions after three sequential loads');
});

test('buildMergedSequenceRows falls back to blank defaults for a malformed/partial row instead of throwing', () => {
  const merged = buildMergedSequenceRows([{}, null, { sequenceText: 42, tags: 'not-an-array' }], 1);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].sequenceText, '');
  assert.equal(merged[1].sequenceText, '');
  assert.equal(merged[2].sequenceText, ''); // 42 is not a string, falls back
  assert.deepEqual(merged[2].tags, []);
});

test('buildMergedSequenceRows returns an empty array for a non-array input, never throws', () => {
  assert.deepEqual(buildMergedSequenceRows(undefined, 1), []);
  assert.deepEqual(buildMergedSequenceRows(null, 1), []);
});
