#!/usr/bin/env node
// Rebuild the complete starter bank: node tools/prepare-bank.mjs
// Sources remain in the OS temporary cache, outside the release archive.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { BasicSoundBank, SoundBankLoader, SpessaLog } from 'spessasynth_core';
import { convertToSF3 } from '../web/src/compression.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = process.env.PROJECT128_BANK_CACHE || join(tmpdir(), 'project128-banks');
const publicDir = resolve(root, 'web/public/banks');
const noticesDir = resolve(root, 'licenses/banks');
const hash = data => createHash('sha256').update(data).digest('hex');
const arrayBuffer = data => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
const sourceCommit = '684543d5e5efaef08d02be50dcda8d552478fa60';
const generalBase = `https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${sourceCommit}/`;
const sources = {
  generalUser: { name: 'GeneralUser-GS.sf2', url: generalBase + 'GeneralUser-GS.sf2', sha256: '9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe' },
  generalLicense: { name: 'GeneralUser-LICENSE.txt', url: generalBase + 'documentation/LICENSE.txt', sha256: '7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be' },
  tim: {
    name: 'TimGM6mb.sf2',
    url: 'https://archive.org/download/500-soundfonts-full-gm-sets/500_Soundfonts_Full_GM_Sets.zip',
    archivePage: 'https://archive.org/details/500-soundfonts-full-gm-sets',
    entry: 'TimGM6mb.sf2', offset: 36161897273, compressedBytes: 5560533, bytes: 5962044,
    sha256: '515ebbfac8cba71b56b882679cc469c31d809f2df04be771d569367be0c2ac94',
  },
  timReference: {
    name: 'TimGM6mb-upstream.sf2',
    url: 'https://raw.githubusercontent.com/musescore/musescore-old/90c33ef9d87b3f5ff92efd3b07d89eb455fb1fef/mscore/share/sound/TimGM6mb.sf2',
    sha256: 'c5378b62028c920cb11e4803327983fee2f2cdff5dc89c708e39da417e51c854',
  },
  timLicense: { name: 'TimGM6mb-LICENSE.txt', url: 'https://metadata.ftp-master.debian.org/changelogs/main/t/timgm6mb-soundfont/unstable_copyright' },
  gpl: { name: 'GPL-2.0.txt', url: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt', sha256: 'edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6' },
};
const extraPrograms = [5, 16, 30, 36, 55, 62, 88, 90];
const bankBudget = Number(process.env.PROJECT128_BANK_BUDGET || 14_000_000);

await mkdir(cache, { recursive: true });
await mkdir(publicDir, { recursive: true });
await mkdir(noticesDir, { recursive: true });
SpessaLog.setLogLevel(false, false, false);
await BasicSoundBank.ready;

async function download(source) {
  const path = join(cache, source.name);
  let data = await readFile(path).catch(() => null);
  if (!data || (source.sha256 && hash(data) !== source.sha256)) {
    console.log(`Downloading ${source.name}${source.entry ? ' (selected ZIP entry only)' : ''}`);
    const headers = source.entry ? { Range: `bytes=${source.offset}-${source.offset + source.compressedBytes + 4096}` } : {};
    const response = await fetch(source.url, { headers });
    if (!response.ok || (source.entry && response.status !== 206)) {
      await response.body?.cancel();
      throw new Error(`Download failed or range ignored: ${source.name}, HTTP ${response.status}`);
    }
    data = Buffer.from(await response.arrayBuffer());
    if (source.entry) {
      if (data.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local header mismatch');
      const nameLength = data.readUInt16LE(26), extraLength = data.readUInt16LE(28);
      if (data.subarray(30, 30 + nameLength).toString() !== source.entry) throw new Error('ZIP entry mismatch');
      if (data.readUInt16LE(8) !== 8) throw new Error('Expected DEFLATE ZIP entry');
      const start = 30 + nameLength + extraLength;
      data = inflateRawSync(data.subarray(start, start + source.compressedBytes));
      if (data.length !== source.bytes) throw new Error('Extracted source length mismatch');
    }
    if (source.sha256 && hash(data) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.name}`);
    await writeFile(path, data);
  }
  return data;
}

const [generalData, generalLicense, timData, referenceData, timLicense, gpl] = await Promise.all(
  Object.values(sources).map(download),
);
sources.timLicense.sha256 = hash(timLicense);
let general = SoundBankLoader.fromArrayBuffer(arrayBuffer(generalData));
const tim = SoundBankLoader.fromArrayBuffer(arrayBuffer(timData));
const reference = SoundBankLoader.fromArrayBuffer(arrayBuffer(referenceData));
const pcmHash = sample => {
  const audio = sample.getAudioData();
  return hash(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
};
const upstreamPCM = new Set(reference.samples.map(pcmHash));
if (!tim.samples.every(sample => upstreamPCM.has(pcmHash(sample)))) {
  throw new Error('Archive sample PCM does not match documented upstream TimGM6mb');
}
const originalPresetCount = general.presets.length;
const extras = extraPrograms.map(program => {
  const preset = tim.presets.find(p => !p.isDrum && p.bankMSB === 0 && p.bankLSB === 0 && p.program === program);
  if (!preset) throw new Error(`Missing TimGM6mb program ${program}`);
  if (general.presets.some(p => p.bankMSB === 64 && p.program === program && !p.isDrum)) throw new Error('Extra address collision');
  preset.bankMSB = 64;
  preset.name = `Tim ${preset.name}`.slice(0, 20);
  return preset;
});
general.addCompletePresets(extras);
const loopRepairs = [];
for (const sample of general.samples) {
  const length = sample.getAudioData().length;
  if (sample.loopEnd > length) {
    loopRepairs.push({ sample: sample.name, oldEnd: sample.loopEnd, newEnd: length, reason: 'Source loop end exceeded available PCM data' });
    sample.loopEnd = length;
  }
}
const extraInventory = extras.map(p => ({ name: p.name, msb: p.bankMSB, lsb: p.bankLSB, program: p.program, source: 'TimGM6mb.sf2' }));
general.soundBankInfo.name = 'Project128 GS';
general.soundBankInfo.creationDate = new Date('2026-10-28T00:00:00Z');
general.soundBankInfo.engineer = 'S. Christian Collins; Tim Brechbill; Project128 assembly';
general.soundBankInfo.copyright += '; TimGM6mb excerpts GPL-2.0-only, (c) 2004 Tim Brechbill, 2010 David Bolton';
general.soundBankInfo.comment += '\n\nProject128 GS combined derivative, GPL-2.0-only, 2026-10-28: added eight genuine TimGM6mb alternate presets at MSB 64 and encoded samples as lossy Ogg Vorbis SF3. GeneralUser GS 2.0.3 BETA source and original license notice retained. Not a Roland SC-88Pro bank. See included licenses/banks notices, GPL-2.0 text, source URLs and assembly script.';
// copyFrom deduplicates samples by name; different banks can share sample names.
// SF2 serialization retains their distinct PCM and establishes canonical ordering.
const editableBinary = general.writeSF2({ writeDefaultModulators: true, writeExtendedLimits: true });
general = SoundBankLoader.fromArrayBuffer(editableBinary);
const sourceOutput = process.argv.find(arg => arg.startsWith('--source-output='))?.slice('--source-output='.length);
if (sourceOutput) await writeFile(resolve(sourceOutput), Buffer.from(editableBinary));
// The SF2 writer sorts preset records; MIDI addresses and contents must survive.
const inventory = bank => bank.presets.map(p => JSON.stringify([p.name, p.bankMSB, p.bankLSB, p.program, p.isGMGSDrum])).sort();
const expectedInventory = inventory(general);

function measure(candidate) {
  const errors = [], attacks = [], seamChanges = [];
  for (let i = 0; i < general.samples.length; i++) {
    const source = general.samples[i], target = candidate.samples[i];
    const a = source.getAudioData(), b = target.getAudioData();
    if (source.loopStart !== target.loopStart || source.loopEnd !== target.loopEnd || source.sampleRate !== target.sampleRate) throw new Error(`Sample metadata changed: ${source.name}`);
    let error = 0, power = 0, attackError = 0, attackPower = 0;
    const attackEnd = Math.min(a.length, Math.ceil(source.sampleRate * 0.05));
    for (let n = 0; n < a.length; n++) {
      if (!Number.isFinite(b[n])) throw new Error(`Invalid decoded sample: ${source.name}`);
      const d = a[n] - b[n]; error += d * d; power += a[n] * a[n];
      if (n < attackEnd) { attackError += d * d; attackPower += a[n] * a[n]; }
    }
    if (power > 1e-10) errors.push(Math.sqrt(error / power));
    if (attackPower > 1e-10) attacks.push(Math.sqrt(attackError / attackPower));
    const start = source.loopStart, end = source.loopEnd - 1;
    if (end > start && end < a.length) seamChanges.push(Math.abs((b[start] - b[end]) - (a[start] - a[end])));
  }
  const quantile = (values, q) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] || 0;
  return { medianNormalizedRMSError: quantile(errors, 0.5), p95NormalizedRMSError: quantile(errors, 0.95), medianAttackNormalizedRMSError: quantile(attacks, 0.5), p95AttackNormalizedRMSError: quantile(attacks, 0.95), p95LoopSeamDelta: quantile(seamChanges, 0.95), maxLoopSeamDelta: Math.max(...seamChanges) };
}

const trials = [];
let chosen;
for (const quality of [0.65, 0.8]) {
  console.log(`Encoding ${general.samples.length} samples at Vorbis q${quality * 10}`);
  const candidatePath = join(cache, `Project128-GS-${hash(Buffer.from(editableBinary))}-${quality}.sf3`);
  const binary = await readFile(candidatePath).catch(async () => {
    const output = Buffer.from(await convertToSF3(editableBinary.slice(0), quality));
    await writeFile(candidatePath, output);
    return output;
  });
  const decoded = SoundBankLoader.fromArrayBuffer(arrayBuffer(binary));
  if (JSON.stringify(inventory(decoded)) !== JSON.stringify(expectedInventory)) throw new Error('Preset inventory changed during conversion');
  const trial = { quality, vorbisQuality: quality * 10, bytes: binary.length, sha256: hash(binary), ...measure(decoded) };
  trials.push(trial);
  console.log(JSON.stringify(trial));
  if (binary.length < bankBudget) chosen = { binary, trial };
}
if (!chosen) throw new Error(`No candidate fits the ${bankBudget}-byte bank budget`);
await writeFile(join(publicDir, 'starter.sf3'), chosen.binary);
const metadata = {
  id: 'project128-gs', name: 'Project128 GS', format: 'SF3', source: 'GeneralUser GS 2.0.3 BETA + 8 TimGM6mb alternates',
  license: 'Combined derivative GPL-2.0-only; original GeneralUser license v2.0 notice retained',
  bytes: chosen.binary.length, sha256: hash(chosen.binary), presetCount: general.presets.length,
  melodicPresetCount: general.presets.filter(p => !p.isDrum).length, distinctDrumKits: 13,
  description: 'Complete General MIDI coverage, GS variations and 13 drum kits, plus eight TimGM6mb alternate timbres at MSB 64. GeneralUser GS based; not a Roland SC-88Pro bank. High-quality Vorbis SF3; encoding is lossy.',
  quality: chosen.trial.quality, extraPresets: extraInventory,
  documentation: 'licenses/banks/README.txt',
};
await writeFile(join(publicDir, 'starter.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(join(noticesDir, 'GeneralUser-LICENSE.txt'), generalLicense);
await writeFile(join(noticesDir, 'TimGM6mb-LICENSE.txt'), timLicense);
await writeFile(join(noticesDir, 'GPL-2.0.txt'), gpl);
await writeFile(join(noticesDir, 'PROVENANCE.json'), JSON.stringify({
  bank: metadata, sources, originalPresetCount, extraPresets: extraInventory, loopRepairs,
  timVerification: { archiveSampleCount: tim.samples.length, upstreamSampleCount: reference.samples.length, matchingPCMCount: tim.samples.filter(s => upstreamPCM.has(pcmHash(s))).length, note: 'Archive and documented upstream containers/program tables differ. Every archive sample has byte-identical decoded PCM in upstream.' },
  tools: { spessasynth_core: '4.4.2', wasmMediaEncoders: '0.7.0', encoder: 'Ogg Vorbis, mono per SF3 sample, original sample rates retained; samples outside 8..96kHz preserved as PCM' },
  trials, selectedQuality: chosen.trial.quality,
  selection: `Highest tested quality fitting the ${bankBudget}-byte bank budget. Technical decode/attack/loop comparisons only; no human listening judgment is claimed.`,
}, null, 2) + '\n');
await writeFile(join(noticesDir, 'README.txt'), `Project128 GS soundbank notices and reproducible source\nCombined derivative license: GPL-2.0-only. Original GeneralUser notice retained.\n\nThis is a modified GeneralUser GS 2.0.3 BETA bank by S. Christian Collins, with eight actual alternate presets from TimGM6mb by Tim Brechbill. It is not an authentic Roland SC-88Pro soundbank or engine. All original GeneralUser presets are retained, including the 13 GS drum kits and their XG address variants. Eight TimGM6mb presets occupy MSB 64, LSB 0, at their original zero-based GM program numbers. They are separate sampled/programmed instruments, not renamed GeneralUser aliases.\n\nGeneralUser portions retain the included GeneralUser license v2.0 and its sample-origin statement. TimGM6mb excerpts are GPL version 2, with copyright and documented source/license in TimGM6mb-LICENSE.txt; the complete GPL version 2 is included. The bank modifications, assembly instructions and source URLs are provided here. GeneralUser source allows modification and repackaging; the Tim portions retain GPL-2.0-only terms.\n\nThe 500 Soundfonts collection is an aggregation, not a blanket license. Only its TimGM6mb.sf2 entry was retrieved using HTTP Range; no other collection bank was included. Every sample's decoded PCM matches the documented upstream MuseScore TimGM6mb, despite container/program-table differences. See PROVENANCE.json for exact pinned GeneralUser source, Tim source archive entry/range, upstream reference, SHA-256 checksums, selected presets and measured conversion trials.\n\nReproduce with Node.js 24 and installed project dependencies:\n  npm ci\n  node tools/prepare-bank.mjs\nThe tool downloads original uncompressed sources to the system temporary directory, outside the deliverable. PROJECT128_BANK_CACHE may override that location. Those source files are the preferred form for editing, available without charge at the exact URLs in PROVENANCE.json. Generate the complete combined editable bank with: node tools/prepare-bank.mjs --source-output=/path/to/Project128-GS-source.sf2 . All modifications are specified by that script. Include this editable source alongside a redistribution, or use the source-delivery provisions of GPL version 2. No source sample rate reduction or MIDI-dependent trimming is applied. Samples outside Vorbis supported rates remain exact PCM inside the SF3. One source Orchestra Hit loop end exceeded its sample data by one frame and is clamped to the available data, as recorded in PROVENANCE.json.\n\nSF3 uses lossy Ogg Vorbis. The release ZIP preserves the resulting SF3 bytes losslessly, but does not restore the source samples. Quality candidates are measured for decoded finite PCM, retained sample rates and loop points, inventory identity, normalized waveform error during full samples and attacks, and loop-seam error change. These measurements are not listening tests or proof of hardware equivalence. Selected quality: Vorbis q${chosen.trial.quality * 10}.\n\nGeneralUser author: https://www.schristiancollins.com/generaluser\nTimGM6mb documented license: ${sources.timLicense.url}\nArchive: ${sources.tim.archivePage}\n`);
console.log(`Wrote ${metadata.name}: ${metadata.bytes} bytes, ${metadata.presetCount} preset records, ${metadata.melodicPresetCount} melodic presets, 13 distinct drum kits.`);
