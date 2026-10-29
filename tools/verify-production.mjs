import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {BasicSoundBank,SoundBankLoader,SpessaLog} from 'spessasynth_core';

// Exercise the built assets under the same non-root URL layout used by iOS.
const root=resolve('dist'), prefix='/native-token/';
const nativePolicy=await readFile('ios/Project128/LocalHTTPPolicy.swift','utf8');
const nativeCSP=nativePolicy.match(/let csp = "([^"\n]+)"/)?.[1];
assert(nativeCSP,'Missing native content security policy');
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(!path.startsWith(prefix))throw Error('Wrong prefix');
  const target=resolve(root,decodeURIComponent(path.slice(prefix.length))||'index.html');
  if(!target.startsWith(root+'/'))throw Error('Invalid path');
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm'};
  res.setHeader('Content-Type',types[extname(target)]||'application/octet-stream');
  res.setHeader('Content-Security-Policy',nativeCSP);
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.end(await readFile(target));
 }catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const address=server.address(), base=`http://127.0.0.1:${address.port}${prefix}`;
const browser=await chromium.launch({headless:true});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
 const consoleErrors=[];page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text().slice(0,400));});
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  const Original=window.AudioWorkletNode;
  window.AudioWorkletNode=class extends Original{
   constructor(context,name,options){
    super(context,name,options);
    const analyser=context.createAnalyser(),gain=context.createGain();
    gain.gain.value=0;this.connect(analyser);analyser.connect(gain);gain.connect(context.destination);
    window.__productionAnalyser=analyser;
   }
  };
 });
 await page.goto(base+'index.html');
 await page.locator('#start-audio').click();
 await page.waitForFunction(()=>document.querySelectorAll('#part-patch option').length>128,{timeout:60000});
 assert.equal(await page.locator('#parts-grid button[data-part]').count(),128);
 assert.equal(await page.locator('#part-rack [data-panel-part]').count(),128);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.evaluate(()=>{const box=document.querySelector('.keyboard-panel').getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}),true);
 await page.keyboard.down('a');
 const peak=await page.evaluate(async()=>{
  let peak=0;const data=new Float32Array(2048);
  for(let i=0;i<12;i++){await new Promise(done=>setTimeout(done,40));window.__productionAnalyser.getFloatTimeDomainData(data);for(const x of data)peak=Math.max(peak,Math.abs(x));}
  return peak;
 });
 await page.keyboard.up('a');
 assert(peak>0.00001,`Production bank was silent: ${peak}`);
 const catalog=await page.locator('.catalog-link').getAttribute('href');
 const reportResponse=await page.request.get(new URL(catalog,base).href);
 assert(reportResponse.ok(),'Native-prefixed catalog URL did not resolve');
 const reportHTML=await reportResponse.text();assert.equal((reportHTML.match(/<li>/g)||[]).length,250);
 const bankNotices=await page.request.get(base+'licenses/banks/README.txt');
 assert(bankNotices.ok(),'Bundled bank notices are missing');
 // Test the lazy Vorbis encoder under the native content-security policy too.
 await BasicSoundBank.ready;SpessaLog.setLogLevel(false,false,false);
 await page.locator('[data-tab="library"]').click();
 await page.locator('#import-bank').setInputFiles({name:'csp-test.sf2',mimeType:'application/octet-stream',buffer:Buffer.from(BasicSoundBank.getSampleSoundBankFile())});
 const compressed=page.waitForEvent('download',{timeout:15000});
 await page.locator('[data-bank-compress]').last().click();
 const download=await compressed.catch(async error=>{console.log('CONVERSION_STATUS',await page.locator('#status').textContent());console.log('CONSOLE_ERRORS',JSON.stringify(consoleErrors));throw error;});
 const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);
 const bytes=Buffer.concat(chunks),bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
 assert(bank.samples.every(sample=>sample.isCompressed&&sample.getAudioData().every(Number.isFinite)));
 await page.locator('[data-bank-use]').first().click();
 await page.locator('#panels-home').click();
 await mkdir('output',{recursive:true});
 await page.screenshot({path:'output/Project128_Portrait.png'});
 await page.locator('[data-tab="parameters"]').click();
 await page.screenshot({path:'output/Project128_Parameters.png'});
 await page.locator('#panels-home').click();
 await page.locator('[data-rack-patch="0"]').click();
 await page.screenshot({path:'output/Project128_PatchBrowser.png'});
 await page.locator('#close-patch-dialog').click();
 await page.setViewportSize({width:1440,height:1024});
 await page.screenshot({path:'output/Project128_Desktop.png'});
 await page.setViewportSize({width:768,height:1024});
 await page.screenshot({path:'output/Project128_Tablet.png'});
 assert.deepEqual(errors,[]);
 const report={built_assets:true,native_token_prefix:true,native_content_security_policy:true,browser_sf3_conversion:true,parts:128,editable_part_panels:128,docked_keyboard:true,starter_presets:await page.locator('#part-patch option').count(),actual_audio_peak:peak,
  user_gesture_audio:true,portrait_horizontal_overflow:false,catalog_count:250,page_errors:errors,native_iOS_verified:false};
 await writeFile('output/production-verification.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(done=>server.close(done));}
