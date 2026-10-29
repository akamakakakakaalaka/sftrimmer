/** Incremental MIDI 1 byte-stream decoder for CoreMIDI packets and USB bursts. */
export class MidiStreamDecoder {
  private running=0;
  private pending:number[]=[];
  private expected=0;
  private sysex:number[]|undefined;
  reset():void {this.running=0;this.pending=[];this.expected=0;this.sysex=undefined;}
  push(bytes:readonly number[]):number[][] {
    const messages:number[][]=[];
    for(const byte of bytes){
      if(!Number.isInteger(byte)||byte<0||byte>255){this.reset();continue;}
      // Real-time bytes may occur between any data bytes, including SysEx.
      if(byte>=0xf8){if(byte===0xff)messages.push([byte]);continue;}
      if(this.sysex){
        if(byte===0xf7){this.sysex.push(byte);messages.push(this.sysex);this.sysex=undefined;continue;}
        if(byte<128){if(this.sysex.length<1_048_576)this.sysex.push(byte);else this.reset();continue;}
        this.sysex=undefined;
      }
      if(byte>=128){
        this.pending=[];
        if(byte===0xf0){this.running=0;this.sysex=[byte];continue;}
        if(byte===0xf7){this.running=0;continue;}
        if(byte<0xf0){this.running=byte;this.expected=(byte&0xf0)===0xc0||(byte&0xf0)===0xd0?1:2;}
        else{this.running=0;this.expected=byte===0xf1||byte===0xf3?1:byte===0xf2?2:0;}
        if(this.expected===0){messages.push([byte]);continue;}
        this.pending=[byte];continue;
      }
      if(!this.pending.length){if(!this.running)continue;this.pending=[this.running];this.expected=(this.running&0xf0)===0xc0||(this.running&0xf0)===0xd0?1:2;}
      this.pending.push(byte);
      if(this.pending.length===this.expected+1){messages.push(this.pending);this.pending=[];}
    }
    return messages;
  }
}
