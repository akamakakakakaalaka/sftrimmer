import { SoundBankLoader, SpessaSynthProcessor, SpessaLog, GeneratorTypes, type BasicSoundBank, type MIDIChannel, type SynthesizerPatch } from 'spessasynth_core';
import type { AppState, BankInfo, PartState, PlayerPosition, Envelope, PerformanceControls } from './contracts.ts';
import { createState } from './state.ts';
import { getPerformanceControls, getProgramPortamento, PERFORMANCE_KEYS } from './performance.ts';
import { transformNote } from './harmony.ts';
import { parseMidiTimeline, type MidiTimeline, type TimedMidiEvent } from './midi-timeline.ts';
import { AppEffects } from './audio-effects.ts';
import { MidiStreamDecoder } from './midi-stream.ts';

const QUANTUM = 128;
const clamp = (n:number,lo:number,hi:number) => Math.max(lo,Math.min(hi,Number.isFinite(n)?n:lo));
interface Selection { msb:number;lsb:number;program:number;drums:boolean }
interface BankEntry { bank:BasicSoundBank;info:BankInfo;generation:number }
interface HeldNote { output:number; noteID:number; ignored?:boolean; source?:string }
interface RestoredNote {part:number;note:number;velocity:number;released:boolean;sostenuto?:boolean}
interface VoiceBridge { modulatedGenerators:Int16Array; startTime:number; vibLfoStartTime:number; channel:number; midiNote:number; noteID:number; isActive:boolean; isInRelease:boolean; isHeld:boolean }
interface ChannelBridge {
  noteOn(note:number,velocity:number,emit?:boolean):void;
  noteOff(note:number):void;
  noteOnID:Uint32Array;
  noteOffID:Uint32Array;
  setDrumFlag(drums:boolean):void;
  computeModulators(voice:VoiceBridge,sourceUsesCC?:number,sourceIndex?:number):void;
  playingNotes:boolean[];
  lastMonoNote:number;
  lastMonoVelocity:number;
  killNote(note:number,releaseTime?:number):void;
}
interface CacheBridge {
  getCachedVoice(preset:object,note:number,velocity:number):unknown;
  setCachedVoice(preset:object,note:number,velocity:number,voices:unknown):void;
}
const clonePart=(part:PartState):PartState=>({...part,envelope:{...part.envelope},drumMap:{...part.drumMap},performance:getPerformanceControls(part)});
const cloneState=(state:AppState):AppState=>({...state,master:{...state.master},parts:state.parts.map(clonePart),presetMappings:state.presetMappings?.map(mapping=>({...mapping,preset:{...mapping.preset,part:clonePart(mapping.preset.part)}})),programPortamento:state.programPortamento?.map(setting=>({...setting}))});
function mergePartChanges(effective:PartState,previous:PartState,next:PartState):PartState {
  const merged=clonePart(effective);
  for(const key of Object.keys(next) as (keyof PartState)[]){
    if(key==='id'||key==='envelope'||key==='drumMap'||key==='performance')continue;
    if(previous[key]!==next[key])Object.assign(merged,{[key]:next[key]});
  }
  for(const key of Object.keys(next.envelope) as (keyof Envelope)[])if(previous.envelope[key]!==next.envelope[key])Object.assign(merged.envelope,{[key]:next.envelope[key]});
  const previousControls=getPerformanceControls(previous),nextControls=getPerformanceControls(next);
  for(const key of PERFORMANCE_KEYS)if(previousControls[key]!==nextControls[key])Object.assign(merged.performance!,{[key]:nextControls[key]});
  for(const key of new Set([...Object.keys(previous.drumMap),...Object.keys(next.drumMap)])){
    const note=Number(key);if(previous.drumMap[note]===next.drumMap[note])continue;
    if(next.drumMap[note]===undefined)delete merged.drumMap[note];else merged.drumMap[note]=next.drumMap[note];
  }
  return merged;
}
const PART_FIELDS=new Set(['bankId','msb','lsb','program','drums','volume','pan','reverb','chorus','delay','mute','solo','transpose','envelope','drumMap','locked','performance','envelope.attack','envelope.decay','envelope.sustain','envelope.release','envelope.enabled',...PERFORMANCE_KEYS.map(key=>`performance.${key}`)]);
const BINDING_FIELDS=new Set(['bankId','msb','lsb','program','drums']);
function applyPartFields(current:PartState,next:PartState,fields:readonly string[]):PartState {
  const result=clonePart(current);
  for(const field of fields){
    if(field.startsWith('performance.')){const key=field.slice(12) as keyof PerformanceControls;Object.assign(result.performance!,{[key]:getPerformanceControls(next)[key]});}
    else if(field==='performance')result.performance=getPerformanceControls(next);
    else if(field.startsWith('envelope.')){const key=field.slice(9) as keyof Envelope;Object.assign(result.envelope,{[key]:next.envelope[key]});}
    else if(field==='envelope')result.envelope={...next.envelope};
    else if(field==='drumMap')result.drumMap={...next.drumMap};
    else Object.assign(result,{[field]:next[field as keyof PartState]});
  }
  return result;
}

/**
 * Pinned spessasynth_core 4.4.2 private-API adapter. No installed package files
 * are changed. The upstream numeric cache omits bank identity; concrete preset
 * objects include their loaded bank generation and retain their own samples.
 */
function isolateVoiceCache(core:SpessaSynthProcessor):void {
  const bridge=core as unknown as CacheBridge;
  if(typeof bridge.getCachedVoice!=='function'||typeof bridge.setCachedVoice!=='function')throw new Error('Unsupported SpessaSynth core: bank-isolation adapter needs review.');
  let voices=new WeakMap<object,Map<number,unknown>>();
  bridge.getCachedVoice=(preset,note,velocity)=>voices.get(preset)?.get(note*128+velocity);
  bridge.setCachedVoice=(preset,note,velocity,value)=>{
    let keys=voices.get(preset);if(!keys){keys=new Map();voices.set(preset,keys);}keys.set(note*128+velocity,value);
  };
  const originalClear=core.clearCache.bind(core);
  core.clearCache=()=>{voices=new WeakMap();originalClear();};
}

function timecents(seconds:number):number { return seconds<=0?-32768:Math.round(clamp(1200*Math.log2(seconds),-32767,15000)); }
function envelopeValues(envelope:Envelope):[number,number,number,number] {
  const sustain=envelope.sustain<=0?1000:clamp(-200*Math.log10(clamp(envelope.sustain,0.00001,1)),0,1000);
  // SF2 decay specifies time to -100dB, rather than time to the sustain level.
  const decay=sustain>0?envelope.decay*1000/sustain:0;
  return [timecents(envelope.attack),timecents(decay),Math.round(sustain),timecents(envelope.release)];
}

/** Shared by the real AudioWorklet and deterministic offline renders. */
export class OfflineEngine {
  readonly core:SpessaSynthProcessor;
  readonly ready:Promise<void>;
  readonly sampleRate:number;
  onWarning?:(message:string)=>void;
  private state:AppState;
  // UI/session controls, sounding presets and incoming MIDI addresses have
  // separate lifetimes. A master edit must not undo a MIDI preset recall.
  private effectiveParts:PartState[];
  private readonly mappedParts=new Set<number>();
  private readonly programPortamentoParts=new Set<number>();
  private readonly midiAddresses=new Map<number,{msb:number;lsb:number}>();
  private readonly banks=new Map<string,BankEntry>();
  private generation=0;
  private readonly selections=new Map<number,Selection>();
  private readonly selectionKeys=new Map<number,string>();
  private readonly held=new Map<string,HeldNote[]>();
  private readonly sostenutoCaptured=new Map<number,Set<string>>();
  private readonly sostenutoReleased=new Map<number,Map<string,HeldNote>>();
  private readonly noteOrigins=new Map<string,string>();
  private readonly streams=Array.from({length:8},()=>new MidiStreamDecoder());
  private readonly effects:AppEffects;
  private readonly partLevels=new Float32Array(128);
  private readonly channelOutputs=Array.from({length:128},()=>[new Float32Array(QUANTUM),new Float32Array(QUANTUM)]);
  private readonly sendLeft=new Float32Array(QUANTUM);
  private readonly sendRight=new Float32Array(QUANTUM);
  private readonly chunkLeft=new Float32Array(QUANTUM);
  private readonly chunkRight=new Float32Array(QUANTUM);
  private timeline?:MidiTimeline;
  private midiBytes?:ArrayBuffer;
  private cursor=0;
  private time=0;
  private playing=false;
  private tempo=1;
  private sequenceIndex=0;
  private restoredNotes:RestoredNote[]=[];

  constructor(sampleRate:number,initialState:AppState=createState()) {
    this.sampleRate=sampleRate;
    SpessaLog.setLogLevel(false,false,false);
    this.core=new SpessaSynthProcessor(sampleRate,{maxBufferSize:QUANTUM,eventsEnabled:false});
    this.ready=this.core.ready;
    this.core.onMissingPreset=()=>undefined;
    isolateVoiceCache(this.core);
    while(this.core.midiChannels.length<128)this.core.createMIDIChannel();
    this.effects=new AppEffects(sampleRate);
    this.state=cloneState(initialState);
    this.effectiveParts=initialState.parts.map(clonePart);
    const originalReset=this.core.reset.bind(this.core);
    this.core.reset=(system)=>{
      this.held.clear();this.sostenutoCaptured.clear();this.sostenutoReleased.clear();this.noteOrigins.clear();originalReset(system);
      for(const part of this.state.parts)if(!part.locked){
        this.programPortamentoParts.delete(part.id);
        if(this.mappedParts.delete(part.id)){
          this.effectiveParts[part.id]=clonePart(part);
          // A system reset clears MIDI controllers in every history. Restore
          // the panel's API mix/binding without resurrecting saved pedals.
          this.updatePart(this.effectiveParts[part.id],undefined,[],false);
        }
        this.midiAddresses.set(part.id,{msb:0,lsb:0});
        this.selections.set(part.id,{msb:0,lsb:0,program:0,drums:part.id%16===9});
      }
    };
    for(let id=0;id<128;id++){
      const channel=this.core.midiChannels[id] as MIDIChannel & ChannelBridge;
      if(typeof channel.computeModulators!=='function'||!channel.noteOnID||typeof channel.setDrumFlag!=='function')throw new Error('Unsupported SpessaSynth channel API.');
      const original=channel.computeModulators.bind(channel);
      // Upstream killNote resets per-pitch counters. Keep them monotonic so a
      // later mono note cannot inherit an earlier group's selective hold.
      const kill=channel.killNote.bind(channel),on=channel.noteOn.bind(channel);
      channel.killNote=(note,releaseTime)=>{
        const next=channel.noteOnID[note],off=channel.noteOffID[note];kill(note,releaseTime);
        channel.noteOnID[note]=next;channel.noteOffID[note]=off;
        const prefix=`${id}:${note}:`;
        for(const key of this.sostenutoCaptured.get(id)??[])if(key.startsWith(prefix)){
          this.sostenutoCaptured.get(id)!.delete(key);this.sostenutoReleased.get(id)?.delete(key);this.noteOrigins.delete(key);
        }
      };
      channel.noteOn=(note,velocity,emit=true)=>{
        if(emit){
          if(!channel.midiParameters.polyMode){
            // MIDI mono uses one boolean per output pitch. Several physical
            // keys can quantize there; retain their remaining key-down state.
            const highest=this.reconcileMonoKeys(id);
            if(channel.lastMonoNote<0)channel.lastMonoNote=highest;
          }
          on(note,velocity,true);return;
        }
        // Mono's internal lower-note restoration reuses the still-held group,
        // rather than inventing an ID that its eventual input Note Off lacks.
        const binding=this.findHeldBinding(id,note);
        const next=channel.noteOnID[note];if(binding)channel.noteOnID[note]=binding.noteID;
        on(note,velocity,false);channel.noteOnID[note]=next;
      };
      channel.computeModulators=(voice,sourceUsesCC,sourceIndex)=>{
        // Rebuild the original values before applying compatibility offsets.
        // Core 4.4.2 has no ordinary CC76/77/78 synthesis implementation.
        original(voice,-1,sourceIndex);
        const cc=channel.midiControllers,generators=voice.modulatedGenerators;
        const rate=(cc[76]>>7)-64,depth=(cc[77]>>7)-64,delay=(cc[78]>>7)-64;
        generators[GeneratorTypes.freqVibLFO]=Math.round(clamp(generators[GeneratorTypes.freqVibLFO]+rate*1200/64,-16000,4500));
        const baseDepth=generators[GeneratorTypes.vibLfoToPitch];
        generators[GeneratorTypes.vibLfoToPitch]=Math.round(clamp(depth<0?baseDepth*(64+depth)/64:baseDepth+depth*100/63,-12000,12000));
        if(delay!==0){
          const baseDelay=generators[GeneratorTypes.delayVibLFO]<=-32768?0:2**(generators[GeneratorTypes.delayVibLFO]/1200);
          const seconds=delay<0?baseDelay*(64+delay)/64:baseDelay+delay*2/63;
          generators[GeneratorTypes.delayVibLFO]=timecents(seconds);
        }
        voice.vibLfoStartTime=voice.startTime+(generators[GeneratorTypes.delayVibLFO]<=-32768?0:2**(generators[GeneratorTypes.delayVibLFO]/1200));
        const envelope=this.effectiveParts[id]?.envelope;
        if(!envelope?.enabled)return;
        const [attack,decay,sustain,release]=envelopeValues(envelope);
        generators[GeneratorTypes.attackVolEnv]=attack;
        generators[GeneratorTypes.holdVolEnv]=-32768;
        generators[GeneratorTypes.delayVolEnv]=-32768;
        generators[GeneratorTypes.decayVolEnv]=decay;
        generators[GeneratorTypes.sustainVolEnv]=sustain;
        generators[GeneratorTypes.releaseVolEnv]=release;
        generators[GeneratorTypes.keyNumToVolEnvHold]=0;
        generators[GeneratorTypes.keyNumToVolEnvDecay]=0;
      };
    }
    this.applyState(initialState);
  }

  async loadBank(data:ArrayBuffer,name:string,id?:string):Promise<BankInfo> {
    await this.ready;
    // Parse before replacing a live bank: a failed import preserves the old one.
    const bank=SoundBankLoader.fromArrayBuffer(data);
    if(!bank.presets.length)throw new Error('The bank contains no playable presets.');
    const identity=id??`bank-${++this.generation}`;
    const info:BankInfo={id:identity,name,bytes:data.byteLength,format:bank.type==='dls'?'DLS':bank.samples.some(s=>s.isCompressed)?'SF3':'SF2',presets:bank.presets.map(p=>({name:p.name,msb:p.bankMSB,lsb:p.bankLSB,program:p.program,drums:p.isDrum}))};
    this.banks.set(identity,{bank,info,generation:++this.generation});
    for(const part of this.effectiveParts)if(part.bankId===identity)this.bind(part.id);
    return info;
  }

  removeBank(id:string):void {
    this.banks.delete(id);
    for(const part of this.effectiveParts)if(part.bankId===id){this.releasePart(part.id,true);this.core.midiChannels[part.id].preset=undefined;}
  }

  applyState(state:AppState):void {
    if(!state||state.parts.length!==128)throw new Error('A performance must contain 128 parts.');
    const pitchChanged=this.state.master.keyShift!==state.master.keyShift;
    if(pitchChanged)this.panic();
    const previous=this.state;
    const previousEffective=this.effectiveParts.map(clonePart);
    this.state=cloneState(state);
    this.core.setSystemParameter('keyShift',clamp(state.master.keyShift,-48,48));
    this.core.setSystemParameter('fineTune',clamp(state.master.fineTune,-100,100));
    this.core.setSystemParameter('gain',clamp(state.master.gain,0,2));
    this.core.setSystemParameter('reverbGain',clamp(state.master.reverbGain??1,0,2));
    this.core.setSystemParameter('chorusGain',clamp(state.master.chorusGain??1,0,2));
    this.setTempo(state.master.tempo);
    this.effects.configure(state.master);
    for(const part of this.state.parts){
      const before=previous.parts[part.id];
      const effective=this.mappedParts.has(part.id)||this.programPortamentoParts.has(part.id)?mergePartChanges(previousEffective[part.id],before,part):clonePart(part);
      this.effectiveParts[part.id]=effective;
      if(before&&(before.msb!==part.msb||before.lsb!==part.lsb))this.midiAddresses.set(part.id,{msb:part.msb,lsb:part.lsb});
      this.updatePart(effective,previousEffective[part.id]);
    }
    this.updateMute();
  }

  applyPart(part:PartState,changedFields?:string[]):void {
    if(!Number.isInteger(part.id)||part.id<0||part.id>=128)throw new Error('Invalid part number.');
    if(changedFields!==undefined&&(!Array.isArray(changedFields)||changedFields.some(field=>!PART_FIELDS.has(field))))throw new Error('Invalid part control field.');
    const previousEffective=clonePart(this.effectiveParts[part.id]);
    const next=changedFields===undefined?clonePart(part):applyPartFields(this.state.parts[part.id],part,changedFields);
    this.state.parts[part.id]=next;
    // Omitted fields mean a full preset/panel replacement. Explicit field paths
    // express slider intent independently of the stale UI baseline, including
    // values equal to that baseline, while retaining the sounding preset.
    const effective=changedFields===undefined?clonePart(next):applyPartFields(previousEffective,part,changedFields);
    if(changedFields===undefined){this.mappedParts.delete(part.id);this.programPortamentoParts.delete(part.id);}
    this.effectiveParts[part.id]=effective;
    this.updatePart(effective,previousEffective,changedFields??[...PART_FIELDS]);this.updateMute();
    if(changedFields===undefined||changedFields.some(field=>BINDING_FIELDS.has(field))){
      this.midiAddresses.set(part.id,{msb:effective.msb,lsb:effective.lsb});
      this.selections.set(part.id,{msb:effective.msb,lsb:effective.lsb,program:effective.program,drums:effective.drums});this.bind(part.id);
      if(changedFields!==undefined)this.applyProgramPortamento(part.id,changedFields);
    }
  }

  private applyProgramPortamento(id:number,explicitFields:readonly string[]=[]):void {
    // A font selection recalls defaults. A full app-preset snapshot and later
    // explicit controller edits own their values independently of this table.
    if(explicitFields.includes('performance'))return;
    const part=this.effectiveParts[id],selection=this.selections.get(id);if(!part||!selection)return;
    const preset=this.core.midiChannels[id].preset;
    const patch=preset?{bankId:part.bankId,msb:preset.bankMSB,lsb:preset.bankLSB,program:preset.program,drums:preset.isDrum}:{bankId:part.bankId,...selection};
    const defaults=getProgramPortamento(this.state,patch),previous=clonePart(part),fields:string[]=[];
    for(const key of ['portamento','portamentoTime'] as const){
      const field=`performance.${key}`;if(explicitFields.includes(field))continue;
      Object.assign(part.performance!,{[key]:defaults[key]});fields.push(field);
    }
    if(!fields.length)return;
    this.programPortamentoParts.add(id);this.updatePart(part,previous,fields);
  }

  private updatePart(part:PartState,previous?:PartState,forceFields:readonly string[]=[],restoreControllers=true):void {
    const initial=!this.selectionKeys.has(part.id);
    const key=JSON.stringify([part.bankId,part.msb,part.lsb,part.program,part.drums,part.locked]);
    if(this.selectionKeys.get(part.id)!==key){this.selectionKeys.set(part.id,key);this.selections.set(part.id,{msb:part.msb,lsb:part.lsb,program:part.program,drums:part.drums});this.bind(part.id);}
    const channel=this.core.midiChannels[part.id];
    channel.setSystemParameter('gain',clamp(part.volume,0,127)/100);
    channel.setSystemParameter('pan',clamp((part.pan-64)/63,-1,1));
    if(!restoreControllers)return;
    for(const [cc,property]of [[91,'reverb'],[93,'chorus']] as const){
      channel.lockController(cc,false);
      if(initial||!previous||previous[property]!==part[property]||previous.locked!==part.locked||forceFields.includes(property))this.core.controllerChange(part.id,cc,Math.round(clamp(part[property],0,127)));
      channel.lockController(cc,part.locked);
    }
    const controls=part.performance!,before=previous?getPerformanceControls(previous):undefined;
    const changed=(key:keyof PerformanceControls)=>initial||!before||before[key]!==controls[key]||forceFields.includes('performance')||forceFields.includes(`performance.${key}`);
    for(const [cc,key] of [[11,'expression'],[1,'modulation'],[76,'vibratoRate'],[77,'vibratoDepth'],[78,'vibratoDelay'],[74,'cutoff'],[71,'resonance'],[73,'attack'],[75,'decay'],[72,'release'],[5,'portamentoTime'],[65,'portamento'],[67,'soft'],[66,'sostenuto'],[64,'hold']] as const){
      channel.lockController(cc,false);
      if(changed(key))this.changeController(part.id,cc,typeof controls[key]==='boolean'?(controls[key]?127:0):controls[key] as number);
      // The panel lock owns patch selection. Pedals, pitch and expression must
      // remain playable from a MIDI keyboard when that selection is locked.
      channel.lockController(cc,false);
    }
    for(const [key,parameter]of [['pitchBend','pitchWheel'],['bendRange','pitchWheelRange'],['fineTune','fineTune'],['mono','polyMode']] as const){
      channel.lockMIDIParameter(parameter,false);
      if(changed(key)){
        if(key==='pitchBend')this.core.pitchWheel(part.id,controls.pitchBend);
        else if(key==='bendRange')this.setRPN(part.id,0,controls.bendRange<<7);
        else if(key==='fineTune')this.setRPN(part.id,1,Math.round(clamp(8192+controls.fineTune*81.92,0,16383)));
        else if(channel.midiParameters.polyMode===controls.mono){channel.lockController(126,false);channel.lockController(127,false);this.releasePart(part.id,true);this.core.controllerChange(part.id,controls.mono?126:127,0);}
      }
      channel.lockMIDIParameter(parameter,false);
    }
    channel.lockController(126,false);channel.lockController(127,false);
  }

  private setRPN(id:number,parameter:number,value:number):void {
    const channel=this.core.midiChannels[id];
    // UI edits must not steal an external sender's RPN/NRPN/data-entry latch.
    const bridge=channel as unknown as {lastParameterIsRegistered:boolean;_midiControllers:Int16Array};
    const selectors=[6,38,98,99,100,101] as const;
    const previous=selectors.map(cc=>channel.midiControllers[cc]),registered=bridge.lastParameterIsRegistered;
    for(const [cc,v]of [[101,parameter>>7],[100,parameter&127],[6,value>>7],[38,value&127]] as const)this.core.controllerChange(id,cc,v);
    selectors.forEach((cc,index)=>bridge._midiControllers[cc]=previous[index]);bridge.lastParameterIsRegistered=registered;
  }

  private groupKey(id:number,note:HeldNote):string {return `${id}:${note.output}:${note.noteID}`;}

  private findHeldBinding(id:number,output:number):HeldNote|undefined {
    let binding:HeldNote|undefined;
    for(const [key,notes]of this.held)if(Number(key.split(':')[1])===id)for(const held of notes)if(!held.ignored&&held.output===output)binding=held;
    return binding;
  }

  private reconcileMonoKeys(id:number):number {
    const channel=this.core.midiChannels[id] as MIDIChannel & ChannelBridge;
    channel.playingNotes.fill(false);let highest=-1;
    for(const [key,notes]of this.held)if(Number(key.split(':')[1])===id)for(const held of notes)if(!held.ignored){
      channel.playingNotes[held.output]=true;highest=Math.max(highest,held.output);
    }
    return highest;
  }

  private releaseBinding(id:number,binding:HeldNote):void {
    if(binding.ignored)return;
    const channel=this.core.midiChannels[id] as MIDIChannel & ChannelBridge;
    const mono=!channel.midiParameters.polyMode,foreground=channel.lastMonoNote===binding.output;
    if(mono)this.reconcileMonoKeys(id);
    channel.noteOffID[binding.output]=binding.noteID;channel.noteOff(binding.output);
    if(mono){
      // Core Note Off clears a single pitch boolean even when another input
      // still holds that pitch. Repair it before the next mono restoration.
      const highest=this.reconcileMonoKeys(id);
      if(foreground&&highest>=0&&channel.lastMonoNote!==highest){
        const remaining=this.findHeldBinding(id,highest);
        const voices=(this.core as unknown as {voices:VoiceBridge[]}).voices;
        const sounding=remaining&&voices.some(voice=>voice.isActive&&!voice.isInRelease&&voice.channel===id&&voice.midiNote===highest&&voice.noteID===remaining.noteID);
        if(sounding){
          if(channel.lastMonoNote>=0&&channel.lastMonoNote!==highest)channel.killNote(channel.lastMonoNote);
          channel.lastMonoNote=highest;
        }else channel.noteOn(highest,channel.lastMonoVelocity,false);
      }
    }
    if(channel.midiControllers[64]<8192)this.noteOrigins.delete(this.groupKey(id,binding));
    else if(binding.source)this.noteOrigins.set(this.groupKey(id,binding),binding.source);
  }

  /** Core 4.4.2 stores CC66 but does not implement its selective hold. */
  private setSostenuto(id:number,enabled:boolean):void {
    if(enabled===this.sostenutoCaptured.has(id))return;
    if(enabled){
      const captured=new Set<string>(),released=new Map<string,HeldNote>();
      const voices=(this.core as unknown as {voices:VoiceBridge[]}).voices;
      for(const voice of voices){
        if(!voice.isActive||voice.channel!==id||voice.isInRelease)continue;
        const binding:HeldNote={output:voice.midiNote,noteID:voice.noteID};
        const key=this.groupKey(id,binding);captured.add(key);
        if(voice.isHeld){
          // Transfer a sustain-held group to selective hold. A later CC64-up
          // must not release it before CC66-up.
          binding.source=this.noteOrigins.get(key);released.set(key,binding);voice.isHeld=false;
        }
      }
      this.sostenutoCaptured.set(id,captured);this.sostenutoReleased.set(id,released);
    }else{
      this.sostenutoCaptured.delete(id);
      const released=this.sostenutoReleased.get(id);this.sostenutoReleased.delete(id);
      for(const binding of released?.values()??[])this.releaseBinding(id,binding);
    }
  }

  private changeController(id:number,cc:number,value:number):void {
    const channel=this.core.midiChannels[id] as MIDIChannel & {lockedControllers:boolean[]};
    if(channel.lockedControllers[cc])return;
    if(cc===66&&(channel.midiControllers[66]>=8192)!==(value>=64))this.setSostenuto(id,value>=64);
    if(cc===126||cc===127)this.releasePart(id,true);
    this.core.controllerChange(id,cc as Parameters<SpessaSynthProcessor['controllerChange']>[1],value);
    if(cc===64&&value<64)for(const key of this.noteOrigins.keys())if(Number(key.split(':')[0])===id)this.noteOrigins.delete(key);
    if(cc===121&&channel.midiControllers[66]<8192)this.setSostenuto(id,false);
  }

  private updateMute():void {
    const solo=this.effectiveParts.some(p=>p.solo);
    for(const part of this.effectiveParts){
      const channel=this.core.midiChannels[part.id],muted=part.mute||(solo&&!part.solo);
      // Core mute forcibly kills voices and resets pitch IDs. End adapter
      // captures and key groups before a later note can reuse those IDs.
      if(muted&&!channel.systemParameters.isMuted)this.releasePart(part.id,true);
      channel.setSystemParameter('isMuted',muted);
    }
  }

  private bind(id:number):void {
    const part=this.effectiveParts[id];if(!part)return;
    const channel=this.core.midiChannels[id] as MIDIChannel & ChannelBridge;
    const entry=part.bankId?this.banks.get(part.bankId):undefined;
    const selection=this.selections.get(id)??part;
    let preset:SynthesizerPatch|undefined;
    if(entry){
      preset=entry.bank.presets.find(p=>p.bankMSB===selection.msb&&p.bankLSB===selection.lsb&&p.program===selection.program&&p.isDrum===selection.drums);
      // Any fallback is strictly within this part's selected bank.
      if(!preset)preset=entry.bank.getPreset({bankMSB:selection.msb,bankLSB:selection.lsb,program:selection.program,isGMGSDrum:selection.drums},entry.bank.isXGBank?'xg':'gs');
    }
    channel.setSystemParameter('presetLock',false);
    channel.setDrumFlag(selection.drums);
    channel.preset=preset;
    Object.assign(channel.patch,{bankMSB:selection.msb,bankLSB:selection.lsb,program:selection.program,isGMGSDrum:preset?.isGMGSDrum??selection.drums});
    // The adapter, rather than global bank priority, owns program changes.
    channel.setSystemParameter('presetLock',true);
  }

  noteOn(partId:number,note:number,velocity=100,source='live'):void {
    const part=this.effectiveParts[partId];if(!part||!Number.isInteger(note)||note<0||note>127)return;
    if(velocity<=0){this.noteOff(partId,note,source);return;}
    const channel=this.core.midiChannels[partId] as MIDIChannel & ChannelBridge;
    const key=`${source}:${partId}:${note}`,held=this.held.get(key)??[],controls=part.performance!;
    if(!channel.preset||channel.systemParameters.isMuted||source==='live'&&(note<controls.lowKey||note>controls.highKey)){
      held.push({output:note,noteID:0,ignored:true});this.held.set(key,held);return;
    }
    const drums=this.selections.get(partId)?.drums??part.drums;
    const output=drums?Math.round(clamp(part.drumMap[note]??note,0,127)):transformNote(note,this.state.master.root,this.state.master.mode,part.transpose);
    const noteID=channel.noteOnID[output];
    channel.noteOn(output,Math.round(clamp(velocity,1,127)));
    const binding={output,noteID,source};held.push(binding);this.held.set(key,held);this.noteOrigins.set(this.groupKey(partId,binding),source);
  }

  noteOff(partId:number,note:number,source='live'):void {
    const key=`${source}:${partId}:${note}`;const held=this.held.get(key);const binding=held?.shift();
    if(!binding)return;if(!held?.length)this.held.delete(key);
    // Select the exact voice group even when different input notes quantize to
    // one output pitch, or a scale/drum map changes while a note is held.
    if(binding.ignored)return;
    const group=this.groupKey(partId,binding);
    if(this.sostenutoCaptured.get(partId)?.has(group)){
      this.sostenutoReleased.get(partId)!.set(group,binding);
      if(!this.core.midiChannels[partId].midiParameters.polyMode)this.reconcileMonoKeys(partId);
    }
    else this.releaseBinding(partId,binding);
  }

  sendMIDI(bytes:number[],port=0,source='external'):void {
    if(!bytes.length||!Number.isInteger(port)||port<0||port>7)return;
    for(const message of this.streams[port].push(bytes))this.dispatchMIDI(message,port,source);
  }

  private dispatchMIDI(bytes:number[],port=0,source='external'):void {
    const status=bytes[0];const command=status&0xf0;const id=port*16+(status&15);
    if(status<0xf0){
      if(command===0x90){this.noteOn(id,bytes[1],bytes[2],source);return;}
      if(command===0x80){this.noteOff(id,bytes[1],source);return;}
      const part=this.effectiveParts[id],base=this.state.parts[id];if(!part)return;
      let address=this.midiAddresses.get(id);
      if(!address){address={msb:base.msb,lsb:base.lsb};this.midiAddresses.set(id,address);}
      if(command===0xc0){
        if(!base.locked){
          const mapping=this.state.presetMappings?.find(m=>m.partId===id&&m.msb===address!.msb&&m.lsb===address!.lsb&&m.program===bytes[1]);
          if(mapping){
            const previous=clonePart(part),recalled=clonePart(mapping.preset.part);
            recalled.id=id;recalled.bankId=mapping.preset.bankId;
            // The receiving panel owns its MIDI program lock, not the saved
            // instrument's original panel. Later mapped PCs remain reachable.
            recalled.locked=base.locked;
            this.effectiveParts[id]=recalled;this.mappedParts.add(id);
            this.programPortamentoParts.delete(id);
            this.updatePart(recalled,previous,['performance']);this.updateMute();
            // A previous unmapped PC may have changed the sounding font
            // address without changing this saved snapshot's identity.
            this.selections.set(id,{msb:recalled.msb,lsb:recalled.lsb,program:recalled.program,drums:recalled.drums});this.bind(id);
            if(!recalled.bankId||!this.banks.has(recalled.bankId))this.onWarning?.(`Part ${id+1}: app preset “${mapping.preset.name}” needs missing soundbank ${recalled.bankId??'(none)'}.`);
          }else{
            const selection=this.selections.get(id)!;
            selection.msb=address.msb;selection.lsb=address.lsb;selection.program=bytes[1];
            const bank=part.bankId?this.banks.get(part.bankId):undefined;
            if(this.core.midiParameters.system==='xg'||bank?.bank.isXGBank)selection.drums=address.msb===127||address.msb===120;
            this.bind(id);this.applyProgramPortamento(id);
          }
        }return;
      }
      if(command===0xb0&&(bytes[1]===0||bytes[1]===32)){
        if(bytes[1]===0)address.msb=bytes[2];else address.lsb=bytes[2];
        return;
      }
      if(command===0xb0&&bytes[1]===120){this.releasePart(id,true);return;}
      if(command===0xb0&&(bytes[1]===123||bytes[1]===124||bytes[1]===125)){
        // Unlike All Sound Off, All Notes Off is a set of ordinary Note Offs;
        // sustain may keep those voices sounding until the pedal is released.
        for(const key of [...this.held.keys()]){
          const [heldSource,heldPart,heldNote]=key.split(':');
          if(Number(heldPart)!==id)continue;
          while(this.held.has(key))this.noteOff(id,Number(heldNote),heldSource);
        }
        return;
      }
      if(command===0xb0){this.changeController(id,bytes[1],bytes[2]);return;}
    }
    this.core.processMessage(bytes,port*16);
    if(status>=0xf0){
      // GM/GS/XG resets and parameter SysEx must never leave global-bank patches
      // in place of the user's concrete per-part binding.
      for(const part of this.effectiveParts)this.bind(part.id);
      this.core.setSystemParameter('keyShift',this.state.master.keyShift);
      this.core.setSystemParameter('fineTune',this.state.master.fineTune);
      this.updateMute();
    }
  }

  private releasePart(id:number,force:boolean):void {
    this.core.midiChannels[id].stopAllNotes(force);
    for(const key of this.held.keys())if(Number(key.split(':')[1])===id)this.held.delete(key);
    this.sostenutoCaptured.delete(id);this.sostenutoReleased.delete(id);
    for(const key of this.noteOrigins.keys())if(Number(key.split(':')[0])===id)this.noteOrigins.delete(key);
  }

  panic():void {this.core.stopAll(true);this.held.clear();this.sostenutoCaptured.clear();this.sostenutoReleased.clear();this.noteOrigins.clear();this.partLevels.fill(0);this.effects.reset();}

  /** Actual rendered part peaks since the previous host meter poll. */
  getPartLevels():number[] {const levels=Array.from(this.partLevels);this.partLevels.fill(0);return levels;}

  /** Pressed output keys, independent of sustain/sostenuto sounding tails. */
  getHeldNotes():number[][] {
    const keys=Array.from({length:128},()=>new Set<number>());
    for(const [key,notes]of this.held){
      const id=Number(key.split(':')[1]);
      for(const note of notes)if(!note.ignored&&note.output>=0)keys[id].add(note.output);
    }
    return keys.map(notes=>[...notes].sort((a,b)=>a-b));
  }

  loadMidi(data:ArrayBuffer,_name?:string):{duration:number;format:number;sequenceCount:number} {
    const timeline=parseMidiTimeline(data);
    this.stop();this.midiBytes=data.slice(0);this.timeline=timeline;this.sequenceIndex=0;this.cursor=0;this.time=0;
    return {duration:timeline.duration,format:timeline.format,sequenceCount:timeline.sequenceCount};
  }

  selectSequence(index:number):void {
    if(!this.midiBytes)throw new Error('Load a MIDI file first.');
    const timeline=parseMidiTimeline(this.midiBytes,index);this.stop();this.timeline=timeline;this.sequenceIndex=index;
  }

  play():void {
    if(!this.timeline||this.playing)return;
    if(this.time>=this.timeline.duration)this.seek(0);
    if(this.time>0){this.seek(this.time);this.retrigger();}
    this.playing=true;
  }
  pause():void {this.playing=false;this.panic();}
  stop():void {this.playing=false;this.time=0;this.cursor=0;this.panic();this.resetSong();}
  private resetSong():void {
    this.mappedParts.clear();this.programPortamentoParts.clear();this.midiAddresses.clear();this.effectiveParts=this.state.parts.map(clonePart);
    this.core.reset();this.held.clear();
    for(const part of this.effectiveParts){this.midiAddresses.set(part.id,{msb:part.msb,lsb:part.lsb});this.selections.set(part.id,{msb:part.msb,lsb:part.lsb,program:part.program,drums:part.drums});this.bind(part.id);this.updatePart(part);}
    this.core.setSystemParameter('keyShift',this.state.master.keyShift);this.core.setSystemParameter('fineTune',this.state.master.fineTune);this.updateMute();
  }
  seek(seconds:number):void {
    const wasPlaying=this.playing;this.panic();this.resetSong();this.cursor=0;this.time=clamp(seconds,0,this.timeline?.duration??0);
    const notes:RestoredNote[]=[];
    const sustain=this.core.midiChannels.map(channel=>channel.midiControllers[64]>=8192);
    const sostenuto=this.core.midiChannels.map(channel=>channel.midiControllers[66]>=8192);
    if(this.timeline)while(this.cursor<this.timeline.events.length&&this.timeline.events[this.cursor].time<this.time){
      const event:TimedMidiEvent=this.timeline.events[this.cursor++];
      const message=event.message,command=message[0]&0xf0,part=event.partOffset+(message[0]&15);
      if(command===0x90&&message[2]>0)notes.push({part,note:message[1],velocity:message[2],released:false});
      else if(command===0x80||command===0x90){
        const index=notes.findIndex(n=>n.part===part&&n.note===message[1]&&!n.released);
        if(index>=0){if(sustain[part]||sostenuto[part]&&notes[index].sostenuto)notes[index].released=true;else notes.splice(index,1);}
      }else{
        this.dispatchMIDI(message,event.partOffset/16,'file');
        if(command===0xb0){
          if([120,123,124,125,126,127].includes(message[1]))for(let i=notes.length-1;i>=0;i--)if(notes[i].part===part){
            if([123,124,125].includes(message[1])&&(sustain[part]||sostenuto[part]&&notes[i].sostenuto))notes[i].released=true;
            else notes.splice(i,1);
          }
        }
        // Read accepted values: panel presets and controller locks can change
        // the result of a MIDI message, including a mapped program change.
        for(let id=0;id<128;id++){
          const nextSustain=this.core.midiChannels[id].midiControllers[64]>=8192;
          const nextSostenuto=this.core.midiChannels[id].midiControllers[66]>=8192;
          if(nextSostenuto!==sostenuto[id])for(const note of notes)if(note.part===id)note.sostenuto=nextSostenuto;
          sustain[id]=nextSustain;sostenuto[id]=nextSostenuto;
        }
        for(let i=notes.length-1;i>=0;i--)if(notes[i].released&&!sustain[notes[i].part]&&!(sostenuto[notes[i].part]&&notes[i].sostenuto))notes.splice(i,1);
        // Recognized GM, GS and XG resets clear the historical note snapshot.
        if(message[0]===0xff||message[0]===0xf0&&(message[1]===0x7e&&message[3]===0x09||message[1]===0x43&&message[6]===0x7e||message[1]===0x41&&message[8]===0x7f)){notes.length=0;sustain.fill(false);}
      }
    }
    this.restoredNotes=notes;
    this.playing=wasPlaying;
    if(wasPlaying)this.retrigger();
  }
  private retrigger():void {
    for(const note of this.restoredNotes){
      this.noteOn(note.part,note.note,note.velocity,'file');
      if(note.sostenuto){
        const binding=this.held.get(`file:${note.part}:${note.note}`)?.at(-1);
        if(binding){
          let captured=this.sostenutoCaptured.get(note.part);if(!captured){captured=new Set();this.sostenutoCaptured.set(note.part,captured);this.sostenutoReleased.set(note.part,new Map());}
          captured.add(this.groupKey(note.part,binding));
        }
      }
      if(note.released)this.noteOff(note.part,note.note,'file');
    }
    this.restoredNotes=[];
  }
  private finishSong():void {
    this.playing=false;
    const fileParts=new Set<number>();
    for(const event of this.timeline?.events??[])if(event.message[0]>=0x80&&event.message[0]<0xf0)fileParts.add(event.partOffset+(event.message[0]&15));
    for(const id of fileParts)this.core.controllerChange(id,64,0);
    for(const key of [...this.held.keys()]){
      const [source,part,note]=key.split(':');if(source!=='file')continue;
      for(const binding of this.held.get(key)??[])this.sostenutoCaptured.get(Number(part))?.delete(this.groupKey(Number(part),binding));
      while(this.held.has(key))this.noteOff(Number(part),Number(note),'file');
    }
    for(const [id,released]of this.sostenutoReleased)for(const [key,binding]of released)if(binding.source==='file'){
      this.sostenutoCaptured.get(id)?.delete(key);released.delete(key);this.releaseBinding(id,binding);
    }
  }
  setTempo(multiplier:number):void {this.tempo=clamp(multiplier,0.25,4);}
  position():PlayerPosition {return {current:this.time,duration:this.timeline?.duration??0,playing:this.playing};}

  /** Render a host callback; accepts any block length without exceeding core's quantum. */
  processBlock(left:Float32Array,right:Float32Array):void {
    left.fill(0);right.fill(0);
    let offset=0;
    while(offset<left.length){
      if(this.playing&&this.timeline){
        while(this.cursor<this.timeline.events.length&&this.timeline.events[this.cursor].time<=this.time+0.0000001){const event=this.timeline.events[this.cursor++];this.dispatchMIDI(event.message,event.partOffset/16,'file');}
        if(this.time>=this.timeline.duration)this.finishSong();
      }
      let count=Math.min(QUANTUM,left.length-offset);
      if(this.playing&&this.timeline){const next=this.timeline.events[this.cursor]?.time??this.timeline.duration;const until=Math.ceil((next-this.time)*this.sampleRate/this.tempo);count=Math.max(1,Math.min(count,until));}
      this.chunkLeft.fill(0);this.chunkRight.fill(0);this.sendLeft.fill(0);this.sendRight.fill(0);
      const sends=this.state.master.delayMix>0&&this.effectiveParts.some(p=>p.delay>0);
      for(const channels of this.channelOutputs){channels[0].fill(0);channels[1].fill(0);}
      this.core.process(this.chunkLeft,this.chunkRight,0,count,this.channelOutputs);
      for(const part of this.effectiveParts){
        const channels=this.channelOutputs[part.id];let peak=this.partLevels[part.id];
        for(let i=0;i<count;i++)peak=Math.max(peak,Math.abs(channels[0][i]),Math.abs(channels[1][i]));
        this.partLevels[part.id]=peak;
      }
      if(sends)for(const part of this.effectiveParts){if(part.delay<=0)continue;const channels=this.channelOutputs[part.id];const gain=part.delay/127;for(let i=0;i<count;i++){this.sendLeft[i]+=channels[0][i]*gain;this.sendRight[i]+=channels[1][i]*gain;}}
      // Views are allocated only for nonstandard callback/event-boundary sizes.
      const l=count===QUANTUM?this.chunkLeft:this.chunkLeft.subarray(0,count),r=count===QUANTUM?this.chunkRight:this.chunkRight.subarray(0,count);
      this.effects.process(l,r,count===QUANTUM?this.sendLeft:this.sendLeft.subarray(0,count),count===QUANTUM?this.sendRight:this.sendRight.subarray(0,count));
      left.set(l,offset);right.set(r,offset);offset+=count;
      if(this.playing)this.time=Math.min(this.timeline?.duration??0,this.time+count/this.sampleRate*this.tempo);
    }
  }

  render(frames:number):[Float32Array,Float32Array] {const l=new Float32Array(frames),r=new Float32Array(frames);this.processBlock(l,r);return [l,r];}
}
