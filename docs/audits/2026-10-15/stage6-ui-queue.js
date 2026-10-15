(async()=>{await window.userProfileReady;if(!document.querySelector('#userNameModal').classList.contains('hidden'))document.querySelector('#skipUserName').click();await window.conveyorUI.ready;
window.conveyorUI.setView('queue');if(document.querySelector('#cvQueueResume').classList.contains('hidden'))throw new Error('No way to resume interrupted queue');
await window.conveyorUI.act('queue-resume');let queue;
for(let i=0;i<150;i++){queue=await window.spriteLab.conveyor.queue();if(['done','failed'].includes(queue.items[0]?.status))break;await new Promise(r=>setTimeout(r,20));}
if(queue.items[0]?.status!=='done')throw new Error(queue.items[0]?.detail||'Queue stalled');
if(queue.items[0].resumeId)throw new Error('Queue kept checkpoint');
window.conveyorUI.renderQueue(queue);document.documentElement.dataset.theme='light';document.documentElement.dataset.shellMotion='off';
})();