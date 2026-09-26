import assert from "node:assert/strict";
import { test } from "node:test";
import { findBodyAnchor } from "../src/body-anchor.mjs";

function ball(tailLength, tailWidth = 8) {
  const width = 160; const height = 100; const data = new Uint8Array(width * height * 4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    if((x-45)**2+(y-50)**2<=30**2 || (x>=70 && x<70+tailLength && y>=50-tailWidth/2 && y<50+tailWidth/2)) data[(y*width+x)*4+3]=255;
  }
  return { data, info:{width,height,channels:4} };
}

test("dense-core anchor stays on the ball when a thick thread grows", () => {
  for(const tail of [4,35,85]) {
    const frame=ball(tail); const point=findBodyAnchor(frame.data,frame.info);
    assert.equal(point.method,"dense-core");
    assert.ok(Math.abs(point.x-45)<=.5 && Math.abs(point.y-50)<=.5, JSON.stringify(point));
    assert.ok(point.radius>=29 && point.radius<=31);
  }
});

test("thin and empty images use the stable mass-median fallback", () => {
  const info={width:100,height:100,channels:4}; const data=new Uint8Array(40000);
  assert.deepEqual(findBodyAnchor(data,info),{x:50,y:50,radius:0,method:"alpha-median"});
  for(let x=20;x<80;x++) data[(50*100+x)*4+3]=255;
  assert.deepEqual(findBodyAnchor(data,info),{x:49,y:50,radius:1,method:"alpha-median"});
});
