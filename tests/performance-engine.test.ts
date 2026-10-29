import assert from 'node:assert/strict';
import test from 'node:test';
import { BasicSoundBank, GeneratorTypes, SoundBankLoader } from 'spessasynth_core';
import type { AppState, PerformanceControls } from '../web/src/contracts.ts';
import { OfflineEngine } from '../web/src/offline.ts';
import { createPerformanceControls } from '../web/src/performance.ts';
import { createPreset, createState } from '../web/src/state.ts';

function fixture(period = 64): ArrayBuffer {
  const bank = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  const pcm = Float32Array.from({ length: 4096 }, (_, index) => {
    const phase = index * 2 * Math.PI / period;
    return 0.3 * Math.sin(phase);
  });
  for (const sample of bank.samples) {
    sample.setAudioData(pcm.slice(), 48000);
    sample.loopStart = 0;
    sample.loopEnd = pcm.length;
    sample.originalKey = 60;
  }
  for (const instrument of bank.instruments) {
    instrument.globalZone.setGenerator(GeneratorTypes.sampleModes, 1);
    instrument.globalZone.setGenerator(GeneratorTypes.initialFilterFc, 10000);
    instrument.globalZone.setGenerator(GeneratorTypes.initialFilterQ, 0);
    instrument.globalZone.setGenerator(GeneratorTypes.attackVolEnv, -3600);
    instrument.globalZone.setGenerator(GeneratorTypes.decayVolEnv, -1200);
    instrument.globalZone.setGenerator(GeneratorTypes.sustainVolEnv, 200);
    instrument.globalZone.setGenerator(GeneratorTypes.releaseVolEnv, -1200);
  }
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
    Object.assign(part.envelope, { attack: 0, decay: 0, sustain: 1, release: 0.02, enabled: true });
  }
  result.parts[0].bankId = 'A';
  result.parts[0].pan = 0;
  return result;
}

async function setup(initial = state(), period = 64): Promise<OfflineEngine> {
  const engine = new OfflineEngine(48000, initial);
  await engine.loadBank(fixture(period), 'A', 'A');
  engine.core.setSystemParameter('effectsEnabled', false);
  return engine;
}

function peak(pcm: Float32Array): number { return pcm.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0); }
function rms(pcm: Float32Array): number { return Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length); }
function difference(a: Float32Array, b: Float32Array): number {
  return Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0) / a.length);
}
function crossings(pcm: Float32Array): number {
  let count = 0;
  for (let index = 1; index < pcm.length; index++) if (pcm[index - 1] <= 0 && pcm[index] > 0) count++;
  return count;
}

test('held-key telemetry reports unique accepted output keys across all ports and ends before pedal tails', async()=>{
  const initial=state();initial.master.mode='major';initial.parts[127].bankId='A';
  initial.parts[0].performance!.lowKey=60;
  const engine=await setup(initial);engine.noteOn(0,59);engine.noteOn(0,60);engine.noteOn(0,61);
  engine.sendMIDI([0x9f,60,100],7);
  const keys=engine.getHeldNotes();assert.equal(keys.length,128);assert.deepEqual(keys[0],[60]);assert.deepEqual(keys[127],[60]);
  keys[0].push(99);assert.deepEqual(engine.getHeldNotes()[0],[60],'telemetry owns its arrays');
  engine.sendMIDI([0xb0,64,127]);engine.noteOff(0,60);assert.deepEqual(engine.getHeldNotes()[0],[60]);
  engine.noteOff(0,61);assert.deepEqual(engine.getHeldNotes()[0],[]);
  assert.ok(peak(engine.render(8192)[0])>0.005,'pedal-held sound continues after its key indicator ends');
  engine.panic();assert.ok(engine.getHeldNotes().every(notes=>notes.length===0));
});

const bigEndian = (value: number, bytes: number) => Array.from({ length: bytes }, (_, index) => (value >>> ((bytes - index - 1) * 8)) & 255);
const vlq = (value: number) => { const bytes = [value & 127]; while ((value >>>= 7) > 0) bytes.unshift((value & 127) | 128); return bytes; };
const event = (delta: number, ...bytes: number[]) => [...vlq(delta), ...bytes];
const end = (delta = 0) => event(delta, 255, 47, 0);
function smf(format: number, tracks: number[][]): ArrayBuffer {
  return Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, ...bigEndian(format, 2), ...bigEndian(tracks.length, 2), 1, 224,
    ...tracks.flatMap(track => [77, 84, 114, 107, ...bigEndian(track.length, 4), ...track])]).buffer;
}

async function controlPCM(controls: Partial<PerformanceControls>, frames = 24000): Promise<Float32Array> {
  const initial = state();
  Object.assign(initial.parts[0].performance!, controls);
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  return engine.render(frames)[0];
}

test('expression changes actual channel amplitude without changing a neighboring part', async () => {
  const initial = state();
  initial.parts[1].bankId = 'A';
  initial.parts[1].pan = 127;
  const engine = await setup(initial);
  const reference = await setup(initial);
  engine.noteOn(0, 60);
  engine.noteOn(1, 60);
  reference.noteOn(0, 60);
  reference.noteOn(1, 60);
  const before = engine.render(8192);
  reference.render(8192);
  initial.parts[0].performance!.expression = 30;
  engine.applyPart(initial.parts[0], ['performance.expression']);
  const after = engine.render(8192);
  const expected = reference.render(8192);
  assert.ok(peak(after[0].slice(-4096)) < peak(before[0].slice(-4096)) * 0.2);
  assert.ok(difference(after[1], expected[1]) < 1e-7, 'neighbor output matches an untouched, time-aligned reference');
});

test('14-bit pitch bend, its RPN range and per-part fine tuning change rendered pitch', async () => {
  const initial = state();
  const engine = await setup(initial, 128);
  engine.noteOn(0, 60);
  const base = crossings(engine.render(48000)[0].slice(-24000));
  Object.assign(initial.parts[0].performance!, { pitchBend: 16383, bendRange: 12 });
  engine.applyPart(initial.parts[0], ['performance.pitchBend', 'performance.bendRange']);
  const bent = crossings(engine.render(48000)[0].slice(-24000));
  assert.ok(bent > base * 1.95 && bent < base * 2.05, `${base} base cycles, ${bent} bent cycles`);
  Object.assign(initial.parts[0].performance!, { pitchBend: 8192, fineTune: 100 });
  engine.applyPart(initial.parts[0], ['performance.pitchBend', 'performance.fineTune']);
  const tuned = crossings(engine.render(48000)[0].slice(-24000));
  assert.ok(tuned > base * 1.04 && tuned < base * 1.08, `${base} base cycles, ${tuned} tuned cycles`);
  assert.equal(engine.core.systemParameters.fineTune, 0, 'part tuning does not alter master tuning');
});

test('cutoff, resonance and soft pedal each change the actual filtered waveform', async () => {
  const neutral = await controlPCM({});
  const dark = await controlPCM({ cutoff: 20 });
  const resonant = await controlPCM({ resonance: 110 });
  const soft = await controlPCM({ soft: true });
  assert.ok(rms(dark.slice(-12000)) < rms(neutral.slice(-12000)) * 0.3, 'cutoff reduces the source harmonics');
  assert.ok(difference(neutral, resonant) > rms(neutral) * 0.05, 'resonance affects rendered samples');
  assert.ok(difference(neutral, soft) > rms(neutral) * 0.03, 'soft pedal affects rendered samples');
});

test('modulation and vibrato rate, depth and delay all reach the PCM renderer', async () => {
  const neutral = await controlPCM({});
  const modulated = await controlPCM({ modulation: 127 });
  const depth = await controlPCM({ vibratoDepth: 127 });
  const rate = await controlPCM({ vibratoDepth: 127, vibratoRate: 110 });
  const delay = await controlPCM({ vibratoDepth: 127, vibratoDelay: 127 });
  assert.ok(difference(neutral, modulated) > rms(neutral) * 0.05, 'CC1 modulation bends the sounding waveform');
  assert.ok(difference(neutral, depth) > rms(neutral) * 0.05, 'CC77 adds audible vibrato');
  assert.ok(difference(depth, rate) > rms(depth) * 0.05, 'CC76 changes the vibrato rate');
  assert.ok(difference(depth, delay) > rms(depth) * 0.05, 'CC78 changes the vibrato onset');
});

test('portamento time changes the start of the next note without altering its destination', async () => {
  const initial = state();
  Object.assign(initial.parts[0].performance!, { portamento: true, portamentoTime: 100 });
  const sliding = await setup(initial);
  sliding.noteOn(0, 60);
  sliding.render(2048);
  sliding.noteOff(0, 60);
  sliding.noteOn(0, 72);
  const slide = sliding.render(8192)[0].slice(2048);
  const reference = await setup();
  reference.noteOn(0, 72);
  const destination = reference.render(8192)[0].slice(2048);
  assert.ok(crossings(slide) < crossings(destination) * 0.75, 'new note starts below the octave destination');
  sliding.noteOff(0, 72);
  assert.ok(peak(sliding.render(24000)[0].slice(-4096)) < 1e-5);
});

test('relative attack, decay and release controls affect the soundbank envelope', async () => {
  async function relative(controls: Partial<PerformanceControls>, release = false): Promise<Float32Array> {
    const initial = state();
    initial.parts[0].envelope.enabled = false;
    Object.assign(initial.parts[0].performance!, controls);
    const engine = await setup(initial);
    engine.noteOn(0, 60);
    if (release) { engine.render(48000); engine.noteOff(0, 60); }
    return engine.render(48000)[0];
  }
  const neutral = await relative({});
  const slowAttack = await relative({ attack: 127 });
  const slowDecay = await relative({ decay: 127 });
  assert.ok(rms(slowAttack.slice(4096, 8192)) < rms(neutral.slice(4096, 8192)) * 0.5);
  assert.ok(rms(slowDecay.slice(16000, 24000)) > rms(neutral.slice(16000, 24000)) * 1.5);
  const release = await relative({}, true);
  const slowRelease = await relative({ release: 127 }, true);
  assert.ok(peak(release.slice(-4096)) < 1e-5, 'soundbank half-second release finishes');
  assert.ok(rms(slowRelease.slice(9600, 16000)) > rms(release.slice(9600, 16000)) * 3,
    `relative CC72 extends release: normal ${rms(release.slice(9600, 16000))}, extended ${rms(slowRelease.slice(9600, 16000))}`);
});

test('absolute amplitude ADSR overrides the relative MIDI envelope controls', async () => {
  const neutral = await controlPCM({});
  const extremes = await controlPCM({ attack: 127, decay: 0, release: 127 });
  assert.ok(difference(neutral, extremes) < 1e-7, 'absolute envelope produces the same attack, decay and sustain');
  const initial = state();
  Object.assign(initial.parts[0].performance!, { release: 127 });
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  engine.render(4096);
  engine.noteOff(0, 60);
  assert.ok(peak(engine.render(12000)[0].slice(-4096)) < 1e-5, 'absolute release wins over relative CC72');
});

test('sostenuto captures only notes already held when the pedal goes down', async () => {
  const initial = state();
  const engine = await setup(initial, 128);
  engine.noteOn(0, 60);
  engine.render(2048);
  initial.parts[0].performance!.sostenuto = true;
  engine.applyPart(initial.parts[0], ['performance.sostenuto']);
  engine.noteOn(0, 72);
  engine.noteOff(0, 60);
  engine.noteOff(0, 72);
  const held = engine.render(24000)[0].slice(-8192);
  assert.ok(peak(held) > 0.005);
  assert.ok(crossings(held) < 85, 'the later octave note releases while the captured low note remains');
  initial.parts[0].performance!.sostenuto = false;
  engine.applyPart(initial.parts[0], ['performance.sostenuto']);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('sostenuto retains exact captured voice groups when scale notes collide', async () => {
  const initial = state();
  initial.master.mode = 'major';
  const engine = await setup(initial);
  const reference = await setup(initial);
  engine.noteOn(0, 60, 110);
  reference.noteOn(0, 60, 110);
  engine.render(2048);
  reference.render(2048);
  engine.sendMIDI([0xb0, 66, 127]);
  engine.noteOn(0, 61, 20);
  engine.noteOff(0, 60);
  engine.noteOff(0, 61);
  const actual = engine.render(24000)[0].slice(-4096);
  const expected = reference.render(24000)[0].slice(-4096);
  assert.ok(peak(actual) > 0.005);
  assert.ok(difference(actual, expected) < 1e-6, 'only the exact original loud voice remains');
  engine.sendMIDI([0xb0, 66, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('sostenuto release hands a captured note to hold until the hold pedal releases', async () => {
  const engine = await setup();
  engine.noteOn(0, 60);
  engine.sendMIDI([0xb0, 66, 127]);
  engine.noteOff(0, 60);
  engine.sendMIDI([0xb0, 64, 127, 66, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) > 0.005);
  engine.sendMIDI([0xb0, 64, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('sostenuto can capture a note that is already held only by sustain', async () => {
  const engine = await setup();
  engine.noteOn(0, 60);
  engine.sendMIDI([0xb0, 64, 127]);
  engine.noteOff(0, 60);
  engine.sendMIDI([0xb0, 66, 127, 64, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) > 0.005, 'sostenuto keeps the transferred sustain voice');
  engine.sendMIDI([0xb0, 66, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('repeating a captured input note releases its new voice without releasing the captured original', async () => {
  const engine = await setup();
  const reference = await setup();
  engine.noteOn(0, 60, 110);
  reference.noteOn(0, 60, 110);
  engine.render(2048);
  reference.render(2048);
  engine.sendMIDI([0xb0, 66, 127]);
  engine.noteOff(0, 60);
  engine.noteOn(0, 60, 20);
  engine.noteOff(0, 60);
  const actual = engine.render(24000)[0].slice(-4096);
  const expected = reference.render(24000)[0].slice(-4096);
  assert.ok(difference(actual, expected) < 1e-6, 'new same-pitch group releases independently');
  engine.sendMIDI([0xb0, 66, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('mono mode restores a held lower note and the final note off leaves silence', async () => {
  const initial = state();
  initial.parts[0].performance!.mono = true;
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  engine.render(2048);
  engine.noteOn(0, 64);
  engine.render(2048);
  engine.noteOff(0, 64);
  assert.ok(peak(engine.render(4096)[0]) > 0.005, 'lower held note is restored');
  engine.noteOff(0, 60);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('mono repeated and scale-colliding inputs retain releasable voice identities', async () => {
  for (const repeated of [false, true]) {
    const initial = state();
    initial.master.mode = 'major';
    initial.parts[0].performance!.mono = true;
    const engine = await setup(initial);
    const second = repeated ? 60 : 61;
    engine.noteOn(0, 60, 110);
    engine.noteOn(0, second, 70);
    engine.render(2048);
    engine.noteOn(0, 64);
    engine.render(2048);
    engine.noteOff(0, 64);
    engine.noteOff(0, second);
    engine.noteOff(0, 60);
    assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5,
      `${repeated ? 'repeated' : 'scale-colliding'} input group ends silent`);
  }
});

test('mono restores a still-held input after another input at its snapped pitch is released', async () => {
  const initial = state();
  initial.master.mode = 'major';
  initial.parts[0].performance!.mono = true;
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  engine.noteOn(0, 61);
  engine.noteOff(0, 61);
  engine.noteOn(0, 64);
  engine.render(2048);
  engine.noteOff(0, 64);
  assert.ok(peak(engine.render(12000)[0].slice(-4096)) > 0.005, 'original physical key remains eligible for mono restoration');
  engine.noteOff(0, 60);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('mono and poly channel mode messages discard stale note-off FIFO entries', async () => {
  for (const controller of [126, 127]) {
    const engine = await setup();
    engine.noteOn(0, 60);
    engine.sendMIDI([0xb0, controller, 0]);
    engine.noteOn(0, 60);
    engine.noteOff(0, 60);
    assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5,
      `CC${controller} removes the killed voice's old FIFO record`);
  }
});

test('a new mono note cannot inherit selective hold from a killed same-pitch voice', async () => {
  const initial = state();
  initial.parts[0].performance!.mono = true;
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  engine.sendMIDI([0xb0, 66, 127]);
  engine.noteOn(0, 64);
  engine.noteOff(0, 60);
  engine.noteOn(0, 60);
  engine.noteOff(0, 60);
  engine.noteOff(0, 64);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5,
    'new same-pitch voice was played after pedal down and must release normally');
});

test('a blocked live note keeps its note-off identity when the range later expands', async () => {
  const initial = state();
  initial.parts[0].performance!.lowKey = 61;
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  assert.equal(peak(engine.render(2048)[0]), 0);
  initial.parts[0].performance!.lowKey = 0;
  engine.applyPart(initial.parts[0], ['performance.lowKey']);
  engine.noteOn(0, 60);
  engine.noteOff(0, 60);
  assert.ok(peak(engine.render(12000)[0].slice(-4096)) > 0.005, 'off for rejected attempt leaves accepted voice held');
  engine.noteOff(0, 60);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('the live key range does not filter external MIDI notes or strand an already held note', async () => {
  const initial = state();
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  Object.assign(initial.parts[0].performance!, { lowKey: 72, highKey: 84 });
  engine.applyPart(initial.parts[0], ['performance.lowKey', 'performance.highKey']);
  engine.noteOff(0, 60);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
  engine.sendMIDI([0x90, 60, 100]);
  assert.ok(peak(engine.render(4096)[0]) > 0.005, 'incoming MIDI bypasses the live keyboard split');
  engine.sendMIDI([0x80, 60, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
});

test('mapped performance controls survive master edits and explicit leaf intent preserves the mapped instrument', async () => {
  const initial = state();
  initial.parts[0].bankId = 'B';
  initial.parts[0].performance!.expression = 45;
  initial.parts[0].performance!.cutoff = 52;
  initial.parts[0].envelope.sustain = 0.3;
  const preset = createPreset(initial, 'Mapped B');
  initial.parts[0].bankId = 'A';
  initial.parts[0].performance = createPerformanceControls();
  initial.parts[0].envelope.sustain = 1;
  initial.presetMappings = [{ partId: 0, msb: 0, lsb: 0, program: 11, preset }];
  const engine = await setup(initial);
  await engine.loadBank(fixture(128), 'B', 'B');
  engine.sendMIDI([0xc0, 11]);
  initial.master.fineTune = 12;
  engine.applyState(initial);
  assert.equal(engine.core.midiChannels[0].midiControllers[11] >> 7, 45, 'master edit preserves recalled expression');
  engine.applyPart(initial.parts[0], ['performance.expression']);
  const expectedState = state();
  expectedState.master.fineTune = 12;
  expectedState.parts[0] = { ...preset.part, id: 0, performance: { ...preset.part.performance!, expression: 127 } };
  const reference = await setup(expectedState);
  await reference.loadBank(fixture(128), 'B', 'B');
  engine.noteOn(0, 60);
  reference.noteOn(0, 60);
  assert.ok(difference(engine.render(24000)[0], reference.render(24000)[0]) < 1e-6,
    'expression baseline reset retains the mapped bank, cutoff and absolute sustain');
});

test('explicit same-baseline controls win after MIDI automation while master-only changes retain it', async () => {
  const initial = state();
  const engine = await setup(initial);
  engine.sendMIDI([0xb0, 11, 25]);
  initial.master.fineTune = 21;
  engine.applyState(initial);
  assert.equal(engine.core.midiChannels[0].midiControllers[11] >> 7, 25);
  engine.applyPart(initial.parts[0], ['performance.expression']);
  assert.equal(engine.core.midiChannels[0].midiControllers[11] >> 7, 127);
  engine.noteOn(0, 60);
  assert.ok(peak(engine.render(8192)[0]) > 0.01, 'explicit expression reset restores full audible output');
});

test('controller reset and panic discard captured pedal voices without changing app master overrides', async () => {
  const initial = state();
  Object.assign(initial.master, { keyShift: 4, fineTune: 29, gain: 0.6 });
  const engine = await setup(initial);
  engine.noteOn(0, 60);
  engine.sendMIDI([0xb0, 66, 127, 64, 127]);
  engine.noteOff(0, 60);
  engine.sendMIDI([0xb0, 121, 0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5);
  assert.equal(engine.core.systemParameters.keyShift, 4);
  assert.equal(engine.core.systemParameters.fineTune, 29);
  assert.equal(engine.core.systemParameters.gain, 0.6);
  engine.noteOn(0, 60);
  engine.sendMIDI([0xb0, 66, 127]);
  engine.noteOff(0, 60);
  engine.panic();
  assert.equal(peak(engine.render(4096)[0]), 0);
  engine.sendMIDI([0xb0, 66, 0]);
  engine.noteOn(0, 60);
  engine.noteOff(0, 60);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5, 'stale captured IDs do not affect the next note lifetime');
});

test('repeated sostenuto-down messages after All Sound Off do not capture newer notes', async () => {
  const engine = await setup();
  engine.noteOn(0, 60);
  engine.sendMIDI([0xb0, 66, 127, 120, 0]);
  engine.noteOn(0, 64);
  engine.sendMIDI([0xb0, 66, 100]);
  engine.noteOff(0, 64);
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5,
    'the unchanged down state does not create another capture edge');
});

test('SMF formats 0, 1 and 2 preserve master overrides, route performance controls and bypass live key splits', async () => {
  const track = [
    ...event(0, 255, 33, 1, 7),
    ...event(0, 240, 5, 126, 127, 9, 1, 247),
    ...event(0, 176, 101, 0), ...event(0, 176, 100, 0), ...event(0, 176, 6, 12),
    ...event(0, 176, 101, 127), ...event(0, 176, 100, 127),
    ...event(0, 224, 0, 96), ...event(0, 176, 11, 90),
    ...event(0, 144, 60, 100), ...event(240, 128, 60, 0), ...end(240),
  ];
  for (const format of [0, 1, 2]) {
    const initial = state();
    initial.parts[0].bankId = null;
    initial.parts[112].bankId = 'A';
    initial.parts[112].pan = 0;
    Object.assign(initial.parts[112].performance!, { lowKey: 100, highKey: 110 });
    Object.assign(initial.master, { keyShift: 4, fineTune: 29, gain: 0.6 });
    const engine = await setup(initial);
    const tracks = format === 0 ? [track] : format === 1 ? [[...end(480)], track] : [track, [...end(480)]];
    const loaded = engine.loadMidi(smf(format, tracks));
    assert.equal(loaded.format, format);
    engine.play();
    assert.ok(peak(engine.render(8192)[0]) > 0.001, `format ${format}: file note bypasses live range`);
    const channel = engine.core.midiChannels[112];
    assert.equal(channel.midiParameters.pitchWheelRange, 12);
    assert.equal(channel.midiParameters.pitchWheel, 12288);
    assert.equal(channel.midiControllers[11] >> 7, 90);
    assert.equal(engine.core.systemParameters.keyShift, 4);
    assert.equal(engine.core.systemParameters.fineTune, 29);
    assert.equal(engine.core.systemParameters.gain, 0.6);
    engine.pause();
    engine.seek(0.1);
    engine.play();
    assert.ok(peak(engine.render(4096)[0]) > 0.001, `format ${format}: seek restores the spanning file note`);
    assert.ok(peak(engine.render(36000)[0].slice(-4096)) < 1e-5, `format ${format}: note releases after resumed playback`);
  }
});

test('seek restores captured sostenuto notes without capturing notes played later', async () => {
  const track = [
    ...event(0, 144, 60, 100), ...event(48, 176, 66, 127), ...event(48, 128, 60, 0),
    ...event(48, 144, 72, 100), ...event(48, 128, 72, 0), ...event(192, 176, 66, 0), ...end(96),
  ];
  const engine = await setup(state(), 128);
  engine.loadMidi(smf(0, [track]));
  engine.seek(0.3);
  engine.play();
  const captured = engine.render(2400)[0];
  assert.ok(peak(captured) > 0.005, 'released note held by historical sostenuto is restored');
  assert.ok(crossings(captured.slice(1024)) < 16, 'later uncaptured octave note is absent after seek');
  assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5, 'scheduled pedal up releases the restored voice');
});

test('automatic file completion releases captured file voices while a live note on another part continues', async () => {
  const initial = state();
  initial.parts[1].bankId = 'A';
  initial.parts[1].pan = 127;
  const track = [...event(0, 144, 60, 100), ...event(48, 176, 66, 127), ...event(48, 128, 60, 0), ...end(144)];
  const engine = await setup(initial);
  engine.loadMidi(smf(0, [track]));
  engine.noteOn(1, 60);
  engine.play();
  const [file, live] = engine.render(36000);
  assert.ok(peak(file.slice(-4096)) < 1e-5, 'end of file releases the captured file voice');
  assert.ok(peak(live.slice(-4096)) > 0.005, 'held live part remains audible');
  engine.noteOff(1, 60);
  assert.ok(peak(engine.render(24000)[1].slice(-4096)) < 1e-5);
});

test('file completion clears its sustained notes with panel hold enabled and the patch locked', async () => {
  const initial = state();
  initial.parts[0].performance!.hold = true;
  initial.parts[0].locked = true;
  const track = [...event(0, 144, 60, 100), ...event(96, 128, 60, 0), ...end(144)];
  const engine = await setup(initial);
  engine.loadMidi(smf(0, [track]));
  engine.play();
  assert.ok(peak(engine.render(8192)[0].slice(-4096)) > 0.005, 'saved panel hold sustains the file note');
  assert.ok(peak(engine.render(28000)[0].slice(-4096)) < 1e-5, 'completion releases the file voice despite the patch lock');
});

test('part meters report actual channel PCM, reset on read and stay clear for muted parts', async () => {
  const initial = state();
  initial.parts[1].bankId = 'A';
  const engine = await setup(initial);
  assert.deepEqual(engine.getPartLevels(), new Array(128).fill(0));
  engine.noteOn(0, 60);
  engine.render(4096);
  const levels = engine.getPartLevels();
  assert.equal(levels.length, 128);
  assert.ok(levels[0] > 0.001, 'sounding channel reports measured audio');
  assert.ok(levels.slice(1).every(level => level === 0), 'unplayed channels report zero');
  assert.deepEqual(engine.getPartLevels(), new Array(128).fill(0), 'reading consumes accumulated peaks');
  engine.panic();
  initial.parts[0].mute = true;
  engine.applyPart(initial.parts[0], ['mute']);
  engine.noteOn(0, 60);
  engine.render(4096);
  assert.deepEqual(engine.getPartLevels(), new Array(128).fill(0), 'muted channel produces no measured PCM');
});

test('master reverb and chorus return gains change their actual wet audio', async () => {
  for (const bus of ['reverb', 'chorus'] as const) {
    async function render(gain: number): Promise<{ playing: Float32Array; tail: Float32Array }> {
      const initial = state();
      initial.master.reverbGain = bus === 'reverb' ? gain : 0;
      initial.master.chorusGain = bus === 'chorus' ? gain : 0;
      initial.parts[0].reverb = bus === 'reverb' ? 127 : 0;
      initial.parts[0].chorus = bus === 'chorus' ? 127 : 0;
      initial.parts[0].envelope.release = 0.001;
      const engine = await setup(initial);
      engine.core.setSystemParameter('effectsEnabled', true);
      engine.noteOn(0, 60);
      const playing = engine.render(8192)[0];
      engine.noteOff(0, 60);
      return { playing, tail: engine.render(24000)[0].slice(512) };
    }
    const silentReturn = await render(0);
    const fullReturn = await render(1);
    assert.ok(peak(silentReturn.tail) < 1e-5, `${bus}: dry release ends with the return gain at zero`);
    assert.ok(difference(silentReturn.playing, fullReturn.playing) > 0.00001,
      `${bus}: return gain changes actual playing PCM (${difference(silentReturn.playing, fullReturn.playing)})`);
    if (bus === 'reverb') assert.ok(peak(fullReturn.tail) > 0.0001, 'reverb return remains audible after the dry note releases');
  }
});
