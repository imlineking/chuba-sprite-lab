// All visible source strings stay Russian. The shared catalog translates UI only, never user data.
const i18nSources=globalThis.SpriteLabI18nCatalog;
const i18nAttributes=["title","placeholder","aria-label","data-help","alt"];
const i18nSkipTags=new Set(["SCRIPT","STYLE","KBD","CODE","TEXTAREA"]);
const i18nState={locale:"ru",observer:null};
const i18nBindings=new WeakMap();
function i18nLocales(){return ["ru",...Object.keys(i18nSources)];}
function i18nDictionary(locale){return i18nSources[locale]||null;}
function i18nReverseDictionary(locale){return Object.fromEntries(Object.entries(i18nDictionary(locale)||{}).map(([source,translated])=>[translated,source]));}
function i18nMapFor(from,to){return from===to?null:to==="ru"?i18nReverseDictionary(from):i18nDictionary(to);}
function i18nSwap(text,map){if(typeof text!=="string"||!map)return null;const result=globalThis.SpriteLabI18n.translate(text,"en",{reverse:map!==i18nSources.en});return result===text?null:result;}
function t(source,replacements=null){let result=globalThis.SpriteLabI18n.translate(source,i18nState.locale);if(replacements)for(const [key,value]of Object.entries(replacements))result=result.split(`{${key}}`).join(String(value));return result;}
function i18nSkipped(node){for(let current=node;current;current=current.parentNode)if(current.tagName&&(i18nSkipTags.has(current.tagName)||current.hasAttribute?.("data-i18n-skip")))return true;return false;}
function i18nTextNodes(root){const nodes=[];const visit=node=>{if(!node||i18nSkipped(node))return;if(node.nodeType===3){nodes.push(node);return;}for(const child of node.childNodes||[])visit(child);};visit(root);return nodes;}
function i18nBoundValue(node,key,current,target){
  const bindings=i18nBindings.get(node)||{};const saved=bindings[key];
  let source=saved&&saved.last===current?saved.source:current;
  if(!(saved&&saved.last===current)&&!/[А-Яа-яЁё]/.test(source))source=globalThis.SpriteLabI18n.translate(source,"en",{reverse:true});
  const next=target==="en"?globalThis.SpriteLabI18n.translate(source,"en"):source;
  bindings[key]={source,last:next};i18nBindings.set(node,bindings);return next;
}
function i18nSwapTree(root,map){
  if(!map||!root||i18nSkipped(root))return 0;
  const target=map===i18nSources.en?"en":"ru";let changed=0;
  for(const node of i18nTextNodes(root)){const next=i18nBoundValue(node,"text",node.textContent,target);if(next!==node.textContent){node.textContent=next;changed++;}}
  const elements=[...(root.nodeType===1?[root]:[]),...(root.querySelectorAll?.("*")||[])];
  for(const element of elements){if(i18nSkipped(element))continue;for(const attribute of i18nAttributes){const value=element.getAttribute(attribute);if(value===null)continue;const next=i18nBoundValue(element,attribute,value,target);if(next!==value){element.setAttribute(attribute,next);changed++;}}}
  return changed;
}
function i18nObserve(){
  const wanted=i18nState.locale!=="ru";
  if(wanted&&!i18nState.observer&&typeof MutationObserver==="function"){
    i18nState.observer=new MutationObserver(records=>{
      const map=i18nMapFor("ru",i18nState.locale);if(!map)return;
      for(const record of records){if(record.type==="attributes"||record.type==="characterData")i18nSwapTree(record.target,map);for(const node of record.addedNodes||[])i18nSwapTree(node,map);}
    });
    i18nState.observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:i18nAttributes});
  }else if(!wanted&&i18nState.observer){i18nState.observer.disconnect();i18nState.observer=null;}
}
function setLocale(locale,{persist=true}={}){
  const target=i18nLocales().includes(locale)?locale:"ru";
  if(target!==i18nState.locale){i18nState.observer?.disconnect();i18nState.observer=null;i18nSwapTree(document.body,i18nMapFor(i18nState.locale,target));i18nState.locale=target;}
  document.documentElement.lang=target;if(typeof document.title==="string")document.title=i18nBoundValue(document,"title",document.title,target);const select=document.getElementById("locale");if(select)select.value=target;i18nObserve();
  if(typeof window!=="undefined"&&window.spriteLab?.setLocale)void window.spriteLab.setLocale(target).catch(()=>{});
  if(persist&&typeof savePreferences==="function")savePreferences();
}
function i18nSavedLocale(){try{const saved=JSON.parse(localStorage.getItem("spriteLab.preferences")||"null");return i18nLocales().includes(saved?.values?.locale)?saved.values.locale:"ru";}catch{return "ru";}}
const i18nLocaleSelect=document.getElementById("locale");
if(i18nLocaleSelect){i18nLocaleSelect.addEventListener("change",event=>setLocale(event.target.value));setLocale(i18nSavedLocale(),{persist:false});}
