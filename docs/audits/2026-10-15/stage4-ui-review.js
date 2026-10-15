(async()=>{await window.userProfileReady;
if (!document.querySelector('#userNameModal').classList.contains('hidden')) document.querySelector('#skipUserName').click();
await window.conveyorUI.ready; window.conveyorUI.setView('conveyor');
const base='C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/';
const files=[base+'stage4-a.png',base+'stage4-b.png'];

await window.conveyorUI.detect([files[0]]);
await window.conveyorUI.act('review');
const dialog=document.querySelector('.review-panel[open]');
if(!dialog||!dialog.textContent.includes('Пиксели не изменялись')) throw new Error('No PNG report');
if(dialog.querySelector('.review-actions').textContent.includes('Проверить снова')) throw new Error('Atlas actions in PNG review');
document.documentElement.dataset.theme='light';document.documentElement.dataset.shellMotion='off';
})();