(async()=>{await window.userProfileReady;
if (!document.querySelector('#userNameModal').classList.contains('hidden')) document.querySelector('#skipUserName').click();
await window.conveyorUI.ready; window.conveyorUI.setView('conveyor');
const base='C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/';
const files=[base+'stage4-a.png',base+'stage4-b.png'];

await window.conveyorUI.detect(files); await window.conveyorUI.act('intent:images');
window.conveyorUI.renderResult({ok:false,failedStage:'export',error:'Контрольный пример: экспорт прерван',resumeId:'ui-test-invalid-token'});
const button=document.querySelector('#cvResult button');
if(!button||!button.textContent.includes('Продолжить')) throw new Error('No resume button');
await window.conveyorUI.act('resume');
if(!window.conveyorUI.snapshot().result?.resumeInvalid) throw new Error('Invalid checkpoint not rejected');
if(document.querySelector('#cvResult button')) throw new Error('Invalid resume button remained');
document.documentElement.dataset.theme='light';document.documentElement.dataset.shellMotion='off';
})();