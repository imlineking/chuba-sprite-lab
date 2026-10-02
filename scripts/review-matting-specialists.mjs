// Local comparison: identical inputs, controlled reference alpha, real unlabelled assets.
// node scripts/review-matting-specialists.mjs <new-report-directory> setup|model-id|render [fast|balanced|max] [cutoff] [case-id,...]
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { segmentSubject } from "../src/ai-segmentation.mjs";
import { keyFrame } from "../src/processor.mjs";

const root = path.resolve(import.meta.dirname, ".."), output = path.resolve(process.argv[2]);
const action = process.argv[3], quality = process.argv[4] || "fast", cutoff = Number(process.argv[5] || 50);
const selected = process.argv[6] && process.argv[6] !== "*" ? process.argv[6].split(",") : null;
const resume = process.argv[7] === "resume";
const colorAction = action?.startsWith("color-");
const hash = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const read = file => sharp(file).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const escape = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const label = id => {
  if(id.startsWith("color-all-"))return "Наш скрипт · цвет во всём изображении";
  if(id.startsWith("color-key-"))return "Наш скрипт · связанный фон";
  if(id.startsWith("color-preserve-"))return "Наш скрипт · чёрный, контур 3";
  if(id.startsWith("color-outline"))return `Наш скрипт · чёрный, контур ${id.match(/outline(\d+)/)[1]}`;
  if(id.startsWith("checker-"))return "Наш локальный удалитель шахматки";
  const match=id.match(/^(.*)-(fast|balanced|max)-(\d+)$/);
  if(!match)return id;
  const model={toonout:"ToonOut","birefnet-tiny":"BiRefNet Tiny","isnet-general":"IS-Net General","isnet-anime":"IS-Net Anime","birefnet-general":"BiRefNet General",u2netp:"U²-Net small"}[match[1]]||match[1];
  return `${model} · ${{fast:"быстрый",balanced:"сбалансированный",max:"максимальный"}[match[2]]} · порог ${match[3]}`;
};
const controlled = path.resolve(root, "../background-removal-lab/evidence/run-01");
const game = "C:/Users/User/Pictures/Chuba/chuba the game";
if (action === "setup") {
  await fs.mkdir(output); await fs.mkdir(path.join(output, "inputs"));
  const cases = [], originals = {};
  async function add(id, source, reference = null, category = "unlabelled-real", color = null) {
    const input = path.join(output, "inputs", `${id}.png`);
    await sharp(source).png().toFile(input);
    originals[source] = await hash(source);
    if (reference) originals[reference] = await hash(reference);
    cases.push({ id, input, reference, category, color, inputHash: await hash(input) });
  }
  for (const id of ["hanging-branch-white-soft0", "hanging-branch-black-soft0", "hanging-branch-green-soft0", "hanging-branch-custom-soft0", "hanging-branch-checker-light-4", "hanging-branch-checker-dark-32", "white-flowers-white-soft0", "white-flowers-black-soft0", "white-flowers-green-soft0", "white-flowers-checker-light-4", "white-flowers-checker-dark-32", "black-contour-control"]) {
    const directory = path.join(controlled, id);
    const color = id.includes("-white-") ? [255,255,255] : id.includes("-black-") || id === "black-contour-control" ? [0,0,0] : id.includes("-green-") ? [0,255,0] : null;
    await add(id, path.join(directory, "input.png"), path.join(directory, "reference.png"), "controlled-alpha", color);
  }
  for (const [id, donor] of [["branch-magenta", "hanging-branch-white-soft0"], ["flowers-magenta", "white-flowers-white-soft0"]]) {
    const reference = path.join(controlled, donor, "reference.png"), source = path.join(output,"inputs",`${id}-composite.png`);
    await sharp(reference).flatten({background:"#ff00ff"}).png().toFile(source);
    await add(id,source,reference,"controlled-alpha-composite",[255,0,255]);
  }
  // Structured nonuniform backgrounds are reproducible composites, not natural photographs.
  for (const [id, donor, dark] of [["branch-textured", "hanging-branch-white-soft0", false], ["flowers-textured-dark", "white-flowers-white-soft0", true]]) {
    const reference = path.join(controlled, donor, "reference.png"), { data, info } = await read(reference);
    const background = Buffer.alloc(info.width * info.height * 3);
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const at = (y * info.width + x) * 3, stripe = Math.sin((x + y * .7) / 12) * 18;
      background[at] = Math.max(0, Math.min(255, (dark ? 40 : 140) + stripe + x / info.width * 50));
      background[at+1] = Math.max(0, Math.min(255, (dark ? 50 : 170) + stripe));
      background[at+2] = Math.max(0, Math.min(255, (dark ? 60 : 190) - stripe));
    }
    const composite = path.join(output, "inputs", `${id}-composite.png`);
    await sharp(background, { raw: { width: info.width, height: info.height, channels: 3 } }).composite([{ input: await sharp(data, { raw: info }).png().toBuffer() }]).png().toFile(composite);
    await add(id, composite, reference, "controlled-alpha-composite");
  }
  for (const name of ["gudkov-indoor-front.jpeg", "gudkov-field-front.jpg", "gudkov-camouflage-beret.jpg"]) await add(`photo-${path.parse(name).name}`, path.join(game, "public/images/NEW sprites/Varyag/references", name));
  for (const name of ["branch_leaves_hanging_01.png", "flowers_white_daisy_01.png", "mushroom_fly_agaric_01.png", "reeds_cattail_02.png"]) await add(`real-${path.parse(name).name}`, path.join(game, "new assets", name));
  await fs.writeFile(path.join(output, "corpus.json"), JSON.stringify({ cases, originals }, null, 2));
  console.log(`Prepared ${cases.length} cases; ${cases.filter(c => c.reference).length} with reference alpha.`);
  process.exit(0);
}
const corpus = JSON.parse(await fs.readFile(path.join(output, "corpus.json"), "utf8"));
if (action === "add-pure-colors") {
  for (const [name,color] of [["green",[0,255,0]],["black",[0,0,0]]]) for(const [subject,donor] of [["branch","hanging-branch-white-soft0"],["flowers","white-flowers-white-soft0"]]) {
    const id=`${subject}-pure-${name}`, reference=path.join(controlled,donor,"reference.png"), input=path.join(output,"inputs",`${id}.png`);
    assert.ok(!corpus.cases.some(item=>item.id===id),"Pure-colour cases already added");
    await sharp(reference).flatten({background:{r:color[0],g:color[1],b:color[2]}}).png().toFile(input);
    corpus.cases.push({id,input,reference,category:"controlled-alpha-composite",color,inputHash:await hash(input)});
  }
  // Existing 'green' controls use a different solid green, not #00ff00.
  for(const item of corpus.cases.filter(item=>item.color)) {
    const source=await read(item.input);item.color=[...source.data.subarray(0,3)];
  }
  await fs.writeFile(path.join(output,"corpus.json"),JSON.stringify(corpus,null,2));
  console.log(`Now ${corpus.cases.length} cases; colours matched to actual inputs.`); process.exit(0);
}
function metrics(prediction, reference) {
  const { width, height } = reference.info, count = width * height;
  const truth = new Uint8Array(count), predicted = new Uint8Array(count);
  let tp=0, fp=0, fn=0, tn=0, alphaError=0, white=0, whiteKept=0, dark=0, darkKept=0;
  for (let i=0;i<count;i++) {
    const at=i*4, t=reference.data[at+3]>127, p=prediction[at+3]>127;
    truth[i]=Number(t); predicted[i]=Number(p);
    if(t&&p)tp++; else if(t)fn++; else if(p)fp++; else tn++;
    alphaError+=Math.abs(reference.data[at+3]-prediction[at+3]);
    const rgb=[reference.data[at],reference.data[at+1],reference.data[at+2]];
    if(t&&Math.min(...rgb)>=170&&Math.max(...rgb)-Math.min(...rgb)<=55){white++;if(p)whiteKept++;}
    if(t&&Math.max(...rgb)<=45){dark++;if(p)darkKept++;}
  }
  function edge(mask) {
    const points=[];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x;if(mask[i]&&(x===0||y===0||x===width-1||y===height-1||!mask[i-1]||!mask[i+1]||!mask[i-width]||!mask[i+width]))points.push(i);}
    return points;
  }
  const tEdge=edge(truth), pEdge=edge(predicted);
  function matched(from,to){const set=new Set(to);return from.filter(i=>{const x=i%width,y=Math.floor(i/width);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&set.has((y+dy)*width+x+dx))return true;return false;}).length;}
  const precision=pEdge.length?matched(pEdge,tEdge)/pEdge.length:0, recall=tEdge.length?matched(tEdge,pEdge)/tEdge.length:0;
  return { iou:tp/(tp+fp+fn), foregroundRecall:tp/(tp+fn), backgroundRemoval:tn/(tn+fp), lostForeground:fn, leakedBackground:fp,
    boundaryF1:precision+recall?2*precision*recall/(precision+recall):0, whiteRecall:white?whiteKept/white:null, darkRecall:dark?darkKept/dark:null, alphaMAE:alphaError/count };
}
if (action !== "render") {
  const id=`${action}-${quality}-${cutoff}`, directory=path.join(output,id); await fs.mkdir(directory,{recursive:resume});
  const previous=resume?await fs.readFile(path.join(directory,"report.json"),"utf8").then(JSON.parse).catch(error=>{if(error.code!=="ENOENT")throw error;return {id,results:[]};}):{id,results:[]};
  assert.equal(previous.id,id); const results=previous.results;
  for (const item of corpus.cases.filter(c=>!selected||selected.includes(c.id))) {
    if(results.some(result=>result.case===item.id)){assert.equal(await hash(item.input),item.inputHash);continue;}
    if (colorAction && !item.color) continue;
    if (action === "checker" && !item.id.includes("checker")) continue;
    assert.equal(await hash(item.input), item.inputHash);
    const start=performance.now();
    let prediction, info, runtime;
    if (action === "checker") {
      const keyed=await keyFrame(item.input,"alpha",18,0,0,{frameIndex:0,aiEdits:[{type:"checker",frameIndex:0}]});
      ({data:prediction,info}=await read(keyed.buffer));runtime={model:"checker",provider:"cpu"};
    } else if (colorAction) {
      const outline=action==="color-preserve"?3:Number(action.match(/^color-outline(\d+)$/)?.[1]||0);
      const black=action!=="color-key"&&action!=="color-all"&&item.color.every(value=>value===0);
      const scope=action==="color-all"?"all":"exterior";
      const keyed=await keyFrame(item.input,black?"black":"custom",18,black?outline:0,0,{keyColor:item.color,keyScope:scope});
      ({data:prediction,info}=await read(keyed.buffer)); runtime={model:"color-key",provider:"cpu",blackOutline:black?outline:null,scope};
    } else {
      const segmented=await segmentSubject(item.input,{appRoot:root,model:action,provider:"dml",quality,cutoff,softness:0});
      assert.equal(segmented.model,action,"Fallback would invalidate comparison");
      prediction=segmented.data;info=segmented.info;
      runtime={model:segmented.model,provider:segmented.provider,quality:segmented.quality,tiles:segmented.tiles,tta:segmented.tta,threshold:segmented.threshold,coverage:segmented.coverage};
    }
    const ms=Math.round(performance.now()-start), file=path.join(directory,`${item.id}.png`);
    await sharp(prediction,{raw:info}).png().toFile(file);
    const score=item.reference?metrics(prediction,await read(item.reference)):null;
    const result={case:item.id,file,ms,runtime,metrics:score}; results.push(result);
    await fs.writeFile(path.join(directory,"report.json"),JSON.stringify({id,contractVersion:2,results},null,2));
    console.log(JSON.stringify({case:item.id,ms,runtime,metrics:score}));
  }
  for (const [file,fingerprint] of Object.entries(corpus.originals)) assert.equal(await hash(file),fingerprint,`Original modified: ${file}`);
  console.log("All originals unchanged."); process.exit(0);
}
const runs=[];
for (const entry of await fs.readdir(output,{withFileTypes:true})) if(entry.isDirectory()&&entry.name!=="inputs"&&entry.name!=="previews") {
  try {const run=JSON.parse(await fs.readFile(path.join(output,entry.name,"report.json"),"utf8"));if(!run.invalid)runs.push(run);} catch(error){if(error.code!=="ENOENT")throw error;}
}
await fs.mkdir(path.join(output,"previews"),{recursive:true});
const rel=file=>path.relative(output,file).replaceAll("\\","/").split("/").map(encodeURIComponent).join("/");
const mainIds=["toonout-fast-50","birefnet-tiny-fast-50","isnet-general-fast-50"];
const sheets=[];
let html=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Где полезен BiRefNet Tiny</title><style>body{font:15px system-ui;background:#eee;color:#181818;margin:24px}section{background:white;padding:18px;margin:24px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}figure{margin:0;min-width:0}img{width:100%;height:220px;object-fit:contain;image-rendering:pixelated}figcaption{min-height:40px;font-weight:600}small{display:block;line-height:1.5;margin:8px 0}p{line-height:1.5}details{margin:18px 0}table{border-collapse:collapse}th,td{text-align:left;padding:6px;border:1px solid #ccc}select{padding:10px}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style><h1>BiRefNet Tiny · поиск полезной специализации</h1><p>Контрольные композиты имеют известную альфу. У настоящих фото и повреждённых исходников эталона нет. IoU и точность контура считаются только на контролях; потеря белого считается по светлым пикселям эталона. Все модели явно запускаются, без восстановления и доработки края. Цветовая вырезка — отдельный лёгкий вариант для ровного фона. Размер и RGB исходника сохранены.</p><label>Подложка <select id="bg"><option value="black">Чёрная</option><option value="white">Белая</option><option value="magenta">Маджента</option></select></label>`;
for (const [index,item] of corpus.cases.entries()) {
  const all=runs.flatMap(run=>run.results.filter(r=>r.case===item.id).map(result=>({...result,id:run.id})));
  const black=item.color?.every(value=>value===0);
  const neutralWhite=item.color?.every(value=>value===255);
  const local=all.find(r=>r.id===(item.color?black?"color-preserve-fast-50":neutralWhite?"color-key-fast-50":"color-all-fast-50":"checker-fast-50"))
    || all.find(r=>r.id==="color-key-fast-50")
    || all.find(r=>r.id===(black?"color-preserve-fast-51":"color-key-fast-51"));
  const primary=[...mainIds.slice(0,2).map(id=>all.find(r=>r.id===id)).filter(Boolean),local||all.find(r=>r.id===mainIds[2])].filter(Boolean);
  const panels=[{id:"Вход",file:item.input},...(item.reference?[{id:"Эталон альфы",file:item.reference}]:[]),...primary];
  html+=`<section><h2>${escape(item.id)}</h2><p>${item.reference?"Контроль с известной альфой":"Реальный вход · только визуальная оценка"}</p><div class="grid">`;
  for (const [column,panel] of panels.entries()) {
    const urls={};
    for(const [bg,color] of [["black","#101010"],["white","#ffffff"],["magenta","#ed00a9"]]) {
      const preview=path.join(output,"previews",`${item.id}-${panel.id}-${bg}.png`);
      await sharp(panel.file).flatten({background:color}).resize(440,280,{fit:"contain",background:color}).png().toFile(preview);urls[bg]=rel(preview);
    }
    const score=panel.metrics;
    html+=`<figure><figcaption>${escape(label(panel.id))}</figcaption><img src="${urls.black}" data-black="${urls.black}" data-white="${urls.white}" data-magenta="${urls.magenta}" alt="${escape(label(panel.id))}"><small>${panel.ms?`${panel.ms} мс · ${escape(JSON.stringify(panel.runtime))}`:""}${score?`<br>IoU ${(score.iou*100).toFixed(2)}% · контур ${(score.boundaryF1*100).toFixed(2)}%<br>Потеря ${score.lostForeground} px · остаток ${score.leakedBackground} px<br>Белое ${score.whiteRecall===null?"—":(score.whiteRecall*100).toFixed(2)+"%"}`:""}</small><a href="${rel(panel.file)}">PNG</a></figure>`;
    if(column<5){const label=Buffer.from(`<svg width="300" height="44"><rect width="300" height="44" fill="white"/><text x="6" y="16" font-size="10">${escape(item.id)}</text><text x="6" y="34" font-size="11">${escape(panel.id)}</text></svg>`);sheets.push({input:label,left:column*300,top:index*244},{input:await sharp(panel.file).flatten({background:"#101010"}).resize(300,200,{fit:"contain",background:"#101010"}).png().toBuffer(),left:column*300,top:index*244+44});}
  }
  html+=`</div><details><summary>Все модели, режимы качества и пороги</summary><table><tr><th>Вариант</th><th>Время</th><th>IoU</th><th>Контур</th><th>Потеря объекта</th><th>Остаток фона</th><th>PNG</th></tr>${all.map(r=>`<tr><td>${escape(r.id)}</td><td>${r.ms} мс</td><td>${r.metrics?(r.metrics.iou*100).toFixed(2)+"%":"—"}</td><td>${r.metrics?(r.metrics.boundaryF1*100).toFixed(2)+"%":"—"}</td><td>${r.metrics?.lostForeground??"—"}</td><td>${r.metrics?.leakedBackground??"—"}</td><td><a href="${rel(r.file)}">PNG</a></td></tr>`).join("")}</table></details></section>`;
}
html+=`<script>document.querySelector('#bg').onchange=event=>document.querySelectorAll('img').forEach(img=>img.src=img.dataset[event.target.value]);</script></html>`;
await fs.writeFile(path.join(output,"review.html"),html);
await fs.writeFile(path.join(output,"comparison.json"),JSON.stringify({cases:corpus.cases,runs},null,2));
await sharp({create:{width:1500,height:corpus.cases.length*244,channels:3,background:"#ddd"}}).composite(sheets).png().toFile(path.join(output,"comparison.png"));
console.log(`Rendered ${runs.length} runs, ${corpus.cases.length} cases.`);
