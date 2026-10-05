// Run with Electron. Real BrowserWindows/IPC, an isolated profile and a supplied
// native DIP cursor. This does not claim to exercise physical mouse input.
import { app, BrowserWindow, screen, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
app.setPath('userData', path.join(output, 'profile'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  await fs.mkdir(output, {recursive:true});
  const { DesktopCompanion } = await import(pathToFileURL(path.join(root,'src/desktop-companion.mjs')));
  const report = {ok:false, physicalMouseTest:false, checks:[]};
  const area=screen.getPrimaryDisplay().workArea;
  let cursor={x:area.x+20,y:area.y+20};
  const fixture=new BrowserWindow({width:300,height:180,x:area.x+50,y:area.y+80,webPreferences:{sandbox:true,contextIsolation:true}});
  await fixture.loadURL('data:text/html,<title>Companion QA</title><input placeholder="Focus fixture">');
  const testScreen={getCursorScreenPoint:()=>cursor,getAllDisplays:()=>screen.getAllDisplays(),getPrimaryDisplay:()=>screen.getPrimaryDisplay(),getDisplayMatching:b=>screen.getDisplayMatching(b),on:(...args)=>screen.on(...args),removeListener:(...args)=>screen.removeListener(...args)};
  const companion=new DesktopCompanion({app,BrowserWindow,screen:testScreen,ipcMain,appRoot:root,mainWindow:()=>fixture});
  const ipc=(surface,request)=>surface.webContents.executeJavaScript(`desktopCompanion.action(${JSON.stringify(request)})`);
  try {
    await companion.create(); companion.update({loading:false,greeting:'Проверка помощника'});
    await pause(300);
    companion.pet.setBounds({x:area.x+Math.min(800,area.width-150),y:area.y+300,width:112,height:128});
    for(const surface of [companion.pet,companion.bubble]) {
      const before=companion.pet.getBounds(), bubble=companion.bubble.getBounds();
      cursor={x:before.x+50,y:before.y+50};
      await ipc(surface,{action:'drag-start',x:-9999,y:9999});
      cursor={x:cursor.x+40,y:cursor.y+20};
      await pause(80);
      for(let i=0;i<10;i++) await ipc(surface,{action:'drag-move',x:-9999-i*100,y:9999});
      assert.ok(Math.abs(companion.pet.getBounds().x-before.x-40)<=1);
      assert.ok(Math.abs(companion.pet.getBounds().y-before.y-20)<=1);
      assert.ok(Math.abs(companion.bubble.getBounds().x-bubble.x-40)<=1);
      assert.ok(companion.pet.getBounds().width<=114 && companion.pet.getBounds().height<=130);
      await ipc(surface,{action:'drag-end'});
    }
    report.checks.push('native bounds follow supplied DIP cursor without renderer coordinate feedback');
    cursor={x:area.x+20,y:area.y+20}; await pause(60);
    assert.equal(companion.mousePassthrough.get(companion.pet),true);
    assert.equal(companion.mousePassthrough.get(companion.bubble),true);
    const pet=companion.pet.getBounds(); cursor={x:pet.x+50,y:pet.y+50}; await pause(60);
    assert.equal(companion.mousePassthrough.get(companion.pet),false);
    await ipc(companion.pet,{action:'toggle'}); await pause(200);
    assert.equal(companion.panelOpen,true);
    const bubble=companion.bubble.getBounds(); cursor={x:bubble.x+20,y:bubble.y+30}; await pause(60);
    assert.equal(companion.mousePassthrough.get(companion.bubble),false);
    cursor={x:bubble.x+2,y:bubble.y+30}; await pause(60);
    assert.equal(companion.mousePassthrough.get(companion.bubble),true);
    report.checks.push('native mouse passthrough toggles for pet, menu, transparent margins');
    fixture.focus(); await pause(100);
    assert.equal(fixture.isFocused(),true);
    companion.show(true); companion.update({loading:false,busy:true,workLabel:'Проверка'});
    for(let i=0;i<35;i++){await pause(100);assert.equal(fixture.isFocused(),true);}
    assert.equal(companion.pet.isFocusable(),false); assert.equal(companion.bubble.isFocusable(),true);
    report.checks.push('other window keeps keyboard focus through show/update and beyond former three-second raise timer');
    await ipc(companion.bubble,{action:'command',command:{kind:'quick',id:'clipping'}});
    assert.equal(fixture.isFocused(),true);
    const saved=companion.pet.getBounds(); await companion.save(); companion.destroy(); await companion.create();
    assert.equal(companion.pet.getBounds().x,saved.x);assert.equal(companion.pet.getBounds().y,saved.y);
    report.checks.push('released position survives recreation; helper command remains callable');
    await fs.writeFile(path.join(output,'pet.png'),(await companion.pet.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(output,'bubble.png'),(await companion.bubble.webContents.capturePage()).toPNG());
    report.ok=true;
  } catch(error){report.error=error.stack;} finally {
    companion.destroy();fixture.destroy();
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report)); app.exit(report.ok?0:1);
  }
}).catch(error=>{console.error(error);app.exit(1);});
