export interface Envelope { attack:number; decay:number; sustain:number; release:number; enabled:boolean }
export interface PartState { id:number; bankId:string|null; msb:number; lsb:number; program:number; drums:boolean; volume:number; pan:number; reverb:number; chorus:number; delay:number; mute:boolean; solo:boolean; transpose:number; envelope:Envelope; drumMap:Record<number,number>; locked:boolean }
export interface MasterState { keyShift:number; fineTune:number; gain:number; tempo:number; root:number; mode:string; theme:string; delayTime:number; delayFeedback:number; delayMix:number; flangerMix:number; crusherBits:number }
export interface PatchBrowserSettings { favorites:string[]; sort:'none'|'name'|'program'|'bank'; closeOnSelect:boolean; favoritesOnly:boolean }
export interface AppState { version:1; master:MasterState; parts:PartState[]; selectedPart:number; presetMappings?:PresetMapping[]; patchBrowser?:PatchBrowserSettings }
export interface PatchInfo { name:string; msb:number; lsb:number; program:number; drums:boolean }
export interface BankInfo { id:string; name:string; bytes:number; format:string; presets:PatchInfo[] }
export interface SavedPreset { version:1; id:string; name:string; bankId:string|null; part:PartState }
export interface PresetMapping { partId:number; msb:number; lsb:number; program:number; preset:SavedPreset }
export interface PlayerPosition { current:number; duration:number; playing:boolean }
