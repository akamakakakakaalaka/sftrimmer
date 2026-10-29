/** Web MIDI input subset for the first-party native CoreMIDI transport.
 * No native host means no polyfill. Output forwards complete messages immediately.
 */
export interface CoreMIDISource {id:string;name:string;manufacturer?:string;version?:string;slot:number}
export type CoreMIDIDestination=Omit<CoreMIDISource,'slot'>;
type StateEvent = Event & {readonly port:CoreMIDIInput|CoreMIDIOutput};
type MessageEvent = Event & {readonly data:Uint8Array;readonly receivedTime:number};

class PortMap<T> implements ReadonlyMap<string,T> {
  constructor(private readonly ports:Map<string,T>) {}
  get size(){return this.ports.size;}
  get(key:string){return this.ports.get(key);}
  has(key:string){return this.ports.has(key);}
  entries(){return this.ports.entries();}
  keys(){return this.ports.keys();}
  values(){return this.ports.values();}
  [Symbol.iterator](){return this.ports[Symbol.iterator]();}
  forEach(callback:(value:T,key:string,map:ReadonlyMap<string,T>)=>void,thisArg?:unknown){this.ports.forEach((value,key)=>callback.call(thisArg,value,key,this));}
}

class StateTarget extends EventTarget {
  private handler:((event:StateEvent)=>unknown)|null=null;
  get onstatechange(){return this.handler;}
  set onstatechange(value:((event:StateEvent)=>unknown)|null){
    if(this.handler)this.removeEventListener('statechange',this.handler as EventListener);
    this.handler=typeof value==='function'?value:null;
    if(this.handler)this.addEventListener('statechange',this.handler as EventListener);
  }
  announce(port:CoreMIDIInput|CoreMIDIOutput){this.dispatchEvent(Object.assign(new Event('statechange'),{port}));}
}

/** Complete MIDI messages only; SysEx requires the access object's explicit opt-in. */
export function validateMIDIOutput(data:unknown,sysexEnabled:boolean):number[]{
  if(!Array.isArray(data)&&!(data instanceof Uint8Array))throw new TypeError('MIDI data must be an array of bytes.');
  if(data.length>65535)throw new RangeError('A MIDI output send is limited to 65535 bytes.');
  const bytes=Array.from(data);let needed=0,sysex=false;
  for(const byte of bytes){
    if(!Number.isInteger(byte)||byte<0||byte>255)throw new TypeError('Invalid MIDI byte.');
    if(byte>=0xf8){if(byte===0xf9||byte===0xfd)throw new TypeError('Undefined MIDI status.');continue;}
    if(sysex){if(byte===0xf7){sysex=false;continue;}if(byte<0x80)continue;throw new TypeError('Invalid SysEx message.');}
    if(needed){if(byte>=0x80)throw new TypeError('Incomplete MIDI message.');needed--;continue;}
    if(byte<0x80)throw new TypeError('MIDI output requires complete messages with status bytes.');
    if(byte<0xf0){needed=(byte&0xf0)===0xc0||(byte&0xf0)===0xd0?1:2;continue;}
    if(byte===0xf0){if(!sysexEnabled)throw new DOMException('Request SysEx access before sending SysEx.','InvalidAccessError');sysex=true;continue;}
    if(byte===0xf1||byte===0xf3){needed=1;continue;}if(byte===0xf2){needed=2;continue;}
    if(byte!==0xf6)throw new TypeError('Invalid MIDI status.');
  }
  if(needed||sysex)throw new TypeError('Incomplete MIDI message.');
  return bytes;
}

export class CoreMIDIOutput extends StateTarget {
  readonly type='output';private connected=false;private wantedOpen=false;
  constructor(private info:CoreMIDIDestination,private readonly owner:CoreMIDIAccess,private readonly sendNative:(message:unknown)=>void){super();}
  get id(){return this.info.id;}get name(){return this.info.name;}
  get manufacturer(){return this.info.manufacturer||'';}get version(){return this.info.version||'';}
  get state(){return this.connected?'connected':'disconnected';}
  get connection(){return !this.wantedOpen?'closed':this.connected?'open':'pending';}
  async open(){if(!this.wantedOpen){this.wantedOpen=true;this.changed();}return this;}
  async close(){if(this.wantedOpen){this.wantedOpen=false;this.changed();}return this;}
  update(info:CoreMIDIDestination,connected:boolean){this.info=info;if(this.connected!==connected){this.connected=connected;this.changed();}}
  private changed(){this.announce(this);this.owner.announce(this);}
  send(data:unknown,timestamp?:number){
    if(!this.connected)throw new DOMException('The MIDI output is disconnected.','InvalidStateError');
    const bytes=validateMIDIOutput(data,this.owner.sysexEnabled);
    if(timestamp!==undefined&&(!Number.isFinite(timestamp)||typeof timestamp!=='number'))throw new TypeError('Invalid MIDI timestamp.');
    if(timestamp!==undefined&&timestamp>performance.now()+1)throw new DOMException('This bridge currently supports immediate MIDI output.','NotSupportedError');
    if(!bytes.length)return;void this.open();
    this.sendNative({command:'midiSend',destination:this.id,data:bytes});
  }
  clear(){throw new DOMException('Output queue cancellation is unavailable; this bridge sends immediately.','NotSupportedError');}
}

export class CoreMIDIInput extends StateTarget {
  readonly type='input';
  private connected=false;
  private wantedOpen=false;
  private midiHandler:((event:MessageEvent)=>unknown)|null=null;
  constructor(private info:CoreMIDISource,private readonly owner:CoreMIDIAccess){super();}
  get id(){return this.info.id;}
  get name(){return this.info.name;}
  get manufacturer(){return this.info.manufacturer||'';}
  get version(){return this.info.version||'';}
  get state(){return this.connected?'connected':'disconnected';}
  get connection(){return !this.wantedOpen?'closed':this.connected?'open':'pending';}
  get onmidimessage(){return this.midiHandler;}
  set onmidimessage(value:((event:MessageEvent)=>unknown)|null){
    if(this.midiHandler)this.removeEventListener('midimessage',this.midiHandler as EventListener);
    this.midiHandler=typeof value==='function'?value:null;
    if(this.midiHandler)this.addEventListener('midimessage',this.midiHandler as EventListener);
  }
  override addEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:boolean|AddEventListenerOptions){
    super.addEventListener(type,callback,options);
    if(type==='midimessage'&&callback)void this.open();
  }
  async open(){if(!this.wantedOpen){this.wantedOpen=true;this.changed();}return this;}
  async close(){if(this.wantedOpen){this.wantedOpen=false;this.changed();}return this;}
  update(info:CoreMIDISource,connected:boolean){this.info=info;if(this.connected!==connected){this.connected=connected;this.changed();}}
  private changed(){this.announce(this);this.owner.announce(this);}
  deliver(bytes:number[]){
    if(!this.connected||!this.wantedOpen)return;
    const time=performance.now();
    const event=Object.assign(new Event('midimessage'),{data:Uint8Array.from(bytes),receivedTime:time});
    Object.defineProperty(event,'timeStamp',{value:time});
    this.dispatchEvent(event);
  }
}

export class CoreMIDIAccess extends StateTarget {
  private readonly connected=new Map<string,CoreMIDIInput>();
  private readonly known=new Map<string,CoreMIDIInput>();
  readonly inputs=new PortMap(this.connected);
  private readonly connectedOutputs=new Map<string,CoreMIDIOutput>();
  private readonly knownOutputs=new Map<string,CoreMIDIOutput>();
  readonly outputs=new PortMap(this.connectedOutputs);
  constructor(readonly sysexEnabled:boolean,private readonly sendNative:(message:unknown)=>void){super();}
  synchronize(sources:CoreMIDISource[]){
    const current=new Map(sources.map(source=>[source.id,source]));
    for(const [id,input] of [...this.connected])if(!current.has(id)){
      this.connected.delete(id);
      input.update({id,name:input.name,manufacturer:input.manufacturer,version:input.version,slot:-1},false);
    }
    for(const source of sources){
      let input=this.known.get(source.id);
      if(!input){input=new CoreMIDIInput(source,this);this.known.set(source.id,input);}
      this.connected.set(source.id,input);input.update(source,true);
    }
  }
  synchronizeOutputs(destinations:CoreMIDIDestination[]){
    const current=new Set(destinations.map(output=>output.id));
    for(const [id,output] of [...this.connectedOutputs])if(!current.has(id)){
      this.connectedOutputs.delete(id);output.update({id,name:output.name,manufacturer:output.manufacturer,version:output.version},false);
    }
    for(const info of destinations){
      let output=this.knownOutputs.get(info.id);
      if(!output){output=new CoreMIDIOutput(info,this,this.sendNative);this.knownOutputs.set(info.id,output);}
      this.connectedOutputs.set(info.id,output);output.update(info,true);
    }
  }
  deliver(source:CoreMIDISource,bytes:number[]){
    if(bytes[0]===0xf0&&!this.sysexEnabled)return;
    this.connected.get(source.id)?.deliver(bytes);
  }
}

/** Separate parsers prevent a second device completing another device's message. */
class MIDIStream {
  private running=0;
  private status=0;
  private needed=0;
  private data:number[]=[];
  private sysex:number[]|null=null;
  feed(bytes:ArrayLike<number>,emit:(message:number[])=>void){
    for(let i=0;i<bytes.length;i++){
      const byte=bytes[i];if(!Number.isInteger(byte)||byte<0||byte>255)continue;
      if(byte>=0xf8){emit([byte]);continue;}
      if(this.sysex){
        if(byte===0xf7){this.sysex.push(byte);emit(this.sysex);this.sysex=null;continue;}
        if(byte<0x80){if(this.sysex.length<1_048_576)this.sysex.push(byte);else this.sysex=null;continue;}
        this.sysex=null;
      }
      if(byte>=0x80){
        this.status=byte;this.data=[];
        if(byte===0xf0){this.running=0;this.status=0;this.needed=0;this.sysex=[byte];continue;}
        if(byte<0xf0){this.running=byte;this.needed=(byte&0xf0)===0xc0||(byte&0xf0)===0xd0?1:2;}
        else{
          this.running=0;this.needed=byte===0xf2?2:byte===0xf1||byte===0xf3?1:0;
          if(byte===0xf6)emit([byte]);
          if(!this.needed)this.status=0;
        }
        continue;
      }
      if(!this.status&&this.running){this.status=this.running;this.needed=(this.status&0xf0)===0xc0||(this.status&0xf0)===0xd0?1:2;}
      if(!this.status)continue;this.data.push(byte);
      if(this.data.length===this.needed){emit([this.status,...this.data]);this.data=[];this.status=0;}
    }
  }
}

export class CoreMIDIWebInputBridge {
  private sources:CoreMIDISource[]=[];
  private destinations:CoreMIDIDestination[]=[];
  private readonly accesses=new Map<boolean,CoreMIDIAccess>();
  private readonly parsers=new Map<string,MIDIStream>();
  constructor(private readonly sendNative:(message:unknown)=>void){}
  async requestMIDIAccess(options:{sysex?:boolean}={}){
    const enabled=options?.sysex===true;
    let access=this.accesses.get(enabled);
    if(!access){access=new CoreMIDIAccess(enabled,this.sendNative);access.synchronize(this.sources);access.synchronizeOutputs(this.destinations);this.accesses.set(enabled,access);}
    return access;
  }
  setSources(raw:unknown){
    if(!Array.isArray(raw))return;
    const sources:CoreMIDISource[]=[],ids=new Set<string>(),slots=new Set<number>();
    for(const item of raw.slice(0,64)){
      if(!item||typeof item!=='object'||typeof item.id!=='string'||!item.id||item.id.length>256
        ||typeof item.name!=='string'||!Number.isInteger(item.slot)||item.slot<0||item.slot>7
        ||ids.has(item.id)||slots.has(item.slot))continue;
      ids.add(item.id);slots.add(item.slot);
      sources.push({id:item.id,name:item.name.slice(0,256),manufacturer:typeof item.manufacturer==='string'?item.manufacturer.slice(0,256):'',version:typeof item.version==='string'?item.version.slice(0,128):'',slot:item.slot});
    }
    const old=new Map(this.sources.map(source=>[source.id,source.slot]));
    for(const id of this.parsers.keys())if(!sources.some(source=>source.id===id&&source.slot===old.get(id)))this.parsers.delete(id);
    this.sources=sources;
    for(const access of this.accesses.values())access.synchronize(sources);
  }
  setDestinations(raw:unknown){
    if(!Array.isArray(raw))return;
    const seen=new Set<string>(),destinations:CoreMIDIDestination[]=[];
    for(const item of raw.slice(0,64)){
      if(!item||typeof item.id!=='string'||!item.id||item.id.length>256||seen.has(item.id)||typeof item.name!=='string')continue;
      seen.add(item.id);destinations.push({id:item.id,name:item.name.slice(0,256),manufacturer:typeof item.manufacturer==='string'?item.manufacturer.slice(0,256):'',version:typeof item.version==='string'?item.version.slice(0,128):''});
    }
    this.destinations=destinations;for(const access of this.accesses.values())access.synchronizeOutputs(destinations);
  }
  receive(slot:number,bytes:unknown){
    if(!this.accesses.size||(!Array.isArray(bytes)&&!(bytes instanceof Uint8Array))||bytes.length>1024)return;
    const source=this.sources.find(source=>source.slot===slot);if(!source)return;
    let parser=this.parsers.get(source.id);if(!parser){parser=new MIDIStream();this.parsers.set(source.id,parser);}
    parser.feed(bytes,message=>{for(const access of this.accesses.values())access.deliver(source,message);});
  }
}

/** The native host has already authorized its own bundled, token-scoped page.
 * This is not a way to grant CoreMIDI to arbitrary Safari websites.
 */
export function installCoreMIDIWebMIDI(navigator:Navigator,nativeHost?:{postMessage:(message:unknown)=>void}){
  if(!nativeHost||typeof navigator.requestMIDIAccess==='function')return null;
  const bridge=new CoreMIDIWebInputBridge(message=>nativeHost.postMessage(message));
  Object.defineProperty(navigator,'requestMIDIAccess',{value:bridge.requestMIDIAccess.bind(bridge),configurable:true});
  nativeHost.postMessage({command:'midiPorts'});
  return bridge;
}
