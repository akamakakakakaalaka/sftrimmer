import './part-rack.css';
import type { AppState, BankInfo, PartState, PerformanceControls } from './contracts';
import { getPerformanceControls, PERFORMANCE_KEYS } from './performance';

interface PartRackCallbacks {
  select: (id: number) => void;
  edit: (id: number, patch: Partial<PartState>, changedFields?: string[]) => void;
  choosePatch: (id: number) => void;
  parameters: (id: number) => void;
}

type BaseControl = 'volume' | 'pan' | 'reverb' | 'chorus' | 'transpose';
type NumericPerformance = { [K in keyof PerformanceControls]: PerformanceControls[K] extends number ? K : never }[keyof PerformanceControls];
type SwitchPerformance = { [K in keyof PerformanceControls]: PerformanceControls[K] extends boolean ? K : never }[keyof PerformanceControls];
type ControlKey = BaseControl | NumericPerformance;
interface Control {
  element: HTMLLabelElement;
  input: HTMLInputElement;
  format: (value: number) => string;
}
interface PartView {
  article: HTMLElement;
  select: HTMLButtonElement;
  patch: HTMLButtonElement;
  volumeStrip: HTMLElement;
  mute: HTMLButtonElement;
  controls: Map<ControlKey, Control>;
  switches: Map<SwitchPerformance, HTMLInputElement>;
  fingerprint?: string;
  level: number;
}

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const signed = (value: number) => value === 0 ? '±0' : value > 0 ? `+${value}` : String(value);
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (value: number) => `${noteNames[value % 12]}${Math.floor(value / 12) - 1}`;
function parseNote(text: string): number | undefined {
  const value = text.trim();
  if (/^\d{1,3}$/.test(value)) {
    const number = Number(value);
    return number <= 127 ? number : undefined;
  }
  const match = /^([a-g])([#b]?)(-?\d{1,2})$/i.exec(value);
  if (!match) return undefined;
  const natural: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const number = (Number(match[3]) + 1) * 12 + natural[match[1].toLowerCase()] + (match[2] === '#' ? 1 : match[2].toLowerCase() === 'b' ? -1 : 0);
  return number >= 0 && number <= 127 ? number : undefined;
}

/** The native panel's compact phone and two-row tablet control arrangements. */
export class PartRack {
  private readonly views: PartView[] = [];
  private state: AppState | undefined;
  private bankGeneration = 0;
  private bankById = new Map<string, BankInfo>();
  private bankSnapshot: { bank: BankInfo; id: string; name: string; presets: BankInfo['presets']; count: number }[] = [];

  constructor(container: HTMLElement, private readonly callbacks: PartRackCallbacks) {
    container.classList.add('part-rack');
    const fragment = document.createDocumentFragment();
    for (let id = 0; id < 128; id++) {
      const view = this.createPart(id);
      this.views.push(view);
      fragment.append(view.article);
    }
    container.append(fragment);
  }

  update(state: AppState, banks: BankInfo[]): void {
    this.state = state;
    const banksChanged = banks.length !== this.bankSnapshot.length || banks.some((bank, index) => {
      const previous = this.bankSnapshot[index];
      return !previous || previous.bank !== bank || previous.id !== bank.id || previous.name !== bank.name || previous.presets !== bank.presets || previous.count !== bank.presets.length;
    });
    if (banksChanged) {
      this.bankGeneration++;
      this.bankById = new Map(banks.map(bank => [bank.id, bank]));
      this.bankSnapshot = banks.map(bank => ({ bank, id: bank.id, name: bank.name, presets: bank.presets, count: bank.presets.length }));
    }
    for (const part of state.parts) {
      const view = this.views[part.id];
      if (!view) continue;
      // Parts are mutated in place by MIDI and the inspector. Fingerprint visible
      // values rather than object identity, then leave every unchanged panel alone.
      const fingerprint = JSON.stringify([this.bankGeneration, part.id === state.selectedPart, part.bankId, part.msb, part.lsb, part.program, part.drums, part.volume, part.pan, part.reverb, part.chorus, part.transpose, part.mute, part.solo, part.envelope.enabled, ...PERFORMANCE_KEYS.map(key => part.performance?.[key])]);
      if (view.fingerprint === fingerprint) continue;
      view.fingerprint = fingerprint;
      const performance = getPerformanceControls(part);
      const bank = part.bankId ? this.bankById.get(part.bankId) : undefined;
      const patch = bank?.presets.find(item => item.msb === part.msb && item.lsb === part.lsb && item.program === part.program && item.drums === part.drums);
      const patchName = patch?.name || (part.bankId ? bank ? `Program ${part.program + 1}` : 'Missing soundbank' : 'Choose a patch');
      const identity = `Part ${part.id + 1}, port ${Math.floor(part.id / 16) + 1}, channel ${part.id % 16 + 1}`;
      view.article.classList.toggle('is-selected', part.id === state.selectedPart);
      view.article.classList.toggle('is-muted', part.mute);
      view.article.classList.toggle('is-solo', part.solo);
      view.select.setAttribute('aria-pressed', String(part.id === state.selectedPart));
      view.select.setAttribute('aria-label', `Select ${identity}`);
      view.select.title = `Select ${identity}; hold or right-click for advanced parameters`;
      view.patch.textContent = patchName;
      view.patch.title = `${patchName}${bank ? ` · ${bank.name}` : ''} · MSB ${part.msb}, LSB ${part.lsb}, program ${part.program}`;
      view.patch.setAttribute('aria-label', `Choose patch for Part ${part.id + 1}: ${patchName}`);
      view.mute.textContent = part.solo ? 'S' : 'M';
      view.mute.setAttribute('aria-pressed', String(part.mute || part.solo));
      view.mute.setAttribute('aria-label', `Mute Part ${part.id + 1}${part.mute ? ', muted' : ''}${part.solo ? ', solo active' : ''}; hold for Solo or press Shift+Enter`);
      view.mute.title = `Tap to mute; hold for Solo; Shift+Enter or Shift+Space toggles Solo${part.mute ? ' · Muted' : ''}${part.solo ? ' · Solo active' : ''}`;
      for (const [property, control] of view.controls) {
        const value = property in performance ? performance[property as NumericPerformance] : part[property as BaseControl];
        this.updateControl(control, value);
        if (property === 'attack' || property === 'decay' || property === 'release') {
          control.input.disabled = part.envelope.enabled;
          control.element.classList.toggle('is-overridden', part.envelope.enabled);
          control.input.title = part.envelope.enabled
            ? 'The absolute ADSR envelope in Advanced overrides this relative MIDI envelope control'
            : `${control.input.dataset.controlName} · relative MIDI envelope, 64 is neutral; drag or use arrow keys`;
          control.element.title = control.input.title;
        }
      }
      for (const [property, input] of view.switches) input.checked = performance[property];
    }
  }

  setPlaying(id: number, playing: boolean): void {
    this.views[id]?.article.classList.toggle('is-playing', playing);
  }

  /** Actual dry channel peaks from the audio worklet, with a readable square-root display. */
  setLevels(levels: number[]): void {
    for (let id = 0; id < this.views.length; id++) {
      const view = this.views[id];
      const peak = Number.isFinite(levels[id]) ? clamp(levels[id], 0, 1) : 0;
      const level = Math.round(Math.sqrt(peak) * 1000);
      if (view.level === level) continue;
      view.level = level;
      view.volumeStrip.style.setProperty('--sampei-audio-level', `${level / 10}%`);
    }
  }

  private currentPart(id: number): PartState | undefined {
    return this.state?.parts.find(part => part.id === id);
  }

  private editBase(id: number, property: BaseControl, value: number): void {
    if (this.currentPart(id)) this.callbacks.edit(id, { [property]: value }, [property]);
  }

  private editPerformance<K extends keyof PerformanceControls>(id: number, property: K, value: PerformanceControls[K]): void {
    const part = this.currentPart(id);
    if (!part) return;
    const performance = { ...getPerformanceControls(part), [property]: value };
    const changedFields = [`performance.${property}`];
    if (performance.lowKey > performance.highKey) {
      const other = property === 'lowKey' ? 'highKey' : 'lowKey';
      performance[other] = performance[property as 'lowKey' | 'highKey'];
      changedFields.push(`performance.${other}`);
    }
    this.callbacks.edit(id, { performance }, changedFields);
  }

  private createPart(id: number): PartView {
    const article = node('article', 'sampei-panel');
    article.dataset.panelPart = String(id);
    article.setAttribute('aria-label', `Part ${id + 1}`);
    const volumeStrip = node('div', 'sampei-volume-strip');
    volumeStrip.setAttribute('aria-hidden', 'true');
    volumeStrip.title = `Part ${id + 1} dry audio peak level`;
    volumeStrip.append(node('span', 'sampei-volume-fill'));
    const mute = this.muteSoloButton(id);
    article.append(volumeStrip, mute);

    const select = node('button', 'sampei-white-field sampei-select', String(id + 1));
    select.type = 'button';
    select.dataset.rackPart = String(id);
    select.setAttribute('aria-pressed', 'false');
    this.partSelectionGesture(select, id);
    article.append(this.headerField('Part', 'part', select));
    const channel = node('span', 'sampei-white-field sampei-channel', String(id % 16 + 1));
    channel.title = `Port ${Math.floor(id / 16) + 1} · MIDI channel ${id % 16 + 1}; each part has a fixed port and channel`;
    channel.setAttribute('aria-label', channel.title);
    article.append(this.headerField('Channel', 'channel', channel));
    const patch = node('button', 'sampei-white-field sampei-patch-button', 'Choose a patch');
    patch.type = 'button';
    patch.dataset.rackPatch = String(id);
    patch.setAttribute('aria-haspopup', 'dialog');
    patch.addEventListener('click', () => this.callbacks.choosePatch(id));
    article.append(this.headerField('Patch', 'patch', patch));

    const controls = new Map<ControlKey, Control>();
    const add = (key: ControlKey, control: Control) => {
      controls.set(key, control);
      article.append(control.element);
    };
    add('lowKey', this.noteField(id, 'lowKey', 'Low'));
    add('highKey', this.noteField(id, 'highKey', 'High'));
    const baseDials: [BaseControl, string][] = [['volume', 'Volume'], ['pan', 'Pan'], ['reverb', 'Reverb'], ['chorus', 'Chorus']];
    for (const [key, caption] of baseDials) {
      add(key, this.dial(id, key, caption, 0, 127, value => this.editBase(id, key, value), key === 'pan' ? value => value === 64 ? 'Center' : value < 64 ? `Left ${64 - value}` : `Right ${value - 64}` : String));
    }
    const performanceDials: [NumericPerformance, string, number, number][] = [
      ['expression', 'Express', 0, 127], ['portamentoTime', 'P.Time', 0, 127], ['fineTune', 'F.Tune', -100, 100],
      ['vibratoRate', 'V.Rate', 0, 127], ['vibratoDepth', 'V.Depth', 0, 127], ['vibratoDelay', 'V.Delay', 0, 127],
      ['attack', 'Attack', 0, 127], ['decay', 'Decay', 0, 127], ['release', 'Release', 0, 127], ['cutoff', 'Cutoff', 0, 127], ['resonance', 'Q', 0, 127],
    ];
    for (const [key, caption, min, max] of performanceDials) {
      add(key, this.dial(id, key, caption, min, max, value => this.editPerformance(id, key, value), key === 'fineTune' ? value => `${signed(value)} cents` : String));
    }
    add('pitchBend', this.slider(id, 'pitchBend', 'P.Bend', 16383));
    add('modulation', this.slider(id, 'modulation', 'Mod', 127));
    add('bendRange', this.numberField(id, 'bendRange', 'Rng', 0, 24, value => this.editPerformance(id, 'bendRange', value)));
    add('transpose', this.numberField(id, 'transpose', 'K.Shft', -48, 48, value => this.editBase(id, 'transpose', value), signed));
    const switches = new Map<SwitchPerformance, HTMLInputElement>();
    for (const [key, caption] of [['portamento', 'Por'], ['mono', 'Mno'], ['soft', 'Soft'], ['sostenuto', 'Sost'], ['hold', 'Hold']] as [SwitchPerformance, string][]) {
      const label = node('label', `sampei-item sampei-switch sampei-control-${key}`);
      label.append(this.caption(caption, key));
      const input = node('input', 'sampei-switch-input');
      input.type = 'checkbox';
      input.id = `rack-${id}-performance-${key}`;
      input.setAttribute('aria-label', `Part ${id + 1} ${key === 'sostenuto' ? 'Sostenuto' : key === 'mono' ? 'Mono mode' : key}`);
      input.addEventListener('change', () => this.editPerformance(id, key, input.checked));
      label.htmlFor = input.id;
      label.append(input);
      article.append(label);
      switches.set(key, input);
    }
    for (const separator of ['header', 'pan', 'chorus', 'portamentoTime', 'mono', 'fineTune', 'vibratoDelay', 'release', 'resonance']) {
      const line = node('span', `sampei-divider sampei-divider-${separator}`);
      line.setAttribute('aria-hidden', 'true');
      article.append(line);
    }
    const advanced = node('button', 'sampei-advanced-access', `Advanced parameters for Part ${id + 1}`);
    advanced.type = 'button';
    advanced.addEventListener('click', () => this.callbacks.parameters(id));
    article.append(advanced);
    return { article, select, patch, volumeStrip, mute, controls, switches, level: 0 };
  }

  private caption(text: string, key?: string): HTMLSpanElement {
    const caption = node('span', 'sampei-caption', text);
    if (key === 'pitchBend' || key === 'sostenuto' || key === 'hold') {
      caption.classList.add('sampei-responsive-caption');
      caption.dataset.phoneCaption = key === 'pitchBend' ? 'PB' : key === 'sostenuto' ? 'Sos' : 'Hld';
      caption.dataset.tabletCaption = text;
      caption.setAttribute('aria-hidden', 'true');
    }
    return caption;
  }

  private headerField(caption: string, key: string, input: HTMLElement): HTMLElement {
    const field = node('div', `sampei-item sampei-header-field sampei-control-${key}`);
    field.append(this.caption(caption), input);
    return field;
  }

  private noteField(id: number, key: 'lowKey' | 'highKey', caption: string): Control {
    const label = node('label', `sampei-item sampei-header-field sampei-control-${key}`);
    const input = node('input', 'sampei-white-field sampei-note-input');
    input.type = 'text';
    input.id = `rack-${id}-performance-${key}`;
    input.maxLength = 5;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Part ${id + 1} ${key === 'lowKey' ? 'lowest' : 'highest'} key`);
    input.title = 'MIDI note C-1 to G9, or note number 0 to 127';
    input.addEventListener('change', () => {
      const value = parseNote(input.value);
      if (value !== undefined) {
        input.setCustomValidity('');
        this.editPerformance(id, key, value);
        input.value = noteName(value);
      } else {
        input.setCustomValidity('Enter a MIDI note from C-1 to G9, or a number from 0 to 127.');
        input.reportValidity();
      }
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('blur', () => {
      const part = this.currentPart(id);
      if (part && parseNote(input.value) === undefined) {
        input.value = noteName(getPerformanceControls(part)[key]);
        input.setCustomValidity('');
      }
    });
    label.htmlFor = input.id;
    label.append(this.caption(caption), input);
    return { element: label, input, format: noteName };
  }

  private numberField(id: number, key: ControlKey, caption: string, min: number, max: number, onInput: (value: number) => void, format: (value: number) => string = String): Control {
    const label = node('label', `sampei-item sampei-number-control sampei-control-${key}`);
    const input = node('input', 'sampei-white-field sampei-number-input');
    input.type = 'number';
    input.id = `rack-${id}-${key === 'transpose' ? key : `performance-${key}`}`;
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.setAttribute('aria-label', `Part ${id + 1} ${key === 'bendRange' ? 'Pitch bend range in semitones' : 'Key shift in semitones'}`);
    const display = node('span', 'sampei-number-display');
    display.setAttribute('aria-hidden', 'true');
    input.addEventListener('input', () => {
      if (!Number.isFinite(input.valueAsNumber)) return;
      const value = Math.round(clamp(input.valueAsNumber, min, max));
      display.textContent = format(value);
      onInput(value);
    });
    label.htmlFor = input.id;
    label.append(this.caption(caption), input, display);
    return { element: label, input, format };
  }

  private dial(id: number, key: ControlKey, caption: string, min: number, max: number, onInput: (value: number) => void, format: (value: number) => string = String): Control {
    const label = node('label', `sampei-item sampei-rotary sampei-control-${key}`);
    const neutral = key === 'fineTune' ? 0 : ['pan', 'vibratoRate', 'vibratoDepth', 'vibratoDelay', 'attack', 'decay', 'release', 'cutoff', 'resonance'].includes(key) ? 64 : undefined;
    if (neutral !== undefined) label.dataset.neutral = String(neutral);
    const input = node('input', 'sampei-rotary-input');
    input.type = 'range';
    input.id = `rack-${id}-${['volume', 'pan', 'reverb', 'chorus'].includes(key) ? key : `performance-${key}`}`;
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.dataset.controlName = caption;
    const accessibleNames: Partial<Record<ControlKey, string>> = { expression: 'Expression', fineTune: 'Fine tuning in cents', portamentoTime: 'Portamento time', vibratoRate: 'Vibrato rate', vibratoDepth: 'Vibrato depth', vibratoDelay: 'Vibrato delay', resonance: 'Resonance' };
    input.setAttribute('aria-label', `Part ${id + 1} ${accessibleNames[key] || caption}`);
    input.title = `${caption} · drag horizontally or use arrow keys`;
    const face = node('span', 'sampei-rotary-face');
    face.setAttribute('aria-hidden', 'true');
    face.append(node('span', 'sampei-rotary-pointer'));
    label.htmlFor = input.id;
    const control = { element: label, input, format };
    input.addEventListener('input', () => {
      this.updateControl(control, input.valueAsNumber);
      onInput(input.valueAsNumber);
    });
    label.append(this.caption(caption), face, input);
    return control;
  }

  private slider(id: number, key: 'pitchBend' | 'modulation', caption: string, max: number): Control {
    const label = node('label', `sampei-item sampei-fader sampei-control-${key}`);
    const input = node('input', 'sampei-fader-input');
    input.type = 'range';
    input.id = `rack-${id}-performance-${key}`;
    input.min = '0';
    input.max = String(max);
    input.step = '1';
    input.setAttribute('aria-label', `Part ${id + 1} ${key === 'pitchBend' ? 'Pitch bend' : 'Modulation'}`);
    input.setAttribute('aria-orientation', 'vertical');
    input.title = key === 'pitchBend' ? 'Pitch bend, 8192 is centered; use arrow keys to adjust' : 'Modulation, 0 to 127';
    const track = node('span', 'sampei-fader-track');
    track.setAttribute('aria-hidden', 'true');
    track.append(node('span', 'sampei-fader-thumb'));
    label.htmlFor = input.id;
    const control = { element: label, input, format: String };
    input.addEventListener('input', () => {
      this.updateControl(control, input.valueAsNumber);
      this.editPerformance(id, key, input.valueAsNumber);
    });
    label.append(this.caption(caption, key), track, input);
    return control;
  }

  private updateControl(control: Control, value: number): void {
    const input = control.input;
    if (input.type === 'text') {
      if (document.activeElement !== input) input.value = control.format(value);
    } else {
      const bounded = clamp(value, Number(input.min), Number(input.max));
      if (input.value !== String(bounded)) input.value = String(bounded);
      const progress = (bounded - Number(input.min)) / (Number(input.max) - Number(input.min));
      const neutral = control.element.dataset.neutral;
      const neutralProgress = neutral === undefined ? 0 : (Number(neutral) - Number(input.min)) / (Number(input.max) - Number(input.min));
      control.element.style.setProperty('--sampei-dial-start', `${Math.min(progress, neutralProgress) * 270}deg`);
      control.element.style.setProperty('--sampei-dial-progress', `${Math.max(progress, neutralProgress) * 270}deg`);
      control.element.style.setProperty('--sampei-dial-angle', `${-135 + progress * 270}deg`);
      control.element.style.setProperty('--sampei-fader-position', `${(1 - progress) * 100}%`);
      const display = control.element.querySelector('.sampei-number-display');
      if (display) display.textContent = control.format(bounded);
    }
    input.setAttribute('aria-valuetext', control.format(value));
  }

  private partSelectionGesture(button: HTMLButtonElement, id: number): void {
    let timer: number | undefined;
    let held = false;
    let originX = 0;
    let originY = 0;
    const cancel = () => { window.clearTimeout(timer); timer = undefined; };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      held = false;
      originX = event.clientX;
      originY = event.clientY;
      cancel();
      timer = window.setTimeout(() => { held = true; this.callbacks.parameters(id); }, 500);
    });
    button.addEventListener('pointermove', event => {
      if (Math.hypot(event.clientX - originX, event.clientY - originY) > 10) { cancel(); held = true; }
    });
    button.addEventListener('pointerup', cancel);
    button.addEventListener('pointerleave', cancel);
    button.addEventListener('pointercancel', cancel);
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      cancel();
      if (!held) this.callbacks.parameters(id);
      held = true;
    });
    button.addEventListener('click', event => {
      if (held && event.detail > 0) { held = false; return; }
      this.callbacks.select(id);
    });
  }

  private muteSoloButton(id: number): HTMLButtonElement {
    const button = node('button', 'sampei-mute', 'M');
    button.type = 'button';
    button.setAttribute('aria-keyshortcuts', 'Shift+Enter Shift+Space');
    let timer: number | undefined;
    let pointer: number | undefined;
    let originX = 0;
    let originY = 0;
    let suppressClick = false;
    const clearTimer = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; };
    const toggle = (property: 'mute' | 'solo') => {
      const part = this.currentPart(id);
      if (part) this.callbacks.edit(id, { [property]: !part[property] }, [property]);
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      clearTimer();
      pointer = event.pointerId;
      originX = event.clientX;
      originY = event.clientY;
      suppressClick = false;
      button.setPointerCapture(event.pointerId);
      timer = window.setTimeout(() => { timer = undefined; suppressClick = true; toggle('solo'); }, 500);
    });
    button.addEventListener('pointermove', event => {
      if (pointer === event.pointerId && Math.hypot(event.clientX - originX, event.clientY - originY) > 10) {
        clearTimer();
        suppressClick = true;
      }
    });
    button.addEventListener('pointerup', event => { if (pointer === event.pointerId) { clearTimer(); pointer = undefined; } });
    button.addEventListener('pointercancel', () => { clearTimer(); pointer = undefined; suppressClick = true; });
    button.addEventListener('lostpointercapture', clearTimer);
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
      suppressClick = false;
      toggle(event.shiftKey ? 'solo' : 'mute');
    });
    return button;
  }
}
