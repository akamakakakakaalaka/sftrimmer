import './player-parts.css';
import type { AppState, BankInfo, PartState, PerformanceControls } from './contracts';
import { getPerformanceControls } from './performance';

export interface PlayerPartsCallbacks {
  select(id: number): void;
  edit(id: number, patch: Partial<PartState>, fields?: string[]): void;
  choosePatch(id: number): void;
}

type MeterKey = 'volume' | 'expression' | 'pan' | 'pitchBend' | 'modulation';
type PedalKey = 'portamento' | 'soft' | 'sostenuto' | 'hold';
interface MeterView {
  label: HTMLLabelElement;
  input: HTMLInputElement;
  name: string;
  neutral?: number;
}
interface PartView {
  id: number;
  article: HTMLElement;
  select: HTMLButtonElement;
  mute: HTMLButtonElement;
  patch: HTMLButtonElement;
  peak: HTMLElement;
  keyboard: SVGSVGElement;
  keys: SVGRectElement[];
  meters: Map<MeterKey, MeterView>;
  pedals: Map<PedalKey, HTMLInputElement>;
  fingerprint: string;
  level: number;
  notes: Set<number>;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (note: number) => `${noteNames[note % 12]}${Math.floor(note / 12) - 1}`;
const patchKey = (patch: Pick<PartState, 'msb' | 'lsb' | 'program' | 'drums'>) => `${patch.msb}:${patch.lsb}:${patch.program}:${Number(patch.drums)}`;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};
const svgElement = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] => document.createElementNS('http://www.w3.org/2000/svg', tag);

/** Sixteen native SMF part strips for one of the eight MIDI ports. */
export class PlayerParts {
  private readonly views: PartView[] = [];
  private state?: AppState;
  private port = 0;
  private levels: number[] = [];
  private notes: number[][] = [];
  private bankSnapshot: { bank: BankInfo; id: string; name: string; presets: BankInfo['presets']; count: number }[] = [];
  private banks = new Map<string, BankInfo>();
  private patches = new Map<string, Map<string, string>>();

  constructor(private readonly container: HTMLElement, private readonly callbacks: PlayerPartsCallbacks) {
    container.classList.add('player-parts');
    container.setAttribute('aria-label', 'MIDI file player parts, port 1');
    const fragment = document.createDocumentFragment();
    for (let slot = 0; slot < 16; slot++) {
      const view = this.createPart(slot);
      this.views.push(view);
      fragment.append(view.article);
    }
    container.append(fragment);
  }

  update(state: AppState, banks: BankInfo[], port = 0): void {
    this.state = state;
    this.port = Number.isFinite(port) ? clamp(Math.trunc(port), 0, 7) : 0;
    this.container.dataset.smfPort = String(this.port);
    this.container.setAttribute('aria-label', `MIDI file player parts, port ${this.port + 1}`);
    const banksChanged = banks.length !== this.bankSnapshot.length || banks.some((bank, index) => {
      const previous = this.bankSnapshot[index];
      return !previous || previous.bank !== bank || previous.id !== bank.id || previous.name !== bank.name || previous.presets !== bank.presets || previous.count !== bank.presets.length;
    });
    if (banksChanged) {
      this.banks = new Map(banks.map(bank => [bank.id, bank]));
      this.patches = new Map(banks.map(bank => [bank.id, new Map(bank.presets.map(patch => [patchKey(patch), patch.name]))]));
      this.bankSnapshot = banks.map(bank => ({ bank, id: bank.id, name: bank.name, presets: bank.presets, count: bank.presets.length }));
    }
    for (let slot = 0; slot < this.views.length; slot++) {
      const view = this.views[slot];
      const id = this.port * 16 + slot;
      const part = state.parts[id]?.id === id ? state.parts[id] : state.parts.find(item => item.id === id);
      if (!part) continue;
      const controls = getPerformanceControls(part);
      const bank = part.bankId ? this.banks.get(part.bankId) : undefined;
      const patchName = (part.bankId ? this.patches.get(part.bankId)?.get(patchKey(part)) : undefined)
        || (part.bankId ? bank ? `Program ${part.program + 1}` : 'Missing soundbank' : 'Choose a patch');
      const fingerprint = JSON.stringify([id, state.selectedPart === id, part.bankId, bank?.name, patchName, part.msb, part.lsb, part.program, part.drums, part.mute, part.solo, part.volume, controls.expression, part.pan, controls.pitchBend, controls.modulation, controls.portamento, controls.soft, controls.sostenuto, controls.hold]);
      if (fingerprint === view.fingerprint) continue;
      const identityChanged = view.id !== id;
      view.id = id;
      view.fingerprint = fingerprint;
      const identity = `Part ${id + 1}, port ${this.port + 1}, channel ${slot + 1}`;
      view.article.dataset.smfPart = String(id);
      view.article.setAttribute('aria-label', identity);
      view.article.classList.toggle('is-selected', state.selectedPart === id);
      view.article.classList.toggle('is-muted', part.mute);
      view.article.classList.toggle('is-solo', part.solo);
      view.select.textContent = String(slot + 1);
      view.select.dataset.smfSelect = String(id);
      view.select.setAttribute('aria-label', `Select ${identity}`);
      view.select.setAttribute('aria-pressed', String(state.selectedPart === id));
      view.select.title = identity;
      view.patch.dataset.smfPatch = String(id);
      view.patch.textContent = patchName;
      view.patch.setAttribute('aria-label', `Choose patch for Part ${id + 1}: ${patchName}`);
      view.patch.title = `${patchName}${bank ? ` · ${bank.name}` : ''} · MSB ${part.msb}, LSB ${part.lsb}, program ${part.program}`;
      view.mute.dataset.smfMute = String(id);
      view.mute.textContent = part.solo ? 'S' : 'M';
      view.mute.setAttribute('aria-label', `Mute Part ${id + 1}${part.mute ? ', muted' : ''}${part.solo ? ', solo active' : ''}; hold or Shift-click for Solo`);
      view.mute.setAttribute('aria-pressed', String(part.mute || part.solo));
      view.mute.title = 'Tap to mute; hold or Shift-click for Solo';
      view.peak.title = `Part ${id + 1} dry audio peak`;
      for (const [key, meter] of view.meters) {
        meter.input.id = `smf-${id}-${key}`;
        meter.label.htmlFor = meter.input.id;
        meter.input.dataset.smfControl = key;
        meter.input.setAttribute('aria-label', `Part ${id + 1} ${meter.name}`);
        this.updateMeter(meter, key === 'volume' || key === 'pan' ? part[key] : controls[key]);
      }
      for (const [key, input] of view.pedals) {
        input.id = `smf-${id}-${key}`;
        input.checked = controls[key];
        input.dataset.smfPedal = key;
        input.setAttribute('aria-label', `Part ${id + 1} ${key === 'hold' ? 'Hold pedal' : key[0].toUpperCase() + key.slice(1)}`);
      }
      if (identityChanged) {
        view.level = -1;
        view.keyboard.removeAttribute('aria-label');
        this.updateActivity(view);
      } else if (!view.notes.size) {
        view.keyboard.setAttribute('aria-label', `Part ${id + 1} sounding notes: none. MIDI range C−1 to G9.`);
      }
    }
  }

  /** Global part-indexed dry peaks and actual sounding MIDI note numbers. */
  setActivity(levels: number[], notes?: number[][]): void {
    this.levels = levels;
    this.notes = notes ?? [];
    for (const view of this.views) this.updateActivity(view);
  }

  private currentPart(view: PartView): PartState | undefined {
    const parts = this.state?.parts;
    return parts?.[view.id]?.id === view.id ? parts[view.id] : parts?.find(part => part.id === view.id);
  }

  private editMeter(view: PartView, key: MeterKey, value: number): void {
    const part = this.currentPart(view);
    if (!part) return;
    if (key === 'volume' || key === 'pan') this.callbacks.edit(view.id, { [key]: value }, [key]);
    else this.callbacks.edit(view.id, { performance: { ...getPerformanceControls(part), [key]: value } }, [`performance.${key}`]);
  }

  private createPart(slot: number): PartView {
    const article = element('article', 'smf-part');
    article.dataset.smfPart = String(slot);
    const body = element('div', 'smf-part-body');
    const peak = element('div', 'smf-part-peak');
    peak.setAttribute('aria-hidden', 'true');
    peak.append(element('span', 'smf-part-peak-fill'));
    const select = element('button', 'smf-part-number', String(slot + 1));
    select.type = 'button';
    const mute = element('button', 'smf-part-mute', 'M');
    mute.type = 'button';
    const patch = element('button', 'smf-part-patch', 'Choose a patch');
    patch.type = 'button';
    patch.setAttribute('aria-haspopup', 'dialog');
    const { keyboard, keys } = this.createKeyboard();
    const view: PartView = { id: slot, article, select, mute, patch, peak, keyboard, keys, meters: new Map(), pedals: new Map(), fingerprint: '', level: -1, notes: new Set() };
    select.addEventListener('click', () => this.callbacks.select(view.id));
    patch.addEventListener('click', () => this.callbacks.choosePatch(view.id));
    this.muteSoloGesture(view);
    body.append(peak, select, mute, patch);
    const meters: [MeterKey, string, string, number, number?][] = [
      ['volume', 'V:', 'Volume', 127], ['expression', 'E:', 'Expression', 127],
      ['pan', 'Pan:', 'Pan', 127, 64], ['pitchBend', 'PB:', 'Pitch bend', 16383, 8192],
      ['modulation', 'M:', 'Modulation', 127],
    ];
    for (const [key, caption, name, max, neutral] of meters) {
      const meter = this.createMeter(view, key, caption, name, max, neutral);
      view.meters.set(key, meter);
      body.append(meter.label);
    }
    const pedals = element('div', 'smf-part-pedals');
    for (const [key, name] of [['portamento', 'Portamento'], ['soft', 'Soft pedal'], ['sostenuto', 'Sostenuto pedal'], ['hold', 'Hold pedal']] as [PedalKey, string][]) {
      const label = element('label', `smf-part-pedal smf-part-pedal-${key}`);
      label.title = name;
      const input = element('input', 'smf-part-pedal-input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        const part = this.currentPart(view);
        if (part) this.callbacks.edit(view.id, { performance: { ...getPerformanceControls(part), [key]: input.checked } }, [`performance.${key}`]);
      });
      label.append(input);
      pedals.append(label);
      view.pedals.set(key, input);
    }
    body.append(pedals);
    article.append(body, keyboard);
    return view;
  }

  private createMeter(view: PartView, key: MeterKey, caption: string, name: string, max: number, neutral?: number): MeterView {
    const label = element('label', `smf-part-control smf-part-control-${key}`);
    const track = element('span', 'smf-part-meter');
    track.setAttribute('aria-hidden', 'true');
    track.append(element('span', 'smf-part-meter-fill'));
    const input = element('input', 'smf-part-range');
    input.type = 'range';
    input.min = '0';
    input.max = String(max);
    input.step = '1';
    const meter = { label, input, name, neutral };
    input.addEventListener('input', () => {
      const value = Math.round(clamp(input.valueAsNumber, 0, max));
      this.updateMeter(meter, value);
      this.editMeter(view, key, value);
    });
    label.append(element('span', 'smf-part-control-caption', caption), track, input);
    return meter;
  }

  private updateMeter(meter: MeterView, value: number): void {
    const max = Number(meter.input.max);
    const bounded = clamp(value, 0, max);
    const progress = bounded / max;
    const origin = meter.neutral === undefined ? 0 : meter.neutral / max;
    meter.input.value = String(bounded);
    meter.label.style.setProperty('--smf-meter-start', `${Math.min(origin, progress) * 100}%`);
    meter.label.style.setProperty('--smf-meter-size', `${Math.abs(progress - origin) * 100}%`);
    const description = meter.name === 'Pan' ? bounded === 64 ? 'Center' : bounded < 64 ? `Left ${64 - bounded}` : `Right ${bounded - 64}`
      : meter.name === 'Pitch bend' && bounded === 8192 ? '8192, centered' : String(bounded);
    meter.input.setAttribute('aria-valuetext', description);
    meter.input.title = `${meter.name}: ${description} · saved part control; drag or use arrow keys`;
  }

  private createKeyboard(): { keyboard: SVGSVGElement; keys: SVGRectElement[] } {
    const keyboard = svgElement('svg');
    keyboard.classList.add('smf-part-keyboard');
    keyboard.setAttribute('viewBox', '0 0 750 20');
    keyboard.setAttribute('preserveAspectRatio', 'none');
    keyboard.setAttribute('role', 'img');
    const whiteKeys = svgElement('g');
    const blackKeys = svgElement('g');
    const keys: SVGRectElement[] = [];
    let whiteIndex = 0;
    for (let note = 0; note < 128; note++) {
      const black = [1, 3, 6, 8, 10].includes(note % 12);
      const key = svgElement('rect');
      key.classList.add('smf-part-key', black ? 'smf-part-key-black' : 'smf-part-key-white');
      key.dataset.smfNote = String(note);
      key.setAttribute('x', String(black ? whiteIndex * 10 - 3 : whiteIndex * 10));
      key.setAttribute('y', '0');
      key.setAttribute('width', black ? '6' : '10');
      key.setAttribute('height', black ? '11' : '20');
      (black ? blackKeys : whiteKeys).append(key);
      keys[note] = key;
      if (!black) whiteIndex++;
    }
    keyboard.append(whiteKeys, blackKeys);
    return { keyboard, keys };
  }

  private updateActivity(view: PartView): void {
    const peak = Number.isFinite(this.levels[view.id]) ? clamp(this.levels[view.id], 0, 1) : 0;
    const level = Math.round(Math.sqrt(peak) * 1000);
    if (level !== view.level) {
      view.level = level;
      view.peak.style.setProperty('--smf-audio-level', `${level / 10}%`);
    }
    const notes = new Set((this.notes[view.id] ?? []).filter(note => Number.isInteger(note) && note >= 0 && note < 128));
    const changed = notes.size !== view.notes.size || [...notes].some(note => !view.notes.has(note));
    if (changed) {
      for (const note of view.notes) if (!notes.has(note)) view.keys[note].classList.remove('is-active');
      for (const note of notes) if (!view.notes.has(note)) view.keys[note].classList.add('is-active');
      view.notes = notes;
    }
    if (changed || !view.keyboard.hasAttribute('aria-label')) {
      view.keyboard.setAttribute('aria-label', `Part ${view.id + 1} sounding notes: ${notes.size ? [...notes].sort((a, b) => a - b).map(noteName).join(', ') : 'none'}. MIDI range C−1 to G9.`);
    }
    view.article.classList.toggle('is-sounding', notes.size > 0);
  }

  private muteSoloGesture(view: PartView): void {
    const button = view.mute;
    button.setAttribute('aria-keyshortcuts', 'Shift+Enter Shift+Space');
    let timer: number | undefined;
    let suppressClick = false;
    let originX = 0;
    let originY = 0;
    const cancel = () => { window.clearTimeout(timer); timer = undefined; };
    const toggle = (key: 'mute' | 'solo') => {
      const part = this.currentPart(view);
      if (part) this.callbacks.edit(view.id, { [key]: !part[key] }, [key]);
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      cancel();
      suppressClick = false;
      originX = event.clientX;
      originY = event.clientY;
      timer = window.setTimeout(() => { suppressClick = true; toggle('solo'); }, 500);
    });
    button.addEventListener('pointermove', event => {
      if (timer !== undefined && Math.hypot(event.clientX - originX, event.clientY - originY) > 10) { cancel(); suppressClick = true; }
    });
    for (const event of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(event, cancel);
    button.addEventListener('contextmenu', event => event.preventDefault());
    button.addEventListener('keydown', event => {
      if (event.shiftKey && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        if (!event.repeat) toggle('solo');
      }
    });
    button.addEventListener('keyup', event => { if (event.shiftKey && event.key === ' ') event.preventDefault(); });
    button.addEventListener('click', event => {
      if (suppressClick && event.detail > 0) { suppressClick = false; return; }
      toggle(event.shiftKey ? 'solo' : 'mute');
    });
  }
}
