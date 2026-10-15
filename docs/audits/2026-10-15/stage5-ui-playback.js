(async()=>{await window.userProfileReady;
if (!document.querySelector('#userNameModal').classList.contains('hidden')) document.querySelector('#skipUserName').click();
await window.conveyorUI.ready;window.conveyorUI.setView('conveyor');
const base='C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/';

await window.conveyorUI.detect([base+'timing-shaped.gif']);await window.conveyorUI.act('preset:pixel-art');await window.conveyorUI.act('run');await window.conveyorUI.renderPreview('result');
const result=window.conveyorUI.snapshot().result;if(!result.ok)throw new Error(result.error);
if(result.artifacts.frames.length<2||document.querySelector('#cvPlay').disabled)throw new Error('No playback');
if(result.artifacts.frames.map(f=>f.durationMs).join(',')!=='80,240')throw new Error('Timing lost');
document.querySelector('#cvNextFrame').click();if(!document.querySelector('#cvFrameLabel').textContent.includes('240'))throw new Error('Step failed');
document.querySelector('#cvPlay').click();if(document.querySelector('#cvPlay').textContent!=='Пауза')throw new Error('No play');
await new Promise(resolve=>setTimeout(resolve,110));document.querySelector('#cvPlay').click();if(document.querySelector('#cvPlay').textContent!=='Воспроизвести')throw new Error('No pause');
document.documentElement.dataset.theme='light';document.documentElement.dataset.shellMotion='off';
})();