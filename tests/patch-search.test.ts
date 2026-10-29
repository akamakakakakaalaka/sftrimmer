import assert from 'node:assert/strict';
import test from 'node:test';
import type { PatchInfo } from '../web/src/contracts.ts';
import { matchesPatchQuery, patchIdentity, sortPatchEntries } from '../web/src/patch-search.ts';

const patch: PatchInfo = { name: 'Warm Glass Bell', msb: 4, lsb: 5, program: 8, drums: false };

test('patch search treats whitespace-separated names as case-insensitive AND terms', () => {
  for (const query of ['', '   ', 'glass', 'BELL warm', '\tGLASS\n warm  ']) {
    assert.equal(matchesPatchQuery(patch, query), true, query);
  }
  assert.equal(matchesPatchQuery(patch, 'glass piano'), false);
  assert.equal(matchesPatchQuery(patch, '4'), false);
});

test('ordinary words beginning with prog or bank remain searchable as names', () => {
  const namedPatch = { ...patch, name: 'Progressive Banker' };
  for (const query of ['Progressive', 'Banker', 'prog', 'bank', 'progress banker']) {
    assert.equal(matchesPatchQuery(namedPatch, query), true, query);
  }
  assert.equal(matchesPatchQuery(namedPatch, 'progress piano'), false);
});

test('program filters use inclusive zero-based MIDI numbers and combine with names and banks', () => {
  for (const query of ['prog8', 'prog8-15', 'prog0-8', 'PROG8 BANK4 glass', 'bank4 prog8-15 warm bell']) {
    assert.equal(matchesPatchQuery(patch, query), true, query);
  }
  for (const query of ['prog9', 'prog9-15', 'prog0-7', 'prog8 bank5', 'prog8 piano', 'prog8 prog9']) {
    assert.equal(matchesPatchQuery(patch, query), false, query);
  }
  assert.equal(matchesPatchQuery({ ...patch, program: 0, msb: 0 }, 'prog0 bank0'), true);
  assert.equal(matchesPatchQuery({ ...patch, program: 127, msb: 127 }, 'prog127 bank127'), true);
  assert.equal(matchesPatchQuery({ ...patch, program: 15 }, 'prog8-15'), true);
  assert.equal(matchesPatchQuery({ ...patch, program: 16 }, 'prog8-15'), false);
});

test('bank filters target the MSB rather than LSB', () => {
  assert.equal(matchesPatchQuery(patch, 'bank4'), true);
  assert.equal(matchesPatchQuery(patch, 'bank5'), false);
  assert.equal(matchesPatchQuery(patch, 'bank0-4'), true);
  assert.equal(matchesPatchQuery(patch, 'bank5-127'), false);
});

test('malformed and out-of-range numeric filters fail closed', () => {
  for (const query of ['prog-1', 'prog128', 'prog8-128', 'prog15-8', 'prog8-', 'prog8-9-10', 'prog8.5', 'prog+8', 'prog1-x',
    'progNaN', 'progInfinity', 'bank-1', 'bank128', 'bank4-', 'bank5-4', 'bank4/5', 'bankNaN',
    'warm prog128', 'glass bank128']) {
    assert.equal(matchesPatchQuery(patch, query), false, query);
    assert.equal(matchesPatchQuery({ ...patch, name: query }, query), false, `name must not rescue ${query}`);
  }
});

test('patch identity stays stable on rename and distinguishes the complete bank and MIDI address', () => {
  const identity = patchIdentity('sha256:bank-a', patch);
  assert.equal(patchIdentity('sha256:bank-a', { ...patch, name: 'Renamed bell' }), identity);
  for (const other of [{ ...patch, msb: 5 }, { ...patch, lsb: 6 }, { ...patch, program: 9 }, { ...patch, drums: true }]) {
    assert.notEqual(patchIdentity('sha256:bank-a', other), identity);
  }
  assert.notEqual(patchIdentity('sha256:bank-b', patch), identity);
});

test('none preserves source order and name sorting keeps source order for equal names', () => {
  const entries = [
    { patch: { ...patch, name: 'Zebra' }, index: 8 },
    { patch: { ...patch, name: 'Bell' }, index: 7 },
    { patch: { ...patch, name: 'Bell' }, index: 3 },
    { patch: { ...patch, name: 'Apple' }, index: 9 }
  ];
  const original = structuredClone(entries);
  const unchanged = sortPatchEntries(entries, 'none');
  assert.notEqual(unchanged, entries);
  assert.deepEqual(unchanged.map(entry => entry.index), [8, 7, 3, 9]);
  const sorted = sortPatchEntries(entries, 'name');
  assert.deepEqual(sorted.map(entry => entry.index), [9, 7, 3, 8]);
  assert.equal(sorted[1], entries[1]);
  assert.deepEqual(entries, original);
});

test('program and bank sorting use the full MIDI address without mutating entries', () => {
  const entries = [
    { patch: { ...patch, msb: 1, lsb: 3, program: 2 }, index: 0 },
    { patch: { ...patch, msb: 0, lsb: 9, program: 4 }, index: 1 },
    { patch: { ...patch, msb: 1, lsb: 2, program: 2 }, index: 2 },
    { patch: { ...patch, msb: 0, lsb: 9, program: 2 }, index: 3 },
    { patch: { ...patch, msb: 1, lsb: 2, program: 1 }, index: 4 },
    { patch: { ...patch, msb: 1, lsb: 2, program: 2 }, index: 5 }
  ];
  const original = structuredClone(entries);
  assert.deepEqual(sortPatchEntries(entries, 'program').map(entry => entry.index), [4, 3, 2, 5, 0, 1]);
  assert.deepEqual(sortPatchEntries(entries, 'bank').map(entry => entry.index), [3, 1, 4, 2, 5, 0]);
  assert.deepEqual(entries, original);
});
