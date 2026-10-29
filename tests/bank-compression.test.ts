import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BasicSoundBank, BasicInstrument, BasicPreset, EmptySample, SoundBankLoader, SpessaLog } from 'spessasynth_core';

SpessaLog.setLogLevel(false, false, false);

async function converter() {
  const module = await import('../web/src/compression.ts').catch(() => null);
  assert.equal(typeof module?.convertToSF3, 'function', 'SF3 conversion must be available');
  return module!.convertToSF3;
}

test('SF3 conversion preserves patch identity, sample loops and decodable audio without mutating input', async () => {
  const convertToSF3 = await converter();
  await BasicSoundBank.ready;
  const source = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  source.soundBankInfo.name = 'Compression test';
  source.soundBankInfo.copyright = 'Example author; retained license notice';
  source.soundBankInfo.comment = 'Retain this bank provenance';
  source.presets[0].name = 'Looped test';
  source.presets[0].bankMSB = 7;
  source.presets[0].program = 29;
  const input = source.writeSF2();
  const original = new Uint8Array(input).slice();
  const progress: number[] = [];
  const output = await convertToSF3(input, 0.7, value => progress.push(value));
  const bank = SoundBankLoader.fromArrayBuffer(output);
  assert.deepEqual(new Uint8Array(input), original);
  assert.equal(bank.soundBankInfo.name, source.soundBankInfo.name);
  assert.equal(bank.soundBankInfo.copyright, source.soundBankInfo.copyright);
  assert.equal(bank.soundBankInfo.comment, source.soundBankInfo.comment);
  assert.deepEqual(bank.presets.map(p => [p.name, p.bankMSB, p.bankLSB, p.program, p.isDrum]),
    source.presets.map(p => [p.name, p.bankMSB, p.bankLSB, p.program, p.isDrum]));
  assert.equal(bank.samples.length, source.samples.length);
  bank.samples.forEach((sample, i) => {
    assert.equal(sample.isCompressed, true);
    assert.equal(sample.loopStart, source.samples[i].loopStart);
    assert.equal(sample.loopEnd, source.samples[i].loopEnd);
    assert.equal(sample.sampleRate, source.samples[i].sampleRate);
    const pcm = sample.getAudioData();
    assert.ok(pcm.length > 0 && pcm.every(Number.isFinite));
    assert.ok(pcm.some(value => Math.abs(value) > 0.01));
  });
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, i) => value >= 0 && value <= 1 && (i === 0 || value >= progress[i - 1])));
});

test('SF3 conversion rejects invalid quality and non-bank data', async () => {
  const convertToSF3 = await converter();
  const input = BasicSoundBank.getSampleSoundBankFile();
  for (const quality of [-0.1, 1.1, NaN, Infinity]) {
    await assert.rejects(convertToSF3(input, quality), /quality/i);
  }
  await assert.rejects(convertToSF3(new ArrayBuffer(3), 0.7));
});

test('SF3 conversion preserves distinct samples sharing a name across merged banks', async () => {
  const convertToSF3 = await converter();
  const source = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  const sample = new EmptySample();
  sample.name = source.samples[0].name;
  const audio = new Float32Array(8_000);
  for (let i = 0; i < audio.length; i++) audio[i] = 0.25 * Math.sin(2 * Math.PI * 440 * i / 8_000);
  sample.setAudioData(audio, 8_000);
  sample.loopStart = 100;
  sample.loopEnd = 7_900;
  const instrument = new BasicInstrument();
  instrument.name = 'Distinct alternate';
  instrument.createZone(sample);
  const preset = new BasicPreset(source);
  preset.name = 'Genuine alternate';
  preset.bankMSB = 64;
  preset.program = 1;
  preset.createZone(instrument);
  source.addCompletePresets([preset]);
  const output = await convertToSF3(source.writeSF2(), 0.7);
  const bank = SoundBankLoader.fromArrayBuffer(output);
  assert.equal(bank.samples.length, 2);
  assert.equal(bank.samples[0].name, bank.samples[1].name);
  assert.notDeepEqual(bank.samples[0].getAudioData(), bank.samples[1].getAudioData());
  assert.deepEqual(bank.samples.map(s => s.sampleRate), source.samples.map(s => s.sampleRate));
});

test('SF3 conversion keeps out-of-range Vorbis sample rates as exact PCM without resampling', async () => {
  const convertToSF3 = await converter();
  const bank = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  const sample = bank.samples[0];
  sample.sampleRate = 6_000;
  const original = sample.getAudioData().slice();
  const result = SoundBankLoader.fromArrayBuffer(await convertToSF3(bank.writeSF2(), 0.7));
  assert.equal(result.samples[0].sampleRate, 6_000);
  assert.equal(result.samples[0].loopStart, sample.loopStart);
  assert.equal(result.samples[0].loopEnd, sample.loopEnd);
  assert.equal(result.samples[0].isCompressed, false);
  assert.deepEqual(result.samples[0].getAudioData(), original);
});
