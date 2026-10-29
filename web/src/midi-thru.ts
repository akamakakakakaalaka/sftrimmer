/** User-operated MIDI input/output menus. No scripting is needed in the player. */
export function setupMIDIThru(){
  const find=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const connect=find<HTMLButtonElement>('midi-connect');
  const inputMenu=find<HTMLSelectElement>('midi-thru-input'),outputMenu=find<HTMLSelectElement>('midi-thru-output');
  const enabled=find<HTMLInputElement>('midi-thru-enabled'),sysex=find<HTMLInputElement>('midi-thru-sysex');
  const status=find<HTMLElement>('midi-thru-status');
  let access:MIDIAccess|null=null,activeOutput:MIDIOutput|null=null;
  const listeners=new Map<string,{input:MIDIInput;listener:(event:MIDIMessageEvent)=>void;reset:()=>void}>();
  const outputListeners=new Map<string,{output:MIDIOutput;reset:()=>void}>();
  const held=new Map<number,number>(),pedals=new Set<number>();
  let count=0,pendingFrame=0;
  function stop(){
    enabled.checked=false;const output=activeOutput;activeOutput=null;
    if(output?.state==='connected'){
      for(const key of pedals){try{output.send([0xb0|(key>>8),key&255,0]);}catch{/* Device may disconnect while releasing. */}}
      for(const [key,remaining] of held)for(let n=0;n<remaining;n++){try{output.send([0x80|(key>>8),key&255,0]);}catch{/* Device may disconnect while releasing. */}}
    }
    held.clear();pedals.clear();
    if(pendingFrame){cancelAnimationFrame(pendingFrame);pendingFrame=0;}
  }
  function forward(input:MIDIInput,event:MIDIMessageEvent){
    if(!enabled.checked||inputMenu.value!==input.id||!activeOutput||!event.data)return;
    try{
      const data=event.data;activeOutput.send(data);
      const kind=data[0]&0xf0,channel=data[0]&15,key=(channel<<8)|data[1];
      if(kind===0x90&&data[2]>0)held.set(key,(held.get(key)||0)+1);
      if(kind===0x80||(kind===0x90&&data[2]===0)){const remaining=(held.get(key)||0)-1;if(remaining>0)held.set(key,remaining);else held.delete(key);}
      if(kind===0xb0){
        if([64,66,69].includes(data[1])){if(data[2]>=64)pedals.add(key);else pedals.delete(key);}
        if(data[1]===120||data[1]===123)for(const note of held.keys())if(note>>8===channel)held.delete(note);
        if(data[1]===121)for(const pedal of pedals)if(pedal>>8===channel)pedals.delete(pedal);
      }
      count++;
      if(!pendingFrame)pendingFrame=requestAnimationFrame(()=>{pendingFrame=0;status.textContent=`MIDI Thru on · ${count} messages forwarded.`;});
    }catch(error){stop();status.textContent=`MIDI Thru stopped: ${(error as Error).message}`;}
  }
  function options(menu:HTMLSelectElement,ports:Iterable<MIDIPort>,placeholder:string){
    const previous=menu.value;menu.replaceChildren(new Option(placeholder,''));
    for(const port of ports)menu.add(new Option(port.name||port.id,port.id));
    if([...menu.options].some(option=>option.value===previous))menu.value=previous;
  }
  function refresh(){
    options(inputMenu,access?.inputs.values()||[],'Choose input');options(outputMenu,access?.outputs.values()||[],'Choose output');
    if(!inputMenu.value||!outputMenu.value){stop();}
    enabled.disabled=!access||!inputMenu.value||!outputMenu.value;
    for(const [id,entry] of listeners)if(access?.inputs.get(id)!==entry.input){entry.input.removeEventListener('midimessage',entry.listener);entry.input.removeEventListener('midistreamreset',entry.reset);listeners.delete(id);}
    if(access)for(const input of access.inputs.values())if(!listeners.has(input.id)){
      const listener=(event:MIDIMessageEvent)=>forward(input,event);
      const reset=()=>{if(enabled.checked&&inputMenu.value===input.id){stop();status.textContent='MIDI Thru paused after an input interruption. Routed notes released.';}};
      listeners.set(input.id,{input,listener,reset});input.addEventListener('midimessage',listener);input.addEventListener('midistreamreset',reset);
    }
    for(const [id,entry] of outputListeners)if(access?.outputs.get(id)!==entry.output){entry.output.removeEventListener('outputreset',entry.reset);outputListeners.delete(id);}
    if(access)for(const output of access.outputs.values())if(!outputListeners.has(output.id)){
      const reset=()=>{if(outputMenu.value===output.id){stop();status.textContent='MIDI output paused after an error. Re-enable MIDI Thru to retry.';}};
      outputListeners.set(output.id,{output,reset});output.addEventListener('outputreset',reset);
    }
    if(access&&!enabled.checked)status.textContent=`${access.inputs.size} inputs · ${access.outputs.size} outputs. Choose a source and destination, then enable MIDI Thru.`;
  }
  function detach(){
    if(access)access.removeEventListener('statechange',refresh);
    for(const entry of listeners.values()){entry.input.removeEventListener('midimessage',entry.listener);entry.input.removeEventListener('midistreamreset',entry.reset);}
    for(const entry of outputListeners.values())entry.output.removeEventListener('outputreset',entry.reset);
    listeners.clear();outputListeners.clear();access=null;
  }
  connect.addEventListener('click',async()=>{
    stop();detach();connect.disabled=true;
    try{
      access=await navigator.requestMIDIAccess({sysex:sysex.checked});access.addEventListener('statechange',refresh);refresh();
      status.textContent=`${access.inputs.size} inputs · ${access.outputs.size} outputs. Choose a source and destination, then enable MIDI Thru.`;
    }catch(error){status.textContent=`MIDI devices unavailable: ${(error as Error).message}`;}
    finally{connect.disabled=typeof navigator.requestMIDIAccess!=='function';}
  });
  inputMenu.addEventListener('change',()=>{stop();refresh();status.textContent='MIDI Thru off.';});
  outputMenu.addEventListener('change',()=>{stop();refresh();status.textContent='MIDI Thru off.';});
  enabled.addEventListener('change',()=>{
    if(!enabled.checked){stop();status.textContent='MIDI Thru off. Routed notes released.';return;}
    activeOutput=access?.outputs.get(outputMenu.value)||null;
    if(!activeOutput||!access?.inputs.has(inputMenu.value)){stop();return;}
    void activeOutput.open().catch(error=>{stop();status.textContent=`MIDI output unavailable: ${(error as Error).message}`;});
    count=0;status.textContent='MIDI Thru on.';
  });
  sysex.addEventListener('change',()=>{stop();detach();refresh();status.textContent='Connect MIDI devices again to apply the SysEx setting.';});
  find<HTMLButtonElement>('midi-thru-release').addEventListener('click',()=>{stop();status.textContent='MIDI Thru off. Routed notes released.';});
  window.addEventListener('pagehide',stop);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();status.textContent='MIDI Thru paused while the player is hidden.';}});
  if(typeof navigator.requestMIDIAccess!=='function'){
    connect.disabled=true;status.textContent='MIDI devices are unavailable in this browser. MIDI files and the onscreen keyboard still work.';
  }
  refresh();
}
