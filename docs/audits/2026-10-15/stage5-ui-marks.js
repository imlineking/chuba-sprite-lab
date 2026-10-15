(async()=>{await window.userProfileReady;
if (!document.querySelector('#userNameModal').classList.contains('hidden')) document.querySelector('#skipUserName').click();
await window.conveyorUI.ready;window.conveyorUI.setView('conveyor');
const base='C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/';

await window.conveyorUI.detect([base+'stage5-pale.png']);await window.conveyorUI.act('preset:pixel-art');await window.conveyorUI.act('run');
const result=window.conveyorUI.snapshot().result;if(!result.ok)throw new Error(result.error);
if(!result.review.issues.some(i=>i.code==='pale_alpha'&&i.regions.length))throw new Error('No located finding');
await window.conveyorUI.act('review');

const show=[...document.querySelectorAll('.review-panel button')].find(b=>b.textContent==='Показать кадр и участки');if(!show)throw new Error('No inspect action');show.click();
for(let n=0;n<100&&document.querySelector('#cvIssueOverlay').classList.contains('hidden');n++)await new Promise(resolve=>setTimeout(resolve,20));
const overlay=document.querySelector('#cvIssueOverlay');if(overlay.classList.contains('hidden'))throw new Error('No marks');
const image=document.querySelector('#cvPreviewImage');if(!image.complete)await new Promise(resolve=>image.onload=resolve);
await new Promise(resolve=>requestAnimationFrame(resolve));
const pixels=overlay.getContext('2d').getImageData(0,0,overlay.width,overlay.height).data;if(!pixels.some((v,i)=>i%4===3&&v>0))throw new Error('Empty overlay');
document.querySelector('#cvPreviewFit').click();await new Promise(resolve=>requestAnimationFrame(resolve));
document.querySelector('#cvPreviewFit').click();
document.documentElement.dataset.theme='light';document.documentElement.dataset.shellMotion='off';
})();