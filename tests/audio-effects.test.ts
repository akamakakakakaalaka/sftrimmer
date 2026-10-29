import test from 'node:test';
import assert from 'node:assert/strict';
import { AppEffects } from '../web/src/audio-effects.ts';
import type { MasterState } from '../web/src/contracts.ts';

const settings=(overrides:Partial<MasterState>={}):MasterState=>({keyShift:0,fineTune:0,gain:1,tempo:1,root:0,mode:'chromatic',theme:'dark',delayTime:0.01,delayFeedback:0,delayMix:0,flangerMix:0,crusherBits:16,...overrides});

test('app effects bypass preserves dry stereo samples at sixteen bits',()=>{
  const effects=new AppEffects(1000);
  effects.configure(settings());
  const left=new Float32Array([0.123456,-0.23456,0,0.4]);
  const right=new Float32Array([0,-0.5,0.3,0.2]);
  const wantLeft=left.slice(),wantRight=right.slice();
  effects.process(left,right);
  assert.deepEqual(left,wantLeft);
  assert.deepEqual(right,wantRight);
});

test('delay returns the impulse at its requested sample time with independent stereo feedback',()=>{
  const effects=new AppEffects(1000);
  effects.configure(settings({delayMix:1,delayFeedback:0.5}));
  const left=new Float32Array(32),right=new Float32Array(32);
  left[0]=0.8;
  effects.process(left,right);
  assert.equal(left[9],0);
  assert.ok(Math.abs(left[10]-0.8)<1e-6);
  assert.ok(Math.abs(left[20]-0.4)<1e-6);
  assert.ok(Math.abs(left[30]-0.2)<1e-6);
  assert.equal(right.reduce((sum,value)=>sum+Math.abs(value),0),0);
});

test('explicit per-part send buffers determine delay input instead of the final dry mix',()=>{
  const effects=new AppEffects(1000);
  effects.configure(settings({delayMix:1}));
  const left=new Float32Array(24),right=new Float32Array(24);
  left[0]=0.7;
  const sendLeft=new Float32Array(24),sendRight=new Float32Array(24);
  sendRight[1]=0.4;
  effects.process(left,right,sendLeft,sendRight);
  assert.equal(left[10],0);
  assert.ok(Math.abs(right[11]-0.4)<1e-6);
  assert.equal(right[1],0);
});

test('bitcrusher quantizes to the selected signed amplitude grid',()=>{
  const effects=new AppEffects(48_000);
  effects.configure(settings({crusherBits:4}));
  const left=new Float32Array([0.2,0.31,-0.2,-0.31]);
  const right=new Float32Array([0,0,0,0]);
  effects.process(left,right);
  assert.deepEqual(Array.from(left),[0.25,0.25,-0.25,-0.25]);
});

test('reset removes delay and flanger tails and restores deterministic audition',()=>{
  const effects=new AppEffects(1000);
  effects.configure(settings({delayMix:1,delayFeedback:0.9,flangerMix:1}));
  const impulse=new Float32Array(8),right=new Float32Array(8);
  impulse[0]=0.5;
  effects.process(impulse,right);
  effects.reset();
  const silence=new Float32Array(80),other=new Float32Array(80);
  effects.process(silence,other);
  assert.equal(silence.reduce((sum,value)=>sum+Math.abs(value),0),0);
  assert.equal(other.reduce((sum,value)=>sum+Math.abs(value),0),0);
});

test('non-finite input and out-of-range settings cannot create unbounded output',()=>{
  const effects=new AppEffects(1000);
  effects.configure(settings({delayMix:20,delayFeedback:Infinity,flangerMix:10,crusherBits:NaN}));
  const left=new Float32Array([NaN,Infinity,-Infinity,20,-20]);
  const right=left.slice();
  effects.process(left,right);
  for(const value of [...left,...right]) assert.ok(Number.isFinite(value)&&Math.abs(value)<=1);
  assert.throws(()=>new AppEffects(0),/sample rate/i);
});
