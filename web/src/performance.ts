import type { AppState, PartState, PerformanceControls } from './contracts.ts';

/** MIDI values, except tuning in cents and the pitch-wheel range in semitones. */
export function createPerformanceControls(): PerformanceControls {
  return { expression:127, lowKey:0, highKey:127, pitchBend:8192, bendRange:2, fineTune:0,
    modulation:0, vibratoRate:64, vibratoDepth:64, vibratoDelay:64, cutoff:64, resonance:64,
    attack:64, decay:64, release:64, portamento:false, portamentoTime:0,
    mono:false, soft:false, sostenuto:false, hold:false };
}

export const PERFORMANCE_KEYS = Object.keys(createPerformanceControls()) as (keyof PerformanceControls)[];

export function normalizePerformanceControls(raw:unknown):PerformanceControls {
  const result=createPerformanceControls();
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return result;
  const values=raw as Record<string,unknown>;
  for(const key of PERFORMANCE_KEYS){
    const value=values[key],fallback=result[key];
    if(typeof fallback==='boolean'){
      if(typeof value==='boolean')Object.assign(result,{[key]:value});
    }else if(typeof value==='number'&&Number.isFinite(value)){
      const min=key==='fineTune'?-100:0;
      const max=key==='pitchBend'?16383:key==='bendRange'?24:key==='fineTune'?100:127;
      Object.assign(result,{[key]:key==='fineTune'?Math.max(min,Math.min(max,value)):Math.round(Math.max(min,Math.min(max,value)))});
    }
  }
  // A malformed imported interval collapses at its lower boundary.
  result.highKey=Math.max(result.lowKey,result.highKey);
  return result;
}

/** Returns an independent, normalized value, including for legacy version-1 parts. */
export function getPerformanceControls(part:PartState):PerformanceControls {
  return normalizePerformanceControls(part.performance);
}

/** Font-program defaults are shared across parts; individual app presets own snapshots. */
export function getProgramPortamento(state:Pick<AppState,'programPortamento'>,patch:Pick<PartState,'bankId'|'msb'|'lsb'|'program'|'drums'>):Pick<PerformanceControls,'portamento'|'portamentoTime'> {
  const setting=state.programPortamento?.find(value=>value.bankId===patch.bankId&&value.msb===patch.msb&&value.lsb===patch.lsb&&value.program===patch.program&&value.drums===patch.drums);
  return setting?{portamento:setting.portamento,portamentoTime:setting.portamentoTime}:{portamento:false,portamentoTime:0};
}
