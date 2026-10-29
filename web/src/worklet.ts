import { OfflineEngine } from './offline.ts';
import { createState } from './state.ts';
import type { AppState } from './contracts.ts';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(name: string, constructor: typeof Project128Processor): void;

interface EngineRequest { id?: number; op: string; args?: unknown[] }

class Project128Processor extends AudioWorkletProcessor {
  private readonly engine!: OfflineEngine;
  private initialized = false;
  private framesUntilPosition = 0;
  private commands: Promise<void> = Promise.resolve();

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const state = options?.processorOptions?.state as AppState | undefined;
    try {
      this.engine = new OfflineEngine(sampleRate, state ?? createState());
      this.engine.onWarning = message => this.port.postMessage({ type: 'error', error: message });
    } catch (error) {
      this.port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.port.onmessage = (event: MessageEvent<EngineRequest>) => {
      const request = event.data;
      this.commands = this.commands.then(() => this.receive(request));
    };
    void this.engine.ready.then(() => {
      this.initialized = true;
      this.port.postMessage({ type: 'ready' });
      this.publishPosition();
    }).catch(error => this.port.postMessage({ type: 'error', error: String(error) }));
  }

  private publishPosition(): void {
    this.port.postMessage({ type: 'position', position: this.engine.position(), levels: this.engine.getPartLevels(), notes:this.engine.getHeldNotes() });
  }

  private async receive(request: EngineRequest): Promise<void> {
    try {
      await this.engine.ready;
      const args = request.args ?? [];
      let result: unknown;
      switch (request.op) {
        case 'loadBank': result = await this.engine.loadBank(args[0] as ArrayBuffer, args[1] as string, args[2] as string | undefined); break;
        case 'removeBank': this.engine.removeBank(args[0] as string); break;
        case 'applyState': this.engine.applyState(args[0] as AppState); break;
        case 'applyPart': this.engine.applyPart(args[0] as Parameters<OfflineEngine['applyPart']>[0], args[1] as string[] | undefined); break;
        case 'noteOn': this.engine.noteOn(args[0] as number, args[1] as number, args[2] as number); break;
        case 'noteOff': this.engine.noteOff(args[0] as number, args[1] as number); break;
        case 'sendMIDI': this.engine.sendMIDI(args[0] as number[], args[1] as number); break;
        case 'panic': this.engine.panic(); break;
        case 'loadMidi': result = this.engine.loadMidi(args[0] as ArrayBuffer, args[1] as string); break;
        case 'play': this.engine.play(); break;
        case 'pause': this.engine.pause(); break;
        case 'stop': this.engine.stop(); break;
        case 'seek': this.engine.seek(args[0] as number); break;
        case 'setTempo': this.engine.setTempo(args[0] as number); break;
        case 'selectSequence': result = this.engine.selectSequence(args[0] as number); break;
        default: throw new Error(`Unknown audio operation: ${request.op}`);
      }
      this.publishPosition();
      if (request.id !== undefined) this.port.postMessage({ type: 'response', id: request.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.port.postMessage(request.id !== undefined ? { type: 'response', id: request.id, error: message } : { type: 'error', error: message });
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const left = outputs[0]?.[0];
    const right = outputs[0]?.[1];
    if (!left || !right) return true;
    left.fill(0);
    right.fill(0);
    if (!this.initialized) return true;
    this.engine.processBlock(left, right);
    this.framesUntilPosition -= left.length;
    if (this.framesUntilPosition <= 0) {
      this.publishPosition();
      this.framesUntilPosition = sampleRate / 10;
    }
    return true;
  }
}

registerProcessor('project128-synth', Project128Processor);
