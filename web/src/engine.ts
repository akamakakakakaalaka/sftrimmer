/// <reference types="vite/client" />
import workletURL from './worklet.ts?worker&url';
import type { AppState, BankInfo, PartState, PlayerPosition } from './contracts.ts';
import { createState, restoreState } from './state.ts';

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Browser control surface. Sound generation and sequencing stay in the worklet. */
export class PlayerEngine {
  onPosition?: (position: PlayerPosition) => void;
  onActivity?: (levels: number[], notes?:number[][]) => void;
  onError?: (error: Error) => void;
  private state: AppState = createState();
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private initPromise?: Promise<void>;
  private isReady = false;
  private nextID = 1;
  private readonly pending = new Map<number, PendingCall>();
  private latestPosition: PlayerPosition = { current: 0, duration: 0, playing: false };

  /** Call on a user gesture. Resume is invoked before asynchronous module loading. */
  async init(): Promise<void> {
    if (!this.context) this.context = new AudioContext({ latencyHint: 'interactive' });
    const resumed = this.context.state === 'running' ? Promise.resolve() : this.context.resume();
    if (!this.initPromise) {
      this.initPromise = this.startWorklet().catch(error => {
        this.initPromise = undefined;
        this.isReady = false;
        this.node?.disconnect();
        this.node = undefined;
        throw error;
      });
    }
    await Promise.all([resumed, this.initPromise]);
  }

  private async startWorklet(): Promise<void> {
    const context = this.context!;
    if (!context.audioWorklet) throw new Error('This browser does not support AudioWorklet audio.');
    await context.audioWorklet.addModule(workletURL);
    const node = new AudioWorkletNode(context, 'project128-synth', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { state: this.state },
    });
    this.node = node;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Audio engine initialization timed out.')), 30_000);
      const failed = (error: Error) => {
        clearTimeout(timer);
        reject(error);
        this.failPending(error);
        this.onError?.(error);
      };
      node.onprocessorerror = () => failed(new Error('The audio processor stopped. Reload the app to restart audio.'));
      node.port.onmessage = (event: MessageEvent) => {
        const message = event.data;
        if (message?.type === 'ready') {
          clearTimeout(timer);
          this.isReady = true;
          // Include changes made while the module and Vorbis decoder initialized.
          node.port.postMessage({ op: 'applyState', args: [this.state] });
          resolve();
        } else if (message?.type === 'position') {
          this.latestPosition = message.position;
          this.onPosition?.(this.position());
          if(Array.isArray(message.levels))this.onActivity?.(message.levels,Array.isArray(message.notes)?message.notes:undefined);
        } else if (message?.type === 'response') {
          const call = this.pending.get(message.id);
          if (!call) return;
          this.pending.delete(message.id);
          clearTimeout(call.timer);
          if (message.error) call.reject(new Error(String(message.error)));
          else call.resolve(message.result);
        } else if (message?.type === 'error') {
          const error = new Error(String(message.error ?? 'Audio processor error.'));
          if (!this.isReady) failed(error);
          else this.onError?.(error);
        }
      };
      node.connect(context.destination);
    });
  }

  private failPending(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private report(error: unknown): void {
    const problem = error instanceof Error ? error : new Error(String(error));
    if (this.onError) this.onError(problem);
    else console.error('Project 128 audio:', problem);
  }

  private command(op: string, ...args: unknown[]): void {
    void this.init().then(() => this.node!.port.postMessage({ op, args })).catch(error => this.report(error));
  }

  private async request<T>(op: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
    await this.init();
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out.`));
      }, 120_000);
      this.pending.set(id, { resolve: result => resolve(result as T), reject, timer });
      try { this.node!.port.postMessage({ id, op, args }, transfer); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async loadBank(data: ArrayBuffer, name: string, id?: string): Promise<BankInfo> {
    const owned = data.slice(0);
    // Start audio within the gesture before awaiting the asynchronous digest.
    await this.init();
    const identity = id ?? `sha256-${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', owned)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    return this.request<BankInfo>('loadBank', [owned, name, identity], [owned]);
  }

  removeBank(id: string): void { this.command('removeBank', id); }

  applyState(state: AppState): void {
    this.state = restoreState(state);
    if (this.isReady) this.node!.port.postMessage({ op: 'applyState', args: [this.state] });
  }

  applyPart(part: PartState, changedFields?: string[]): void {
    if (!Number.isInteger(part.id) || part.id < 0 || part.id > 127) throw new RangeError('Part must be between 0 and 127.');
    this.state.parts[part.id] = restoreState({ ...this.state, parts: [part] }).parts[part.id];
    if (this.isReady) this.node!.port.postMessage({ op: 'applyPart', args: [this.state.parts[part.id], changedFields] });
  }

  noteOn(partId: number, note: number, velocity = 100): void { this.command('noteOn', partId, note, velocity); }
  noteOff(partId: number, note: number): void { this.command('noteOff', partId, note); }
  panic(): void { this.command('panic'); }
  sendMIDI(bytes: number[] | Uint8Array, port = 0): void { this.command('sendMIDI', Array.from(bytes), port); }

  async loadMidi(data: ArrayBuffer, name = 'MIDI file'): Promise<{ duration: number; format: number; sequenceCount: number }> {
    const owned = data.slice(0);
    return this.request('loadMidi', [owned, name], [owned]);
  }

  play(): Promise<void> { return this.request('play', []); }
  pause(): Promise<void> { return this.request('pause', []); }
  stop(): Promise<void> { return this.request('stop', []); }
  seek(seconds: number): Promise<void> { return this.request('seek', [seconds]); }
  setTempo(multiplier: number): void {
    this.state.master.tempo = Math.min(4, Math.max(0.25, Number.isFinite(multiplier) ? multiplier : 1));
    if (this.isReady) this.node!.port.postMessage({ op: 'setTempo', args: [this.state.master.tempo] });
  }
  selectSequence(index: number): Promise<void> { return this.request('selectSequence', [index]); }
  position(): PlayerPosition { return { ...this.latestPosition }; }

  async convertToSF3(data: ArrayBuffer, quality: number, onProgress?: (fraction: number) => void): Promise<ArrayBuffer> {
    const { convertToSF3 } = await import('./compression.ts');
    return convertToSF3(data, quality, onProgress);
  }
}
