import './style.css';
import { PlayerEngine } from './engine';
import { loadState, saveState, restoreState, createPreset, applyPreset, parsePreset } from './state';
import { SCALES, requiresMicrotonalTuning } from './harmony';
import type { AppState, BankInfo, PartState, PlayerPosition, SavedPreset, PresetMapping } from './contracts';

const icons: Record<string, string> = {
  wave: '<path d="M3 12h2l2-7 4 14 3-16 3 14 2-5h2"/>',
  power: '<path d="M12 3v8M6.3 5.9a8 8 0 1 0 11.4 0"/>',
  music: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  folder: '<path d="M3 7V5h6l2 3h10v12H3Z"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  rewind: '<path d="M5 5v14m14-14L8 12l11 7Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  sliders: '<path d="M5 3v7m0 4v7m7-18v12m0 4v2m7-18v3m0 4v11M2 10h6m1 5h6m1-9h6"/>',
  keys: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M8 5v8h3V5m3 0v8h3V5M9 13v6m6-6v6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6Zm-4 9 3 3 5-6"/>',
};
const icon = (name: string) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.wave}</svg>`;
const escapeHTML = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const on = (selector: string, type: string, handler: EventListener) => $(selector).addEventListener(type, handler);
const formatTime = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
const formatBytes = (bytes: number) => bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
const noteName = (note: number) => `${['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][note % 12]}${Math.floor(note / 12) - 1}`;
const modeNames: Record<string,string> = {chromatic:'Chromatic · bypass',major:'Major',naturalMinor:'Natural minor',harmonicMinor:'Harmonic minor',melodicMinor:'Melodic minor',hijaz:'Hijaz',rast:'Rast · microtonal',bayati:'Bayati · microtonal',hirajoshi:'Hirajoshi',insen:'Insen'};
const themeNames: Record<string,string> = {dark:'Midnight',slate:'Slate',forest:'Forest',paper:'Paper'};
const engine = new PlayerEngine();
let state = loadState();
let audioReady = false;
let audioStarting = false;
let busy = 0;
let currentTab = 'perform';
let midiName = '';
let position: PlayerPosition = { current: 0, duration: 0, playing: false };
let baseNote = 48;
let velocity = 100;
let sustain = false;
let banks: BankInfo[] = [];
let pendingBanks: { data: ArrayBuffer; name: string }[] = [];
let sequenceCount = 1;
let pendingMidi: { data: ArrayBuffer; name: string } | null = null;
let savedPresets: SavedPreset[] = [];
const bankSources = new Map<string,{data:ArrayBuffer;name:string;converted?:ArrayBuffer}>();
const heldPointers = new Map<number,{part:number;note:number}>();
const heldKeys = new Map<string,{part:number;note:number}>();
const sounding = new Map<string,{part:number;note:number;count:number}>();
const sustained = new Map<string,{part:number;note:number}>();
const physicalKeys: Record<string,number> = {a:0,w:1,s:2,e:3,d:4,f:5,t:6,g:7,y:8,h:9,u:10,j:11,k:12,o:13,l:14,p:15,';':16,"'":17};
try {
  const stored = JSON.parse(localStorage.getItem('project128.presets') || '[]');
  if (Array.isArray(stored)) savedPresets = stored.map(item => parsePreset(JSON.stringify(item)));
} catch { /* A damaged optional library does not prevent the instrument from opening. */ }

$('#app').innerHTML = `
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><div class="brand-symbol">${icon('wave')}</div><div><div class="brand-title">PROJECT <span>128</span></div><div class="brand-caption">A LITTLE SPACE FOR EVERY SOUND</div></div></div>
    <div class="topbar-right"><div class="engine-status" id="engine-status"><span class="status-dot"></span><span id="engine-label">AUDIO OFF</span></div><button class="audio-button" id="start-audio">${icon('power')}<span>Start audio</span></button></div>
  </header>
  <nav class="navigation" aria-label="Main navigation"><div class="tabs" role="tablist"><button class="tab" id="tab-perform" data-tab="perform" role="tab" aria-selected="true" aria-controls="view-perform">Perform</button><button class="tab" id="tab-library" data-tab="library" role="tab" aria-selected="false" aria-controls="view-library">Library</button><button class="tab" id="tab-settings" data-tab="settings" role="tab" aria-selected="false" aria-controls="view-settings">Settings</button></div><span class="version">STANDALONE / 01</span></nav>
  <div class="error-banner" id="error-banner" role="alert" hidden></div>
  <main>
    <section class="view" id="view-perform" role="tabpanel" aria-labelledby="tab-perform">
      <div class="page-heading"><div><div class="eyebrow">Your performance space</div><h1>Make room for sound.</h1><p>Eight ports. 128 parts. One instrument.</p></div><div class="heading-meta"><span class="live-dot"></span><span id="assigned-count">000</span> ASSIGNED</div></div>
      <div class="performance-layout">
        <div class="performance-main">
          <section class="panel transport" aria-label="MIDI transport">
            <div class="transport-top"><div class="track-info"><div class="track-art">${icon('music')}</div><div><div class="track-name" id="track-name">Your next idea starts here</div><div class="track-detail" id="track-detail">Open a MIDI file, or play the keys below.</div></div></div><button class="icon-button" id="open-midi" aria-label="Open MIDI file" title="Open MIDI file">${icon('folder')}</button></div>
            <div class="transport-timeline"><div class="time-labels mono"><span id="current-time">0:00</span><span id="duration">0:00</span></div><input type="range" id="seek" min="0" max="1" step="0.01" value="0" disabled aria-label="Song position"></div>
            <div class="transport-bottom"><div class="playback-buttons"><button class="icon-button" id="rewind" aria-label="Return to beginning" title="Return to beginning" disabled>${icon('rewind')}</button><button class="icon-button" id="play" aria-label="Play MIDI" title="Play" disabled>${icon('play')}</button><button class="icon-button" id="pause" aria-label="Pause MIDI" title="Pause" disabled>${icon('pause')}</button><button class="icon-button" id="stop" aria-label="Stop MIDI" title="Stop" disabled>${icon('stop')}</button></div><label class="tempo-inline" for="tempo">TEMPO <input type="range" id="tempo" min="0.25" max="4" step="0.01" value="1"><output id="tempo-value">1.00×</output></label></div><label class="field" id="sequence-control" style="margin-top:15px" hidden>Independent sequence<select id="sequence"></select></label>
          </section>
          <section class="panel overview" aria-label="128-part overview"><div class="panel-header"><div class="panel-title">${icon('grid')}Part overview</div><span class="chip">8 PORTS × 16 CH</span></div><div class="overview-caption">Select a part to shape its sound. Numbers are MIDI channels.</div><div class="parts-grid" id="parts-grid"></div><div class="grid-legend"><span><i class="legend-box"></i>Selected</span><span><i class="legend-dot"></i>Bank assigned</span><span>All 128 parts are independent</span></div></section>
        </div>
        <aside class="panel part-inspector" aria-label="Selected part controls">
          <div class="panel-header"><div class="panel-title">${icon('sliders')}Selected part</div><label class="switch-label"><input type="checkbox" id="part-locked">Lock</label></div>
          <div class="part-identity"><div class="part-number"><span id="part-number">01</span><small id="part-port">PORT 1 · CH 1</small></div><div class="toggle-group"><button class="small-toggle" id="part-mute" aria-pressed="false">Mute</button><button class="small-toggle" id="part-solo" aria-pressed="false">Solo</button></div></div>
          <div class="inspector-section patch-section"><div class="select-stack"><label class="field">Soundbank<select id="part-bank"><option value="">No bank assigned</option></select></label><label class="field">Instrument<select id="part-patch"><option value="">Choose a soundbank first</option></select></label></div><div class="field-grid"><label class="field">BANK MSB<input id="part-msb" type="number" min="0" max="127" value="0"></label><label class="field">BANK LSB<input id="part-lsb" type="number" min="0" max="127" value="0"></label><label class="field">PROGRAM<input id="part-program" type="number" min="0" max="127" value="0"></label></div><div class="envelope-note">Panel values are saved controls; MIDI can recall another preset. Apply displayed settings to restore them.</div><button class="text-button" id="apply-part-settings" style="margin-top:7px">Apply displayed settings ${icon('arrow')}</button><div class="section-heading" style="margin:13px 0 0"><label class="switch-label"><input id="part-drums" type="checkbox">Percussion part</label><span class="subtle" style="font-size:9px">MIDI values 0–127</span></div></div>
          <div class="inspector-section mixer-section"><div class="range-field"><label class="field-label" for="part-volume">Volume<output id="part-volume-value">100</output></label><input id="part-volume" type="range" min="0" max="127" step="1" value="100"></div><div class="range-field"><label class="field-label" for="part-pan">Pan<output id="part-pan-value">Center</output></label><input id="part-pan" type="range" min="0" max="127" step="1" value="64"></div><div class="send-grid">${['reverb','chorus','delay'].map(name => `<div><label class="field-label" for="part-${name}">${name[0].toUpperCase()+name.slice(1)}<output id="part-${name}-value">0</output></label><input id="part-${name}" type="range" min="0" max="127" step="1" value="0"></div>`).join('')}</div></div>
          <div class="inspector-section envelope-section"><div class="section-heading"><span>Amplitude envelope</span><label class="switch-label"><input id="envelope-enabled" type="checkbox">Override</label></div><svg class="envelope-graph" viewBox="0 0 300 70" preserveAspectRatio="none" aria-label="Amplitude ADSR curve" role="img"><path class="graph-grid" d="M0 65H300M0 35H300M0 5H300M60 0V70M120 0V70M180 0V70M240 0V70"/><path id="envelope-fill" class="curve-fill"/><path id="envelope-curve" class="curve-line"/></svg><div class="envelope-fields"><label>Attack · s<input id="env-attack" type="number" min="0" max="20" step="0.01"></label><label>Decay · s<input id="env-decay" type="number" min="0" max="20" step="0.01"></label><label>Sustain · %<input id="env-sustain" type="number" min="0" max="100" step="1"></label><label>Release · s<input id="env-release" type="number" min="0" max="20" step="0.01"></label></div><div class="envelope-note" id="envelope-note">Original bank envelope. Enable override to use absolute values.</div></div>
          <div class="inspector-footer"><button class="text-button" id="open-drum-map">Drum key map ${icon('arrow')}</button><button class="text-button" id="save-part-preset">Save as preset ${icon('arrow')}</button></div>
        </aside>
        <section class="panel keyboard-panel" aria-label="Touch keyboard"><div class="keyboard-toolbar"><div class="panel-title">${icon('keys')}Play it your way</div><div class="keyboard-controls"><label class="velocity-control" for="velocity">VEL <input id="velocity" type="range" min="1" max="127" value="100"><output id="velocity-value">100</output></label><div class="octave-control"><button id="octave-down" aria-label="Keyboard octave down">−</button><span id="octave-label">C3 – C5</span><button id="octave-up" aria-label="Keyboard octave up">+</button></div><button class="small-toggle" id="sustain" aria-pressed="false">Sustain</button></div><span class="keyboard-help">A–K on your computer keyboard</span></div><div class="keyboard" id="keyboard"></div><div class="keyboard-bottom"><span id="keyboard-part">Playing part 01 · channel 1</span><button class="text-button" id="panic" style="font-size:9px">${icon('shield')}All notes off</button></div></section>
      </div>
    </section>
    <section class="view" id="view-library" role="tabpanel" aria-labelledby="tab-library" hidden>
      <div class="page-heading"><div><div class="eyebrow">Your sound collection</div><h1>A home for every voice.</h1><p>Load your banks. Keep your own sounds close.</p></div><span class="chip" id="library-count">0 BANKS</span></div>
      <div class="library-grid"><section class="panel"><div class="panel-header"><div class="panel-title">${icon('folder')}Soundbanks</div><button class="text-button" id="open-bank">${icon('upload')}Import bank</button></div><div id="bank-list"></div><div class="library-note" id="bank-provenance">Bundled sound: GeneralUser GS, a GM/GS bank by S. Christian Collins. This is not a Roland SC-88Pro bank. Imported SF2, SF3, and DLS banks stay independent.</div><div class="library-note"><label class="switch-label"><input id="auto-compress" type="checkbox">Compress imported SF2 to SF3 automatically</label><label class="field" style="margin-top:12px">Vorbis quality<select id="compression-quality"><option value="0.3">Compact · quality 0.3</option><option value="0.5" selected>Balanced · quality 0.5</option><option value="0.7">Higher fidelity · quality 0.7</option></select></label><div style="margin-top:10px">SF3 compression is lossy. The original stays available during this session; download it before closing.</div></div></section>
      <section class="panel"><div class="panel-header"><div class="panel-title">${icon('sliders')}Individual presets</div><button class="text-button" id="open-preset">${icon('upload')}Import</button></div><div class="preset-save"><input id="preset-name" type="text" maxlength="80" placeholder="Name the selected part…" aria-label="Preset name"><button class="button" id="create-preset">Save part</button></div><div id="preset-list"></div><div class="library-note">A preset holds one part’s bank, patch, envelope, sends, and drum map. Export uses the original .p128preset JSON format. KQ preset files are not supported.</div><section class="preset-mapping-section" aria-label="MIDI program mappings"><div class="section-heading"><span>MIDI program map</span><button class="text-button" id="open-preset-mapping">Map a preset ${icon('arrow')}</button></div><div class="subtle" id="mapping-selected-part"></div><p class="mapping-help">An exact saved app preset mapping takes priority over a soundbank patch change. Unmapped program changes select the normal bank patch. Part locks still apply.</p><div id="preset-mapping-list"></div><p class="mapping-help">Each mapping keeps a snapshot of the preset, including its bank, envelope, sends, and drum map. Removing the library preset leaves its mappings intact.</p></section></section></div>
    </section>
    <section class="view" id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
      <div class="page-heading"><div><div class="eyebrow">Keep things in tune</div><h1>Your instrument, your rules.</h1><p>Master settings stay with you when songs change.</p></div></div>
      <div class="settings-grid"><section class="panel settings-panel"><h2>Tuning & harmony</h2><p>Pitch overrides apply to melodic parts. Percussion keeps its original tuning.</p><div class="tuning-fields"><label class="field">Key shift · semitones<input id="key-shift" type="number" min="-48" max="48" step="1"></label><label class="field">Fine tune · cents<input id="fine-tune" type="number" min="-100" max="100" step="1"></label></div><div class="tuning-fields"><label class="field">Scale root<select id="root">${['C','C♯ / D♭','D','D♯ / E♭','E','F','F♯ / G♭','G','G♯ / A♭','A','A♯ / B♭','B'].map((name,i) => `<option value="${i}">${name}</option>`).join('')}</select></label><label class="field">Scale / mode<select id="mode">${Object.keys(SCALES).map(name => `<option value="${name}"${requiresMicrotonalTuning(name)?' disabled':''}>${modeNames[name] || name}${requiresMicrotonalTuning(name)?' · unavailable':''}</option>`).join('')}</select></label></div><div class="settings-note" id="harmony-note">Scale mapping changes live and MIDI notes. Chromatic leaves note classes unchanged.</div><div class="range-field" style="margin-top:20px"><label class="field-label" for="master-gain">Master output<output id="master-gain-value"></output></label><input id="master-gain" type="range" min="0" max="2" step="0.01"></div></section>
      <section class="panel settings-panel"><h2>Shared effect buses</h2><p>Shape the room around your parts. Each part controls its own send amount.</p>${[['delay-time','Delay time','0.05','2','0.01'],['delay-feedback','Delay feedback','0','0.9','0.01'],['delay-mix','Delay mix','0','1','0.01'],['flanger-mix','Flanger mix','0','1','0.01'],['crusher-bits','Bitcrusher depth','2','16','1']].map(([id,label,min,max,step]) => `<div class="range-field"><label class="field-label" for="${id}">${label}<output id="${id}-value"></output></label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}"></div>`).join('')}</section>
      <section class="panel settings-panel"><h2>Find your atmosphere</h2><p>Four palettes for long sessions and changing light.</p><div class="theme-options">${[['dark','#101a2c','#e9bc78'],['slate','#20252d','#b3c5df'],['forest','#182a24','#d9c88e'],['paper','#f8f5ed','#8c5e2f']].map(([id,bg,accent]) => `<button class="theme-option" data-theme-choice="${id}" aria-pressed="false"><span class="theme-swatch" style="--swatch-bg:${bg};--swatch-accent:${accent}"></span>${themeNames[id]}</button>`).join('')}</div><label class="sr-only" for="theme">Theme</label><select id="theme" class="sr-only">${Object.entries(themeNames).map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></section>
      <section class="panel settings-panel"><h2>A session worth keeping</h2><p>Settings save on this device automatically. Make a backup to take your setup somewhere else.</p><div class="settings-actions"><button class="button" id="export-session">${icon('download')}Back up session</button><button class="button" id="open-session">${icon('upload')}Restore backup</button></div><div class="settings-note">Backups include all 128 parts, master settings, and individual presets. Soundbank and MIDI audio data are separate; import the matching banks after restoring.</div></section></div>
      <a class="catalog-link" href="docs/features.html" target="_blank" rel="noopener"><span><strong>A bigger picture. 250 possibilities.</strong><small>Explore the feature catalog with honest implementation status.</small></span>${icon('arrow')}</a>
      <p class="library-note"><a href="licenses/banks/README.txt" target="_blank" rel="noopener">Soundbank credits, licenses and editable-source details</a></p>
    </section>
  </main>
  <footer class="footer-status"><span id="status" role="status" aria-live="polite">Ready when you are. Start audio to load the bundled soundbank.</span><span class="footer-mark">MADE FOR THE MOMENT</span></footer>
</div>
<input class="file-input" id="import-bank" type="file" accept=".sf2,.sf3,.dls" multiple aria-label="Import soundbank">
<input class="file-input" id="import-midi" type="file" accept=".mid,.midi,.rmi" aria-label="Import MIDI file">
<input class="file-input" id="import-preset" type="file" accept=".p128preset,.json" aria-label="Import individual preset">
<input class="file-input" id="restore-session" type="file" accept=".json,.p128session,.p128backup" aria-label="Restore session backup">
<dialog id="drum-dialog" aria-labelledby="drum-title"><div class="dialog-header"><h2 id="drum-title">Every key has a place.</h2><button class="icon-button" id="close-drum-map" aria-label="Close drum map">${icon('close')}</button></div><p>Remap an incoming drum note to another key for the selected part. Unmapped notes pass through unchanged.</p><div class="drum-map-fields"><label class="field">Incoming note<input id="drum-source" type="number" min="0" max="127" value="36"></label><label class="field">Play this note<input id="drum-target" type="number" min="0" max="127" value="36"></label></div><button class="button accent" id="add-drum-map">Add mapping</button><div class="drum-list" id="drum-map-list"></div><div class="dialog-buttons"><button class="button" id="clear-drum-map">Clear map</button><button class="button" id="done-drum-map">Done</button></div></dialog>
<dialog id="preset-map-dialog" aria-labelledby="preset-map-title"><div class="dialog-header"><h2 id="preset-map-title">A program for your sound.</h2><button class="icon-button" id="close-preset-map" aria-label="Close preset mapping">${icon('close')}</button></div><p>Choose the incoming MIDI bank and program address that recalls a saved app preset on this part. All incoming MIDI values below are zero-based, from 0 to 127.</p><div class="mapping-dialog-fields"><label class="field">Selected part · 1–128<input id="mapping-part" type="number" min="1" max="128" readonly></label><label class="field">Saved app preset<select id="mapping-preset"></select></label></div><div class="field-grid mapping-address-fields"><label class="field">BANK MSB<input id="mapping-msb" type="number" min="0" max="127" step="1"></label><label class="field">BANK LSB<input id="mapping-lsb" type="number" min="0" max="127" step="1"></label><label class="field">PROGRAM<input id="mapping-program" type="number" min="0" max="127" step="1"></label></div><p>The saved preset takes priority at this exact address. Saving an existing address replaces its snapshot.</p><div class="dialog-buttons"><button class="button" id="cancel-preset-map">Cancel</button><button class="button accent" id="save-preset-mapping">Save mapping</button></div></dialog>`;

function setStatus(message: string, working = false) {
  $('#status').replaceChildren();
  if (working) { const spinner = document.createElement('i'); spinner.className = 'busy-indicator'; $('#status').append(spinner); }
  $('#status').append(document.createTextNode(message));
}
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  $('#error-banner').textContent = `Error: ${message}`;
  $('#error-banner').hidden = false;
  setStatus(`Error: ${message}`);
  console.error('[Project128]', error);
}
async function run(label: string, task: () => unknown | Promise<unknown>) {
  busy++;
  $('#error-banner').hidden = true;
  setStatus(label, true);
  try { await task(); }
  catch (error) { reportError(error); }
  finally { busy--; if (!busy) $('#status .busy-indicator')?.remove(); }
}
function persist() {
  try { saveState(state); }
  catch (error) { reportError(new Error(`Settings could not be saved on this device: ${error instanceof Error ? error.message : error}`)); }
}
function persistPresets() { localStorage.setItem('project128.presets', JSON.stringify(savedPresets)); }
function selectedPart() { return state.parts[state.selectedPart]; }
function commitMaster(patch: Partial<AppState['master']>) {
  Object.assign(state.master, patch);
  persist();
  if (audioReady) engine.applyState(state);
  renderMaster();
}
function commitPart(patch: Partial<PartState>, changedFields: string[] = Object.keys(patch)) {
  Object.assign(selectedPart(), patch);
  persist();
  if (audioReady) engine.applyPart(selectedPart(), changedFields);
  renderPart(); renderGrid();
}
function showTab(tab: string) {
  currentTab = tab;
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  document.querySelectorAll<HTMLElement>('.view').forEach(view => view.hidden = view.id !== `view-${tab}`);
}
function renderGrid() {
  const grid = $('#parts-grid');
  if (!grid.childElementCount) {
    for (let port = 0; port < 8; port++) {
      const row = document.createElement('div'); row.className = 'port-row';
      const label = document.createElement('span'); label.className = 'port-label'; label.textContent = `P${port + 1}`; row.append(label);
      for (let channel = 0; channel < 16; channel++) {
        const id = port * 16 + channel;
        const button = document.createElement('button'); button.className = 'part-cell'; button.dataset.part = String(id); button.textContent = String(channel + 1).padStart(2,'0');
        button.addEventListener('click', () => { state.selectedPart = id; persist(); renderPart(); renderGrid(); });
        row.append(button);
      }
      grid.append(row);
    }
  }
  state.parts.forEach(part => {
    const button = $<HTMLButtonElement>(`[data-part="${part.id}"]`);
    button.setAttribute('aria-pressed', String(part.id === state.selectedPart));
    button.classList.toggle('has-bank', Boolean(part.bankId)); button.classList.toggle('is-muted', part.mute); button.classList.toggle('is-solo', part.solo);
    const bank = banks.find(bank => bank.id === part.bankId);
    const patch = bank?.presets.find(p => p.msb === part.msb && p.lsb === part.lsb && p.program === part.program && p.drums === part.drums);
    button.setAttribute('aria-label', `Part ${part.id + 1}, port ${Math.floor(part.id/16)+1}, channel ${part.id%16+1}, ${patch?.name || (part.bankId ? 'bank assigned' : 'no bank')}${part.mute ? ', muted':''}${part.solo ? ', solo':''}`);
    button.title = button.getAttribute('aria-label')!;
  });
  $('#assigned-count').textContent = String(state.parts.filter(part => part.bankId).length).padStart(3,'0');
}
function renderPart() {
  const part = selectedPart();
  const bank = banks.find(bank => bank.id === part.bankId);
  $('#part-number').textContent = String(part.id + 1).padStart(2,'0');
  $('#part-port').textContent = `PORT ${Math.floor(part.id/16)+1} · CH ${part.id%16+1}`;
  $('#keyboard-part').textContent = `Playing part ${String(part.id+1).padStart(2,'0')} · channel ${part.id%16+1}`;
  const bankSelect = $<HTMLSelectElement>('#part-bank');
  bankSelect.innerHTML = '<option value="">No bank assigned</option>' + banks.map(bank => `<option value="${escapeHTML(bank.id)}">${escapeHTML(bank.name)}</option>`).join('') + (part.bankId && !bank ? `<option value="${escapeHTML(part.bankId)}">Missing bank · import to relink</option>`:'');
  bankSelect.value = part.bankId || '';
  const patchSelect = $<HTMLSelectElement>('#part-patch');
  if (bank) {
    patchSelect.innerHTML = bank.presets.map((patch,index) => `<option value="${index}">${escapeHTML(patch.name)}${patch.drums?' · drums':''}</option>`).join('');
    const index = bank.presets.findIndex(patch => patch.msb === part.msb && patch.lsb === part.lsb && patch.program === part.program && patch.drums === part.drums);
    if (index < 0) { const option = document.createElement('option'); option.value=''; option.textContent='Patch not present at this address'; patchSelect.prepend(option); }
    patchSelect.value = index < 0 ? '' : String(index);
    patchSelect.disabled = false;
  } else { patchSelect.innerHTML = `<option value="">${part.bankId ? 'Import the missing bank' : 'Choose a soundbank first'}</option>`; patchSelect.disabled = true; }
  for (const property of ['msb','lsb','program','volume','pan','reverb','chorus','delay'] as const) $<HTMLInputElement>(`#part-${property}`).value = String(part[property]);
  for (const property of ['locked','drums'] as const) $<HTMLInputElement>(`#part-${property}`).checked = part[property];
  for (const property of ['mute','solo'] as const) $(`#part-${property}`).setAttribute('aria-pressed', String(part[property]));
  for (const property of ['volume','reverb','chorus','delay'] as const) $(`#part-${property}-value`).textContent = String(part[property]);
  $('#part-pan-value').textContent = part.pan === 64 ? 'Center' : part.pan < 64 ? `L ${64-part.pan}` : `R ${part.pan-64}`;
  $<HTMLInputElement>('#envelope-enabled').checked = part.envelope.enabled;
  for (const property of ['attack','decay','sustain','release'] as const) {
    const input = $<HTMLInputElement>(`#env-${property}`); input.value = String(property === 'sustain' ? Math.round(part.envelope[property]*100) : part.envelope[property]); input.disabled = !part.envelope.enabled;
  }
  $('#envelope-note').textContent = part.envelope.enabled ? 'Absolute amplitude override · seconds and sustain level.' : 'Original bank envelope. Enable override to use absolute values.';
  renderEnvelope();
  if ($<HTMLDialogElement>('#drum-dialog').open) renderDrumMap();
  renderPresetMappings();
}
function renderEnvelope() {
  const env = selectedPart().envelope;
  const attack = 12 + Math.min(env.attack, 5) * 10;
  const decay = attack + 20 + Math.min(env.decay, 5) * 9;
  const releaseStart = Math.max(decay+35, 205-Math.min(env.release,5)*5);
  const releaseEnd = Math.min(295, releaseStart+25+Math.min(env.release,5)*12);
  const sustainY = 65 - env.sustain * 57;
  const path = `M4 65 L${attack} 8 L${decay} ${sustainY} L${releaseStart} ${sustainY} L${releaseEnd} 65`;
  $('#envelope-curve').setAttribute('d',path); $('#envelope-fill').setAttribute('d',`${path} Z`);
  $('.envelope-graph').style.opacity = env.enabled ? '1' : '.4';
}
function renderMaster() {
  document.documentElement.dataset.theme = state.master.theme;
  const masterFields: Record<string,number|string> = {'key-shift':state.master.keyShift,'fine-tune':state.master.fineTune,root:state.master.root,mode:state.master.mode,theme:state.master.theme,'master-gain':state.master.gain,'delay-time':state.master.delayTime,'delay-feedback':state.master.delayFeedback,'delay-mix':state.master.delayMix,'flanger-mix':state.master.flangerMix,'crusher-bits':state.master.crusherBits,tempo:state.master.tempo};
  Object.entries(masterFields).forEach(([id,value]) => { $<HTMLInputElement>(`#${id}`).value=String(value); });
  $('#master-gain-value').textContent = `${Math.round(state.master.gain*100)}%`;
  $('#delay-time-value').textContent = `${state.master.delayTime.toFixed(2)} s`;
  for (const [id,value] of [['delay-feedback',state.master.delayFeedback],['delay-mix',state.master.delayMix],['flanger-mix',state.master.flangerMix]] as const) $(`#${id}-value`).textContent = `${Math.round(value*100)}%`;
  $('#crusher-bits-value').textContent = state.master.crusherBits === 16 ? '16 bit · bypass' : `${state.master.crusherBits} bit`;
  $('#tempo-value').textContent = `${state.master.tempo.toFixed(2)}×`;
  document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === state.master.theme)));
  $('#harmony-note').textContent = requiresMicrotonalTuning(state.master.mode) ? 'This scale needs per-note microtonal tuning, which is not implemented yet. Its scale mapping is bypassed; choose another mode for active mapping.' : state.master.mode === 'chromatic' ? 'Scale mapping changes live and MIDI notes. Chromatic leaves note classes unchanged.' : 'Root-based scale mapping applies to melodic parts. This is a static scale template; percussion is excluded.';
}
function renderTransport(next = position) {
  position = next;
  $('#current-time').textContent = formatTime(next.current); $('#duration').textContent = formatTime(next.duration);
  const seek = $<HTMLInputElement>('#seek'); seek.max = String(next.duration || 1); seek.value = String(next.current); seek.disabled = !midiName || !audioReady;
  for (const id of ['play','pause','stop','rewind']) $<HTMLButtonElement>(`#${id}`).disabled = !midiName || !audioReady;
  $<HTMLButtonElement>('#pause').disabled ||= !next.playing;
  $<HTMLButtonElement>('#play').disabled ||= next.playing;
}
function renderLibrary() {
  $('#library-count').textContent = `${banks.length} BANK${banks.length===1?'':'S'}`;
  const pendingMarkup = pendingBanks.map(bank => `<div class="bank-item"><div class="item-title">${escapeHTML(bank.name)}</div><div class="item-meta">Queued · ${formatBytes(bank.data.byteLength)} · start audio to load</div></div>`).join('');
  $('#bank-list').innerHTML = banks.map(bank => `<div class="bank-item"><div class="item-title">${escapeHTML(bank.name)}</div><div class="item-meta">${escapeHTML(bank.format.toUpperCase())} · ${bank.presets.length} patches · ${formatBytes(bank.bytes)}</div><div class="item-actions"><button class="text-button" data-bank-use="${escapeHTML(bank.id)}">Use on selected part ${icon('arrow')}</button>${bankSources.has(bank.id)?`<button class="text-button" data-bank-download="${escapeHTML(bank.id)}">${icon('download')}Original</button>`:''}${bankSources.get(bank.id)?.name.toLowerCase().endsWith('.sf2')?`<button class="text-button" data-bank-compress="${escapeHTML(bank.id)}">Compress to SF3</button>`:''}${bankSources.get(bank.id)?.converted?`<button class="text-button" data-bank-sf3="${escapeHTML(bank.id)}">${icon('download')}SF3</button>`:''}<button class="text-button" data-bank-remove="${escapeHTML(bank.id)}">Remove</button></div></div>`).join('') + pendingMarkup || `<div class="empty-state"><div class="empty-symbol">${icon('folder')}</div><h3>Start with a little possibility.</h3><p>Start audio to load GeneralUser GS, or bring an SF2, SF3, or DLS bank from your files.</p><button class="button" id="empty-import-bank">${icon('upload')}Import a soundbank</button></div>`;
  $('#preset-list').innerHTML = savedPresets.map(preset => `<div class="preset-item"><div class="item-title">${escapeHTML(preset.name)}</div><div class="item-meta">Program ${preset.part.program} · ${preset.part.drums?'percussion':'melodic'} · ${banks.some(bank => bank.id === preset.bankId)?'bank available':preset.bankId?'bank needs importing':'no bank assigned'}</div><div class="item-actions"><button class="text-button" data-preset-use="${escapeHTML(preset.id)}">Load into selected part ${icon('arrow')}</button><button class="text-button" data-preset-map="${escapeHTML(preset.id)}">Map program</button><button class="text-button" data-preset-export="${escapeHTML(preset.id)}">${icon('download')}Export</button><button class="text-button" data-preset-remove="${escapeHTML(preset.id)}">Delete</button></div></div>`).join('') || `<div class="empty-state"><div class="empty-symbol">${icon('sliders')}</div><h3>That sound you keep coming back to.</h3><p>Give your selected part a name and save it here. Every preset remembers its own settings.</p></div>`;
  renderPresetMappings();
}
function renderPresetMappings() {
  const part=selectedPart();
  $('#mapping-selected-part').textContent=`Part ${String(part.id+1).padStart(2,'0')} · port ${Math.floor(part.id/16)+1} · channel ${part.id%16+1}`;
  $<HTMLButtonElement>('#open-preset-mapping').disabled=!savedPresets.length;
  const mappings=(state.presetMappings||[]).map((mapping,index)=>({mapping,index})).filter(({mapping})=>mapping.partId===part.id);
  $('#preset-mapping-list').innerHTML=mappings.map(({mapping,index})=>`<div class="mapping-row" data-mapping-address="${mapping.msb}:${mapping.lsb}:${mapping.program}"><div><div class="item-title">${escapeHTML(mapping.preset.name)}</div><div class="item-meta mono">MSB ${mapping.msb} · LSB ${mapping.lsb} · PC ${mapping.program}</div></div><button class="text-button" data-mapping-remove="${index}" aria-label="Remove mapping ${mapping.msb}:${mapping.lsb}:${mapping.program}">Remove</button></div>`).join('')||'<div class="mapping-empty">No saved app preset mappings for this part.</div>';
}
function openPresetMapping(presetId?:string) {
  if(!savedPresets.length){setStatus('Save an individual preset first, then map its incoming MIDI program.');return;}
  const part=selectedPart();
  $<HTMLInputElement>('#mapping-part').value=String(part.id+1);
  $<HTMLSelectElement>('#mapping-preset').innerHTML=savedPresets.map(preset=>`<option value="${escapeHTML(preset.id)}">${escapeHTML(preset.name)}</option>`).join('');
  $<HTMLSelectElement>('#mapping-preset').value=presetId&&savedPresets.some(preset=>preset.id===presetId)?presetId:savedPresets[0].id;
  for(const property of ['msb','lsb','program'] as const)$<HTMLInputElement>(`#mapping-${property}`).value=String(part[property]);
  $<HTMLDialogElement>('#preset-map-dialog').showModal();
}
function savePresetMapping() {
  const preset=savedPresets.find(preset=>preset.id===$<HTMLSelectElement>('#mapping-preset').value);
  if(!preset)throw new Error('Choose an available saved app preset before saving a mapping.');
  const mapping:PresetMapping={partId:validNumber('mapping-part',1,128,true)-1,msb:validNumber('mapping-msb',0,127,true),lsb:validNumber('mapping-lsb',0,127,true),program:validNumber('mapping-program',0,127,true),preset:parsePreset(JSON.stringify(preset))};
  const others=(state.presetMappings||[]).filter(existing=>!(existing.partId===mapping.partId&&existing.msb===mapping.msb&&existing.lsb===mapping.lsb&&existing.program===mapping.program));
  if(others.length>=2048)throw new Error('This session already has 2,048 MIDI program mappings. Remove a mapping before adding another.');
  state.presetMappings=[...others,mapping];
  persist();if(audioReady)engine.applyState(state);renderPresetMappings();$<HTMLDialogElement>('#preset-map-dialog').close();
  setStatus(`“${preset.name}” mapped to part ${mapping.partId+1}, incoming ${mapping.msb}:${mapping.lsb}:${mapping.program}.`);
}
function renderKeyboard() {
  const keyboard = $('#keyboard'); keyboard.replaceChildren();
  const whites = Array.from({length:25},(_,i)=>baseNote+i).filter(note => ![1,3,6,8,10].includes(note%12));
  let whiteIndex = 0;
  for (let note=baseNote;note<=baseNote+24;note++) {
    const black = [1,3,6,8,10].includes(note%12);
    const key = document.createElement('button'); key.className=`key ${black?'black':'white'}`; key.dataset.note=String(note); key.setAttribute('aria-label',`Play ${noteName(note)}`); key.setAttribute('aria-pressed','false');
    if (black) key.style.left=`calc(${(whiteIndex-.33)/whites.length*100}% + 2px)`;
    else { whiteIndex++; if(note%12===0) key.textContent=noteName(note); }
    key.addEventListener('pointerdown', event => {
      event.preventDefault(); if (!audioReady) {setStatus('Start audio first, then play a note.');return;}
      key.setPointerCapture(event.pointerId); const part=state.selectedPart; heldPointers.set(event.pointerId,{part,note}); pressNote(part,note); updateKeyVisual(note);
    });
    const release = (event:PointerEvent) => { const active=heldPointers.get(event.pointerId); if(!active)return; heldPointers.delete(event.pointerId); releaseNote(active.part,active.note); updateKeyVisual(active.note); };
    key.addEventListener('pointerup',release); key.addEventListener('pointercancel',release); key.addEventListener('lostpointercapture',release);
    keyboard.append(key);
  }
  $('#octave-label').textContent=`${noteName(baseNote)} – ${noteName(baseNote+24)}`;
  $<HTMLButtonElement>('#octave-down').disabled=baseNote<=12; $<HTMLButtonElement>('#octave-up').disabled=baseNote>=96;
}
function updateKeyVisual(note:number) {
  const key=$(`[data-note="${note}"]`);if(!key)return;const down=Array.from(heldPointers.values()).some(active=>active.note===note)||Array.from(heldKeys.values()).some(active=>active.note===note);key.classList.toggle('is-down',down);key.setAttribute('aria-pressed',String(down));
}
function pressNote(part:number,note:number) {
  const token=`${part}:${note}`;
  if(sustained.has(token)){engine.noteOff(part,note);sustained.delete(token);}
  const existing=sounding.get(token);
  if(existing) existing.count++; else {sounding.set(token,{part,note,count:1});engine.noteOn(part,note,velocity);}
  $(`[data-part="${part}"]`).classList.add('is-playing');
}
function releaseNote(part:number,note:number) {
  const token=`${part}:${note}`,active=sounding.get(token);if(!active)return;
  active.count--;if(active.count>0)return;sounding.delete(token);
  if(sustain)sustained.set(token,{part,note});else engine.noteOff(part,note);
  if(!Array.from(sounding.values()).some(item=>item.part===part))$(`[data-part="${part}"]`).classList.remove('is-playing');
}
function releaseAll() {
  if(audioReady) engine.panic();
  heldPointers.clear();heldKeys.clear();sounding.clear();sustained.clear();
  document.querySelectorAll('.is-down,.is-playing').forEach(key=>{key.classList.remove('is-down','is-playing');if(key.hasAttribute('data-note'))key.setAttribute('aria-pressed','false');});
}
function setSustain(enabled:boolean) {
  sustain=enabled;$('#sustain').setAttribute('aria-pressed',String(enabled));
  if(!enabled){sustained.forEach(({part,note})=>engine.noteOff(part,note));sustained.clear();}
}
function assignBank(bank:BankInfo) {
  const part=selectedPart(); const patch=bank.presets.find(p=>p.drums===part.drums)||bank.presets[0];
  commitPart({bankId:bank.id,...(patch?{msb:patch.msb,lsb:patch.lsb,program:patch.program,drums:patch.drums}:{})});
}
async function loadBank(data:ArrayBuffer,name:string) {
  const bank=await engine.loadBank(data,name);const existing=banks.findIndex(item=>item.id===bank.id);if(existing>=0)banks[existing]=bank;else banks.push(bank);
  bankSources.set(bank.id,{data:data.slice(0),name});
  if(!selectedPart().bankId)assignBank(bank);else if(audioReady)engine.applyState(state);
  renderLibrary();renderPart();renderGrid();return bank;
}
async function startAudio() {
  if(audioStarting)return;
  if(audioReady){setStatus('Audio is ready. Play a note or open a MIDI file.');return;}
  audioStarting=true;const button=$<HTMLButtonElement>('#start-audio');button.disabled=true;button.querySelector('span')!.textContent='Starting…';
  await run('Starting audio and loading GeneralUser GS…',async()=>{
    await engine.init();audioReady=true;
    $('#engine-status').classList.add('ready');$('#engine-label').textContent='AUDIO READY';button.classList.add('is-ready');button.querySelector('span')!.textContent='Audio ready';
    try {
      const [response,metadata]=await Promise.all([fetch(new URL('banks/starter.sf3',document.baseURI)),fetch(new URL('banks/starter.json',document.baseURI)).then(response=>response.ok?response.json():null).catch(()=>null)]);if(!response.ok)throw new Error(`Bundled bank could not be loaded (${response.status}). Import a soundbank from Library to continue.`);
      const bank=await loadBank(await response.arrayBuffer(),typeof metadata?.name==='string'?metadata.name:'GeneralUser GS · starter');
      const source=bankSources.get(bank.id);if(source)source.name='Project128-GS.sf3';
      if(typeof metadata?.description==='string')$('#bank-provenance').textContent=metadata.description;
      // Fresh sessions give each of the 128 logical parts its own concrete bank binding.
      let changed=false;
      state.parts.forEach(part=>{if(!part.bankId){part.bankId=bank.id;const patch=bank.presets.find(p=>p.drums===part.drums&&p.program===part.program)||bank.presets.find(p=>p.drums===part.drums)||bank.presets[0];if(patch){part.msb=patch.msb;part.lsb=patch.lsb;part.program=patch.program;part.drums=patch.drums;}changed=true;}});
      if(changed)persist();
    } catch(error) {reportError(error);}
    for(const pending of pendingBanks.splice(0))await importBank(pending.data,pending.name);
    engine.applyState(state);engine.setTempo(state.master.tempo);renderGrid();renderPart();renderLibrary();
    if(pendingMidi){const pending=pendingMidi;pendingMidi=null;await importMidi(pending.data,pending.name);}
    renderTransport();setStatus(banks.length?'Audio ready. Your instrument is listening.':'Audio ready. Import a soundbank from Library.');
  });
  audioStarting=false;button.disabled=false;
  if(!audioReady)button.querySelector('span')!.textContent='Start audio';
}
async function importBank(data:ArrayBuffer,name:string) {
  if(!audioReady){pendingBanks.push({data,name});renderLibrary();setStatus(`${name} is queued. Start audio to load it.`);return;}
  const bank=await loadBank(data,name);assignBank(bank);setStatus(`${bank.name} ready · ${bank.presets.length} patches.`);
  if(name.toLowerCase().endsWith('.sf2')&&$<HTMLInputElement>('#auto-compress').checked)await compressBank(bank.id);
}
async function importMidi(data:ArrayBuffer,name:string) {
  if(!audioReady){const {parseMidiTimeline}=await import('./midi-timeline');parseMidiTimeline(data);midiName=name;$('#track-name').textContent=name;pendingMidi={data,name};$('#track-detail').textContent='MIDI queued · start audio when you’re ready';setStatus(`${name} is queued. Start audio to prepare playback.`);renderTransport();return;}
  const result=await engine.loadMidi(data,name);midiName=name;$('#track-name').textContent=name;position={current:0,duration:result.duration,playing:false};
  sequenceCount=result.sequenceCount;$('#sequence-control').hidden=result.format!==2||sequenceCount<2;$<HTMLSelectElement>('#sequence').innerHTML=Array.from({length:sequenceCount},(_,index)=>`<option value="${index}">Sequence ${index+1}</option>`).join('');
  $('#track-detail').textContent=`MIDI format ${result.format} · ${formatTime(result.duration)} · ready to play`;
  engine.applyState(state);engine.setTempo(state.master.tempo);renderTransport();setStatus(`${name} ready. Master settings preserved.`);
}
function download(data:BlobPart,name:string,type='application/json') {
  const blob=new Blob([data],{type});
  const bridge=(window as unknown as {webkit?:{messageHandlers?:{project128?:{postMessage:(message:unknown)=>void}}}}).webkit?.messageHandlers?.project128;
  if(bridge){void run(`Preparing ${name}…`,async()=>{const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));bridge.postMessage({command:'share',name,data:btoa(binary)});setStatus(`${name} ready to share.`);});return;}
  const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function fileSafe(name:string) {return name.replace(/[^a-z0-9 _.-]/gi,'').trim()||'Project128';}
async function compressBank(id:string) {
  const source=bankSources.get(id);if(!source)throw new Error('The original SF2 is no longer available. Import it again to compress.');
  const {convertToSF3}=await import('./compression');
  const quality=Number($<HTMLSelectElement>('#compression-quality').value);
  const result=await convertToSF3(source.data.slice(0),quality,(progress:unknown)=>{setStatus(`Compressing ${source.name}… ${typeof progress==='number'?Math.round(progress*100)+'%':String(progress)}`,true);});
  const buffer=result;
  source.converted=buffer;renderLibrary();download(buffer,source.name.replace(/\.sf2$/i,'.sf3'),'application/octet-stream');setStatus(`SF3 exported · ${formatBytes(buffer.byteLength)}. Original retained in this session.`);
}
function storePreset(preset:SavedPreset) {
  const index=savedPresets.findIndex(item=>item.id===preset.id);if(index>=0)savedPresets[index]=preset;else savedPresets.push(preset);persistPresets();renderLibrary();
}
function saveCurrentPreset() {
  const input=$<HTMLInputElement>('#preset-name');const name=input.value.trim()||`Part ${state.selectedPart+1} · my sound`;
  storePreset(createPreset(state,name));input.value='';setStatus(`“${name}” saved to your preset library.`);
}
function importPreset(text:string) {const preset=parsePreset(text);storePreset(preset);setStatus(`“${preset.name}” imported. Load it into any selected part.`);}
async function importSession(text:string) {
  const raw=JSON.parse(text);const sessionData=raw?.project128Session===1?raw.state:raw;
  if(!sessionData||sessionData.version!==1||!Array.isArray(sessionData.parts)||sessionData.parts.length!==128||!sessionData.master)throw new Error('Invalid Project 128 session backup. The active session has been preserved.');
  const restored=restoreState(sessionData);
  const presets=raw.project128Session===1&&Array.isArray(raw.presets)?raw.presets.map((preset:unknown)=>parsePreset(JSON.stringify(preset))):savedPresets;
  if(audioReady)await engine.stop();
  releaseAll();state=restored;savedPresets=presets;persist();persistPresets();
  if(audioReady){engine.applyState(state);engine.setTempo(state.master.tempo);}renderMaster();renderPart();renderGrid();renderLibrary();setStatus('Session restored. Import any missing soundbanks to relink the parts.');
}
function renderDrumMap() {
  const entries=Object.entries(selectedPart().drumMap);
  $('#drum-map-list').innerHTML=entries.map(([source,target])=>`<div class="drum-row"><span class="mono">${source} ${noteName(Number(source))} → ${target} ${noteName(target)}</span><button data-drum-remove="${source}" aria-label="Remove mapping for note ${source}">Remove</button></div>`).join('')||'<p>No custom mappings. Every key plays its original note.</p>';
}
function validNumber(id:string,min:number,max:number,integer=false) {
  const input=$<HTMLInputElement>(`#${id}`);let value=Number(input.value);if(!Number.isFinite(value))value=min;value=Math.max(min,Math.min(max,value));if(integer)value=Math.round(value);input.value=String(value);return value;
}

on('#start-audio','click',()=>void startAudio());
document.querySelectorAll<HTMLElement>('[data-tab]').forEach(button=>button.addEventListener('click',()=>showTab(button.dataset.tab!)));
for(const [button,input] of [['#open-midi','#import-midi'],['#open-bank','#import-bank'],['#open-preset','#import-preset'],['#open-session','#restore-session']])on(button,'click',()=>$(input).click());
function bindFileInput(id:string,handler:(data:ArrayBuffer,name:string)=>unknown|Promise<unknown>) {
  on(id,'change',event=>{const input=event.target as HTMLInputElement;const files=Array.from(input.files||[]);input.value='';if(!files.length)return;void run('Reading imported files…',async()=>{for(const file of files)await handler(await file.arrayBuffer(),file.name);});});
}
bindFileInput('#import-bank',importBank);bindFileInput('#import-midi',importMidi);bindFileInput('#import-preset',data=>importPreset(new TextDecoder().decode(data)));bindFileInput('#restore-session',data=>importSession(new TextDecoder().decode(data)));
on('#play','click',()=>void run('Starting playback…',async()=>{await engine.play();renderTransport(engine.position());setStatus(`Playing ${midiName}.`);}));
on('#pause','click',()=>void run('Pausing…',async()=>{await engine.pause();renderTransport(engine.position());setStatus('Playback paused.');}));
on('#stop','click',()=>void run('Stopping…',async()=>{await engine.stop();renderTransport(engine.position());setStatus('Playback stopped. Master settings preserved.');}));
on('#rewind','click',()=>void run('Returning to beginning…',async()=>{await engine.seek(0);renderTransport(engine.position());setStatus('At the beginning.');}));
on('#seek','input',event=>{const seconds=Number((event.target as HTMLInputElement).value);void run('Seeking…',async()=>{await engine.seek(seconds);renderTransport(engine.position());setStatus(`Position ${formatTime(seconds)}.`);});});
on('#tempo','input',()=>{commitMaster({tempo:validNumber('tempo',.25,4)});if(audioReady)engine.setTempo(state.master.tempo);});
on('#apply-part-settings','click',()=>void run('Applying displayed part settings…',()=>{if(!audioReady){setStatus('Start audio first to apply the displayed part settings.');return;}engine.applyPart(selectedPart());setStatus(`Displayed settings applied to part ${state.selectedPart+1}.`);}));
on('#part-bank','change',()=>{const bank=banks.find(bank=>bank.id===$<HTMLSelectElement>('#part-bank').value);if(bank)assignBank(bank);else commitPart({bankId:null});});
on('#part-patch','change',()=>{const bank=banks.find(bank=>bank.id===selectedPart().bankId);const patch=bank?.presets[Number($<HTMLSelectElement>('#part-patch').value)];if(patch&&bank)commitPart({bankId:bank.id,msb:patch.msb,lsb:patch.lsb,program:patch.program,drums:patch.drums});});
for(const property of ['msb','lsb','program'] as const)on(`#part-${property}`,'change',()=>{const part=selectedPart();commitPart({bankId:part.bankId,msb:part.msb,lsb:part.lsb,program:part.program,drums:part.drums,[property]:validNumber(`part-${property}`,0,127,true)});});
for(const property of ['volume','pan','reverb','chorus','delay'] as const)on(`#part-${property}`,'input',()=>commitPart({[property]:validNumber(`part-${property}`,0,127,true)}));
for(const property of ['locked','drums'] as const)on(`#part-${property}`,'change',()=>commitPart({[property]:$<HTMLInputElement>(`#part-${property}`).checked}));
for(const property of ['mute','solo'] as const)on(`#part-${property}`,'click',()=>commitPart({[property]:!selectedPart()[property]}));
on('#envelope-enabled','change',()=>commitPart({envelope:{...selectedPart().envelope,enabled:$<HTMLInputElement>('#envelope-enabled').checked}},['envelope.enabled']));
for(const property of ['attack','decay','sustain','release'] as const)on(`#env-${property}`,'change',()=>commitPart({envelope:{...selectedPart().envelope,[property]:validNumber(`env-${property}`,0,property==='sustain'?100:20)/(property==='sustain'?100:1)}},[`envelope.${property}`]));
on('#key-shift','input',()=>commitMaster({keyShift:validNumber('key-shift',-48,48,true)}));on('#fine-tune','input',()=>commitMaster({fineTune:validNumber('fine-tune',-100,100)}));
on('#root','change',()=>commitMaster({root:Number($<HTMLSelectElement>('#root').value)}));on('#mode','change',()=>commitMaster({mode:$<HTMLSelectElement>('#mode').value}));
on('#master-gain','input',()=>commitMaster({gain:validNumber('master-gain',0,2)}));
for(const [id,property,min,max] of [['delay-time','delayTime',.05,2],['delay-feedback','delayFeedback',0,.9],['delay-mix','delayMix',0,1],['flanger-mix','flangerMix',0,1],['crusher-bits','crusherBits',2,16]] as const)on(`#${id}`,'input',()=>commitMaster({[property]:validNumber(id,min,max)}));
on('#theme','change',()=>commitMaster({theme:$<HTMLSelectElement>('#theme').value}));document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(button=>button.addEventListener('click',()=>commitMaster({theme:button.dataset.themeChoice!})));
on('#velocity','input',()=>{velocity=validNumber('velocity',1,127,true);$('#velocity-value').textContent=String(velocity);});
on('#octave-down','click',()=>{releaseAll();baseNote=Math.max(12,baseNote-12);renderKeyboard();});on('#octave-up','click',()=>{releaseAll();baseNote=Math.min(96,baseNote+12);renderKeyboard();});
on('#sustain','click',()=>setSustain(!sustain));on('#panic','click',()=>{releaseAll();setSustain(false);setStatus('All notes released.');});
document.addEventListener('keydown',event=>{if(event.repeat||event.metaKey||event.ctrlKey||event.altKey||currentTab!=='perform'||!audioReady||event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||$<HTMLDialogElement>('#drum-dialog').open||$<HTMLDialogElement>('#preset-map-dialog').open)return;const offset=physicalKeys[event.key.toLowerCase()];if(offset===undefined)return;event.preventDefault();const note=baseNote+offset;heldKeys.set(event.code,{part:state.selectedPart,note});pressNote(state.selectedPart,note);updateKeyVisual(note);});
document.addEventListener('keyup',event=>{const active=heldKeys.get(event.code);if(!active)return;heldKeys.delete(event.code);releaseNote(active.part,active.note);updateKeyVisual(active.note);});
window.addEventListener('blur',()=>{releaseAll();setSustain(false);});document.addEventListener('visibilitychange',()=>{if(document.hidden){releaseAll();setSustain(false);}});
on('#save-part-preset','click',()=>{showTab('library');$<HTMLInputElement>('#preset-name').focus();setStatus('Name your selected part to save an individual preset.');});on('#create-preset','click',()=>void run('Saving preset…',saveCurrentPreset));
on('#preset-name','keydown',event=>{if((event as KeyboardEvent).key==='Enter')void run('Saving preset…',saveCurrentPreset);});
on('#bank-list','click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;
  if(button.id==='empty-import-bank'){$('#import-bank').click();return;}
  const id=button.dataset.bankUse||button.dataset.bankRemove||button.dataset.bankCompress||button.dataset.bankDownload||button.dataset.bankSf3;if(!id)return;
  void run('Updating soundbank…',async()=>{
    if(button.dataset.bankUse){const bank=banks.find(bank=>bank.id===id);if(bank){assignBank(bank);setStatus(`${bank.name} assigned to part ${state.selectedPart+1}.`);}}
    if(button.dataset.bankRemove){await engine.removeBank(id);banks=banks.filter(bank=>bank.id!==id);bankSources.delete(id);renderLibrary();renderPart();renderGrid();setStatus('Bank removed. Parts keep their bank reference for relinking.');}
    if(button.dataset.bankCompress)await compressBank(id);
    if(button.dataset.bankDownload){const source=bankSources.get(id);if(source){download(source.data,source.name,'application/octet-stream');setStatus('Original soundbank exported.');}}
    if(button.dataset.bankSf3){const source=bankSources.get(id);if(source?.converted){download(source.converted,source.name.replace(/\.sf2$/i,'.sf3'),'application/octet-stream');setStatus('Compressed SF3 exported.');}}
  });
});
on('#preset-list','click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;const id=button.dataset.presetUse||button.dataset.presetExport||button.dataset.presetRemove||button.dataset.presetMap;const preset=savedPresets.find(preset=>preset.id===id);if(!preset)return;
  void run('Updating preset…',()=>{
    if(button.dataset.presetMap){openPresetMapping(preset.id);setStatus('Choose the incoming MIDI address for this saved app preset.');}
    if(button.dataset.presetUse){releaseAll();state=applyPreset(state,preset,state.selectedPart);persist();if(audioReady){engine.applyState(state);engine.applyPart(selectedPart());}renderPart();renderGrid();setStatus(`“${preset.name}” loaded into part ${state.selectedPart+1}.${preset.bankId&&!banks.some(bank=>bank.id===preset.bankId)?' Import its missing soundbank to play.':''}`);}
    if(button.dataset.presetExport){download(JSON.stringify(preset,null,2),`${fileSafe(preset.name)}.p128preset`);setStatus('Individual preset exported.');}
    if(button.dataset.presetRemove){savedPresets=savedPresets.filter(item=>item.id!==preset.id);persistPresets();renderLibrary();setStatus('Preset removed from this device.');}
  });
});
on('#open-preset-mapping','click',()=>openPresetMapping());
for(const id of ['#close-preset-map','#cancel-preset-map'])on(id,'click',()=>$<HTMLDialogElement>('#preset-map-dialog').close());
on('#save-preset-mapping','click',()=>void run('Saving MIDI program mapping…',savePresetMapping));
on('#preset-mapping-list','click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-mapping-remove]');if(!button)return;
  const index=Number(button.dataset.mappingRemove);if(!Number.isInteger(index))return;
  state.presetMappings=(state.presetMappings||[]).filter((_,mappingIndex)=>mappingIndex!==index);persist();if(audioReady)engine.applyState(state);renderPresetMappings();setStatus('MIDI program mapping removed. This address now follows normal bank patch selection.');
});
on('#export-session','click',()=>{download(JSON.stringify({project128Session:1,state,presets:savedPresets,bankManifest:banks.map(({id,name})=>({id,name}))},null,2),'Project128-session.p128session');setStatus('Session backup exported. Soundbanks are separate.');});
on('#open-drum-map','click',()=>{renderDrumMap();$<HTMLDialogElement>('#drum-dialog').showModal();});for(const id of ['#close-drum-map','#done-drum-map'])on(id,'click',()=>$<HTMLDialogElement>('#drum-dialog').close());
on('#add-drum-map','click',()=>{const source=validNumber('drum-source',0,127,true),target=validNumber('drum-target',0,127,true);commitPart({drumMap:{...selectedPart().drumMap,[source]:target}});renderDrumMap();setStatus(`Drum note ${source} now plays ${target}.`);});
on('#clear-drum-map','click',()=>{commitPart({drumMap:{}});renderDrumMap();setStatus('Drum map cleared.');});on('#drum-map-list','click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-drum-remove]');if(!button)return;const map={...selectedPart().drumMap};delete map[Number(button.dataset.drumRemove)];commitPart({drumMap:map});renderDrumMap();});

engine.onPosition=next=>renderTransport(next);
engine.onError=reportError;
on('#sequence','change',()=>void run('Selecting independent sequence…',async()=>{engine.selectSequence(Number($<HTMLSelectElement>('#sequence').value));setStatus(`Sequence ${Number($<HTMLSelectElement>('#sequence').value)+1} selected.`);}));
interface MIDIDecoder {running:number;status:number;needed:number;data:number[];sysex:number[]|null}
const midiDecoders=new Map<number,MIDIDecoder>();
function decodeNativeMIDI(bytes:number[],port:number) {
  if(!Number.isInteger(port)||port<0||port>7)return;
  let decoder=midiDecoders.get(port);if(!decoder){decoder={running:0,status:0,needed:0,data:[],sysex:null};midiDecoders.set(port,decoder);}
  for(const byte of bytes){
    if(!Number.isInteger(byte)||byte<0||byte>255)continue;
    if(byte>=0xf8){engine.sendMIDI([byte],port);continue;}
    if(decoder.sysex){
      if(byte===0xf7){decoder.sysex.push(byte);engine.sendMIDI(decoder.sysex,port);decoder.sysex=null;continue;}
      if(byte<0x80){if(decoder.sysex.length<1048576)decoder.sysex.push(byte);else decoder.sysex=null;continue;}
      decoder.sysex=null;
    }
    if(byte>=0x80){
      decoder.data=[];decoder.status=byte;
      if(byte===0xf0){decoder.running=0;decoder.sysex=[byte];continue;}
      if(byte>=0xf0){decoder.running=0;decoder.needed=byte===0xf2?2:(byte===0xf1||byte===0xf3?1:0);}
      else{decoder.running=byte;decoder.needed=(byte&0xf0)===0xc0||(byte&0xf0)===0xd0?1:2;}
      if(!decoder.needed){engine.sendMIDI([byte],port);decoder.status=0;}continue;
    }
    if(!decoder.status&&decoder.running){decoder.status=decoder.running;decoder.needed=(decoder.status&0xf0)===0xc0||(decoder.status&0xf0)===0xd0?1:2;}
    if(!decoder.status)continue;decoder.data.push(byte);
    if(decoder.data.length===decoder.needed){engine.sendMIDI([decoder.status,...decoder.data],port);decoder.data=[];decoder.status=0;}
  }
}
type NativeImport = {kind:string;name:string;data:string};
const nativeWindow=window as unknown as {nativeImport:(file:NativeImport)=>Promise<void>;nativeMIDI:(bytes:number[],timestampNativeMonotonicMs?:number,port?:number)=>void;nativeAudioInterruption?:(interrupted:boolean)=>void};
nativeWindow.nativeImport=async(file:NativeImport)=>run(`Importing ${file.name}…`,async()=>{
  const binary=atob(file.data);const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));const kind=file.kind.toLowerCase();
  if(kind==='bank'||/\.(sf2|sf3|dls)$/i.test(file.name))await importBank(bytes.buffer,file.name);
  else if(kind==='midi'||/\.(mid|midi|rmi)$/i.test(file.name))await importMidi(bytes.buffer,file.name);
  else if(kind==='session'||/\.(p128session|p128backup)$/i.test(file.name))await importSession(new TextDecoder().decode(bytes));
  else if(kind==='preset'||file.name.endsWith('.p128preset'))importPreset(new TextDecoder().decode(bytes));
  else throw new Error(`Unsupported import: ${file.name}. Choose a soundbank, MIDI, Project 128 preset, or session backup.`);
});
nativeWindow.nativeMIDI=(bytes,_timestamp,port=0)=>{if(audioReady)decodeNativeMIDI(bytes,port);};
nativeWindow.nativeAudioInterruption=interrupted=>{if(interrupted){releaseAll();void run('Audio interrupted…',async()=>{await engine.pause();renderTransport(engine.position());setStatus('Audio was interrupted. Tap play when you’re ready to continue.');});}};
window.addEventListener('nativeAudioInterruption',event=>{
  const detail=(event as CustomEvent<{began?:boolean}>).detail;
  nativeWindow.nativeAudioInterruption?.(detail?.began===true);
});
window.addEventListener('unhandledrejection',event=>{event.preventDefault();reportError(event.reason);});
renderGrid();renderPart();renderMaster();renderLibrary();renderKeyboard();renderTransport();
