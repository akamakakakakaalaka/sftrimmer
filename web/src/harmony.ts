/** Static templates; these do not model context-sensitive maqam performance. */
export const SCALES: Readonly<Record<string, readonly number[]>> = Object.freeze({
  chromatic: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
  naturalMinor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  harmonicMinor: Object.freeze([0, 2, 3, 5, 7, 8, 11]),
  melodicMinor: Object.freeze([0, 2, 3, 5, 7, 9, 11]),
  hijaz: Object.freeze([0, 1, 4, 5, 7, 8, 10]),
  rast: Object.freeze([0, 2, 3.5, 5, 7, 9, 10.5]),
  bayati: Object.freeze([0, 1.5, 3, 5, 7, 8, 10]),
  hirajoshi: Object.freeze([0, 2, 3, 7, 8]),
  insen: Object.freeze([0, 1, 5, 7, 10])
});

export const SCALE_CENTS: Readonly<Record<string, readonly number[]>> = Object.freeze(
  Object.fromEntries(Object.entries(SCALES).map(([name, notes]) => [name, Object.freeze(notes.map(note => note * 100))]))
);

const modeNames = new Map(Object.keys(SCALES).map(name => [name.toLowerCase(), name]));
modeNames.set('minor', 'naturalMinor');

export function normalizeMode(mode: unknown): string {
  if (typeof mode !== 'string') return 'chromatic';
  return modeNames.get(mode.toLowerCase().replace(/[\s_-]/g, '')) ?? 'chromatic';
}

export function requiresMicrotonalTuning(mode: string): boolean {
  return SCALES[normalizeMode(mode)].some(note => !Number.isInteger(note));
}

function midiNote(note: number): number {
  return Number.isFinite(note) ? Math.min(127, Math.max(0, Math.round(note))) : 0;
}

/**
 * Snap to the selected root/scale, then transpose. Percussion exclusion and
 * remembering transformed note-offs are the caller's responsibilities.
 * Rast/Bayati must use SCALE_CENTS with per-voice tuning; this integer-only API
 * bypasses their snapping so a rounded 12-TET imitation is never substituted.
 */
export function transformNote(note: number, root: number, mode: string, transpose: number): number {
  const input = midiNote(note);
  const scale = SCALES[normalizeMode(mode)];
  const shift = Number.isFinite(transpose) ? Math.round(transpose) : 0;
  if (requiresMicrotonalTuning(mode)) return midiNote(input + shift);
  const tonic = Number.isFinite(root) ? ((Math.round(root) % 12) + 12) % 12 : 0;
  let output = input;
  let distance = Infinity;
  // Include neighbouring octaves so notes near C/B map correctly across them.
  const octave = Math.floor((input - tonic) / 12);
  for (let offset = octave - 1; offset <= octave + 1; offset++) {
    for (const degree of scale) {
      const candidate = tonic + offset * 12 + degree;
      if (candidate < 0 || candidate > 127) continue;
      const delta = Math.abs(candidate - input);
      if (delta < distance || (delta === distance && candidate < output)) {
        output = candidate;
        distance = delta;
      }
    }
  }
  return midiNote(output + shift);
}
