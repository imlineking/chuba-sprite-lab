(async()=>{
 await window.userProfileReady;if(!$('#userNameModal').classList.contains('hidden')){await spriteLab.saveUserProfile('Тест');setModalOpen($('#userNameModal'),false);}
 clearTimeout(state.sessionTimer);saveSessionSoon=()=>{};savePreferences=()=>{};
 const pause=ms=>new Promise(r=>setTimeout(r,ms)),assert=(v,m)=>{if(!v)throw new Error(m);};
 document.documentElement.dataset.shellMotion='on';spriteLabAppearance.choose('dark');await pause(180);
 setTab('process');await pause(40);const moving=document.querySelector('.control-deck').getAnimations({subtree:true}).length;assert(moving>0,'Tab transition missing');
 setTab('export');setTab('source');await pause(580);assert(!document.querySelector('.control-deck').getAnimations({subtree:true}).length,'Rapid section change leaves animation');
 $('#backdropToggle').click();await pause(35);assert($('#backdropMenu').getAnimations({subtree:true}).length>0,'Popup does not animate');
 closeBackdropMenu();await pause(20);assert(!$('#backdropMenu').getAnimations({subtree:true}).length,'Closed popup still animating');
 $('#backdropToggle').click();closeBackdropMenu();$('#backdropToggle').click();await pause(520);assert(!$('#backdropMenu').getAnimations({subtree:true}).length,'Popup reopening leaves animation');closeBackdropMenu();
 await openAbout();await pause(40);assert($('#aboutModal').getAnimations({subtree:true}).length>0,'Modal reveal missing');
 closeAbout();await pause(20);assert(!$('#aboutModal').getAnimations({subtree:true}).length,'Closed modal still animating');
 document.documentElement.dataset.shellMotion='off';spriteLabShellMotion.cancel();setTab('process');$('#backdropToggle').click();await pause(50);
 assert(!document.querySelector('#appShell').getAnimations({subtree:true}).length,'Disabled motion still running');closeBackdropMenu();
 await openAbout();await pause(30);$('#closeAbout').focus();const back=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true});trapModalFocus($('#aboutModal'),back);assert(back.defaultPrevented&&document.activeElement!==$('#closeAbout'),'Reverse focus trap failed');const next=new KeyboardEvent('keydown',{key:'Tab',cancelable:true});trapModalFocus($('#aboutModal'),next);assert(next.defaultPrevented&&document.activeElement===$('#closeAbout'),'Forward focus trap failed');closeAbout();assert(!$('#appShell').inert,'Modal left workspace inert');
 window.openFeedback('idea');$('#feedbackMessage').focus();assert(document.activeElement===$('#feedbackMessage'),'Feedback textarea inaccessible');window.closeFeedback();
 await spriteLab.logError('MOTION_AUDIT '+JSON.stringify({ok:true,checks:['section reveal','rapid navigation','popup close/reopen','modal close','motion off'],moving}));setTab('source');
})()
