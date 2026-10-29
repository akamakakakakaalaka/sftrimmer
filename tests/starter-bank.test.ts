import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { BasicSoundBank, SoundBankLoader, SpessaLog } from 'spessasynth_core';

SpessaLog.setLogLevel(false, false, false);

test('bundled bank contains complete GM coverage and eight genuine documented alternate presets within budget', async () => {
  const root = new URL('../', import.meta.url);
  const metadata = JSON.parse(await readFile(new URL('web/public/banks/starter.json', root), 'utf8').catch(() => '{}'));
  assert.equal(metadata.name, 'Project128 GS', 'a generated starter bank must be bundled');
  const data = await readFile(new URL('web/public/banks/starter.sf3', root));
  assert.ok(data.length < 14_000_000, `bank exceeds budget: ${data.length}`);
  assert.equal(metadata.bytes, data.length);
  assert.equal(metadata.sha256, createHash('sha256').update(data).digest('hex'));
  await BasicSoundBank.ready;
  const bank = SoundBankLoader.fromArrayBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  assert.equal(bank.soundBankInfo.name, metadata.name);
  assert.equal(bank.presets.length, metadata.presetCount);
  const gm = new Set(bank.presets.filter(p => p.bankMSB === 0 && p.bankLSB === 0 && !p.isDrum).map(p => p.program));
  assert.equal(gm.size, 128);
  const identities = bank.presets.map(p => `${p.bankMSB}:${p.bankLSB}:${p.program}:${p.isGMGSDrum}`);
  assert.equal(new Set(identities).size, identities.length, 'patch addresses must be unique');
  const extras = bank.presets.filter(p => p.bankMSB === 64 && !p.isDrum);
  assert.deepEqual(extras.map(p => p.program).sort((a, b) => a - b), [5, 16, 30, 36, 55, 62, 88, 90]);
  assert.ok(extras.every(p => p.name.startsWith('Tim ') && p.zones.some(z => z.instrument.zones.length > 0)));
  for (const extra of extras) {
    const original = bank.presets.find(p => !p.isDrum && p.bankMSB === 0 && p.bankLSB === 0 && p.program === extra.program)!;
    const signature = (preset: typeof extra) => preset.zones.flatMap(zone => zone.instrument.zones.map(z => {
      const audio = z.sample.getAudioData();
      return createHash('sha256').update(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)).digest('hex');
    })).sort();
    assert.notDeepEqual(signature(extra), signature(original), `${extra.name} must be a distinct sampled alternate`);
  }
  assert.equal(bank.presets.filter(p => p.isGMGSDrum).length, 13);
  assert.ok(bank.samples.every(sample => sample.isCompressed || sample.sampleRate < 8_000 || sample.sampleRate > 96_000));
  assert.ok(bank.samples.filter(sample => sample.isCompressed).length > bank.samples.length * 0.95);
  assert.ok(!/authentic|roland samples/i.test(metadata.description));
  for (const name of ['GeneralUser-LICENSE.txt', 'TimGM6mb-LICENSE.txt', 'GPL-2.0.txt', 'PROVENANCE.json', 'README.txt']) {
    assert.ok((await readFile(new URL(`licenses/banks/${name}`, root))).length > 100);
  }
});

test('bundled samples decode to finite PCM with valid retained loops', async () => {
  const data = await readFile(new URL('../web/public/banks/starter.sf3', import.meta.url));
  await BasicSoundBank.ready;
  const bank = SoundBankLoader.fromArrayBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  for (const sample of bank.samples) {
    const audio = sample.getAudioData();
    assert.ok(audio.length > 0, sample.name);
    assert.ok(audio.every(Number.isFinite), sample.name);
    assert.ok(sample.loopStart >= 0 && sample.loopEnd <= audio.length && sample.loopStart <= sample.loopEnd, sample.name);
  }
});
