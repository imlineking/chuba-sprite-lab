import assert from 'node:assert/strict';
import {test,afterEach} from 'node:test';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import '../src/pixel-colors.js';
import {frameColorPatch,frameAdjustmentPatch} from '../src/frame-color.mjs';
import {createDocument,ensureCel,compositeFrame,addLayer,createHistory,pushPatch,undoPatch,redoPatch} from '../src/sprite-document.mjs';
import {openSession,changeFrameColor,adjustFrame,stepHistory,readState,resetSessionsForTests} from '../src/editor-session.mjs';
import {keyFrame} from '../src/processor.mjs';
const colors=globalThis.SpriteLabPixelColors;
afterEach(resetSessionsForTests);
const pixels=new Uint8ClampedArray([120,60,20,255,121,60,20,255,120,60,20,128,120,60,20,0]);

test('palette shows diverse actual RGB colours before the near-white variants',()=>{
 const input=[];
 for(let n=220;n<255;n++)for(let k=0;k<80;k++)input.push(n,n,n,255);
 for(const c of [[120,60,20],[25,100,30],[215,180,20]])for(let k=0;k<30;k++)input.push(...c,255);
 input.push(255,0,255,0);
 const palette=colors.palette(input),keys=palette.slice(0,32).map(c=>c.slice(0,3).join(','));
 for(const key of ['120,60,20','25,100,30','215,180,20'])assert.ok(keys.includes(key));
 assert.equal(palette.length,38);assert.ok(!palette.some(c=>c.join(',')==='255,0,255,255'));
});
test('HSV converts picker coordinates to exact RGB primary colours and back',()=>{
 for(const rgb of [[255,0,0],[0,255,0],[0,0,255],[120,60,20],[255,255,255],[0,0,0]])assert.deepEqual(colors.hsvToRgb(...colors.rgbToHsv(rgb)).slice(0,3),rgb);
});
test('preview replaces every disconnected exact match, keeps alpha and does not mutate source',()=>{
 const original=pixels.slice(),out=colors.preview(pixels,colors.matches(pixels,[120,60,20]),[20,150,60]);
 assert.deepEqual([...out],[20,150,60,255,121,60,20,255,20,150,60,128,120,60,20,0]);assert.deepEqual(pixels,original);
 assert.equal(colors.matches(pixels,[120,60,20],1).length,3);
});
test('frame replacement, removal and undo are atomic and agree with preview',()=>{
 const session=openSession({width:4,height:1,pixels});
 const changed=changeFrameColor(session.sessionId,{source:[120,60,20],replacement:[20,150,60]});
 assert.equal(changed.changedPixels,2);assert.deepEqual(changed.composite,colors.preview(session.composite,colors.matches(session.composite,[120,60,20]),[20,150,60]));
 assert.deepEqual(stepHistory(session.sessionId).composite,new Uint8ClampedArray([...pixels.slice(0,12),0,0,0,0]));
 assert.equal(readState(session.sessionId).canUndo,false);stepHistory(session.sessionId,'redo');
 const removed=changeFrameColor(session.sessionId,{source:[20,150,60],erase:true});
 assert.equal(removed.composite[3],0);assert.equal(removed.composite[11],0);assert.equal(removed.composite[7],255);
 assert.equal(stepHistory(session.sessionId).composite[11],128);
});
test('multilayer colour operations preserve hidden layers and other frames through undo/redo',()=>{
 const doc=createDocument({width:2,height:1,frames:2});const base=doc.layers[0];
 ensureCel(doc,base.id,0).set([200,50,50,255,80,90,100,255]);ensureCel(doc,base.id,1).set([1,2,3,255,4,5,6,255]);
 const top=addLayer(doc);top.opacity=150;top.blendMode='multiply';ensureCel(doc,top.id,0).set([50,200,50,255,0,0,0,0]);
 const hidden=addLayer(doc);hidden.visible=false;hidden.locked=true;ensureCel(doc,hidden.id,0).fill(99);
 const before=compositeFrame(doc,0),other=compositeFrame(doc,1),history=createHistory();
 const patch=frameColorPatch(doc,0,[...before.slice(0,3)],[10,20,30]);pushPatch(history,doc,patch);
 assert.deepEqual([...compositeFrame(doc,0).slice(0,4)],[10,20,30,255]);assert.deepEqual(compositeFrame(doc,0).slice(4),before.slice(4));
 const later=addLayer(doc,'Later');later.locked=true;
 undoPatch(history,doc);assert.deepEqual(compositeFrame(doc,0),before);assert.ok(doc.layers.some(l=>l.id===later.id&&l.locked));
 redoPatch(history,doc);assert.deepEqual([...compositeFrame(doc,0).slice(0,4)],[10,20,30,255]);assert.deepEqual(compositeFrame(doc,1),other);
 const remove=frameColorPatch(doc,0,[10,20,30],null,{erase:true});pushPatch(history,doc,remove);assert.equal(compositeFrame(doc,0)[3],0);
 undoPatch(history,doc);assert.equal(compositeFrame(doc,0)[3],255);assert.deepEqual([...ensureCel(doc,hidden.id,0)],Array(8).fill(99));
});
test('locked contributing layer blocks the whole operation without partial writes',()=>{
 const doc=createDocument({width:4,height:1});ensureCel(doc,doc.layers[0].id,0).set(pixels);doc.layers[0].locked=true;
 assert.throws(()=>frameColorPatch(doc,0,[120,60,20],[0,0,0]),/заблокирован/);assert.deepEqual(ensureCel(doc,doc.layers[0].id,0),pixels);
 assert.throws(()=>frameColorPatch(doc,0,[-1,0,0],[0,0,0]),/исходный/);
});
test('unchanged replacement and identity grading create no history',()=>{
 const session=openSession({width:4,height:1,pixels});
 assert.equal(changeFrameColor(session.sessionId,{source:[120,60,20],replacement:[120,60,20]}).canUndo,false);
 assert.equal(adjustFrame(session.sessionId,{adjustments:{}}).canUndo,false);
});
test('grading preserves alpha, neutral identity and protects transparent hidden RGB',()=>{
 assert.deepEqual(colors.adjust(pixels),pixels);
 const gray=colors.adjust(pixels,{saturation:-100});assert.equal(gray[0],gray[1]);assert.equal(gray[1],gray[2]);
 const bright=colors.adjust(pixels,{brightness:20});assert.ok(bright[0]>pixels[0]);assert.equal(bright[11],128);assert.deepEqual(bright.slice(12),pixels.slice(12));
 const tint=colors.adjust(pixels,{tint:'#00ff00',tintStrength:100});assert.equal(tint[0],0);assert.equal(tint[2],0);assert.equal(tint[1],pixels[1]);
 const ramp=new Uint8ClampedArray([25,25,25,255,230,230,230,255]);
 const shadow=colors.adjust(ramp,{shadows:50}),light=colors.adjust(ramp,{highlights:-50});
 assert.ok(shadow[0]-ramp[0]>shadow[4]-ramp[4]);assert.ok(ramp[4]-light[4]>ramp[0]-light[0]);
 const contrast=colors.adjust(ramp,{contrast:50});assert.ok(contrast[0]<ramp[0]);assert.ok(contrast[4]>ramp[4]);
});
test('multiple grading sliders commit as one undoable operation with exact preview parity',()=>{
 const session=openSession({width:4,height:1,pixels});const options={brightness:10,saturation:30,contrast:-20,shadows:15,highlights:-10,tint:'#ffbb88',tintStrength:35};
 const original=readState(session.sessionId).composite;const changed=adjustFrame(session.sessionId,{adjustments:options});
 assert.deepEqual(changed.composite,colors.adjust(original,options));assert.deepEqual(stepHistory(session.sessionId).composite,original);assert.equal(readState(session.sessionId).canUndo,false);
 assert.deepEqual(stepHistory(session.sessionId,'redo').composite,changed.composite);
});
test('RGB normalization handles grayscale+alpha, indexed PNG and CMYK JPEG in the real processing path',async()=>{
 const fixtures=[
  await sharp(Buffer.from([50,128,200,255]),{raw:{width:2,height:1,channels:2}}).toColourspace('b-w').png().toBuffer(),
  await sharp(Buffer.from([120,60,20,255,25,100,30,0]),{raw:{width:2,height:1,channels:4}}).png({palette:true}).toBuffer(),
  await sharp(Buffer.from([120,60,20,255,25,100,30,255]),{raw:{width:2,height:1,channels:4}}).toColourspace('cmyk').jpeg().toBuffer()
 ];
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'sprite-lab-rgb-'));
 try {for(const [index,input] of fixtures.entries()){
  const inputPath=path.join(folder,String(index)+'.png');await fs.writeFile(inputPath,input);
  const result=await keyFrame(inputPath,'alpha',0,0,0);const decoded=await sharp(result.buffer).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(result.info.channels,4);assert.equal(result.info.width,2);assert.equal(decoded.data.length,8);
 }} finally {await fs.rm(folder,{recursive:true,force:true});}
});
