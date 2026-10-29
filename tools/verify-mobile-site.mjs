import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {BasicSoundBank,SoundBankLoader,SpessaLog} from 'spessasynth_core';

const root=resolve(process.argv[2]);
const csp=(await readFile('ios/Project128/LocalHTTPPolicy.swift','utf8')).match(/let csp = "([^"\n]+)"/)[1];
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.css':'text/css','.png':'image/png','.woff2':'font/woff2','.txt':'text/plain'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
    const path=resolve(root,pathname.replace(/^\//,'')||'index.html');
    assert(path.startsWith(root+'/'));
    res.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');
    res.setHeader('Content-Security-Policy',csp);
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    res.end(await readFile(path));
  }catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({headless:true});
try{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'requestMIDIAccess',{value:undefined,configurable:true});
    const Original=window.AudioWorkletNode;
    window.AudioWorkletNode=class extends Original{
      constructor(context,name,options){
        super(context,name,options);
        const analyser=context.createAnalyser(),gain=context.createGain();gain.gain.value=0;
        this.connect(analyser);analyser.connect(gain);gain.connect(context.destination);window.__siteAnalyser=analyser;
      }
    };
  });
  const peak=()=>page.evaluate(async()=>{
    let peak=0;const values=new Float32Array(2048);
    for(let i=0;i<10;i++){await new Promise(done=>setTimeout(done,40));window.__siteAnalyser.getFloatTimeDomainData(values);for(const sample of values)peak=Math.max(peak,Math.abs(sample));}
    return peak;
  });
  const start=async()=>{
    await page.locator('#start-audio').click();
    await page.waitForFunction(()=>document.querySelectorAll('#part-patch option').length>128,{timeout:60000});
  };
  await page.goto(base);
  await page.waitForFunction(()=>document.body.dataset.offlineReady==='true',{timeout:60000});
  assert.equal(await page.evaluate(()=>typeof navigator.requestMIDIAccess),'undefined');
  const manifest=await (await page.request.get(base+'manifest.webmanifest')).json();
  assert.equal(manifest.display,'standalone');assert.equal(manifest.icons.length,2);
  await start();
  const key=page.locator('#keyboard [data-note="60"]');const rect=await key.boundingBox();
  await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height*.85);await page.mouse.down();
  const onscreenPeak=await peak();await page.mouse.up();assert(onscreenPeak>0.00001);
  const header=[77,84,104,100,0,0,0,6,0,0,0,1,0,96],track=[0,0xc0,0,0,0x90,60,100,0x87,0x40,0x80,60,0,0,0xff,0x2f,0];
  await page.locator('#import-midi').setInputFiles({name:'phone-playback.mid',mimeType:'audio/midi',buffer:Buffer.from([...header,77,84,114,107,0,0,0,track.length,...track])});
  await page.locator('#play').click();const midiPeak=await peak();assert(midiPeak>0.00001);await page.locator('#stop').click();
  await context.setOffline(true);await page.goto(base);await start();
  const cached=await page.evaluate(async()=>({controlled:!!navigator.serviceWorker.controller,caches:await caches.keys()}));
  assert(cached.controlled&&cached.caches.some(name=>name.startsWith('project128-pwa-')));
  await BasicSoundBank.ready;SpessaLog.setLogLevel(false,false,false);
  await page.locator('#import-bank').setInputFiles({name:'offline-custom.sf2',mimeType:'application/octet-stream',buffer:Buffer.from(BasicSoundBank.getSampleSoundBankFile())});
  await page.locator('#tab-library').click();
  const downloaded=page.waitForEvent('download');await page.locator('[data-bank-compress]').last().click();
  const download=await downloaded;const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);
  const bytes=Buffer.concat(chunks),bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  assert(bank.samples.every(sample=>sample.isCompressed&&sample.getAudioData().every(Number.isFinite)));
  await page.locator('.menu-popover:not([hidden]) [data-close-view]').click();
  await page.locator('#tab-settings').click();assert(await page.locator('#offline-status').textContent()==='Player and starter soundbank saved for offline use.');
  await page.screenshot({path:'output/Project128_Web_Offline.png'});
  await page.locator('.menu-popover:not([hidden]) [data-close-view]').click();
  await page.screenshot({path:'output/Project128_Web_Phone.png'});
  assert.deepEqual(errors,[]);
  const report={manifest:true,offline_reload:true,offline_SF2_import:true,offline_SF3_conversion:true,onscreen_audio_peak:onscreenPeak,MIDI_file_audio_peak:midiPeak,no_fake_WebMIDI:true,parts:await page.locator('#part-rack [data-panel-part]').count(),page_errors:errors,actual_iOS27_device_tested:false,WebKit_browser_tested:false};
  await mkdir('output',{recursive:true});await writeFile('output/mobile-web-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(done=>server.close(done));}
