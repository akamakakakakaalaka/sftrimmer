import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProgramPortamentoSetting } from '../web/src/contracts.ts';
import { getProgramPortamento } from '../web/src/performance.ts';
import { applyPreset, createPreset, createState, loadState, restoreState, saveState } from '../web/src/state.ts';

const setting=(patch:Partial<ProgramPortamentoSetting>={}):ProgramPortamentoSetting=>({bankId:'sha256:font-A',msb:0,lsb:0,program:0,drums:false,portamento:true,portamentoTime:97,...patch});

test('program portamento defaults are optional, independent, and matched to the complete concrete font tuple',()=>{
  const state=createState(),other=createState();assert.equal(state.programPortamento?.length,0);
  state.programPortamento!.push(setting());assert.deepEqual(other.programPortamento,[]);
  const part={...state.parts[0],bankId:'sha256:font-A'};
  assert.deepEqual(getProgramPortamento(state,part),{portamento:true,portamentoTime:97});
  for(const patch of [{bankId:'sha256:font-B'},{msb:1},{lsb:1},{program:1},{drums:true},{bankId:null}]){
    assert.deepEqual(getProgramPortamento(state,{...part,...patch}),{portamento:false,portamentoTime:0});
  }
  const copied=getProgramPortamento(state,part);copied.portamentoTime=2;assert.equal(state.programPortamento![0].portamentoTime,97);
  assert.deepEqual(restoreState({version:1}).programPortamento,[],'old sessions need no migration');
});

test('program settings reject invalid addresses and switches, clamp finite times, and deduplicate complete tuples',()=>{
  const valid=setting();
  const bad=[null,[],{},setting({bankId:''}),setting({bankId:'x'.repeat(257)}),
    {...valid,bankId:null},setting({msb:-1}),setting({msb:128}),setting({lsb:0.5}),setting({program:NaN}),
    {...valid,msb:'0'},{...valid,drums:0},{...valid,portamento:'true'},setting({portamentoTime:Infinity}),{...valid,portamentoTime:'80'}];
  const input={version:1,programPortamento:[...bad,valid,setting({portamentoTime:3}),
    setting({bankId:'font-B',portamentoTime:999}),setting({msb:1,portamentoTime:-9}),setting({lsb:1,portamentoTime:12.7}),
    setting({program:1}),setting({drums:true})]};
  const restored=restoreState(input).programPortamento!;
  assert.equal(restored.length,6);assert.deepEqual(restored[0],valid,'first valid occurrence wins');
  assert.equal(restored[1].portamentoTime,127);assert.equal(restored[2].portamentoTime,0);assert.equal(restored[3].portamentoTime,13);
  for(const raw of [undefined,null,{},'font-A'])assert.deepEqual(restoreState({version:1,programPortamento:raw}).programPortamento,[]);
});

test('program settings retain at most the first 8192 unique valid tuples',()=>{
  const settings=Array.from({length:8194},(_,index)=>setting({msb:Math.floor(index/128),program:index%128}));
  const restored=restoreState({version:1,programPortamento:settings}).programPortamento!;
  assert.equal(restored.length,8192);assert.deepEqual(restored[8191],settings[8191]);
  restored[0].portamentoTime=2;assert.equal(settings[0].portamentoTime,97);
});

test('session persistence owns program defaults while individual app presets retain only their performance snapshot',()=>{
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)} as unknown as Storage;
  const state=createState();state.parts[0].bankId='sha256:font-A';
  Object.assign(state.parts[0].performance!,{portamento:false,portamentoTime:18});state.programPortamento=[setting()];
  saveState(state,storage);const restored=loadState(storage);assert.deepEqual(restored.programPortamento,state.programPortamento);
  const preset=createPreset(restored,'Short glide snapshot');
  assert.equal('programPortamento' in preset,false);assert.equal('programPortamento' in preset.part,false);
  assert.equal(preset.part.performance!.portamentoTime,18);
  const applied=applyPreset(restored,preset,127);applied.programPortamento![0].portamentoTime=3;
  assert.equal(restored.programPortamento![0].portamentoTime,97);assert.equal(state.programPortamento[0].portamentoTime,97);
  assert.equal(applied.parts[127].performance!.portamentoTime,18);
});
