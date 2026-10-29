export interface Envelope { attack:number; decay:number; sustain:number; release:number; enabled:boolean }
export interface PerformanceControls {
  expression:number; lowKey:number; highKey:number; pitchBend:number; bendRange:number; fineTune:number;
  modulation:number; vibratoRate:number; vibratoDepth:number; vibratoDelay:number; cutoff:number; resonance:number;
  attack:number; decay:number; release:number; portamento:boolean; portamentoTime:number;
  mono:boolean; soft:boolean; sostenuto:boolean; hold:boolean;
}
export interface PartState { id:number; bankId:string|null; msb:number; lsb:number; program:number; drums:boolean; volume:number; pan:number; reverb:number; chorus:number; delay:number; mute:boolean; solo:boolean; transpose:number; envelope:Envelope; drumMap:Record<number,number>; locked:boolean; performance?:PerformanceControls }
export type PartControlField = Exclude<keyof PartState,'id'> | `envelope.${keyof Envelope}` | `performance.${keyof PerformanceControls}`;
export interface MasterState { keyShift:number; fineTune:number; gain:number; tempo:number; root:number; mode:string; theme:string; delayTime:number; delayFeedback:number; delayMix:number; flangerMix:number; crusherBits:number; balance?:number; reverbGain?:number; chorusGain?:number }
export interface PatchBrowserSettings { favorites:string[]; sort:'none'|'name'|'program'|'bank'; closeOnSelect:boolean; favoritesOnly:boolean }
export interface ProgramPortamentoSetting { bankId:string; msb:number; lsb:number; program:number; drums:boolean; portamento:boolean; portamentoTime:number }
export interface AppState { version:1; master:MasterState; parts:PartState[]; selectedPart:number; presetMappings?:PresetMapping[]; patchBrowser?:PatchBrowserSettings; programPortamento?:ProgramPortamentoSetting[] }
export interface PatchInfo { name:string; msb:number; lsb:number; program:number; drums:boolean }
export interface BankInfo { id:string; name:string; bytes:number; format:string; presets:PatchInfo[] }
export interface SavedPreset { version:1; id:string; name:string; bankId:string|null; part:PartState }
export interface PresetMapping { partId:number; msb:number; lsb:number; program:number; preset:SavedPreset }
export interface PlayerPosition { current:number; duration:number; playing:boolean }
