import type { AppState, Envelope, MasterState, PartState, PresetMapping, SavedPreset } from './contracts.ts';
import { normalizeMode } from './harmony.ts';

const SESSION_KEY = 'project128.session';
const PART_COUNT = 128;
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const result = Math.min(max, Math.max(min, value));
  return integer ? Math.round(result) : result;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function bankId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function createEnvelope(): Envelope {
  return { attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.3, enabled: false };
}

function createPart(id: number): PartState {
  return { id, bankId: null, msb: 0, lsb: 0, program: 0, drums: id % 16 === 9,
    volume: 100, pan: 64, reverb: 25, chorus: 0, delay: 0, mute: false, solo: false,
    transpose: 0, envelope: createEnvelope(), drumMap: {}, locked: false };
}

function createMaster(): MasterState {
  return { keyShift: 0, fineTune: 0, gain: 0.7, tempo: 1, root: 0, mode: 'chromatic', theme: 'dark',
    delayTime: 0.3, delayFeedback: 0.25, delayMix: 0, flangerMix: 0, crusherBits: 16 };
}

export function createState(): AppState {
  return { version: 1, master: createMaster(), parts: Array.from({ length: PART_COUNT }, (_, id) => createPart(id)), selectedPart: 0, presetMappings: [] };
}

function restoreMaster(raw: unknown): MasterState {
  const defaults = createMaster();
  if (!record(raw)) return defaults;
  return {
    keyShift: bounded(raw.keyShift, defaults.keyShift, -48, 48, true),
    fineTune: bounded(raw.fineTune, defaults.fineTune, -100, 100),
    gain: bounded(raw.gain, defaults.gain, 0, 2),
    tempo: bounded(raw.tempo, defaults.tempo, 0.25, 4),
    root: bounded(raw.root, defaults.root, 0, 11, true),
    mode: normalizeMode(raw.mode),
    theme: typeof raw.theme === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(raw.theme) ? raw.theme : defaults.theme,
    delayTime: bounded(raw.delayTime, defaults.delayTime, 0.01, 4),
    delayFeedback: bounded(raw.delayFeedback, defaults.delayFeedback, 0, 0.95),
    delayMix: bounded(raw.delayMix, defaults.delayMix, 0, 1),
    flangerMix: bounded(raw.flangerMix, defaults.flangerMix, 0, 1),
    crusherBits: bounded(raw.crusherBits, defaults.crusherBits, 1, 16, true)
  };
}

function restorePart(raw: RecordValue, id: number): PartState {
  const defaults = createPart(id);
  const envelope = record(raw.envelope) ? raw.envelope : {};
  const drumMap: Record<number, number> = {};
  if (record(raw.drumMap)) {
    for (const [key, value] of Object.entries(raw.drumMap)) {
      const source = Number(key);
      if (String(source) !== key || !Number.isInteger(source) || source < 0 || source > 127 || typeof value !== 'number' || !Number.isFinite(value)) continue;
      drumMap[source] = bounded(value, source, 0, 127, true);
    }
  }
  return {
    id, bankId: bankId(raw.bankId),
    msb: bounded(raw.msb, defaults.msb, 0, 127, true),
    lsb: bounded(raw.lsb, defaults.lsb, 0, 127, true),
    program: bounded(raw.program, defaults.program, 0, 127, true),
    drums: boolean(raw.drums, defaults.drums),
    volume: bounded(raw.volume, defaults.volume, 0, 127, true),
    pan: bounded(raw.pan, defaults.pan, 0, 127, true),
    reverb: bounded(raw.reverb, defaults.reverb, 0, 127, true),
    chorus: bounded(raw.chorus, defaults.chorus, 0, 127, true),
    delay: bounded(raw.delay, defaults.delay, 0, 127, true),
    mute: boolean(raw.mute, defaults.mute), solo: boolean(raw.solo, defaults.solo),
    transpose: bounded(raw.transpose, defaults.transpose, -48, 48, true),
    envelope: {
      attack: bounded(envelope.attack, defaults.envelope.attack, 0, 30),
      decay: bounded(envelope.decay, defaults.envelope.decay, 0, 30),
      sustain: bounded(envelope.sustain, defaults.envelope.sustain, 0, 1),
      release: bounded(envelope.release, defaults.envelope.release, 0, 30),
      enabled: boolean(envelope.enabled, defaults.envelope.enabled)
    },
    drumMap, locked: boolean(raw.locked, defaults.locked)
  };
}

/** Restore only this app's schema. MIDI-file state never enters this model. */
export function restoreState(raw: unknown): AppState {
  const state = createState();
  if (!record(raw) || raw.version !== 1) return state;
  state.master = restoreMaster(raw.master);
  state.selectedPart = bounded(raw.selectedPart, 0, 0, PART_COUNT - 1, true);
  const seen = new Set<number>();
  if (Array.isArray(raw.parts)) {
    for (const part of raw.parts) {
      if (!record(part) || typeof part.id !== 'number' || !Number.isInteger(part.id) || part.id < 0 || part.id >= PART_COUNT || seen.has(part.id)) continue;
      seen.add(part.id);
      state.parts[part.id] = restorePart(part, part.id);
    }
  }
  state.presetMappings = restoreMappings(raw.presetMappings);
  return state;
}

export function saveState(state: AppState, storage?: Storage): void {
  try { (storage ?? globalThis.localStorage)?.setItem(SESSION_KEY, JSON.stringify(restoreState(state))); }
  catch { /* Storage may be disabled or full; the active session remains usable. */ }
}

export function loadState(storage?: Storage): AppState {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(SESSION_KEY);
    return raw ? restoreState(JSON.parse(raw)) : createState();
  } catch { return createState(); }
}

export function createPreset(state: AppState, name: string): SavedPreset {
  const snapshot = restoreState(state);
  const part = snapshot.parts[snapshot.selectedPart];
  return { version: 1, id: globalThis.crypto?.randomUUID?.() ?? `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name: name.trim().slice(0, 120) || 'Untitled preset', bankId: part.bankId, part };
}

function validPreset(raw: unknown): raw is SavedPreset {
  if (!record(raw) || raw.version !== 1 || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128
      || typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 120
      || (raw.bankId !== null && bankId(raw.bankId) !== raw.bankId) || !record(raw.part)) return false;
  const part = raw.part;
  if (typeof part.id !== 'number' || !Number.isInteger(part.id) || part.id < 0 || part.id >= PART_COUNT
      || part.bankId !== raw.bankId || !record(part.envelope) || !record(part.drumMap)) return false;
  const clean = restorePart(part, part.id);
  // Import rejects invalid values instead of silently turning an unrelated
  // record into a plausible preset. Session recovery is deliberately gentler.
  for (const key of Object.keys(clean) as (keyof PartState)[]) {
    if (key !== 'envelope' && key !== 'drumMap' && part[key] !== clean[key]) return false;
  }
  for (const key of Object.keys(clean.envelope) as (keyof Envelope)[]) {
    if (part.envelope[key] !== clean.envelope[key]) return false;
  }
  const rawMap = part.drumMap;
  const keys = Object.keys(rawMap);
  if (keys.length !== Object.keys(clean.drumMap).length) return false;
  return keys.every(key => rawMap[key] === clean.drumMap[Number(key)]);
}

function clonePreset(preset: SavedPreset): SavedPreset {
  return { version: 1, id: preset.id, name: preset.name.trim(), bankId: preset.bankId,
    part: restorePart(preset.part as unknown as RecordValue, preset.part.id) };
}

/**
 * Bindings are strict: malformed addresses must never become an unintended
 * program-zero binding. First valid occurrence wins for the complete
 * part/MSB/LSB/program tuple; retain at most 2,048 unique valid bindings.
 */
function restoreMappings(raw: unknown): PresetMapping[] {
  const mappings: PresetMapping[] = [];
  if (!Array.isArray(raw)) return mappings;
  const seen = new Set<string>();
  for (const mapping of raw) {
    if (!record(mapping)) continue;
    const { partId, msb, lsb, program, preset } = mapping;
    if (![partId, msb, lsb, program].every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 127)
        || !validPreset(preset)) continue;
    const address = `${partId}:${msb}:${lsb}:${program}`;
    if (seen.has(address)) continue;
    seen.add(address);
    mappings.push({ partId: partId as number, msb: msb as number, lsb: lsb as number, program: program as number, preset: clonePreset(preset) });
    if (mappings.length === 2048) break;
  }
  return mappings;
}

export function parsePreset(text: string): SavedPreset {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error('Unsupported preset: import a Project 128 JSON preset. KQ preset files are not supported.'); }
  if (!validPreset(raw)) throw new Error('Invalid Project 128 preset or unsupported version.');
  return clonePreset(raw);
}

export function applyPreset(state: AppState, preset: SavedPreset, partId: number): AppState {
  if (!Number.isInteger(partId) || partId < 0 || partId >= PART_COUNT) throw new RangeError('Part must be between 0 and 127.');
  if (!validPreset(preset)) throw new Error('Invalid Project 128 preset.');
  const result = restoreState(state);
  result.parts[partId] = restorePart(preset.part as unknown as RecordValue, partId);
  return result;
}
