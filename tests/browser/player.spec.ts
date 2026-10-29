import {test,expect} from '@playwright/test';

function midi(format:number):Buffer {
 const header=[77,84,104,100,0,0,0,6,0,format,0,1,0,96];
 const body=[0,0xc0,0,0,0x90,60,100,96,0x80,60,0,0,0xff,0x2f,0];
 return Buffer.from([...header,77,84,114,107,0,0,0,body.length,...body]);
}

test('128 logical parts are selectable in a portrait viewport',async({page})=>{
 await page.goto('/');
 await expect(page.locator('#part-rack [data-panel-part]')).toHaveCount(128);
 const last=page.locator('#part-rack button[data-rack-part="127"]');
 await last.click();
 await expect(last).toHaveAttribute('aria-pressed','true');
 await page.locator('[data-tab="parameters"]').click();
 await expect(page.locator('#part-number')).toHaveText('128');
 await page.locator('#part-number').scrollIntoViewIfNeeded();
 await expect(page.locator('#part-number')).toBeInViewport();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('rack dials edit their own part and the keyboard stays docked between pages',async({page})=>{
 await page.goto('/');
 await expect(page.locator('#rack-1-volume')).toBeVisible();
 await page.locator('#rack-1-volume').fill('43');
 await page.locator('#rack-1-volume').dispatchEvent('input');
 let saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('project128.session')||'{}'));
 expect(saved.selectedPart).toBe(1);expect(saved.parts[1].volume).toBe(43);expect(saved.parts[0].volume).toBe(100);
 for(const tab of ['library','parameters','midi','settings','reset','player']){
  await page.locator(`[data-tab="${tab}"]`).click();
  await expect(page.locator('#keyboard')).toBeVisible();
  const box=await page.locator('.keyboard-panel').boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.y+box!.height).toBeLessThanOrEqual(845);
 }
 await page.locator('#panels-home').click();
 await page.locator('#rack-1-envelope-enabled').check();
 await page.locator('#rack-1-attack').fill('1.25');
 await page.locator('#rack-1-attack').dispatchEvent('input');
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('project128.session')||'{}'));
 expect(saved.parts[1].envelope).toMatchObject({enabled:true,attack:1.25,decay:.2,sustain:.8,release:.3});
 expect(saved.parts[0].envelope.enabled).toBe(false);
 await page.setViewportSize({width:844,height:390});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('[data-tab="parameters"]').click();
 await page.locator('#save-part-preset').scrollIntoViewIfNeeded();
 await expect(page.locator('#save-part-preset')).toBeInViewport();
});

test('patch sheet searches bank patches and commits the selected part only',async({page})=>{
 await page.goto('/');await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 await page.locator('[data-rack-patch="1"]').click();
 await expect(page.locator('#patch-dialog')).toBeVisible();
 await page.locator('#patch-search').fill('oboe');
 const patch=page.locator('#patch-results [data-patch-index]').first();
 await expect(patch).toContainText(/oboe/i);
 await patch.click();await expect(page.locator('#patch-dialog')).not.toBeVisible();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('project128.session')||'{}'));
 expect(saved.selectedPart).toBe(1);expect(saved.parts[1].program).toBe(68);expect(saved.parts[0].program).toBe(0);
 await expect(page.locator('[data-rack-patch="1"]')).toContainText(/oboe/i);
 await page.locator('[data-rack-patch="1"]').click();await page.locator('#patch-search').fill('no such patch 123');
 await expect(page.locator('#patch-results')).toContainText('No patches match');
 await page.keyboard.press('Escape');
 await expect(page.locator('#patch-dialog')).not.toBeVisible();
});

test('website patch search, favorites and Close toggle persist',async({page})=>{
 await page.goto('/');await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 await page.locator('[data-rack-patch="0"]').click();
 await page.locator('#patch-search').fill('prog68 bank0');
 await expect(page.locator('#patch-results [data-patch-index]').first()).toContainText(/oboe/i);
 await page.locator('#patch-results [data-patch-favorite]').first().click();
 await page.locator('#patch-favorites').click();
 await expect(page.locator('#patch-results [data-patch-index]')).toHaveCount(1);
 await page.locator('#patch-auto-close').uncheck();
 await page.locator('#patch-sort').selectOption('name');
 await page.locator('#patch-results [data-patch-index]').click();
 await expect(page.locator('#patch-dialog')).toBeVisible();
 await expect(page.locator('#patch-results [data-patch-index]')).toHaveAttribute('aria-pressed','true');
 await page.reload();await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 await page.locator('[data-rack-patch="0"]').click();
 await expect(page.locator('#patch-favorites')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('#patch-auto-close')).not.toBeChecked();
 await expect(page.locator('#patch-sort')).toHaveValue('name');
 await expect(page.locator('#patch-results [data-patch-index]')).toHaveCount(1);
});

test('website toolbar, mute/hold-solo and keyboard ruler work',async({page})=>{
 await page.goto('/');
 expect(await page.locator('.tabs [data-tab]').evaluateAll(buttons=>buttons.map(button=>(button as HTMLElement).dataset.tab))).toEqual(['library','reset','parameters','midi','settings','player']);
 const mute=page.locator('[data-panel-part="0"] .sampei-mute');
 await mute.click();
 let saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('project128.session')||'{}'));
 expect(saved.parts[0].mute).toBe(true);
 await mute.click();await mute.click({delay:700});
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('project128.session')||'{}'));
 expect(saved.parts[0].mute).toBe(false);expect(saved.parts[0].solo).toBe(true);
 await mute.press('Shift+Enter');
 await page.locator('#keyboard-scroll').fill('72');await page.locator('#keyboard-scroll').dispatchEvent('input');
 await expect(page.locator('#keyboard [data-note="72"]')).toBeVisible();
 await page.locator('[data-tab="reset"]').click();
 await expect(page.locator('#view-perform')).toBeVisible();
 await expect(page.locator('#view-reset')).toBeVisible();
 await expect(page.locator('#view-reset [data-close-view]')).toBeFocused();
 await expect(page.locator('[data-reset-cc]')).toHaveCount(3);
 await page.keyboard.press('Escape');await expect(page.locator('#view-reset')).not.toBeVisible();
 await expect(page.locator('#panels-home')).toBeFocused();
 await page.locator('[data-tab="parameters"]').click();
 await page.locator('#view-parameters').evaluate(view=>view.scrollTop=10000);
 await page.locator('[data-tab="midi"]').click();await page.locator('[data-tab="parameters"]').click();
 expect(await page.locator('#view-parameters').evaluate(view=>view.scrollTop)).toBe(0);
 await page.locator('#panels-home').click();
 await page.setViewportSize({width:320,height:568});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('hiding the keyboard releases live keys while a held MIDI note keeps sounding',async({page})=>{
 await page.addInitScript(()=>{
  const NativeNode=window.AudioWorkletNode;
  window.AudioWorkletNode=class extends NativeNode{
   constructor(context:BaseAudioContext,name:string,options?:AudioWorkletNodeOptions){
    super(context,name,options);const analyser=context.createAnalyser(),silent=context.createGain();
    silent.gain.value=0;this.connect(analyser);analyser.connect(silent);silent.connect(context.destination);
    (window as any).__testAnalyser=analyser;
   }
  };
 });
 await page.goto('/');await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 await page.locator('#rack-0-reverb').fill('0');await page.locator('#rack-0-reverb').dispatchEvent('input');
 const header=[77,84,104,100,0,0,0,6,0,0,0,1,0,96];
 const body=[0,0xc0,16,0,0x90,60,100,0x8f,0,0x80,60,0,0,0xff,0x2f,0];
 await page.locator('#import-midi').setInputFiles({name:'held.mid',mimeType:'audio/midi',buffer:Buffer.from([...header,77,84,114,107,0,0,0,body.length,...body])});
 await page.locator('#play').click();await expect(page.locator('#current-time')).toHaveText('0:01');
 await page.keyboard.down('a');await expect(page.locator('#keyboard [data-note="48"]')).toHaveAttribute('aria-pressed','true');
 await page.locator('#toggle-keys').click();
 await expect(page.locator('#keyboard')).not.toBeVisible();
 await expect(page.locator('#keyboard [data-note="48"]')).toHaveAttribute('aria-pressed','false');
 await page.waitForTimeout(800);
 const peak=await page.evaluate(()=>{const a=(window as any).__testAnalyser as AnalyserNode,d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return Math.max(...d.map(Math.abs));});
 expect(peak).toBeGreaterThan(.00001);
 await page.keyboard.up('a');
});

test('master tuning persists after reload and across MIDI formats',async({page})=>{
 await page.goto('/');
 await page.locator('[data-tab="parameters"]').click();
 await page.locator('#key-shift').fill('5');
 await page.locator('#key-shift').dispatchEvent('input');
 await page.locator('#fine-tune').fill('-17');
 await page.locator('#fine-tune').dispatchEvent('input');
 await page.reload();
 await page.locator('[data-tab="parameters"]').click();
 await expect(page.locator('#key-shift')).toHaveValue('5');
 await expect(page.locator('#fine-tune')).toHaveValue('-17');
 await page.locator('#start-audio').click();
 await expect(page.locator('#status')).not.toContainText(/Starting|Loading/i,{timeout:60000});
 for(const format of [0,1,2]){
   await page.locator('#import-midi').setInputFiles({name:`format-${format}.mid`,mimeType:'audio/midi',buffer:midi(format)});
   await expect(page.locator('#status')).toContainText(/MIDI|Loaded|format/i);
   await expect(page.locator('#key-shift')).toHaveValue('5');
   await expect(page.locator('#fine-tune')).toHaveValue('-17');
 }
});

test('audio start loads real bundled presets and reports corrupt imports',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 const count=await page.locator('#part-patch option').count();
 expect(count).toBeGreaterThan(128);
 await page.locator('#import-bank').setInputFiles({name:'broken.sf2',mimeType:'application/octet-stream',buffer:Buffer.from('bad soundfont')});
 await expect(page.locator('#status')).toContainText(/error|invalid|fail|unsupported|could not/i);
 await expect(page.locator('#part-patch option')).toHaveCount(count);
 expect(errors).toEqual([]);
});

test('the native interruption event releases held keyboard notes and pauses playback',async({page})=>{
 await page.goto('/');
 await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 const key=page.locator('#keyboard button[data-note]').first();
 await page.keyboard.down('a');
 await expect(key).toHaveAttribute('aria-pressed','true');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('nativeAudioInterruption',{detail:{began:true}})));
 await expect(key).toHaveAttribute('aria-pressed','false');
 await expect(page.locator('#status')).toContainText('Audio was interrupted');
 await page.keyboard.up('a');
});

test('individual app presets have persistent per-part MIDI bank/program mappings',async({page})=>{
 await page.goto('/');await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 await page.locator('[data-tab="library"]').click();
 await page.locator('#preset-name').fill('Program mapped piano');
 await page.locator('#create-preset').click();
 await page.locator('[data-preset-map]').first().click();
 await expect(page.locator('#preset-map-dialog')).toBeVisible();
 await page.locator('#mapping-msb').fill('23');await page.locator('#mapping-lsb').fill('7');await page.locator('#mapping-program').fill('12');
 await page.locator('#save-preset-mapping').click();
 await expect(page.locator('[data-mapping-address="23:7:12"]')).toBeVisible();
 let stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('project128.session')||'{}'));
 expect(stored.presetMappings).toHaveLength(1);
 expect(stored.presetMappings[0]).toMatchObject({partId:0,msb:23,lsb:7,program:12,preset:{name:'Program mapped piano'}});
 expect(stored.presetMappings[0].preset.bankId).toMatch(/^sha256-/);
 await page.reload();await page.locator('[data-tab="library"]').click();
 await expect(page.locator('[data-mapping-address="23:7:12"]')).toBeVisible();
 await page.locator('[data-mapping-remove]').first().click();
 stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('project128.session')||'{}'));
 expect(stored.presetMappings).toHaveLength(0);
});

test('restoring a session stops current transport before applying saved controls',async({page})=>{
 await page.goto('/');await page.locator('#start-audio').click();
 await expect.poll(()=>page.locator('#part-patch option').count(),{timeout:60000}).toBeGreaterThan(128);
 const header=[77,84,104,100,0,0,0,6,0,0,0,1,0,96];
 const body=[0,0xc0,0,0,0x90,60,100,0x8f,0,0x80,60,0,0,0xff,0x2f,0];
 const longMidi=Buffer.from([...header,77,84,114,107,0,0,0,body.length,...body]);
 await page.locator('#import-midi').setInputFiles({name:'long.mid',mimeType:'audio/midi',buffer:longMidi});
 await expect(page.locator('#track-detail')).toContainText('MIDI format 0');
 await page.locator('#play').click();
 await expect(page.locator('#current-time')).toHaveText('0:01');
 const backup=await page.evaluate(()=>JSON.stringify({project128Session:1,state:JSON.parse(localStorage.getItem('project128.session')||'{}'),presets:[]}));
 await page.locator('#restore-session').setInputFiles({name:'restore.p128session',mimeType:'application/json',buffer:Buffer.from(backup)});
 await expect(page.locator('#status')).toContainText('Session restored');
 await expect(page.locator('#current-time')).toHaveText('0:00');
 await page.waitForTimeout(300);
 await expect(page.locator('#current-time')).toHaveText('0:00');
});
