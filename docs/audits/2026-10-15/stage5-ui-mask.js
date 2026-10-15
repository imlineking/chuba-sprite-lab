(async()=>{await window.userProfileReady;
if (!document.querySelector('#userNameModal').classList.contains('hidden')) document.querySelector('#skipUserName').click();
await window.conveyorUI.ready;window.conveyorUI.setView('conveyor');
const base='C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/';

await window.conveyorUI.detect([base+'stage5-pale.png']);await window.conveyorUI.act('preset:pixel-art');await window.conveyorUI.act('run');
const result=window.conveyorUI.snapshot().result;if(!result.ok)throw new Error(result.error);
if(!result.review.issues.some(i=>i.code==='pale_alpha'&&i.regions.length))throw new Error('No located finding');
await window.conveyorUI.act('review');

const edit=[...document.querySelectorAll('.review-panel button')].find(b=>b.textContent==='Править маску этого кадра');if(!edit)throw new Error('No edit action');edit.click();
for(let n=0;n<150&&document.querySelector('#aiMaskModal').classList.contains('hidden');n++)await new Promise(resolve=>setTimeout(resolve,20));
if(document.querySelector('#aiMaskModal').classList.contains('hidden'))throw new Error('Mask not opened');
if(state.selectedFrameIndex!==0||state.source.paths.length!==1)throw new Error('Wrong mask frame');
document.documentElement.dataset.theme='dark';document.documentElement.dataset.shellMotion='off';
})();