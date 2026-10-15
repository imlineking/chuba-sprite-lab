(async () => {
  await window.userProfileReady;
  if (!document.querySelector('#userNameModal').classList.contains('hidden')) {
    document.querySelector('#skipUserName').click();
  }
  window.conveyorUI.setView('conveyor');
  await window.conveyorUI.detect(['C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab/docs/audits/2026-10-15/fixture.png']);
  document.documentElement.dataset.shellMotion = 'off';
})();
