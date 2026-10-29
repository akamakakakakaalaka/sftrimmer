import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerformanceControls, getPerformanceControls, normalizePerformanceControls } from '../web/src/performance.ts';
import { createState, createPreset, parsePreset, applyPreset, restoreState } from '../web/src/state.ts';

test('performance defaults are independent and preserve version-1 sessions and presets',()=>{
  const state=createState(),defaults=createPerformanceControls();
  assert.deepEqual(state.parts[0].performance,defaults);
  state.parts[0].performance!.expression=31;assert.equal(state.parts[1].performance!.expression,127);
  const legacy=createPreset(state,'Legacy');delete legacy.part.performance;
  const imported=parsePreset(JSON.stringify(legacy));assert.deepEqual(imported.part.performance,defaults);
  assert.deepEqual(restoreState({version:1,parts:[{id:0}]}).parts[0].performance,defaults);
  const value=getPerformanceControls(state.parts[0]);value.expression=3;assert.equal(state.parts[0].performance!.expression,31);
});

test('performance import bounds finite values and validates preset control records strictly',()=>{
  const value=normalizePerformanceControls({expression:999,lowKey:80,highKey:12,pitchBend:-2,bendRange:999,fineTune:-101,modulation:NaN,
    vibratoRate:1.2,portamento:'yes',mono:true,release:Infinity});
  assert.equal(value.expression,127);assert.equal(value.lowKey,80);assert.equal(value.highKey,80);
  assert.equal(value.pitchBend,0);assert.equal(value.bendRange,24);assert.equal(value.fineTune,-100);
  assert.equal(value.modulation,0);assert.equal(value.vibratoRate,1);assert.equal(value.portamento,false);assert.equal(value.mono,true);assert.equal(value.release,64);
  const preset=createPreset(createState(),'Controls');preset.part.performance!.expression=999;
  assert.throws(()=>parsePreset(JSON.stringify(preset)),/invalid/i);
});

test('performance snapshots and MIDI mapped presets deep-clone every controller',()=>{
  const state=createState();state.parts[0].performance!.fineTune=42.5;state.parts[0].performance!.hold=true;
  const preset=createPreset(state,'Tuned hold');state.presetMappings=[{partId:2,msb:0,lsb:0,program:7,preset}];
  const restored=restoreState(state),applied=applyPreset(restored,preset,3);
  applied.parts[3].performance!.fineTune=-99;applied.presetMappings![0].preset.part.performance!.hold=false;
  assert.equal(preset.part.performance!.fineTune,42.5);assert.equal(restored.presetMappings![0].preset.part.performance!.hold,true);
  assert.equal(state.parts[0].performance!.hold,true);
});

test('master balance and wet returns survive state recovery and clamp their ranges',()=>{
  assert.equal(createState().master.balance,0);
  assert.equal(createState().master.reverbGain,1);assert.equal(createState().master.chorusGain,1);
  assert.equal(restoreState({version:1,master:{balance:-9}}).master.balance,-1);
  assert.equal(restoreState({version:1,master:{balance:9}}).master.balance,1);
  assert.equal(restoreState({version:1,master:{balance:NaN}}).master.balance,0);
  const restored=restoreState({version:1,master:{reverbGain:-9,chorusGain:9}});
  assert.equal(restored.master.reverbGain,0);assert.equal(restored.master.chorusGain,2);
});
