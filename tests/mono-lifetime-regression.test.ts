import assert from 'node:assert/strict';
import test from 'node:test';
import { BasicSoundBank, GeneratorTypes, SoundBankLoader } from 'spessasynth_core';
import { OfflineEngine } from '../web/src/offline.ts';
import { createState } from '../web/src/state.ts';

function fixture():ArrayBuffer {
  const bank=SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  for(const sample of bank.samples){
    sample.setAudioData(Float32Array.from({length:4096},(_,i)=>0.3*Math.sin(i*Math.PI/64)),48000);
    sample.loopStart=0;sample.loopEnd=4096;sample.originalKey=60;
  }
  for(const instrument of bank.instruments)instrument.globalZone.setGenerator(GeneratorTypes.sampleModes,1);
  return bank.writeSF2();
}

async function setup(){
  const state=createState();state.master.mode='major';
  for(const part of state.parts){part.bankId='A';part.drums=false;part.reverb=0;part.chorus=0;part.locked=false;
    Object.assign(part.envelope,{enabled:true,attack:0,decay:0,sustain:1,release:0.002});}
  state.parts[0].performance!.mono=true;
  const engine=new OfflineEngine(48000,state);await engine.loadBank(fixture(),'A','A');engine.core.setSystemParameter('effectsEnabled',false);
  return {state,engine};
}

const peak=(pcm:Float32Array)=>pcm.reduce((maximum,value)=>Math.max(maximum,Math.abs(value)),0);

test('mono restores the remaining exact snapped group when an inactive duplicate is released before the foreground note',async()=>{
  for(const repeated of [false,true]){
    const {engine}=await setup();const duplicate=repeated?60:61;
    engine.noteOn(0,60,110);engine.noteOn(0,duplicate,60);engine.noteOn(0,64);engine.render(4096);
    engine.noteOff(0,duplicate);engine.noteOff(0,64);
    assert.deepEqual(engine.getHeldNotes()[0],[60]);
    assert.ok(peak(engine.render(12000)[0].slice(-4096))>0.005,'remaining physical key must have a sounding restored voice');
    engine.noteOff(0,60);assert.ok(peak(engine.render(24000)[0].slice(-4096))<1e-5,'restored exact group must release');
  }
});

test('mono restores another held snapped group when its restored foreground duplicate is released',async()=>{
  const {engine}=await setup();
  engine.noteOn(0,60,110);engine.noteOn(0,61,60);engine.noteOn(0,64);engine.render(4096);
  engine.noteOff(0,64);engine.render(2048);engine.noteOff(0,61);
  assert.deepEqual(engine.getHeldNotes()[0],[60]);
  assert.ok(peak(engine.render(12000)[0].slice(-4096))>0.005);
  engine.noteOff(0,60);assert.ok(peak(engine.render(24000)[0].slice(-4096))<1e-5);
});

test('mute and solo transitions discard captured voice lifetimes before the core resets pitch IDs',async()=>{
  for(const solo of [false,true]){
    const {state,engine}=await setup();state.parts[0].performance!.mono=false;engine.applyPart(state.parts[0],['performance.mono']);
    engine.noteOn(0,60);engine.sendMIDI([0xb0,66,127]);
    const part=state.parts[solo?1:0];if(solo)part.solo=true;else part.mute=true;
    engine.applyPart(part,[solo?'solo':'mute']);engine.noteOff(0,60);
    if(solo)part.solo=false;else part.mute=false;engine.applyPart(part,[solo?'solo':'mute']);
    engine.noteOn(0,60);engine.noteOff(0,60);
    assert.deepEqual(engine.getHeldNotes()[0],[]);
    assert.ok(peak(engine.render(24000)[0].slice(-4096))<1e-5,`${solo?'solo-induced':'manual'} mute cannot transfer selective hold to a later voice`);
  }
});
