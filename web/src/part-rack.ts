import './part-rack.css';
import type { AppState, BankInfo, Envelope, PartState } from './contracts';

interface PartRackCallbacks {
  select: (id: number) => void;
  edit: (id: number, patch: Partial<PartState>, changedFields?: string[]) => void;
  choosePatch: (id: number) => void;
  parameters: (id: number) => void;
}

type MixerProperty = 'volume' | 'pan' | 'reverb' | 'chorus' | 'delay';
type EnvelopeProperty = 'attack' | 'decay' | 'sustain' | 'release';
interface Dial {
  element: HTMLLabelElement;
  input: HTMLInputElement;
  output: HTMLOutputElement;
  format: (value: number) => string;
}
interface PartView {
  article: HTMLElement;
  select: HTMLButtonElement;
  patch: HTMLButtonElement;
  address: HTMLElement;
  volumeStrip: HTMLElement;
  mute: HTMLButtonElement;
  transpose: HTMLInputElement;
  locked: HTMLInputElement;
  override: HTMLInputElement;
  mixer: Record<MixerProperty, Dial>;
  envelope: Record<EnvelopeProperty, Dial>;
}

const mixerProperties: MixerProperty[] = ['volume', 'pan', 'reverb', 'chorus', 'delay'];
const envelopeProperties: EnvelopeProperty[] = ['attack', 'decay', 'sustain', 'release'];
const names: Record<MixerProperty | EnvelopeProperty, string> = {
  volume: 'Volume', pan: 'Pan', reverb: 'Reverb', chorus: 'Chorus', delay: 'Delay',
  attack: 'Attack', decay: 'Decay', sustain: 'Sustain', release: 'Release',
};
const formatPan = (value: number) => value === 64 ? 'Center' : value < 64 ? `L ${64 - value}` : `R ${value - 64}`;
const formatSeconds = (value: number) => `${value.toFixed(2)} s`;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

/** Stable, directly editable controls for all eight MIDI ports. */
export class PartRack {
  private readonly views: PartView[] = [];
  private state: AppState | undefined;

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
    const bankById = new Map(banks.map(bank => [bank.id, bank]));
    for (const part of state.parts) {
      const view = this.views[part.id];
      if (!view) continue;
      const selected = part.id === state.selectedPart;
      const bank = part.bankId ? bankById.get(part.bankId) : undefined;
      const patch = bank?.presets.find(item => item.msb === part.msb && item.lsb === part.lsb && item.program === part.program && item.drums === part.drums);
      const patchName = patch?.name || (part.bankId ? bank ? `Program ${part.program + 1}` : 'Missing soundbank' : 'Choose a patch');
      const identity = `Part ${part.id + 1}, port ${Math.floor(part.id / 16) + 1}, channel ${part.id % 16 + 1}`;
      view.article.classList.toggle('is-selected', selected);
      view.article.classList.toggle('is-muted', part.mute);
      view.article.classList.toggle('is-solo', part.solo);
      view.article.classList.toggle('has-bank', Boolean(part.bankId));
      view.select.setAttribute('aria-pressed', String(selected));
      view.select.setAttribute('aria-label', `Select ${identity}`);
      view.select.title = `Select ${identity}`;
      view.patch.textContent = patchName;
      view.patch.title = `${patchName}${bank ? ` · ${bank.name}` : ''} · MSB ${part.msb}, LSB ${part.lsb}, program ${part.program}`;
      view.patch.setAttribute('aria-label', `Choose patch for Part ${part.id + 1}: ${patchName}`);
      view.volumeStrip.style.setProperty('--saved-volume', `${Math.max(0, Math.min(127, part.volume)) / 127 * 100}%`);
      view.volumeStrip.title = `Saved volume: ${part.volume} of 127`;
      view.mute.textContent = part.solo ? 'S' : 'M';
      view.mute.setAttribute('aria-pressed', String(part.mute || part.solo));
      view.mute.setAttribute('aria-label', `Mute Part ${part.id + 1}${part.mute ? ', muted' : ''}${part.solo ? ', solo active' : ''}; hold for Solo or press Shift+Enter`);
      view.mute.title = `Part ${part.id + 1}: tap to toggle mute; hold for Solo; Shift+Enter or Shift+Space toggles Solo${part.mute ? ' · Muted' : ''}${part.solo ? ' · Solo active' : ''}`;
      const transpose = String(part.transpose);
      if (view.transpose.value !== transpose) view.transpose.value = transpose;
      view.locked.checked = part.locked;
      view.override.checked = part.envelope.enabled;
      for (const property of mixerProperties) this.updateDial(view.mixer[property], part[property]);
      for (const property of envelopeProperties) {
        const dial = view.envelope[property];
        this.updateDial(dial, part.envelope[property]);
        dial.input.disabled = !part.envelope.enabled;
        dial.element.classList.toggle('is-disabled', !part.envelope.enabled);
      }
    }
  }

  setPlaying(id: number, playing: boolean): void {
    this.views[id]?.article.classList.toggle('is-playing', playing);
  }

  private currentPart(id: number): PartState | undefined {
    return this.state?.parts.find(part => part.id === id);
  }

  private edit(id: number, patch: Partial<PartState>, fields: string[]): void {
    if (this.currentPart(id)) this.callbacks.edit(id, patch, fields);
  }

  private editEnvelope(id: number, patch: Partial<Envelope>, fields: string[]): void {
    const part = this.currentPart(id);
    if (part) this.callbacks.edit(id, { envelope: { ...part.envelope, ...patch } }, fields);
  }

  private createPart(id: number): PartView {
    const number = id + 1;
    const article = element('article', 'sampei-part');
    article.dataset.panelPart = String(id);
    article.setAttribute('aria-label', `Part ${number}`);

    const strip = element('div', 'sampei-strip');
    const volumeStrip = element('div', 'sampei-saved-volume');
    volumeStrip.setAttribute('aria-hidden', 'true');
    volumeStrip.append(element('span', 'sampei-saved-volume-fill'));
    const mute = this.muteSoloButton(id);
    const lockLabel = element('label', 'sampei-lock');
    const locked = element('input', 'sampei-checkbox');
    locked.type = 'checkbox';
    locked.id = `rack-${id}-locked`;
    locked.setAttribute('aria-label', `Lock Part ${number}`);
    locked.title = `Lock Part ${number} against MIDI program changes`;
    locked.addEventListener('change', () => this.edit(id, { locked: locked.checked }, ['locked']));
    lockLabel.title = locked.title;
    lockLabel.append(locked, element('span', '', 'Lock'));
    strip.append(volumeStrip, mute);

    const body = element('div', 'sampei-part-body');
    const head = element('div', 'sampei-part-head');
    const partField = element('div', 'sampei-head-field sampei-number-field');
    const select = element('button', 'sampei-part-select', String(number));
    select.type = 'button';
    select.dataset.rackPart = String(id);
    select.setAttribute('aria-pressed', 'false');
    select.addEventListener('click', () => this.callbacks.select(id));
    partField.append(element('span', 'sampei-field-caption', 'Part'), select);
    const channelField = element('div', 'sampei-head-field sampei-channel-field');
    const address = element('span', 'sampei-address', `${Math.floor(id / 16) + 1} / ${id % 16 + 1}`);
    address.title = `Port ${Math.floor(id / 16) + 1} · Channel ${id % 16 + 1}`;
    address.setAttribute('aria-label', address.title);
    channelField.append(element('span', 'sampei-field-caption', 'Port / Ch'), address);
    const patchField = element('div', 'sampei-head-field sampei-patch-field');
    const patch = element('button', 'sampei-patch', 'Choose a patch');
    patch.type = 'button';
    patch.dataset.rackPatch = String(id);
    patch.setAttribute('aria-haspopup', 'dialog');
    patch.addEventListener('click', () => this.callbacks.choosePatch(id));
    patchField.append(element('span', 'sampei-field-caption', 'Patch'), patch);
    const parameters = element('button', 'sampei-parameters', 'Param');
    parameters.type = 'button';
    parameters.setAttribute('aria-label', `Parameters for Part ${number}`);
    parameters.title = `Open all parameters for Part ${number}`;
    parameters.addEventListener('click', () => this.callbacks.parameters(id));
    head.append(partField, channelField, patchField, parameters);

    const mixerRow = element('div', 'sampei-dial-row sampei-mixer');
    mixerRow.setAttribute('role', 'group');
    mixerRow.setAttribute('aria-label', `Part ${number} mixer`);
    const mixer = {} as Record<MixerProperty, Dial>;
    for (const property of mixerProperties) {
      const dial = this.createDial(id, property, 127, '1', property === 'pan' ? formatPan : String, value => {
        this.edit(id, { [property]: value }, [property]);
      });
      mixer[property] = dial;
      mixerRow.append(dial.element);
    }

    const envelopeRow = element('div', 'sampei-dial-row sampei-envelope');
    envelopeRow.setAttribute('role', 'group');
    envelopeRow.setAttribute('aria-label', `Part ${number} amplitude envelope`);
    const envelope = {} as Record<EnvelopeProperty, Dial>;
    for (const property of envelopeProperties) {
      const dial = this.createDial(id, property, property === 'sustain' ? 1 : 20, '0.01', property === 'sustain' ? value => `${Math.round(value * 100)}%` : formatSeconds, value => {
        this.editEnvelope(id, { [property]: value }, [`envelope.${property}`]);
      });
      dial.input.disabled = true;
      envelope[property] = dial;
      envelopeRow.append(dial.element);
    }
    const overrideLabel = element('label', 'sampei-env-override');
    overrideLabel.append(element('span', 'sampei-dial-caption', 'Override'));
    const overrideControl = element('span', 'sampei-override-control');
    const override = element('input', 'sampei-checkbox');
    override.type = 'checkbox';
    override.id = `rack-${id}-envelope-enabled`;
    override.setAttribute('aria-label', `Part ${number} Envelope override`);
    override.title = `Use an amplitude envelope override for Part ${number}`;
    override.addEventListener('change', () => this.editEnvelope(id, { enabled: override.checked }, ['envelope.enabled']));
    overrideControl.append(override);
    overrideLabel.append(overrideControl, element('span', 'sampei-envelope-caption', 'ADSR'));
    envelopeRow.append(overrideLabel);
    const secondary = element('div', 'sampei-secondary-controls');
    const transposeLabel = element('label', 'sampei-key-shift');
    const transpose = element('input', 'sampei-transpose');
    transpose.type = 'number';
    transpose.id = `rack-${id}-transpose`;
    transpose.min = '-48';
    transpose.max = '48';
    transpose.step = '1';
    transpose.value = '0';
    transpose.setAttribute('aria-label', `Part ${number} Key shift`);
    transpose.title = `Part ${number} key shift in semitones, −48 to +48`;
    transposeLabel.htmlFor = transpose.id;
    transposeLabel.append(element('span', 'sampei-field-caption', 'K.Shft'), transpose);
    transpose.addEventListener('input', () => {
      if (!Number.isFinite(transpose.valueAsNumber)) return;
      const value = Math.max(-48, Math.min(48, Math.round(transpose.valueAsNumber)));
      this.edit(id, { transpose: value }, ['transpose']);
    });
    secondary.append(transposeLabel, lockLabel);
    body.append(head, mixerRow, envelopeRow, secondary);
    article.append(strip, body);
    return { article, select, patch, address, volumeStrip, mute, transpose, locked, override, mixer, envelope };
  }

  private muteSoloButton(id: number): HTMLButtonElement {
    const button = element('button', 'sampei-toggle sampei-mute', 'M');
    button.type = 'button';
    button.setAttribute('aria-label', `Mute Part ${id + 1}; hold for Solo or press Shift+Enter`);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-keyshortcuts', 'Shift+Enter Shift+Space');
    let timer: number | undefined;
    let pointer: number | undefined;
    let originX = 0;
    let originY = 0;
    let suppressClick = false;
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const toggle = (property: 'mute' | 'solo') => {
      const part = this.currentPart(id);
      if (part) this.edit(id, { [property]: !part[property] }, [property]);
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      clearTimer();
      pointer = event.pointerId;
      originX = event.clientX;
      originY = event.clientY;
      suppressClick = false;
      button.setPointerCapture(event.pointerId);
      timer = window.setTimeout(() => {
        timer = undefined;
        suppressClick = true;
        toggle('solo');
      }, 500);
    });
    button.addEventListener('pointermove', event => {
      if (pointer === event.pointerId && Math.hypot(event.clientX - originX, event.clientY - originY) > 10) {
        clearTimer();
        suppressClick = true;
      }
    });
    button.addEventListener('pointerup', event => {
      if (pointer !== event.pointerId) return;
      clearTimer();
      pointer = undefined;
    });
    const cancel = () => {
      clearTimer();
      pointer = undefined;
      suppressClick = true;
    };
    button.addEventListener('pointercancel', cancel);
    button.addEventListener('lostpointercapture', clearTimer);
    button.addEventListener('contextmenu', event => event.preventDefault());
    button.addEventListener('keydown', event => {
      if (event.shiftKey && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        if (!event.repeat) toggle('solo');
      }
    });
    button.addEventListener('keyup', event => {
      if (event.shiftKey && event.key === ' ') event.preventDefault();
    });
    button.addEventListener('click', event => {
      // A completed hold already changed Solo. The following pointer click must not mute.
      if (suppressClick && event.detail > 0) {
        suppressClick = false;
        return;
      }
      suppressClick = false;
      toggle(event.shiftKey ? 'solo' : 'mute');
    });
    return button;
  }

  private createDial(id: number, property: MixerProperty | EnvelopeProperty, max: number, step: string, format: (value: number) => string, onInput: (value: number) => void): Dial {
    const label = element('label', 'sampei-dial');
    const input = element('input', 'sampei-dial-input');
    input.type = 'range';
    input.id = `rack-${id}-${property}`;
    input.min = '0';
    input.max = String(max);
    input.step = step;
    input.value = '0';
    input.setAttribute('aria-label', `Part ${id + 1} ${names[property]}`);
    input.title = `${names[property]} · drag horizontally or use arrow keys`;
    label.htmlFor = input.id;
    const control = element('span', 'sampei-knob');
    control.setAttribute('aria-hidden', 'true');
    control.append(element('span', 'sampei-knob-needle'));
    const output = element('output', 'sampei-dial-value');
    output.htmlFor = input.id;
    const dial: Dial = { element: label, input, output, format };
    input.addEventListener('input', () => {
      const value = input.valueAsNumber;
      this.updateDial(dial, value);
      onInput(value);
    });
    label.append(element('span', 'sampei-dial-caption', names[property]), control, input, output);
    this.updateDial(dial, 0);
    return dial;
  }

  private updateDial(dial: Dial, value: number): void {
    const bounded = Math.max(Number(dial.input.min), Math.min(Number(dial.input.max), value));
    const textValue = String(bounded);
    // Retain the input node and avoid resetting its drag value when it is already current.
    if (dial.input.value !== textValue) dial.input.value = textValue;
    const valueText = dial.format(bounded);
    dial.output.value = valueText;
    dial.input.setAttribute('aria-valuetext', valueText);
    dial.element.style.setProperty('--dial-progress', `${bounded / Number(dial.input.max) * 270}deg`);
    dial.element.style.setProperty('--dial-angle', `${-135 + bounded / Number(dial.input.max) * 270}deg`);
  }
}
