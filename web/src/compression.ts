import { BasicSoundBank, SoundBankLoader } from 'spessasynth_core';
import { createOggEncoder } from 'wasm-media-encoders';

/** Convert a complete bank to lossy Vorbis SF3. Quality is normalized to 0..1.
 * Existing compressed samples are preserved to avoid another lossy generation.
 * Rates outside Vorbis' 8..96 kHz range stay as PCM, preserving pitch and loops.
 * The caller retains ownership of the unchanged input buffer.
 */
export async function convertToSF3(
  data: ArrayBuffer,
  quality: number,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError('SF3 quality must be between 0 and 1.');
  }
  onProgress?.(0);
  await BasicSoundBank.ready;
  const bank = SoundBankLoader.fromArrayBuffer(data.slice(0));
  // One encoder per conversion prevents concurrent requests sharing WASM state.
  const encoder = await createOggEncoder();
  let serial = 1;
  const allSamples = bank.samples;
  // Upstream otherwise resamples low-rate samples to 48 kHz with nearest-neighbor.
  // SF3 supports mixed PCM/Vorbis, so preserve those short samples exactly.
  bank.samples = allSamples.filter(sample => sample.sampleRate >= 8_000 && sample.sampleRate <= 96_000);
  try {
    await bank.setSampleFormat({
      format: 'compressed',
      compressionFunction: async (audio: Float32Array, sampleRate: number) => {
        encoder.configure({ channels: 1, sampleRate, vbrQuality: quality * 10, oggSerialNo: serial++ });
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (let offset = 0; offset < audio.length; offset += 65_536) {
          const chunk = encoder.encode([audio.subarray(offset, offset + 65_536)]).slice();
          chunks.push(chunk);
          length += chunk.length;
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        const final = encoder.finalize().slice();
        chunks.push(final);
        length += final.length;
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        return result;
      },
      progressFunction: fraction => onProgress?.(fraction * 0.95),
    });
  } finally {
    bank.samples = allSamples;
  }
  const result = bank.writeSF2({ writeDefaultModulators: true, writeExtendedLimits: true });
  onProgress?.(1);
  return result;
}
