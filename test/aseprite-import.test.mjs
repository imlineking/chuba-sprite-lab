import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodeAseprite } from '../src/aseprite-import.mjs';
import { encodeEditorDocument,decodeEditorDocument } from '../src/editor-document.mjs';
import { compositeFrame } from '../src/sprite-document.mjs';
const word=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const string=s=>Buffer.concat([word(Buffer.byteLength(s)),Buffer.from(s)]);
const chunk=(type,data)=>{const b=Buffer.alloc(6);b.writeUInt32LE(data.length+6);b.writeUInt16LE(type,4);return Buffer.concat([b,data]);};
export function aseFixture(depth=32){
  const layer=Buffer.alloc(16);layer.writeUInt16LE(3);layer[12]=255;
  const image=Buffer.alloc(20);image[6]=255;image.writeUInt16LE(2,7);image.writeUInt16LE(2,16);image.writeUInt16LE(1,18);
  const raw=depth===32?Buffer.from([255,0,0,255,0,255,0,128]):depth===16?Buffer.from([70,255,200,128]):Buffer.from([1,0]);
  const linked=Buffer.alloc(18);linked.writeInt16LE(1,2);linked.writeInt16LE(2,4);linked[6]=255;linked.writeUInt16LE(1,7);
  const palette=Buffer.alloc(26);palette.writeUInt32LE(2);palette.writeUInt32LE(1,8);palette.set([0,0,0,0],22);const pal=Buffer.concat([palette,Buffer.from([0,0,255,50,80,255])]);
  const tag=Buffer.alloc(27);tag.writeUInt16LE(1);tag.writeUInt16LE(1,12);tag[14]=2;
  const chunks=[[chunk(0x2004,Buffer.concat([layer,string('Лист')])),chunk(0x2019,pal),chunk(0x2018,Buffer.concat([tag,string('Полёт')])),chunk(0x2005,Buffer.concat([image,deflateSync(raw)]))],[chunk(0x2005,linked)]];
  const frames=chunks.map((items,i)=>{const h=Buffer.alloc(16),payload=Buffer.concat(items);h.writeUInt32LE(16+payload.length);h.writeUInt16LE(0xf1fa,4);h.writeUInt16LE(items.length,6);h.writeUInt16LE(i?230:80,8);return Buffer.concat([h,payload]);});
  const h=Buffer.alloc(128);h.writeUInt32LE(128+frames.reduce((s,f)=>s+f.length,0));h.writeUInt16LE(0xa5e0,4);h.writeUInt16LE(2,6);h.writeUInt16LE(4,8);h.writeUInt16LE(4,10);h.writeUInt16LE(depth,12);h.writeUInt32LE(1,14);
  return Buffer.concat([h,...frames]);
}
test('native Aseprite retains linked cel positions, RGBA, layers, Cyrillic tags and duration',()=>{
  const image=decodeAseprite(aseFixture());assert.equal(image.frames.length,2);assert.deepEqual(image.frames.map(f=>f.durationMs),[80,230]);assert.deepEqual([...image.frames[1].pixels.subarray((2*4+1)*4,(2*4+3)*4)],[255,0,0,255,0,255,0,128]);assert.equal(image.tags[0].name,'Полёт');assert.equal(image.tags[0].direction,'pingpong');
  for(const frame of image.frames){const doc=decodeEditorDocument(encodeEditorDocument(frame.document,0),{width:4,height:4});assert.equal(doc.layers[0].name,'Лист');assert.deepEqual(Buffer.from(compositeFrame(doc,0)),frame.pixels);}
});
test('Aseprite indexed transparent index and grayscale are decoded separately from white content',()=>{
  const indexed=decodeAseprite(aseFixture(8));assert.deepEqual([...indexed.frames[0].pixels.subarray(0,8)],[255,50,80,255,0,0,0,0]);const gray=decodeAseprite(aseFixture(16));assert.deepEqual([...gray.frames[0].pixels.subarray(0,8)],[70,70,70,255,200,200,200,128]);
});
test('Aseprite rejects corrupt chunk boundaries and linked cel cycles',()=>{
  const truncated=aseFixture().subarray(0,130);assert.throws(()=>decodeAseprite(truncated));const bad=aseFixture();bad.writeUInt32LE(0xffffffff,144);assert.throws(()=>decodeAseprite(bad),/Оборванный/);
  const cycle=aseFixture();cycle.writeUInt16LE(1,cycle.length-2);assert.throws(()=>decodeAseprite(cycle),/Циклическая/);
});
