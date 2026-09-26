(async()=>{
 await window.userProfileReady;
 if(!document.querySelector('#userNameModal').classList.contains('hidden')){await spriteLab.saveUserProfile('Тест');setModalOpen(document.querySelector('#userNameModal'),false);}
 clearTimeout(state.sessionTimer);saveSessionSoon=()=>{};savePreferences=()=>{};
 const check=(condition,message)=>{if(!condition)throw new Error(message);};
 if(localStorage.getItem('appearance.qa.completed')){
  check(document.documentElement.dataset.theme==='light','Theme lost after restarting Electron');
  check(document.documentElement.dataset.shellMotion==='off','Motion preference lost after restarting Electron');
 }
 await window.openUserPreferences();
 const light=document.querySelector('[data-appearance-theme=light]'), dark=document.querySelector('[data-appearance-theme=dark]');
 dark.focus();dark.click();check(document.documentElement.dataset.theme==='dark','Dark selector failed');
 light.focus();light.click();check(document.documentElement.dataset.theme==='light','Light selector failed');
 check(light.getAttribute('aria-pressed')==='true'&&dark.getAttribute('aria-pressed')==='false','Selection state is ambiguous');
 check(document.activeElement===light,'Theme switch moved keyboard focus');
 document.querySelector('#themeToggle').click();check(document.documentElement.dataset.theme==='dark','Header toggle failed');
 document.querySelector('#themeToggle').click();check(document.documentElement.dataset.theme==='light','Header reverse toggle failed');
 const motion=document.querySelector('#appearanceMotion');
 if(!motion.disabled){if(motion.checked)motion.click();motion.click();check(localStorage.getItem('spriteLab.shellMotion')==='on','Motion could not be enabled');motion.click();}
 check(document.documentElement.dataset.shellMotion==='off','Motion could not be disabled');
 setTab('process');check(document.querySelectorAll('.panel.active').length===1,'Navigation left more than one active panel');
 check(document.querySelector('#sourcePanel').inert&&!document.querySelector('#processPanel').inert,'Navigation focus isolation changed');
 check(!document.querySelector('.shell-curtains').getAnimations({subtree:true}).length,'Disabled curtains still animate');
 setLocale('en',{persist:false});spriteLabAppearance.choose('dark');
 check(document.querySelector('#themeToggle').title==='Light theme · Porcelain','Theme toggle did not use the active language');
 setLocale('ru',{persist:false});spriteLabAppearance.choose('light');
 localStorage.setItem('appearance.qa.completed','1');
 await spriteLab.logError('APPEARANCE_SETTINGS_OK selector toggle focus motion restart locale inert');
})()
