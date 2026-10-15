(async()=>{await window.userProfileReady;
if (!document.querySelector('#userNameModal').classList.contains('hidden')) document.querySelector('#skipUserName').click();
await window.conveyorUI.ready; window.conveyorUI.setView('conveyor');
const base='C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/';
const files=[base+'stage4-a.png',base+'stage4-b.png'];

await window.conveyorUI.detect(files);
if (!document.querySelector('#cvRunAll').disabled) throw new Error('Purpose required');
const {planConveyorGuide}=await import('./copilot-conveyor.mjs');
if (planConveyorGuide(window.conveyorUI.snapshot()).chips.length!==3) throw new Error('Three purposes required');
await window.conveyorUI.act('preset:pixel-art');
for(const intent of ['images','atlas','animation']){
 await window.conveyorUI.act('intent:'+intent);
 if(document.querySelector('#cvRunAll').disabled) throw new Error('Run disabled');
 await window.conveyorUI.act('run');
 const result=window.conveyorUI.snapshot().result;
 if(!result?.ok) throw new Error(intent+': '+result?.error);
 if(intent==='images'&&(result.review.kind!=='png'||result.exported.files.length!==2)) throw new Error('Independent PNG failed');
 if(intent!=='images'&&result.stages.find(s=>s.id==='pack').status!=='done') throw new Error('No atlas');
}
await window.conveyorUI.act('intent:images');
await window.conveyorUI.act('run');
await window.conveyorUI.renderPreview('result');
if(window.conveyorUI.snapshot().busy) throw new Error('Busy after finish');
document.documentElement.dataset.theme='dark'; document.documentElement.dataset.shellMotion='off';
})();