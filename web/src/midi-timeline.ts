/** A MIDI message scheduled on the synthesizer's absolute, seconds-based clock. */
export interface TimedMidiEvent {
  time: number;
  message: number[];
  /** Port number multiplied by 16, added to a channel-voice message's channel. */
  partOffset: number;
}

export interface MidiTimeline {
  events: TimedMidiEvent[];
  duration: number;
  format: number;
  sequenceCount: number;
}

interface TickEvent {
  tick: number;
  track: number;
  order: number;
  message?: number[];
  partOffset: number;
  tempo?: number;
}

class Reader {
  position = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  get remaining() { return this.bytes.length - this.position; }
  take(count: number) {
    if (!Number.isInteger(count) || count < 0 || count > this.remaining) {
      throw new Error('Truncated MIDI data.');
    }
    const out = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return out;
  }
  byte() { return this.take(1)[0]; }
  uint(count: number) {
    let result = 0;
    for (const byte of this.take(count)) result = result * 256 + byte;
    return result;
  }
  tag() { return String.fromCharCode(...this.take(4)); }
  variable() {
    let result = 0;
    for (let index = 0; index < 4; index++) {
      const byte = this.byte();
      result = result * 128 + (byte & 127);
      if ((byte & 128) === 0) return result;
    }
    throw new Error('Invalid MIDI variable-length quantity.');
  }
}

function readTrack(bytes: Uint8Array, track: number) {
  const input = new Reader(bytes);
  const events: TickEvent[] = [];
  let tick = 0;
  let runningStatus = 0;
  let partOffset = 0;
  let order = 0;
  let sysex: number[] | undefined;
  while (input.remaining) {
    tick += input.variable();
    const first = input.byte();
    let status = first;
    let firstData: number | undefined;
    if (status < 128) {
      if (!runningStatus) throw new Error('MIDI data byte has no running status.');
      firstData = status;
      status = runningStatus;
    }
    if (status >= 128 && status <= 239) {
      runningStatus = status;
      const dataLength = (status & 240) === 192 || (status & 240) === 208 ? 1 : 2;
      const message = [status];
      if (firstData !== undefined) message.push(firstData);
      while (message.length <= dataLength) {
        const byte = input.byte();
        if (byte > 127) throw new Error('Invalid MIDI channel data byte.');
        message.push(byte);
      }
      events.push({ tick, track, order: order++, message, partOffset });
    } else if (status === 255) {
      runningStatus = 0;
      const type = input.byte();
      const data = input.take(input.variable());
      if (type === 47) {
        if (data.length !== 0) throw new Error('Invalid MIDI end-of-track event.');
        break;
      }
      if (type === 81) {
        if (data.length !== 3) throw new Error('Invalid MIDI tempo event.');
        const tempo = data[0] * 65536 + data[1] * 256 + data[2];
        if (!tempo) throw new Error('MIDI tempo must be positive.');
        events.push({ tick, track, order: order++, tempo, partOffset });
      } else if (type === 33) {
        if (data.length !== 1 || data[0] > 7) {
          throw new Error('MIDI port is outside the supported eight ports (0–7).');
        }
        partOffset = data[0] * 16;
      }
    } else if (status === 240 || status === 247) {
      runningStatus = 0;
      const data = Array.from(input.take(input.variable()));
      if (status === 240) {
        if (sysex) throw new Error('A new MIDI SysEx began before the previous message ended.');
        sysex = [240, ...data];
      } else if (sysex) {
        for (const byte of data) sysex.push(byte);
      } else {
        // An F7 escape is an already encoded raw message, not another F7 prefix.
        if (data.length) events.push({ tick, track, order: order++, message: data, partOffset });
        continue;
      }
      if (sysex.at(-1) === 247) {
        events.push({ tick, track, order: order++, message: sysex, partOffset });
        sysex = undefined;
      }
    } else {
      throw new Error(`Unsupported MIDI file event status 0x${status.toString(16)}.`);
    }
  }
  if (sysex) throw new Error('Unterminated MIDI SysEx message.');
  return { events, endTick: tick };
}

/**
 * Decode SMF 0/1 or one independent SMF-2 pattern. Format 2's default is its first
 * pattern; callers can request another pattern explicitly. All input views stay
 * read-only, and corrupt imports throw before a new timeline reaches playback.
 */
export function parseMidiTimeline(data: ArrayBuffer, sequenceIndex = 0): MidiTimeline {
  const file = new Reader(new Uint8Array(data));
  if (file.tag() !== 'MThd') throw new Error('Missing MIDI MThd header.');
  const headerSize = file.uint(4);
  if (headerSize < 6) throw new Error('Truncated MIDI header.');
  const header = new Reader(file.take(headerSize));
  const format = header.uint(2);
  const trackCount = header.uint(2);
  const division = header.uint(2);
  if (format > 2 || format === 0 && trackCount !== 1) throw new Error('Unsupported MIDI format or track count.');
  if (!trackCount) throw new Error('The MIDI file has no tracks.');
  if (!division) throw new Error('MIDI time division must be positive.');
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0 || sequenceIndex >= (format === 2 ? trackCount : 1)) {
    throw new Error('MIDI sequence index is outside the file.');
  }
  let secondsPerTick: number | undefined;
  if (division & 32768) {
    const frameCode = (division >> 8) - 256;
    const ticksPerFrame = division & 255;
    const framesPerSecond = frameCode === -29 ? 30000 / 1001 : -frameCode;
    if (![-24, -25, -29, -30].includes(frameCode) || !ticksPerFrame) {
      throw new Error('Unsupported SMPTE MIDI time division.');
    }
    secondsPerTick = 1 / (framesPerSecond * ticksPerFrame);
  }
  const ticks: TickEvent[] = [];
  let endTick = 0;
  for (let track = 0; track < trackCount; track++) {
    if (file.tag() !== 'MTrk') throw new Error('Missing MIDI MTrk chunk.');
    const body = file.take(file.uint(4));
    if (format !== 2 || track === sequenceIndex) {
      const parsed = readTrack(body, track);
      for (const event of parsed.events) ticks.push(event);
      endTick = Math.max(endTick, parsed.endTick);
    }
  }
  ticks.sort((a,b) => a.tick - b.tick || a.track - b.track || a.order - b.order);
  let previousTick = 0;
  let time = 0;
  let tempo = 500_000;
  const events: TimedMidiEvent[] = [];
  for (const event of ticks) {
    time += (event.tick - previousTick) * (secondsPerTick ?? tempo / (division * 1_000_000));
    previousTick = event.tick;
    if (event.tempo !== undefined) tempo = event.tempo;
    if (event.message) events.push({ time, message: event.message, partOffset: event.partOffset });
  }
  const duration = time + (endTick - previousTick) * (secondsPerTick ?? tempo / (division * 1_000_000));
  return { events, duration, format, sequenceCount: format === 2 ? trackCount : 1 };
}
