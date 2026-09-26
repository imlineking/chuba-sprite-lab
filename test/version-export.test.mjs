import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import sharp from 'sharp';
import { processSprites, inspectSource } from '../src/processor.mjs';

test('UI, lockfile and real engine exports use the application version', async t => {
 const root=path.resolve(import.meta.dirname,'..');
 const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 const lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
 assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
 const markup=await fs.readFile(path.join(root,'src/index.html'),'utf8');
 assert.equal(/id="versionBadge"[^>]*>([^<]+)/.exec(markup)[1],pkg.version);
 assert.equal(/id="aboutVersion"[^>]*>([^<]+)/.exec(markup)[1],pkg.version);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sprite-version-'));
 assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const image=path.join(dir,'input.png');
 await sharp({create:{width:16,height:16,channels:4,background:{r:180,g:120,b:30,alpha:1}}}).png().toFile(image);
 const source=await inspectSource({kind:'frames',paths:[image],appRoot:root});
 for(const format of ['texturepacker','phaser3']){
  const result=await processSprites({source,appRoot:root,outputDir:path.join(dir,format),name:'version-check',options:{keyMode:'alpha',autoSize:true,autoColumns:true,padding:2,removeDuplicates:false,outputBackground:'transparent',exportFormat:format,exports:{sheet:true,frames:false,metadata:true,preview:false}}});
  const suffix=format==='phaser3'?'phaser':'texturepacker';
  const metadata=JSON.parse(await fs.readFile(path.join(path.dirname(result.sheetPath),`version-check.${suffix}.json`),'utf8'));
  assert.equal(metadata.meta.version,pkg.version,format+' exported version');
 }
});
