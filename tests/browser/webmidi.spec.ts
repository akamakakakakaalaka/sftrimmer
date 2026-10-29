import {test, expect} from '@playwright/test';

test('native CoreMIDI sources deliver complete Web MIDI input events', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'requestMIDIAccess', {value:undefined, configurable:true});
    (window as any).webkit = {messageHandlers:{project128:{postMessage:()=>{}}}};
  });
  await page.goto('/');
  await expect.poll(()=>page.evaluate(()=>typeof navigator.requestMIDIAccess)).toBe('function');
  const received=await page.evaluate(async()=>{
    const w=window as any;
    w.nativeMIDIPorts([{id:'keyboard-1',name:'Keyboard',manufacturer:'Test maker',slot:0}]);
    const access=await navigator.requestMIDIAccess();
    const input=access.inputs.get('keyboard-1')!;
    const messages:number[][]=[];
    input.onmidimessage=event=>messages.push(Array.from(event.data!));
    w.nativeMIDI([0x90,60],1000,0);
    w.nativeMIDI([100,61,0xf8,0xf9,0xfd,90,0xf0,1,2,0xf7,0x80,60,0],1001,0);
    return {messages,name:input.name,manufacturer:input.manufacturer,outputs:access.outputs.size,connection:input.connection};
  });
  expect(received).toEqual({messages:[[0x90,60,100],[0xf8],[0x90,61,90],[0x80,60,0]],name:'Keyboard',manufacturer:'Test maker',outputs:0,connection:'open'});
});

test('SysEx access, close and reconnect stay independent', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true});
    (window as any).webkit={messageHandlers:{project128:{postMessage:()=>{}}}};
  });
  await page.goto('/');
  await expect.poll(()=>page.evaluate(()=>typeof navigator.requestMIDIAccess)).toBe('function');
  const result=await page.evaluate(async()=>{
    const w=window as any,source={id:'device-a',name:'A',slot:2};
    w.nativeMIDIPorts([source]);
    const standard=await navigator.requestMIDIAccess(),sysex=await navigator.requestMIDIAccess({sysex:true});
    const a=standard.inputs.get('device-a')!,b=sysex.inputs.get('device-a')!;
    const plain:number[][]=[],extended:number[][]=[];
    a.onmidimessage=e=>plain.push(Array.from(e.data!));b.onmidimessage=e=>extended.push(Array.from(e.data!));
    w.nativeMIDI([0xf0,0x7e,0x7f,9,1,0xf7],1,2);
    await a.close();w.nativeMIDI([0x90,60,100],2,2);
    await a.open();w.nativeMIDI([0x90,61,100],3,2);
    w.nativeMIDIPorts([]);const disconnected={state:a.state,connection:a.connection,size:standard.inputs.size};
    w.nativeMIDIPorts([source]);w.nativeMIDI([0x90,62,100],4,2);
    const reconnected={same:a===standard.inputs.get('device-a'),state:a.state,connection:a.connection};
    return {plain,extended,disconnected,reconnected,sysexEnabled:sysex.sysexEnabled};
  });
  expect(result).toEqual({plain:[[0x90,61,100],[0x90,62,100]],extended:[[0xf0,0x7e,0x7f,9,1,0xf7],[0x90,60,100],[0x90,61,100],[0x90,62,100]],disconnected:{state:'disconnected',connection:'pending',size:0},reconnected:{same:true,state:'connected',connection:'open'},sysexEnabled:true});
});

test('a regular browser keeps its existing Web MIDI implementation', async ({page})=>{
  await page.addInitScript(()=>{
    (window as any).__originalMIDI=()=>Promise.resolve({marker:'browser'});
    Object.defineProperty(navigator,'requestMIDIAccess',{value:(window as any).__originalMIDI,configurable:true});
  });
  await page.goto('/');
  expect(await page.evaluate(()=>navigator.requestMIDIAccess===(window as any).__originalMIDI)).toBe(true);
});

test('a Safari-like page without a native host does not invent hardware access', async ({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true}));
  await page.goto('/');
  expect(await page.evaluate(()=>typeof navigator.requestMIDIAccess)).toBe('undefined');
  await expect(page.locator('#keyboard')).toBeVisible();
});

test('device replacement and SysEx endings cannot leak partial messages', async ({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true});
    (window as any).webkit={messageHandlers:{project128:{postMessage:()=>{}}}};
  });
  await page.goto('/');
  await expect.poll(()=>page.evaluate(()=>typeof navigator.requestMIDIAccess)).toBe('function');
  const messages=await page.evaluate(async()=>{
    const w=window as any;
    w.nativeMIDIPorts([{id:'a',name:'A',slot:0},{id:'b',name:'B',slot:1}]);
    const access=await navigator.requestMIDIAccess({sysex:true}),events:{id:string;data:number[]}[]=[];
    const listen=(id:string)=>{access.inputs.get(id)!.onmidimessage=e=>events.push({id,data:Array.from(e.data!)});};
    listen('a');listen('b');
    w.nativeMIDI([0x90,60],1,0);w.nativeMIDI([100],1,1);w.nativeMIDI([90],2,0);
    w.nativeMIDI([0x90,65],3,0);
    w.nativeMIDIPorts([{id:'b',name:'B',slot:1},{id:'c',name:'C',slot:0},{id:'spoof',name:'Same slot',slot:0}]);
    listen('c');w.nativeMIDI([100],4,0);w.nativeMIDI([0x90,72,100],5,0);
    w.nativeMIDI([0xf0,1,0xf7,2,3],6,0);
    return {events,ids:[...access.inputs.keys()]};
  });
  expect(messages).toEqual({events:[{id:'a',data:[0x90,60,90]},{id:'c',data:[0x90,72,100]},{id:'c',data:[0xf0,1,0xf7]}],ids:['b','c']});
});

test('Web MIDI input can forward messages to an explicitly selected CoreMIDI output', async ({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true});
    (window as any).__sent=[];
    (window as any).webkit={messageHandlers:{project128:{postMessage:(message:unknown)=>(window as any).__sent.push(message)}}};
  });
  await page.goto('/');
  await expect.poll(()=>page.evaluate(()=>typeof navigator.requestMIDIAccess)).toBe('function');
  const result=await page.evaluate(async()=>{
    const w=window as any;
    w.nativeMIDIPorts([{id:'keys',name:'Keys',slot:0}],[{id:'synth',name:'Hardware synth',manufacturer:'Maker'}]);
    const access=await navigator.requestMIDIAccess(),output=access.outputs.get('synth')!;
    access.inputs.get('keys')!.onmidimessage=e=>output.send(e.data!,e.timeStamp);
    w.nativeMIDI([0x90,64,100],1,0);
    const errors:string[]=[];
    for(const send of [()=>output.send([0x90,60]),()=>output.send([0xf0,0x7e,0xf7]),()=>output.send([0x90,60,100],performance.now()+1000)]){
      try{send();errors.push('accepted');}catch(error){errors.push((error as Error).name);}
    }
    const connection=output.connection;
    w.nativeMIDIPorts([],[]);
    try{output.send([0x80,64,0]);}catch(error){errors.push((error as Error).name);}
    return {sent:w.__sent.filter((m:any)=>m.command==='midiSend'),errors,connection,state:output.state,name:output.name};
  });
  expect(result).toEqual({sent:[{command:'midiSend',destination:'synth',data:[0x90,64,100]}],errors:['TypeError','InvalidAccessError','NotSupportedError','InvalidStateError'],connection:'open',state:'disconnected',name:'Hardware synth'});
});

test('MIDI Thru menus route only the chosen input and release held notes when switched off', async ({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true});
    (window as any).__sent=[];
    (window as any).webkit={messageHandlers:{project128:{postMessage:(m:unknown)=>(window as any).__sent.push(m)}}};
  });
  await page.goto('/');await page.locator('#tab-midi').click();
  await expect(page.locator('#midi-thru-enabled')).toBeVisible();
  await expect(page.locator('#midi-thru-enabled')).not.toBeChecked();
  await page.evaluate(()=>(window as any).nativeMIDIPorts([{id:'a',name:'Keyboard A',slot:0},{id:'b',name:'Keyboard B',slot:1}],[{id:'out',name:'Synthesizer'}]));
  await page.locator('#midi-connect').click();
  await page.locator('#midi-thru-input').selectOption('a');
  await page.locator('#midi-thru-output').selectOption('out');
  await page.evaluate(()=>(window as any).nativeMIDI([0x90,60,100],0,0));
  expect(await page.evaluate(()=>(window as any).__sent.filter((m:any)=>m.command==='midiSend'))).toEqual([]);
  await page.locator('#midi-thru-enabled').check();
  await page.evaluate(()=>{(window as any).nativeMIDI([0x90,64,100],0,0);(window as any).nativeMIDI([0x90,65,100],0,1);});
  await page.locator('#midi-thru-enabled').uncheck();
  expect(await page.evaluate(()=>(window as any).__sent.filter((m:any)=>m.command==='midiSend'))).toEqual([
    {command:'midiSend',destination:'out',data:[0x90,64,100]},
    {command:'midiSend',destination:'out',data:[0x80,64,0]}
  ]);
});

test('synthetic synth panic never becomes hardware MIDI and duplicate notes remain releasable', async ({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true});
    (window as any).__sent=[];(window as any).webkit={messageHandlers:{project128:{postMessage:(m:unknown)=>(window as any).__sent.push(m)}}};
  });
  await page.goto('/');await page.locator('#tab-midi').click();
  await page.evaluate(()=>(window as any).nativeMIDIPorts([{id:'a',name:'A',slot:0},{id:'b',name:'B',slot:1}],[{id:'out',name:'Out'}]));
  await page.locator('#midi-connect').click();await page.locator('#midi-thru-input').selectOption('a');await page.locator('#midi-thru-output').selectOption('out');await page.locator('#midi-thru-enabled').check();
  await page.evaluate(()=>{
    const w=window as any;
    w.nativeMIDI([0x90,60,100,0x90,60,90,0x80,60,0],0,0);
    w.nativeMIDIPorts([{id:'a',name:'A',slot:0}],[{id:'out',name:'Out'}]);
    w.nativeMIDI([0xb0,120,0,0xb0,123,0],0,0,true,false);
  });
  await expect(page.locator('#midi-thru-enabled')).toBeChecked();
  await page.locator('#midi-thru-enabled').uncheck();
  expect(await page.evaluate(()=>(window as any).__sent.filter((m:any)=>m.command==='midiSend').map((m:any)=>m.data))).toEqual([[0x90,60,100],[0x90,60,90],[0x80,60,0],[0x80,60,0]]);
});

test('an input stream reset releases only routed notes and output errors require explicit resume', async ({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true});
    (window as any).__sent=[];(window as any).webkit={messageHandlers:{project128:{postMessage:(m:unknown)=>(window as any).__sent.push(m)}}};
  });
  await page.goto('/');await page.locator('#tab-midi').click();
  await page.evaluate(()=>(window as any).nativeMIDIPorts([{id:'a',name:'A',slot:0}],[{id:'out',name:'Out'}]));
  await page.locator('#midi-connect').click();await page.locator('#midi-thru-input').selectOption('a');await page.locator('#midi-thru-output').selectOption('out');await page.locator('#midi-thru-enabled').check();
  await page.evaluate(()=>{const w=window as any;w.nativeMIDI([0x90,60,100],0,0);w.nativeMIDI([0xb0,120,0,0xb0,123,0],0,0,true,true);});
  await expect(page.locator('#midi-thru-enabled')).not.toBeChecked();
  expect(await page.evaluate(()=>(window as any).__sent.filter((m:any)=>m.command==='midiSend').map((m:any)=>m.data))).toEqual([[0x90,60,100],[0x80,60,0]]);
  const result=await page.evaluate(async()=>{
    const w=window as any,access=await navigator.requestMIDIAccess(),output=access.outputs.get('out')!;
    w.nativeMIDIOutputReset('out');let blocked='';try{output.send([0x90,61,100]);}catch(error){blocked=(error as Error).name;}
    await output.open();output.send([0x90,62,100]);
    return{blocked,resumes:w.__sent.filter((m:any)=>m.command==='midiOutputResume').length};
  });
  expect(result).toEqual({blocked:'InvalidStateError',resumes:1});
});
