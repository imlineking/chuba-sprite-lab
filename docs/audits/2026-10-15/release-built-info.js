(async()=>{
await window.userProfileReady;
if(!document.querySelector('#userNameModal').classList.contains('hidden'))document.querySelector('#skipUserName').click();
await window.conveyorUI.ready;
const info=await window.spriteLab.getAppInfo();
if(info.version!=='1.9.0'||!info.portable)throw new Error('Wrong packaged version: '+JSON.stringify(info));
for(const id of ['versionBadge','aboutVersion'])if(document.getElementById(id).textContent.trim()!=='1.9.0')throw new Error('Stale version in '+id);
window.conveyorUI.setView('conveyor');
document.documentElement.dataset.theme='light';
document.documentElement.dataset.shellMotion='off';
})();
