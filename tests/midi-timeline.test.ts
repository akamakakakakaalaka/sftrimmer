import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidiTimeline } from '../web/src/midi-timeline.ts';

const be = (value:number, bytes:number) => Array.from({length:bytes}, (_,i) => (value >>> ((bytes-i-1)*8)) & 255);
const vlq = (value:number) => { const out=[value & 127]; while ((value >>>=7)>0) out.unshift((value & 127)|128); return out; };
const ev = (delta:number, ...message:number[]) => [...vlq(delta), ...message];
const end = (delta=0) => ev(delta,255,47,0);
const tempo = (delta:number, micros:number) => ev(delta,255,81,3,...be(micros,3));
function smf(format:number, division:number, tracks:number[][]):ArrayBuffer {
  return new Uint8Array([77,84,104,100,0,0,0,6,...be(format,2),...be(tracks.length,2),...be(division,2),
    ...tracks.flatMap(track => [77,84,114,107,...be(track.length,4),...track])]).buffer;
}

test('format 0 uses tempo changes and includes trailing end-of-track rests', () => {
  const parsed=parseMidiTimeline(smf(0,480,[[...ev(0,144,60,100),...tempo(480,1_000_000),...ev(480,128,60,0),...end(480)]]));
  assert.equal(parsed.format,0);
  assert.equal(parsed.events[0].time,0);
  assert.equal(parsed.events[1].time,1.5);
  assert.equal(parsed.duration,2.5);
});

test('format 1 merges tempo and performance tracks using stable simultaneous ordering', () => {
  const parsed=parseMidiTimeline(smf(1,480,[
    [...tempo(0,1_000_000),...end(480)],
    [...ev(0,192,10),...ev(240,144,60,100),...ev(240,128,60,0),...end()],
  ]));
  assert.deepEqual(parsed.events.map(e=>[e.time,e.message[0]]),[[0,192],[0.5,144],[1,128]]);
  assert.equal(parsed.duration,1);
});

test('running status preserves messages and track port changes route eight MIDI ports', () => {
  const parsed=parseMidiTimeline(smf(0,480,[[
    ...ev(0,255,33,1,1),...ev(0,144,60,100),...ev(0,64,90),
    ...ev(240,255,33,1,7),...ev(240,144,60,0),...end(),
  ]]));
  assert.deepEqual(parsed.events.map(e=>[e.message,e.partOffset]),[
    [[144,60,100],16],[[144,64,90],16],[[144,60,0],112],
  ]);
});

test('format 2 keeps selected patterns independent, including their own tempo maps', () => {
  const data=smf(2,480,[
    [...tempo(0,1_000_000),...ev(0,144,60,100),...ev(480,128,60,0),...end()],
    [...tempo(0,250_000),...ev(0,144,72,100),...ev(480,128,72,0),...end()],
  ]);
  const first=parseMidiTimeline(data);
  const second=parseMidiTimeline(data,1);
  assert.equal(first.sequenceCount,2);
  assert.equal(first.duration,1);
  assert.equal(second.duration,0.25);
  assert.equal(second.events[0].time,0);
  assert.equal(second.events[0].message[1],72);
  assert.throws(()=>parseMidiTimeline(data,2),/sequence/i);
});

test('SMPTE timing uses frames and ticks and ignores tempo events', () => {
  const parsed=parseMidiTimeline(smf(0,(231<<8)|40,[[
    ...tempo(0,2_000_000),...ev(0,144,60,100),...ev(1000,128,60,0),...end(),
  ]]));
  assert.equal(parsed.events[1].time,1);
  assert.equal(parsed.duration,1);
  const drop=parseMidiTimeline(smf(0,(227<<8)|100,[[...ev(3000,144,60,100),...end()]]));
  assert.ok(Math.abs(drop.duration-1.001)<1e-9);
});

test('complete and split SysEx preserve full messages without variable-length byte leakage', () => {
  const parsed=parseMidiTimeline(smf(0,480,[[
    ...ev(0,240,4,126,127,9,247),
    ...ev(0,240,2,67,16),...ev(120,247,3,76,0,247),...end(),
  ]]));
  assert.deepEqual(parsed.events.map(e=>e.message),[[240,126,127,9,247],[240,67,16,76,0,247]]);
  assert.equal(parsed.events[1].time,0.125);
});

test('long split SysEx does not depend on the JavaScript function argument limit', () => {
  const body = new Array<number>(180_000).fill(1);
  const track = [...ev(0,240,2,67,16),0,247,...vlq(body.length+1),...body,247,...end()];
  const parsed = parseMidiTimeline(smf(0,480,[track]));
  assert.equal(parsed.events[0].message.length,180_004);
  assert.deepEqual(parsed.events[0].message.slice(-3),[1,1,247]);
});

test('malformed headers, divisions, event lengths and unsupported ports fail explicitly', () => {
  assert.throws(()=>parseMidiTimeline(new ArrayBuffer(0)),/header|truncated/i);
  assert.throws(()=>parseMidiTimeline(smf(0,0,[[...end()]])),/division/i);
  assert.throws(()=>parseMidiTimeline(smf(0,480,[[...ev(0,144,60)]])),/truncated|data/i);
  assert.throws(()=>parseMidiTimeline(smf(0,480,[[...ev(0,255,33,1,8),...end()]])),/port/i);
  assert.throws(()=>parseMidiTimeline(smf(3,480,[[...end()]])),/format/i);
});
