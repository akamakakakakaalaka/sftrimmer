import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPreset, createPreset, createState, loadState, parsePreset, restoreState, saveState } from '../web/src/state.ts';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); }
  };
}

test('a new session supplies 128 independent parts with MIDI percussion channels', () => {
  const state = createState();
  assert.equal(state.parts.length, 128);
  assert.deepEqual(state.parts.map(part => part.id), Array.from({ length: 128 }, (_, id) => id));
  assert.deepEqual(state.parts.filter(part => part.drums).map(part => part.id), [9, 25, 41, 57, 73, 89, 105, 121]);
  assert.equal(state.master.keyShift, 0);
  assert.equal(state.master.gain, 0.7);
  state.parts[0].envelope.attack = 3;
  state.parts[0].drumMap[36] = 40;
  assert.equal(state.parts[1].envelope.attack, 0.01);
  assert.deepEqual(state.parts[1].drumMap, {});
});

test('session storage round trips master tuning, part edits and bank identity', () => {
  const storage = memoryStorage();
  const state = createState();
  state.master.keyShift = -7;
  state.master.fineTune = 37;
  state.master.tempo = 1.25;
  state.selectedPart = 117;
  Object.assign(state.parts[117], { bankId: 'sha256:bank-a', msb: 127, lsb: 4, program: 73, transpose: 12 });
  state.parts[117].drumMap[36] = 38;
  saveState(state, storage);
  assert.equal(storage.getItem('project128.session') === null, false);
  const restored = loadState(storage);
  assert.deepEqual(restored, state);
  restored.parts[117].envelope.release = 6;
  assert.equal(state.parts[117].envelope.release, 0.3);
});

test('untrusted session input clamps finite values and discards invalid data', () => {
  const restored = restoreState({
    version: 1,
    selectedPart: 999,
    master: { keyShift: 999, fineTune: -999, gain: Infinity, tempo: NaN, root: 99, mode: 'invented-mode', delayFeedback: 2, theme: '<script>' },
    parts: [{ id: 0, bankId: 123, volume: 900, pan: -9, msb: 999, program: '10', mute: 'false', solo: true,
      transpose: -999, envelope: { attack: -1, decay: Infinity, sustain: 3, release: NaN, enabled: true },
      drumMap: { 36: 999, 37: '40', '-1': 38, '__proto__': 44 } }]
  });
  assert.equal(restored.selectedPart, 127);
  assert.equal(restored.master.keyShift, 48);
  assert.equal(restored.master.fineTune, -100);
  assert.equal(restored.master.gain, 0.7);
  assert.equal(restored.master.tempo, 1);
  assert.equal(restored.master.root, 11);
  assert.equal(restored.master.mode, 'chromatic');
  assert.equal(restored.master.theme, 'dark');
  assert.equal(restored.master.delayFeedback, 0.95);
  assert.equal(restored.parts[0].bankId, null);
  assert.equal(restored.parts[0].volume, 127);
  assert.equal(restored.parts[0].pan, 0);
  assert.equal(restored.parts[0].msb, 127);
  assert.equal(restored.parts[0].program, 0);
  assert.equal(restored.parts[0].mute, false);
  assert.equal(restored.parts[0].solo, true);
  assert.equal(restored.parts[0].transpose, -48);
  assert.deepEqual(restored.parts[0].envelope, { attack: 0, decay: 0.2, sustain: 1, release: 0.3, enabled: true });
  assert.deepEqual(restored.parts[0].drumMap, { 36: 127 });
});

test('restoration preserves logical identity when part records are missing, reordered or duplicated', () => {
  const restored = restoreState({ version: 1, parts: [
    { id: 127, volume: 44 }, { id: 0, volume: 33 }, { id: 127, volume: 11 },
    { id: -1, volume: 1 }, { id: 128, volume: 2 }, { volume: 4 }
  ] });
  assert.equal(restored.parts.length, 128);
  assert.equal(restored.parts[0].volume, 33);
  assert.equal(restored.parts[127].volume, 44);
  assert.equal(restored.parts[1].volume, 100);
  assert.equal(restored.parts[127].id, 127);
  assert.equal(restoreState(null).parts.length, 128);
  assert.equal(restoreState({ version: 2, master: { gain: 1.2 } }).master.gain, 0.7);
});

test('corrupt or unavailable session storage falls back to a usable session', () => {
  const storage = memoryStorage();
  storage.setItem('project128.session', '{bad json');
  assert.equal(loadState(storage).parts.length, 128);
  storage.setItem('project128.session', 'null');
  assert.equal(loadState(storage).master.fineTune, 0);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } } as unknown as Storage;
  assert.equal(loadState(blocked).parts.length, 128);
  assert.doesNotThrow(() => saveState(createState(), blocked));
});

test('an individual preset snapshots its bank and nested edits without shared references', () => {
  const state = createState();
  state.selectedPart = 19;
  Object.assign(state.parts[19], { bankId: 'bank-A', msb: 9, lsb: 4, program: 31 });
  state.parts[19].envelope.enabled = true;
  state.parts[19].drumMap[36] = 42;
  const preset = createPreset(state, '  Glass bell  ');
  assert.equal(preset.name, 'Glass bell');
  assert.equal(preset.bankId, 'bank-A');
  assert.equal(preset.part.program, 31);
  const applied = applyPreset(state, preset, 120);
  assert.equal(applied.parts[120].id, 120);
  assert.equal(applied.parts[120].bankId, 'bank-A');
  assert.equal(applied.parts[120].drumMap[36], 42);
  applied.parts[120].envelope.attack = 7;
  applied.parts[120].drumMap[36] = 60;
  applied.parts[19].drumMap[36] = 61;
  assert.equal(preset.part.envelope.attack, 0.01);
  assert.equal(preset.part.drumMap[36], 42);
  assert.equal(state.parts[19].drumMap[36], 42);
  assert.equal(state.parts[120].bankId, null);
  assert.equal(parsePreset(JSON.stringify(preset)).part.bankId, 'bank-A');
});

test('preset import rejects unrelated, corrupt, mismatched-bank and invalid records', () => {
  const preset = createPreset(createState(), 'Piano');
  assert.throws(() => parsePreset('KQSPRESET\u0000legacy'));
  assert.throws(() => parsePreset(JSON.stringify({ version: 1, name: 'Piano' })));
  assert.throws(() => parsePreset(JSON.stringify({ ...preset, version: 2 })));
  assert.throws(() => parsePreset(JSON.stringify({ ...preset, bankId: 'other-bank' })));
  assert.throws(() => parsePreset(JSON.stringify({ ...preset, part: { ...preset.part, volume: 'loud' } })));
  assert.throws(() => applyPreset(createState(), preset, 128));
});

test('MIDI app-preset mappings round trip exact bank identity without sharing nested edits', () => {
  const state = createState();
  assert.equal(state.presetMappings?.length, 0);
  state.parts[0].bankId = 'sha256:exact-bank-fingerprint';
  state.parts[0].envelope.enabled = true;
  state.parts[0].drumMap[36] = 42;
  const preset = createPreset(state, 'Mapped glass');
  state.presetMappings!.push({ partId: 127, msb: 127, lsb: 9, program: 42, preset });
  const storage = memoryStorage();
  saveState(state, storage);
  const restored = loadState(storage);
  assert.deepEqual(restored.presetMappings, state.presetMappings);
  assert.equal(restored.presetMappings![0].preset.bankId, 'sha256:exact-bank-fingerprint');
  const applied = applyPreset(restored, preset, 32);
  assert.deepEqual(applied.presetMappings, restored.presetMappings);
  applied.presetMappings![0].preset.part.envelope.attack = 4;
  applied.presetMappings![0].preset.part.drumMap[36] = 60;
  assert.equal(restored.presetMappings![0].preset.part.envelope.attack, 0.01);
  assert.equal(restored.presetMappings![0].preset.part.drumMap[36], 42);
  assert.equal(preset.part.drumMap[36], 42);
  const snapshot = createPreset(restored, 'Individual only');
  assert.equal('presetMappings' in snapshot, false);
  assert.equal('presetMappings' in snapshot.part, false);
});

test('malformed MIDI app-preset bindings are dropped rather than defaulted to another address', () => {
  const preset = createPreset(createState(), 'Piano');
  const valid = { partId: 0, msb: 0, lsb: 0, program: 0, preset };
  const bad = [null, {}, { ...valid, partId: -1 }, { ...valid, partId: 128 },
    { ...valid, partId: 0.5 }, { ...valid, msb: '0' }, { ...valid, msb: 128 },
    { ...valid, lsb: -1 }, { ...valid, lsb: NaN }, { ...valid, program: Infinity },
    { ...valid, program: 0.5 }, { ...valid, program: undefined },
    { ...valid, preset: { ...preset, bankId: 'mismatched-bank' } },
    { ...valid, preset: { ...preset, part: { ...preset.part, volume: 'loud' } } }];
  assert.deepEqual(restoreState({ version: 1, presetMappings: bad }).presetMappings, []);
  assert.deepEqual(restoreState({ version: 1, presetMappings: { '0': valid } }).presetMappings, []);
  assert.deepEqual(restoreState({ version: 1, presetMappings: [...bad, valid] }).presetMappings, [valid]);
});

test('mapping collisions keep the first valid binding and remain scoped to one part and full address', () => {
  const first = createPreset(createState(), 'First valid');
  const second = createPreset(createState(), 'Later duplicate');
  const mapping = { partId: 17, msb: 2, lsb: 3, program: 4, preset: first };
  const restored = restoreState({ version: 1, presetMappings: [
    { ...mapping, preset: {} }, mapping, { ...mapping, preset: second },
    { ...mapping, partId: 18, preset: second },
    { ...mapping, msb: 3, preset: second },
    { ...mapping, lsb: 4, preset: second },
    { ...mapping, program: 5, preset: second }
  ] });
  assert.equal(restored.presetMappings!.length, 5);
  assert.deepEqual(restored.presetMappings!.map(item => [item.partId, item.msb, item.lsb, item.program, item.preset.name]), [
    [17, 2, 3, 4, 'First valid'], [18, 2, 3, 4, 'Later duplicate'],
    [17, 3, 3, 4, 'Later duplicate'], [17, 2, 4, 4, 'Later duplicate'], [17, 2, 3, 5, 'Later duplicate']
  ]);
});

test('session restoration retains at most the first 2048 unique valid MIDI app-preset bindings', () => {
  const preset = createPreset(createState(), 'Bounded map');
  const mappings = Array.from({ length: 2050 }, (_, index) => ({ partId: Math.floor(index / 128), msb: 0, lsb: 0, program: index % 128, preset }));
  const restored = restoreState({ version: 1, presetMappings: mappings });
  assert.equal(restored.presetMappings!.length, 2048);
  assert.equal(restored.presetMappings![2047].partId, 15);
  assert.equal(restored.presetMappings![2047].program, 127);
  restored.presetMappings![0].preset.part.envelope.release = 9;
  assert.equal(restored.presetMappings![1].preset.part.envelope.release, 0.3);
  assert.equal(preset.part.envelope.release, 0.3);
});
