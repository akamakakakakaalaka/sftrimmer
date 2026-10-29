import {test,expect} from '@playwright/test';

function midi(format:number):Buffer {
 const header=[77,84,104,100,0,0,0,6,0,format,0,1,0,96];
 const body=[0,0xc0,0,0,0x90,60,100,96,0x80,60,0,0,0xff,0x2f,0];
 return Buffer.from([...header,77,84,114,107,0,0,0,body.length,...body]);
}

test('128 logical parts are selectable in a portrait viewport',async({page})=>{
 await page.goto('/');
 await expect(page.locator('#parts-grid button[data-part]')).toHaveCount(128);
 const last=page.locator('#parts-grid button[data-part="127"]');
 await last.click();
 await expect(last).toHaveAttribute('aria-pressed','true');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('master tuning persists after reload and across MIDI formats',async({page})=>{
 await page.goto('/');
 await page.locator('[data-tab="settings"]').click();
 await page.locator('#key-shift').fill('5');
 await page.locator('#key-shift').dispatchEvent('input');
 await page.locator('#fine-tune').fill('-17');
 await page.locator('#fine-tune').dispatchEvent('input');
 await page.reload();
 await page.locator('[data-tab="settings"]').click();
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
