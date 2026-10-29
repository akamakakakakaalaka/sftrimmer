import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicSoundBank, SoundBankLoader, SpessaLog, GeneratorTypes } from 'spessasynth_core';
import { OfflineEngine } from '../web/src/offline.ts';
import type { AppState, SavedPreset } from '../web/src/contracts.ts';
import { convertToSF3 } from '../web/src/compression.ts';

SpessaLog.setLogLevel(false, false, false);
function state(): AppState {
  return {version:1, selectedPart:0, master:{keyShift:0,fineTune:0,gain:0.7,tempo:1,root:0,mode:'chromatic',theme:'dark',delayTime:0.2,delayFeedback:0.3,delayMix:0,flangerMix:0,crusherBits:16},parts:Array.from({length:128},(_,id)=>({id,bankId:null,msb:0,lsb:0,program:0,drums:false,volume:100,pan:64,reverb:0,chorus:0,delay:0,mute:false,solo:false,transpose:0,envelope:{attack:0.001,decay:0.1,sustain:1,release:0.03,enabled:true},drumMap:{},locked:true}))};
}
function fixture(period:number): ArrayBuffer {
  const bank = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  const pcm = Float32Array.from({length:4096},(_,i)=>0.4*Math.sin(i*2*Math.PI/period));
  for(const sample of bank.samples){ sample.name='Identical sample name';sample.setAudioData(pcm.slice(),48000);sample.loopStart=0;sample.loopEnd=4096;sample.originalKey=60; }
  // Keep two equal-address samples/layers. Isolation must not depend on sample names.
  bank.presets[0].name='Identical preset name';
  for(const instrument of bank.instruments) instrument.globalZone.setGenerator(GeneratorTypes.sampleModes,1);
  return bank.writeSF2();
}
function crossings(pcm:Float32Array){let n=0;for(let i=1025;i<pcm.length;i++)if(pcm[i-1]<=0&&pcm[i]>0)n++;return n;}
function peak(pcm:Float32Array){return pcm.reduce((p,v)=>Math.max(p,Math.abs(v)),0);}
function longNoteMidi():ArrayBuffer {
  const track=[0,0x90,60,100,0x83,0x60,0x80,60,0,0,0xff,0x2f,0];
  return Uint8Array.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,track.length,...track]).buffer;
}

test('equal MIDI addresses and sample names remain isolated in actual stereo PCM',async()=>{
  const s=state(); const engine=new OfflineEngine(48000,s);
  await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');
  s.parts[0].bankId='A';s.parts[0].pan=0;s.parts[1].bankId='B';s.parts[1].pan=127;
  engine.applyState(s);engine.noteOn(0,60);engine.noteOn(1,60);
  const [left,right]=engine.render(8192);
  assert.ok(peak(left)>0.01&&peak(right)>0.01,'both independently routed banks must produce audio');
  assert.ok(crossings(left)>crossings(right)*1.8,'bank A must retain its higher sample frequency while B plays');
  engine.panic();s.parts[0].bankId='B';engine.applyPart(s.parts[0]);engine.noteOn(0,60);
  const [switched]=engine.render(8192);assert.ok(crossings(switched)<crossings(left)*0.6,'A→B must invalidate concrete preset identity');
  engine.panic();s.parts[0].bankId='A';engine.applyPart(s.parts[0]);engine.noteOn(0,60);
  const [back]=engine.render(8192);assert.ok(crossings(back)>crossings(switched)*1.8,'B→A restores the correct sample');
});

test('replacing a bank ID starts new voices from the new generation',async()=>{
  const s=state();const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','same');
  s.parts[0].bankId='same';engine.applyState(s);engine.noteOn(0,60);const [a]=engine.render(8192);
  engine.panic();await engine.loadBank(fixture(128),'B','same');engine.noteOn(0,60);const [b]=engine.render(8192);
  assert.ok(crossings(a)>crossings(b)*1.8);
  engine.removeBank('same');engine.noteOn(0,60);engine.panic();const [silent]=engine.render(8192);assert.equal(peak(silent),0);
});

test('note-off follows the original transformed note after the scale changes',async()=>{
  const s=state();const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');
  s.parts[0].bankId='A';s.master.mode='major';engine.applyState(s);engine.noteOn(0,61);
  assert.ok(peak(engine.render(2048)[0])>0.01);
  s.master.mode='naturalMinor';engine.applyState(s);engine.noteOff(0,61);
  const [tail]=engine.render(24000);assert.ok(peak(tail.slice(-4096))<1e-5,'no stuck transformed note');
});

test('MIDI reset preserves app tuning and concrete bank selection',async()=>{
  const s=state();s.master.keyShift=3;s.master.fineTune=37;
  const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');s.parts[0].bankId='A';engine.applyState(s);
  engine.sendMIDI([0xf0,0x7e,0x7f,0x09,0x01,0xf7]);
  assert.equal(engine.core.systemParameters.keyShift,3);assert.equal(engine.core.systemParameters.fineTune,37);
  engine.noteOn(0,60);assert.ok(peak(engine.render(4096)[0])>0.01);
});

test('envelope editing and solo never mutate a neighboring part',async()=>{
  const s=state();const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');
  for(const id of [0,1])s.parts[id].bankId='A';s.parts[0].pan=0;s.parts[1].pan=127;
  s.parts[0].envelope.sustain=0.1;s.parts[1].envelope.sustain=1;s.parts[0].envelope.decay=0.001;
  engine.applyState(s);engine.noteOn(0,60);engine.noteOn(1,60);const [l,r]=engine.render(8192);
  assert.ok(peak(l.slice(4096))<peak(r.slice(4096))*0.2);
  engine.panic();s.parts[1].solo=true;engine.applyState(s);engine.noteOn(0,60);assert.equal(peak(engine.render(2048)[0]),0);
});

test('native MIDI packets retain running status across packets and ignore interleaved clocks',async()=>{
  const s=state();const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');s.parts[0].bankId='A';engine.applyState(s);
  engine.sendMIDI([0x90,60,100,0xf8,64]);engine.sendMIDI([100]);
  assert.ok(peak(engine.render(2048)[0])>0.01);
  engine.sendMIDI([0xb0,64,127,0x80,60,0,64,0]);
  assert.ok(peak(engine.render(4096)[0])>0.01,'sustain holds both mapped voice groups');
  engine.sendMIDI([0xb0,64,0]);
  assert.ok(peak(engine.render(24000)[0].slice(-4096))<1e-5,'both note offs survive packet framing and release after pedal up');
});

test('colliding scale notes release their exact voice group in reverse order',async()=>{
  const s=state();s.master.mode='major';const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');s.parts[0].bankId='A';engine.applyState(s);
  const reference=new OfflineEngine(48000,s);await reference.loadBank(fixture(64),'A','A');reference.noteOn(0,60,110);reference.render(2048);
  engine.noteOn(0,60,110);engine.noteOn(0,61,20);engine.render(2048);
  engine.noteOff(0,61);const loud=engine.render(6000)[0].slice(-2048),expected=reference.render(6000)[0].slice(-2048);
  assert.ok(peak(expected)>0.005);
  assert.ok(loud.every((v,i)=>Math.abs(v-expected[i])<1e-5),'releasing the quiet snapped note leaves the original loud note PCM intact');
  engine.noteOff(0,60);assert.ok(peak(engine.render(12000)[0].slice(-2048))<1e-5);
});

test('pause and seek restore MIDI notes spanning the transport position',async()=>{
  const s=state();s.parts[0].bankId='A';const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');
  engine.loadMidi(longNoteMidi());engine.play();assert.ok(peak(engine.render(4800)[0])>0.01);
  engine.pause();assert.equal(peak(engine.render(2048)[0]),0);assert.ok(Math.abs(engine.position().current-0.1)<1e-8);
  engine.play();assert.ok(peak(engine.render(4800)[0])>0.005,'resume retriggers the held MIDI note');
  engine.pause();engine.seek(0.3);engine.play();assert.ok(peak(engine.render(4800)[0])>0.005,'seeking restores a spanning note');
  const rest=engine.render(24000)[0];assert.ok(peak(rest.slice(-4096))<1e-5);assert.equal(engine.position().playing,false);
});

test('MIDI resets discard stale transformed note IDs before subsequent note lifetimes',async()=>{
  const s=state();const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');s.parts[0].bankId='A';engine.applyState(s);
  engine.noteOn(0,60);engine.render(1024);engine.sendMIDI([0xf0,0x7e,0x7f,0x09,0x01,0xf7]);
  engine.noteOn(0,60);engine.noteOff(0,60);engine.render(6000);
  engine.noteOn(0,60);engine.render(1024);engine.noteOff(0,60);
  assert.ok(peak(engine.render(18000)[0].slice(-4096))<1e-5);
});

test('reloading a bank retains existing voice sample data while new notes use its new generation',async()=>{
  const s=state();s.parts[0].bankId='A';
  const engine=new OfflineEngine(48000,s),reference=new OfflineEngine(48000,s),data=fixture(64);
  await engine.loadBank(data,'A','A');await reference.loadBank(data,'A','A');
  engine.noteOn(0,60);reference.noteOn(0,60);engine.render(4096);reference.render(4096);
  await engine.loadBank(fixture(128),'Replacement','A');
  const actual=engine.render(4096)[0],expected=reference.render(4096)[0];
  assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<1e-6),'a held note retains its old immutable sample generation');
  engine.noteOff(0,60);engine.render(12000);engine.noteOn(0,60);
  assert.ok(crossings(engine.render(8192)[0])<70,'new notes use the lower-frequency replacement sample');
});

test('SF2 SF3 and DLS at identical addresses keep independent decoded sample identities',async()=>{
  const s=state();const engine=new OfflineEngine(48000,s);
  const a=await engine.loadBank(fixture(64),'SF2','sf2');
  const b=await engine.loadBank(await convertToSF3(fixture(128),0.7),'SF3','sf3');
  const c=await engine.loadBank(SoundBankLoader.fromArrayBuffer(fixture(256)).writeDLS(),'DLS','dls');
  assert.deepEqual([a.format,b.format,c.format],['SF2','SF3','DLS']);
  const counts:number[]=[];
  for(const bankId of ['sf2','sf3','dls']){engine.panic();s.parts[0].bankId=bankId;engine.applyPart(s.parts[0]);engine.noteOn(0,60);const pcm=engine.render(8192)[0];assert.ok(peak(pcm)>0.005);counts.push(crossings(pcm));}
  assert.ok(counts[0]>counts[1]*1.7&&counts[1]>counts[2]*1.7,`distinct decoded source frequencies: ${counts.join(', ')}`);
});

test('XG drum bank selection returns to melodic mode when bank MSB returns to zero',async()=>{
  const s=state();s.parts[0].bankId='A';s.parts[0].locked=false;const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');
  engine.sendMIDI([0xf0,0x43,0x10,0x4c,0,0,0x7e,0,0xf7]);
  engine.sendMIDI([0xb0,0,127,0xc0,0]);assert.equal(engine.core.midiChannels[0].drumChannel,true);
  engine.sendMIDI([0xb0,0,0,0xc0,0]);assert.equal(engine.core.midiChannels[0].drumChannel,false);
});

test('All Notes Off respects the sustain pedal while All Sound Off kills audio immediately',async()=>{
  const s=state();s.parts[0].bankId='A';const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');
  engine.sendMIDI([0x90,60,100,0xb0,64,127,123,0]);assert.ok(peak(engine.render(24000)[0].slice(-4096))>0.005);
  engine.sendMIDI([0xb0,64,0]);assert.ok(peak(engine.render(12000)[0].slice(-4096))<1e-5);
  engine.sendMIDI([0x90,60,100,0xb0,64,127,120,0]);assert.equal(peak(engine.render(2048)[0]),0);
});

test('a MIDI system reset resets unlocked song patches while retaining app master overrides',async()=>{
  const s=state();s.parts[0].bankId='A';s.parts[0].locked=false;s.master.fineTune=23;
  const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');engine.sendMIDI([0xc0,5]);
  assert.equal(engine.core.midiChannels[0].patch.program,5);engine.sendMIDI([0xf0,0x7e,0x7f,9,1,0xf7]);
  assert.equal(engine.core.midiChannels[0].patch.program,0);assert.equal(engine.core.systemParameters.fineTune,23);
});

test('automatic MIDI completion releases file notes without cutting a held live keyboard part',async()=>{
  const s=state();s.parts[0].bankId='A';s.parts[0].pan=0;s.parts[1].bankId='A';s.parts[1].pan=127;
  const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');engine.loadMidi(longNoteMidi());
  engine.noteOn(1,60);engine.play();const [file,live]=engine.render(36000);
  assert.ok(peak(file.slice(-4096))<1e-5);assert.ok(peak(live.slice(-4096))>0.005,'live voice survives end-of-file');
  engine.noteOff(1,60);assert.ok(peak(engine.render(12000)[1].slice(-4096))<1e-5);
});

test('changing master tuning preserves unlocked MIDI effect automation until the part send is edited',async()=>{
  const s=state();s.parts[0].bankId='A';s.parts[0].locked=false;const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');
  engine.sendMIDI([0xb0,91,100]);assert.equal(engine.core.midiChannels[0].midiControllers[91]>>7,100);
  s.master.fineTune=17;engine.applyState(s);assert.equal(engine.core.midiChannels[0].midiControllers[91]>>7,100);
  s.parts[0].reverb=64;engine.applyPart(s.parts[0]);assert.equal(engine.core.midiChannels[0].midiControllers[91]>>7,64);
});

function mappedState():AppState {
  const s=state();s.parts[0].bankId='A';s.parts[0].locked=false;s.parts[0].pan=0;s.parts[1].bankId='A';s.parts[1].pan=127;
  const part={...s.parts[0],id:73,bankId:'B',volume:73,reverb:71,chorus:22,delay:89,envelope:{attack:0.002,decay:0.005,sustain:0.25,release:0.08,enabled:true},drumMap:{60:64},locked:true};
  const preset:SavedPreset={version:1,id:'custom-B',name:'Custom B',bankId:'B',part};
  s.presetMappings=[{partId:0,msb:7,lsb:9,program:11,preset}];return s;
}

test('exact MIDI addresses recall an individual app preset into only the receiving part',async()=>{
  const s=mappedState(),engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');
  engine.core.setSystemParameter('effectsEnabled',false);
  engine.sendMIDI([0xb0,0,7,32,9,0xc0,11]);engine.noteOn(0,60);engine.noteOn(1,60);const [mapped,untouched]=engine.render(8192);
  assert.ok(crossings(untouched)>crossings(mapped)*1.7,'mapped bank B is audible independently from neighboring bank A');
  assert.equal(engine.core.midiChannels[0].systemParameters.gain,0.73);assert.equal(engine.core.midiChannels[1].systemParameters.gain,1);
  assert.equal(engine.core.midiChannels[0].midiControllers[91]>>7,71);assert.equal(engine.core.midiChannels[0].midiControllers[93]>>7,22);
  const referenceState=state();referenceState.parts[0].bankId='B';referenceState.parts[0].pan=0;
  const reference=new OfflineEngine(48000,referenceState);await reference.loadBank(fixture(128),'B','B');reference.core.setSystemParameter('effectsEnabled',false);reference.noteOn(0,60);
  assert.ok(peak(mapped.slice(-4096))<peak(reference.render(8192)[0].slice(-4096))*0.3,'absolute preset sustain and gain reach the actual renderer');
  assert.equal(engine.core.midiChannels[0].patch.bankMSB,0,'incoming map MSB does not overwrite saved font MSB');
  assert.equal(engine.core.midiChannels[0].patch.bankLSB,0);assert.equal(engine.core.midiChannels[0].patch.program,0);
  engine.panic();engine.noteOn(73,60);assert.equal(peak(engine.render(2048)[0]),0,'original snapshot part ID is ignored');
});

test('mapped app settings persist through master changes and merge explicit envelope edits by field',async()=>{
  const s=mappedState(),engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');engine.sendMIDI([0xb0,0,7,32,9,0xc0,11]);
  engine.core.setSystemParameter('effectsEnabled',false);
  s.master.fineTune=17;s.master.gain=0.6;engine.applyState(s);
  assert.equal(engine.core.midiChannels[0].systemParameters.gain,0.73);assert.equal(engine.core.midiChannels[0].midiControllers[91]>>7,71);
  s.parts[0].envelope.attack=0.003;engine.applyState(s);engine.noteOn(0,60);engine.noteOn(1,60);const [mapped,plain]=engine.render(8192);
  assert.ok(crossings(plain)>crossings(mapped)*1.7);assert.ok(peak(mapped.slice(-4096))<peak(plain.slice(-4096))*0.3,'editing attack retains mapped sustain');
  assert.equal(s.presetMappings![0].preset.part.envelope.attack,0.002,'recall/edits never mutate the saved snapshot');
});

test('mapping namespace retains incoming bank latches and unmapped PCs use the effective soundbank',async()=>{
  const s=mappedState();const other=JSON.parse(JSON.stringify(s.presetMappings![0]));other.program=12;other.preset.part.volume=62;s.presetMappings!.push(other);
  const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');
  engine.sendMIDI([0xb0,0,7,32,9,0xc0,11,12]);assert.equal(engine.core.midiChannels[0].systemParameters.gain,0.62,'second map uses original incoming 7/9 latches');
  engine.sendMIDI([0xc0,13]);assert.equal(engine.core.midiChannels[0].patch.program,13);assert.equal(engine.core.midiChannels[0].patch.bankMSB,7);assert.equal(engine.core.midiChannels[0].patch.bankLSB,9);
  engine.noteOn(0,60);const rendered=engine.render(8192)[0];assert.ok(crossings(rendered)<70,'ordinary font fallback remains within mapped bank B');
  engine.panic();engine.sendMIDI([0xc0,11]);assert.equal(engine.core.midiChannels[0].patch.program,0,'repeat recall restores font patch after an unmapped PC');assert.equal(engine.core.midiChannels[0].patch.bankMSB,0);assert.equal(engine.core.midiChannels[0].patch.bankLSB,0);
});

test('explicit full-part UI intent restores its displayed bank and envelope after MIDI app-preset recall',async()=>{
  const s=mappedState(),engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');engine.core.setSystemParameter('effectsEnabled',false);
  engine.sendMIDI([0xb0,0,7,32,9,0xc0,11]);engine.noteOn(0,60);const mapped=engine.render(8192)[0];engine.panic();
  engine.applyPart(s.parts[0]);engine.noteOn(0,60);const manual=engine.render(8192)[0];
  assert.ok(crossings(manual)>crossings(mapped)*1.7,'explicit bank A choice wins even when it equals the saved UI baseline');
  assert.equal(engine.core.midiChannels[0].systemParameters.gain,1);assert.equal(engine.core.midiChannels[0].midiControllers[91]>>7,0);
  assert.ok(peak(manual.slice(-4096))>peak(mapped.slice(-4096))*2,'displayed sustain and volume replace recalled values');
});

test('MIDI-file program events select app presets and missing mapped banks report without stealing another bank',async()=>{
  const s=mappedState(),engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');
  engine.core.setSystemParameter('effectsEnabled',false);
  const track=[0,0xb0,0,7,0,0xb0,32,9,0,0xc0,11,0,0x90,60,100,0x83,0x60,0x80,60,0,0,0xff,0x2f,0];
  const midi=Uint8Array.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,track.length,...track]).buffer;
  engine.loadMidi(midi);engine.play();assert.ok(crossings(engine.render(8192)[0])<70);engine.stop();
  const warnings:string[]=[];engine.onWarning=warning=>warnings.push(warning);s.presetMappings![0].preset.bankId='missing';s.presetMappings![0].preset.part.bankId='missing';engine.applyState(s);
  engine.sendMIDI([0xb0,0,7,32,9,0xc0,11]);engine.noteOn(0,60);assert.equal(peak(engine.render(2048)[0]),0);assert.ok(warnings.some(w=>w.includes('missing')));
});

test('mapped drum notes use saved key maps and note-off survives another preset recall',async()=>{
  const s=mappedState(),saved=s.presetMappings![0].preset.part;saved.drums=true;saved.envelope.release=0.02;
  const next=JSON.parse(JSON.stringify(s.presetMappings![0]));next.program=12;next.preset.part.drumMap={60:72};s.presetMappings!.push(next);
  const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');engine.core.setSystemParameter('effectsEnabled',false);
  engine.core.setSystemParameter('eventsEnabled',true);const notes:number[]=[];engine.core.onEventCall=event=>{if(event.type==='noteOn')notes.push(event.data.midiNote);};
  engine.sendMIDI([0xb0,0,7,32,9,0xc0,11]);engine.noteOn(0,60);assert.ok(peak(engine.render(4096)[0])>0.001);assert.deepEqual(notes,[64]);
  engine.sendMIDI([0xc0,12]);engine.noteOff(0,60);assert.ok(peak(engine.render(18000)[0].slice(-4096))<1e-5,'the original remapped note releases after changing app presets');
});

test('mapped per-preset delay sends feed the actual shared delay bus',async()=>{
  const s=mappedState();s.master.delayMix=1;s.master.delayTime=0.1;s.master.delayFeedback=0;
  const saved=s.presetMappings![0].preset.part;Object.assign(saved,{delay:127,reverb:0,chorus:0,volume:100});Object.assign(saved.envelope,{attack:0,decay:0,sustain:1,release:0.001});
  const engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');engine.core.setSystemParameter('effectsEnabled',false);
  engine.sendMIDI([0xb0,0,7,32,9,0xc0,11]);engine.noteOn(0,60);engine.render(480);engine.noteOff(0,60);const echo=engine.render(9600)[0];
  assert.ok(peak(echo.slice(2000,3500))<1e-5,'dry release ends before the delayed return');
  assert.ok(peak(echo.slice(4300,6200))>0.001,'saved delay127 overrides baseline delay0 in actual rendered PCM');
});

test('explicit field edits preserve mapped bank and sustain while accepting values equal to the UI baseline',async()=>{
  const s=mappedState(),engine=new OfflineEngine(48000,s);await engine.loadBank(fixture(64),'A','A');await engine.loadBank(fixture(128),'B','B');engine.core.setSystemParameter('effectsEnabled',false);
  engine.sendMIDI([0xb0,0,7,32,9,0xc0,11]);
  engine.applyPart(s.parts[0],['volume']);engine.applyPart(s.parts[0],['envelope.attack']);
  assert.equal(engine.core.midiChannels[0].systemParameters.gain,1,'explicit volume100 applies even though baseline was already100');
  const expectedState=state();expectedState.parts[0]={...s.presetMappings![0].preset.part,id:0,locked:false,volume:100,envelope:{...s.presetMappings![0].preset.part.envelope,attack:0.001}};
  const reference=new OfflineEngine(48000,expectedState);await reference.loadBank(fixture(128),'B','B');reference.core.setSystemParameter('effectsEnabled',false);
  engine.noteOn(0,60);reference.noteOn(0,60);const mapped=engine.render(8192)[0],expected=reference.render(8192)[0];
  assert.ok(mapped.every((v,i)=>Math.abs(v-expected[i])<1e-6),'volume/attack edits retain actual bank B PCM and mapped sustain');
  engine.panic();engine.applyPart(s.parts[0],['bankId','msb','lsb','program','drums']);engine.noteOn(0,60);const manual=engine.render(8192)[0];
  assert.ok(crossings(manual)>crossings(mapped)*1.7,'explicit bank binding fields return to bank A');
  assert.throws(()=>engine.applyPart(s.parts[0],['id']),/field/i,'only declared control paths may be edited');
});
