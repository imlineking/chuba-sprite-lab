(() => {
  let profile=null, firstRun=false, saving=false;
  const modal=$("#userNameModal"), input=$("#userNameInput"), status=$("#userNameStatus");
  function render() {
    $("#userNameEyebrow").textContent=firstRun?"ЗНАКОМСТВО":"НАСТРОЙКИ";
    $("#userNameTitle").textContent=firstRun?"Привет, давай знакомиться!":"Как к вам обращаться?";
    $("#userNameIntro").textContent=firstRun?"Копилот запомнит имя и будет использовать его в приветствии.":"Измените имя для приветствия копилота. Пустое поле вернёт имя учётной записи.";
    input.value=profile?.name||"";
    input.placeholder=profile?.accountName||"Введите имя";
    $("#userNameAccountHint").textContent=profile?.accountName?`Имя учётной записи: ${profile.accountName}. ${firstRun?"При пропуске или закрытии окна используется это имя.":"Автоматическое приветствие использует только первое имя."}`:"Имя учётной записи недоступно. Без имени копилот скажет: «Привет! Давай начнём работу.»";
    $("#skipUserName").textContent=firstRun?"Пропустить":"Отмена";
    $("#saveUserName").textContent=firstRun?"Начать работу":"Сохранить";
    status.textContent=""; status.classList.remove("error");
  }
  async function save(name) {
    if(saving)return;
    saving=true;
    for(const button of modal.querySelectorAll("button")) button.disabled=true;
    status.textContent="Сохраняю…";
    try {
      profile=await window.spriteLab.saveUserProfile(name);
      setModalOpen(modal,false,null,$("#openPreferences"));
      firstRun=false;
    } catch(error) { status.textContent=error.message||"Не удалось сохранить имя.";status.classList.add("error"); }
    finally {saving=false;for(const button of modal.querySelectorAll("button"))button.disabled=false;}
  }
  function close() {
    if(saving)return;
    if(firstRun)void save("");
    else setModalOpen(modal,false,null,$("#openPreferences"));
  }
  window.openUserPreferences=async()=>{
    profile=await window.spriteLab.getUserProfile();firstRun=false;render();
    setModalOpen(modal,true,input,$("#openPreferences"));
  };
  $("#openPreferences").addEventListener("click",()=>window.openUserPreferences().catch(error=>showError(error.message)));
  $("#userNameForm").addEventListener("submit",event=>{event.preventDefault();void save(input.value);});
  $("#skipUserName").addEventListener("click",close);
  $("#closeUserName").addEventListener("click",close);
  modal.addEventListener("click",event=>{if(event.target===modal)close();});
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&!modal.classList.contains("hidden")){event.preventDefault();event.stopImmediatePropagation();close();}
  },true);
  window.userProfileReady=(async()=>{
    profile=await window.spriteLab.getUserProfile();
    if(!profile.onboardingCompleted){firstRun=true;render();setModalOpen(modal,true,input,$("#openPreferences"));}
    return profile;
  })().catch(error=>{showError(error.message||"Не удалось прочитать настройки имени.");return null;});
})();
