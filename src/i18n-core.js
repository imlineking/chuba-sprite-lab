// Pure translator shared by renderer, companion and native dialogs. Template slots keep values intact.
(() => {
  const dictionary = globalThis.SpriteLabI18nCatalog.en;
  const cache = new Map();
  const reversed=Object.fromEntries(Object.entries(dictionary).map(([ru,en])=>[en,ru]));
  // These slots contain interface descriptions, not names or paths. Other slots are opaque data.
  const uiSlots={
    'Будет создано: {0}.':['0'],
    'Подложка: {0} · только для просмотра':['0'],
    '{0} шрифтов · {1}':['1'],
    'Имя учётной записи: {0}. {1}':['1'],
    '{0} · idle/run/jump — в один атлас':['0'],
    'Фон: {0} · {1} FPS · {2} · {3}{4}{5}{6}':['0','2','3','4','5','6'],
    'Фон будет удалён · режим: {0}':['0'],
    'Удалить {0} фон':['0'],
    'Чёрный фон · {0}':['0'],
    '{0} · Для Qwen/Gemma нужен запущенный Ollama и установленная модель; интернет не требуется.':['0']
  };
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function patterns(reverse) {
    if (cache.has(reverse)) return cache.get(reverse);
    const result=[];
    for(const [ru,en] of Object.entries(dictionary)) {
      const source=reverse?en:ru, target=reverse?ru:en;
      if(!/\{[\w]+\}/.test(source))continue;
      const slots=[]; let cursor=0, pattern='^';
      for(const match of source.matchAll(/\{([\w]+)\}/g)) {
        pattern+=escape(source.slice(cursor,match.index))+'([\\s\\S]*?)';slots.push(match[1]);cursor=match.index+match[0].length;
      }
      pattern+=escape(source.slice(cursor))+'$';result.push({regex:new RegExp(pattern),target,slots,source});
    }
    // More specific sentences take precedence over short fragments with unrestricted slots.
    result.sort((a,b)=>b.source.replace(/\{\w+\}/g,'').length-a.source.replace(/\{\w+\}/g,'').length);
    cache.set(reverse,result);return result;
  }
  function translate(text,locale='en',{reverse=false}={}) {
    if(typeof text!=='string'||(!reverse&&locale!=='en'))return text;
    const trimmed=text.trim();if(!trimmed||(!reverse&&!/[А-Яа-яЁё]/.test(trimmed)))return text;
    let translated=reverse?reversed[trimmed]:dictionary[trimmed];
    if(translated===undefined)for(const item of patterns(reverse)) {
      const match=item.regex.exec(trimmed);if(!match)continue;
      const values=Object.fromEntries(item.slots.map((slot,i)=>[slot,match[i+1]]));
      if(!reverse)for(const slot of uiSlots[item.source]||[])values[slot]=translate(values[slot],locale);
      translated=item.target.replace(/\{(\w+)\}/g,(all,key)=>values[key]??all);break;
    }
    if(translated!==undefined)return text.replace(trimmed,translated);
    // IPC errors have an Electron prefix; multiline reports have independently translated lines.
    const ipc=/^(Error invoking remote method '[^']+': (?:Error: )?)([\s\S]+)$/.exec(text);
    if(ipc)return ipc[1]+translate(ipc[2],locale,{reverse});
    const colon=/^([^:]+:)([\s\S]+)$/.exec(text);
    if(colon){const label=reverse?reversed[colon[1].trim()]:dictionary[colon[1].trim()];if(label)return label+colon[2];}
    if(text.includes('\n'))return text.split('\n').map(line=>translate(line,locale,{reverse})).join('\n');
    // Model cards and report summaries join independently authored labels.
    const parts=text.split(/( · |, )/);
    if(parts.length>1)return parts.map((part,i)=>i%2?part:translate(part,locale,{reverse})).join('');
    return text;
  }
  function dialogOptions(options,locale) {
    const result={...options};
    for(const key of ['title','message','detail','buttonLabel'])if(typeof result[key]==='string')result[key]=translate(result[key],locale);
    if(result.buttons)result.buttons=result.buttons.map(text=>translate(text,locale));
    if(result.filters)result.filters=result.filters.map(filter=>({...filter,name:translate(filter.name,locale)}));
    return result;
  }
  globalThis.SpriteLabI18n={translate,dictionary,dialogOptions};
})();
