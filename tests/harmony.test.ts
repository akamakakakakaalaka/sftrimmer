import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresMicrotonalTuning, SCALE_CENTS, SCALES, transformNote } from '../web/src/harmony.ts';

test('chromatic mode preserves every MIDI note and applies semitone transposition', () => {
  for (let note = 0; note < 128; note++) assert.equal(transformNote(note, 7, 'chromatic', 0), note);
  assert.equal(transformNote(60, 0, 'chromatic', 12), 72);
  assert.equal(transformNote(3, 0, 'chromatic', -12), 0);
  assert.equal(transformNote(120, 0, 'chromatic', 12), 127);
});

test('major and minor mapping use the selected root and nearest note with lower ties', () => {
  assert.equal(transformNote(61, 0, 'major', 0), 60);
  assert.equal(transformNote(63, 0, 'major', 0), 62);
  assert.equal(transformNote(64, 0, 'naturalMinor', 0), 63);
  assert.equal(transformNote(71, 0, 'natural minor', 0), 70);
  assert.equal(transformNote(61, 2, 'major', 0), 61);
  assert.equal(transformNote(60, 0, 'major', 1), 61);
  assert.equal(transformNote(68, 0, 'harmonic minor', 0), 68);
  assert.equal(transformNote(69, 0, 'melodic-minor', 0), 69);
});

test('named scale templates include distinct Hijaz, Hirajoshi and Insen intervals', () => {
  assert.deepEqual(SCALES.hijaz, [0, 1, 4, 5, 7, 8, 10]);
  assert.deepEqual(SCALES.hirajoshi, [0, 2, 3, 7, 8]);
  assert.deepEqual(SCALES.insen, [0, 1, 5, 7, 10]);
  assert.equal(transformNote(62, 0, 'Hijaz', 0), 61);
  assert.equal(transformNote(64, 0, 'Hirajoshi', 0), 63);
  assert.equal(transformNote(64, 0, 'Insen', 0), 65);
});

test('Rast and Bayati expose cents instead of silently rounding quarter tones', () => {
  assert.deepEqual(SCALE_CENTS.rast, [0, 200, 350, 500, 700, 900, 1050]);
  assert.deepEqual(SCALE_CENTS.bayati, [0, 150, 300, 500, 700, 800, 1000]);
  assert.equal(requiresMicrotonalTuning('Rast'), true);
  assert.equal(requiresMicrotonalTuning('bayati'), true);
  assert.equal(requiresMicrotonalTuning('major'), false);
  assert.equal(transformNote(64, 0, 'rast', 0), 64);
  assert.equal(transformNote(62, 0, 'bayati', 12), 74);
});

test('invalid harmony arguments produce finite bounded notes with a chromatic fallback', () => {
  assert.equal(transformNote(60, 0, 'unknown', 0), 60);
  assert.equal(transformNote(NaN, Infinity, 'major', NaN), 0);
  assert.equal(transformNote(60, NaN, 'major', 0), 60);
  assert.equal(transformNote(999, 0, 'chromatic', 0), 127);
  assert.equal(transformNote(-99, 0, 'chromatic', 0), 0);
});
