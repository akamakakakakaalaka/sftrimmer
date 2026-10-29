import type { MasterState } from './contracts.ts';

const bounded = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
const audio = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;

/**
 * Original app DSP. These effects are separate from the synthesizer's XG graph.
 * The delay accepts part-send buses; the flanger and crusher process the mix.
 */
export class AppEffects {
  private readonly sampleRate: number;
  private readonly delayLeft: Float32Array;
  private readonly delayRight: Float32Array;
  private readonly flangeLeft: Float32Array;
  private readonly flangeRight: Float32Array;
  private readonly smoothing: number;
  private delayWrite = 0;
  private flangeWrite = 0;
  private phase = 0;
  private targetTime = 0.25;
  private targetFeedback = 0.3;
  private targetDelayMix = 0;
  private targetFlangerMix = 0;
  private targetBalance = 0;
  private delayTime = 0.25;
  private feedback = 0.3;
  private delayMix = 0;
  private flangerMix = 0;
  private balance = 0;
  private bits = 16;
  private configured = false;

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 384_000) {
      throw new Error('The effects sample rate must be between 0 and 384000 Hz.');
    }
    this.sampleRate = sampleRate;
    this.delayLeft = new Float32Array(Math.ceil(sampleRate * 2) + 2);
    this.delayRight = new Float32Array(this.delayLeft.length);
    this.flangeLeft = new Float32Array(Math.ceil(sampleRate * 0.012) + 2);
    this.flangeRight = new Float32Array(this.flangeLeft.length);
    this.smoothing = 1 - Math.exp(-1 / (sampleRate * 0.01));
  }

  configure(master: MasterState): void {
    this.targetTime = bounded(master.delayTime, 0.01, 2, 0.25);
    this.targetFeedback = bounded(master.delayFeedback, 0, 0.9, 0.3);
    this.targetDelayMix = bounded(master.delayMix, 0, 1, 0);
    this.targetFlangerMix = bounded(master.flangerMix, 0, 1, 0);
    this.targetBalance = bounded(master.balance ?? 0, -1, 1, 0);
    this.bits = Math.round(bounded(master.crusherBits, 1, 16, 16));
    if (!this.configured) {
      this.delayTime = this.targetTime;
      this.feedback = this.targetFeedback;
      this.delayMix = this.targetDelayMix;
      this.flangerMix = this.targetFlangerMix;
      this.balance = this.targetBalance;
      this.configured = true;
    }
  }

  private read(buffer: Float32Array, write: number, samplesBack: number): number {
    let position = write - samplesBack;
    if (position < 0) position += buffer.length;
    const before = Math.floor(position);
    const after = before + 1 === buffer.length ? 0 : before + 1;
    const fraction = position - before;
    return buffer[before] + (buffer[after] - buffer[before]) * fraction;
  }

  /** Process in place without allocating on the audio thread. */
  process(left: Float32Array, right: Float32Array, sendLeft?: Float32Array, sendRight?: Float32Array): void {
    if (left.length !== right.length || sendLeft && sendLeft.length !== left.length || sendRight && sendRight.length !== left.length) {
      throw new Error('Effect buffers must have equal lengths.');
    }
    const hasSends = sendLeft !== undefined || sendRight !== undefined;
    const step = this.bits === 16 ? 0 : Math.pow(2, 1 - this.bits);
    const phaseStep = 2 * Math.PI * 0.2 / this.sampleRate;
    for (let i = 0; i < left.length; i++) {
      this.delayTime += (this.targetTime - this.delayTime) * this.smoothing;
      this.feedback += (this.targetFeedback - this.feedback) * this.smoothing;
      this.delayMix += (this.targetDelayMix - this.delayMix) * this.smoothing;
      this.flangerMix += (this.targetFlangerMix - this.flangerMix) * this.smoothing;
      this.balance += (this.targetBalance - this.balance) * this.smoothing;
      const dryL = audio(left[i]);
      const dryR = audio(right[i]);
      const delayedL = this.read(this.delayLeft, this.delayWrite, this.delayTime * this.sampleRate);
      const delayedR = this.read(this.delayRight, this.delayWrite, this.delayTime * this.sampleRate);
      const inputL = hasSends ? audio(sendLeft?.[i] ?? 0) : dryL;
      const inputR = hasSends ? audio(sendRight?.[i] ?? 0) : dryR;
      this.delayLeft[this.delayWrite] = audio(inputL + delayedL * this.feedback);
      this.delayRight[this.delayWrite] = audio(inputR + delayedR * this.feedback);
      if (++this.delayWrite === this.delayLeft.length) this.delayWrite = 0;

      const flangeDelayL = Math.max(1, (0.003 + 0.002 * Math.sin(this.phase)) * this.sampleRate);
      const flangeDelayR = Math.max(1, (0.003 + 0.002 * Math.sin(this.phase + Math.PI / 2)) * this.sampleRate);
      const flangedL = this.read(this.flangeLeft, this.flangeWrite, flangeDelayL);
      const flangedR = this.read(this.flangeRight, this.flangeWrite, flangeDelayR);
      this.flangeLeft[this.flangeWrite] = audio(dryL + flangedL * 0.35);
      this.flangeRight[this.flangeWrite] = audio(dryR + flangedR * 0.35);
      if (++this.flangeWrite === this.flangeLeft.length) this.flangeWrite = 0;
      this.phase += phaseStep;
      if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;

      let outL = dryL + delayedL * this.delayMix + flangedL * this.flangerMix;
      let outR = dryR + delayedR * this.delayMix + flangedR * this.flangerMix;
      if (step) {
        outL = Math.round(outL / step) * step;
        outR = Math.round(outR / step) * step;
      }
      left[i] = audio(outL * (this.balance > 0 ? 1-this.balance : 1));
      right[i] = audio(outR * (this.balance < 0 ? 1+this.balance : 1));
    }
  }

  reset(): void {
    this.delayLeft.fill(0);
    this.delayRight.fill(0);
    this.flangeLeft.fill(0);
    this.flangeRight.fill(0);
    this.delayWrite = 0;
    this.flangeWrite = 0;
    this.phase = 0;
    this.delayTime = this.targetTime;
    this.feedback = this.targetFeedback;
    this.delayMix = this.targetDelayMix;
    this.flangerMix = this.targetFlangerMix;
    this.balance = this.targetBalance;
  }
}
