import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const APP_SOURCE_URL = new URL('../src/App.jsx', import.meta.url);

const loadMathApi = () => {
  const source = readFileSync(APP_SOURCE_URL, 'utf8');
  const helperSource = source.split('const GraphSimulatorView')[0].replace(/^import .*$/gm, '');
  eval(`${helperSource}
globalThis.__unfolderMathApi = {
  buildBaseTriangle,
  unfoldCodeData
};`);
  const api = globalThis.__unfolderMathApi;
  delete globalThis.__unfolderMathApi;
  return api;
};

const api = loadMathApi();
const DEFAULT_ANGLE_PARAMS = { a: 15, b: 50, length: 10 };

test('unfoldCodeData handles empty, invalid, and disabled code gracefully', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);

  // disabled code
  const disabledData = api.unfoldCodeData('2 2', baseTriangle, false);
  assert.equal(disabledData.triangles.length, 0);

  // empty code
  const emptyData = api.unfoldCodeData('   ', baseTriangle, true);
  assert.equal(emptyData.triangles.length, 0);

  // invalid code
  const invalidData = api.unfoldCodeData('a b c', baseTriangle, true);
  assert.equal(invalidData.triangles.length, 0);
  
  // mixed valid/invalid code drops invalid
  const mixedData = api.unfoldCodeData('2 a -5 3', baseTriangle, true);
  // It filters numbers > 0, so '2' and '3' should be parsed.
  assert.deepEqual(mixedData.parsedSequence.map(s => s.count), [2, 3]);
  assert.equal(mixedData.triangles.length, 5); // 2 + 3
});

test('unfoldCodeData respects MAX_CODE_TRIANGLES limit', () => {
  const baseTriangle = api.buildBaseTriangle(DEFAULT_ANGLE_PARAMS);

  // A very large sequence that exceeds 3000
  const largeData = api.unfoldCodeData('4000', baseTriangle, true);
  assert.equal(largeData.triangles.length, 3000); // Because MAX_CODE_TRIANGLES = 3000
  assert.equal(largeData.reflectionEdges.length, 3000);
  assert.equal(largeData.sideSequence.length, 3000);
});
