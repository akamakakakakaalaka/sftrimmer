import assert from 'node:assert/strict';
import test from 'node:test';
import { BasicSoundBank, GeneratorTypes, SoundBankLoader } from 'spessasynth_core';
import { OfflineEngine } from '../web/src/offline.ts';
import { createPreset, createState } from '../web/src/state.ts';

function fixture(): ArrayBuffer {
  const bank = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  const pcm = Float32Array.from({ length: 4096 }, (_, index) => 0.3 * Math.sin(index * 2 * Math.PI / 128));
  for (const sample of bank.samples) {
    sample.setAudioData(pcm.slice(), 48000);
    sample.loopStart = 0;
    sample.loopEnd = pcm.length;
    sample.originalKey = 60;
  }
  for (const instrument of bank.instruments) instrument.globalZone.setGenerator(GeneratorTypes.sampleModes, 1);
  return bank.writeSF2();
}

const resets = {
  GM: [0xf0, 0x7e, 0x7f, 9, 1, 0xf7],
  GS: [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41, 0xf7],
  XG: [0xf0, 0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7],
};

function peak(pcm: Float32Array): number { return pcm.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0); }

async function resetAfter(mapped: boolean, reset: number[]): Promise<OfflineEngine> {
  const state = createState();
  Object.assign(state.master, { keyShift: 4, fineTune: 29, gain: 0.6 });
  const part = state.parts[0];
  Object.assign(part, { bankId: 'A', reverb: 0, chorus: 0, locked: false });
  Object.assign(part.envelope, { enabled: true, attack: 0, decay: 0, sustain: 1, release: 0.001 });
  Object.assign(part.performance!, { hold: true, sostenuto: true, soft: true, portamento: true, portamentoTime: 100,
    expression: 42, modulation: 77, pitchBend: 13000, bendRange: 12, fineTune: 23 });
  state.presetMappings = [{ partId: 0, msb: 0, lsb: 0, program: 11, preset: createPreset(state, 'Same held snapshot') }];
  const engine = new OfflineEngine(48000, state);
  await engine.loadBank(fixture(), 'A', 'A');
  engine.core.setSystemParameter('effectsEnabled', false);
  if (mapped) engine.sendMIDI([0xc0, 11]);
  engine.sendMIDI(reset);
  return engine;
}

for (const [system, reset] of Object.entries(resets)) {
  test(`${system} reset clears controllers uniformly after direct and mapped-preset histories`, async () => {
    const direct = await resetAfter(false, reset);
    const mapped = await resetAfter(true, reset);
    const controls = [1, 5, 11, 64, 65, 66, 67] as const;
    const directValues = controls.map(controller => direct.core.midiChannels[0].midiControllers[controller] >> 7);
    const mappedValues = controls.map(controller => mapped.core.midiChannels[0].midiControllers[controller] >> 7);
    assert.deepEqual(directValues, [0, 0, 127, 0, 0, 0, 0], `${system}: native reset controller defaults`);
    assert.deepEqual(mappedValues, directValues, `${system}: recalling an app snapshot must not resurrect saved pedals during reset`);
    for (const engine of [direct, mapped]) {
      assert.equal(engine.core.midiChannels[0].midiParameters.pitchWheel, 8192);
      assert.equal(engine.core.midiChannels[0].midiParameters.pitchWheelRange, 2);
      assert.equal(engine.core.midiChannels[0].midiParameters.fineTune, 0);
      assert.equal(engine.core.systemParameters.keyShift, 4);
      assert.equal(engine.core.systemParameters.fineTune, 29);
      assert.equal(engine.core.systemParameters.gain, 0.6);
      engine.noteOn(0, 60);
      assert.ok(peak(engine.render(4096)[0]) > 0.005, `${system}: the concrete user-selected bank still plays`);
      engine.noteOff(0, 60);
      assert.ok(peak(engine.render(24000)[0].slice(-4096)) < 1e-5, `${system}: reset pedals permit an ordinary note to release`);
    }
  });
}
