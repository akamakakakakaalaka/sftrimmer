import assert from 'node:assert/strict';
import test from 'node:test';
import { BasicPreset, BasicSoundBank, GeneratorTypes, SoundBankLoader } from 'spessasynth_core';
import type { AppState, ProgramPortamentoSetting } from '../web/src/contracts.ts';
import { OfflineEngine } from '../web/src/offline.ts';
import { createPerformanceControls } from '../web/src/performance.ts';
import { createPreset, createState, restoreState } from '../web/src/state.ts';

function fixture(period: number): ArrayBuffer {
  const bank = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  const pcm = Float32Array.from({ length: 4096 }, (_, index) => 0.3 * Math.sin(index * 2 * Math.PI / period));
  for (const sample of bank.samples) {
    sample.name = 'Same sample name';
    sample.setAudioData(pcm.slice(), 48000);
    sample.loopStart = 0;
    sample.loopEnd = pcm.length;
    sample.originalKey = 60;
  }
  for (const instrument of bank.instruments) instrument.globalZone.setGenerator(GeneratorTypes.sampleModes, 1);
  bank.presets[0].name = 'Shared program zero';
  const second = new BasicPreset(bank);
  Object.assign(second, { name: 'Shared program one', bankMSB: 0, bankLSB: 0, program: 1, isGMGSDrum: false });
  for (const instrument of bank.instruments) second.createZone(instrument);
  bank.addPresets(second);
  return bank.writeSF2();
}

function state(): AppState {
  const result = createState();
  for (const part of result.parts) {
    part.locked = false;
    part.drums = false;
    part.reverb = 0;
    part.chorus = 0;
    part.performance = createPerformanceControls();
    Object.assign(part.envelope, { attack: 0, decay: 0, sustain: 1, release: 0.001, enabled: true });
  }
  result.parts[0].bankId = 'A';
  result.parts[0].pan = 0;
  return result;
}

function setting(bankId: string, program: number, portamento: boolean, portamentoTime: number): ProgramPortamentoSetting {
  return { bankId, msb: 0, lsb: 0, program, drums: false, portamento, portamentoTime };
}

async function setup(initial: AppState): Promise<OfflineEngine> {
  const engine = new OfflineEngine(48000, initial);
  const [a, b] = [fixture(128), fixture(256)];
  await engine.loadBank(a, 'A', 'A');
  await engine.loadBank(b, 'B', 'B');
  engine.core.setSystemParameter('effectsEnabled', false);
  return engine;
}

function crossings(pcm: Float32Array): number {
  let result = 0;
  for (let index = 1; index < pcm.length; index++) if (pcm[index - 1] <= 0 && pcm[index] > 0) result++;
  return result;
}

function glide(engine: OfflineEngine, part = 0, channel = 0): number {
  engine.panic();
  engine.noteOn(part, 60);
  engine.render(2048);
  engine.noteOff(part, 60);
  engine.noteOn(part, 72);
  return crossings(engine.render(8192)[channel].slice(4096));
}

const bindingFields = ['bankId', 'msb', 'lsb', 'program', 'drums'] as const;

test('font identity separates equal-program portamento defaults and actual sample voices', async () => {
  const initial = state();
  initial.parts[1].bankId = 'B';
  initial.parts[1].pan = 127;
  initial.programPortamento = [setting('A', 0, true, 100), setting('B', 0, false, 100)];
  const engine = await setup(initial);
  engine.applyPart(initial.parts[0], [...bindingFields]);
  engine.applyPart(initial.parts[1], [...bindingFields]);
  engine.noteOn(0, 60);
  engine.noteOn(1, 60);
  const base = engine.render(8192);
  const leftBase = crossings(base[0].slice(4096)), rightBase = crossings(base[1].slice(4096));
  assert.ok(leftBase > rightBase * 1.8, 'the two equal-address fonts retain their distinct sample frequencies');
  engine.noteOff(0, 60);
  engine.noteOff(1, 60);
  engine.noteOn(0, 72);
  engine.noteOn(1, 72);
  const selected = engine.render(8192);
  const sliding = crossings(selected[0].slice(4096)), immediate = crossings(selected[1].slice(4096));
  assert.ok(sliding > immediate * 0.9 && sliding < immediate * 1.3,
    `A starts its octave glide while B reaches the octave immediately (${sliding}, ${immediate})`);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 127);
  assert.equal(engine.core.midiChannels[1].midiControllers[65] >> 7, 0);
});

test('ordinary MIDI program changes recall each actual program and its stored glide time', async () => {
  const initial = state();
  initial.programPortamento = [setting('A', 0, true, 100), setting('A', 1, true, 30)];
  const engine = await setup(initial);
  assert.deepEqual((await engine.loadBank(fixture(128), 'A again', 'A')).presets.map(preset => preset.program), [0, 1]);
  engine.sendMIDI([0xc0, 0]);
  const slow = glide(engine);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 100);
  engine.sendMIDI([0xc0, 1]);
  const fast = glide(engine);
  assert.equal(engine.core.midiChannels[0].patch.program, 1);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 30);
  assert.ok(fast > slow * 1.6, `program one reaches its octave faster (${slow} slow, ${fast} fast cycles)`);
  engine.sendMIDI([0xc0, 0]);
  const recalled = glide(engine);
  assert.ok(Math.abs(recalled - slow) <= 1, 'returning to program zero restores its slow glide');
});

test('selecting an unconfigured font program restores neutral portamento instead of carrying the previous font', async () => {
  const initial = state();
  initial.programPortamento = [setting('A', 0, true, 100)];
  const engine = await setup(initial);
  engine.applyPart(initial.parts[0], [...bindingFields]);
  const sliding = glide(engine);
  initial.parts[0].program = 1;
  engine.applyPart(initial.parts[0], ['program']);
  const unconfigured = glide(engine);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 0);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 0);
  assert.ok(unconfigured > sliding * 1.7, 'unconfigured A program one reaches the octave immediately');
  initial.parts[0].program = 0;
  engine.applyPart(initial.parts[0], ['program']);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 127, 'manual program selection recalls the configured setting again');
  initial.parts[0].bankId = 'B';
  engine.applyPart(initial.parts[0], ['bankId']);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 0);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 0);
  const independent = glide(engine);
  assert.ok(independent > unconfigured * 0.45 && independent < unconfigured * 0.55, 'new font keeps its own source sample');
});

test('restored saved defaults remain dormant until selection and work after bank reload', async () => {
  const initial = state();
  initial.programPortamento = [setting('A', 0, true, 100), setting('A', 1, true, 30)];
  const recovered = restoreState(JSON.parse(JSON.stringify(initial)));
  const engine = await setup(recovered);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 0, 'loading saved settings does not replace the initial panel snapshot');
  engine.sendMIDI([0xc0, 0]);
  const slow = glide(engine);
  await engine.loadBank(fixture(128), 'Reloaded A', 'A');
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 100);
  assert.ok(Math.abs(glide(engine) - slow) <= 1, 'reloading the concrete bank leaves the recalled control state intact');
  engine.sendMIDI([0xc0, 1]);
  assert.ok(glide(engine) > slow * 1.6, 'the recovered second-program setting is available after reload');
});

test('explicit snapshot and leaf intent override a remembered default even at the UI baseline', async () => {
  const initial = state();
  initial.programPortamento = [setting('A', 0, true, 100)];
  const engine = await setup(initial);
  engine.sendMIDI([0xc0, 0]);
  const slow = glide(engine);
  engine.applyPart(initial.parts[0], ['performance.portamento', 'performance.portamentoTime']);
  assert.ok(glide(engine) > slow * 1.7, 'explicit false/time-zero baseline overrides the active program default');
  initial.programPortamento = [setting('A', 0, true, 110)];
  engine.applyState(initial);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 0, 'editing the defaults table does not recall it immediately');
  engine.sendMIDI([0xc0, 0]);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 110);
  engine.applyPart(initial.parts[0], [...bindingFields, 'performance.portamento', 'performance.portamentoTime']);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 0, 'explicit controls win in the same binding transaction');
  Object.assign(initial.parts[0].performance!, { portamento: true, portamentoTime: 30 });
  engine.applyPart(initial.parts[0]);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 30, 'full-part snapshot wins over remembered time110');
  assert.ok(glide(engine) > slow * 1.6, 'the explicit full snapshot reaches the octave with its fast time');
});

test('mapped app snapshots override font defaults through master edits, parameter SysEx and bank reload', async () => {
  const initial = state();
  Object.assign(initial.parts[0].performance!, { portamento: true, portamentoTime: 30 });
  const preset = createPreset(initial, 'Fast explicit snapshot');
  initial.parts[0].performance = createPerformanceControls();
  initial.programPortamento = [setting('A', 0, false, 100)];
  initial.presetMappings = [{ partId: 0, msb: 0, lsb: 0, program: 11, preset }];
  const engine = await setup(initial);
  engine.sendMIDI([0xc0, 11]);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 127);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 30);
  const fast = glide(engine);
  initial.master.fineTune = 17;
  engine.applyState(initial);
  engine.sendMIDI([0xf0, 0x7f, 0x7f, 4, 1, 127, 127, 0xf7]);
  await engine.loadBank(fixture(128), 'Reloaded A', 'A');
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 127);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 30);
  assert.ok(glide(engine) > fast * 0.95, 'snapshot glide remains audible after unrelated updates');
  assert.equal(preset.part.performance!.portamentoTime, 30, 'playback never rewrites the saved app preset');
});

test('remembered MIDI selection survives stale panel master edits and copied table updates stay dormant', async () => {
  const initial = state();
  const saved = setting('A', 0, true, 100);
  initial.programPortamento = [saved];
  const engine = await setup(initial);
  saved.portamentoTime = 30;
  engine.sendMIDI([0xc0, 0]);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 100, 'engine owns an independent copy of imported table records');
  const slow = glide(engine);
  initial.master.fineTune = 17;
  engine.applyState(initial);
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 127, 'stale panel baseline false does not overwrite sounding defaults');
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 100, 'table update does not recall itself during a master edit');
  assert.ok(glide(engine) < slow * 1.1, 'the previous slow glide remains audible after the master edit');
  saved.portamentoTime = 110;
  engine.sendMIDI([0xc0, 0]);
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 30, 'applyState copied the new table rather than retaining the source reference');
  assert.ok(glide(engine) > slow * 1.6, 'the updated default takes effect at the next program selection');
});

test('fallback patch selection uses its actual complete font tuple for remembered defaults', async () => {
  const initial = state();
  const unrelated = { ...setting('A', 55, false, 0), msb: 7, lsb: 9 };
  const drum = { ...setting('A', 0, false, 0), drums: true };
  initial.programPortamento = [unrelated, drum, setting('A', 0, true, 100)];
  const engine = await setup(initial);
  engine.sendMIDI([0xb0, 0, 7, 32, 9, 0xc0, 55]);
  assert.equal(engine.core.midiChannels[0].preset?.program, 0, 'missing request falls back to actual font program zero');
  assert.equal(engine.core.midiChannels[0].midiControllers[65] >> 7, 127, 'fictional incoming bank/program tuple does not override the actual preset setting');
  assert.equal(engine.core.midiChannels[0].midiControllers[5] >> 7, 100, 'melodic tuple remains separate from the matching drum program');
  const slow = glide(engine);
  Object.assign(initial.parts[0], { msb: 7, lsb: 9, program: 55 });
  engine.applyPart(initial.parts[0], ['msb', 'lsb', 'program']);
  assert.ok(Math.abs(glide(engine) - slow) <= 1, 'manual fallback binding uses the same concrete-preset default');
});
