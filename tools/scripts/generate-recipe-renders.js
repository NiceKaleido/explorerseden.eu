const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PNG } = require('pngjs');
const zlib = require('zlib');
const DS = require('deepslate');
const { Identifier, ItemStack, ItemModel, BlockModel, NbtString, NbtCompound, NbtInt } = DS;

const repoRoot = process.env.SOURCE_REPO_ROOT || process.cwd();
const workflowRoot = process.env.WORKFLOW_ROOT || path.resolve(__dirname, '..', '..');
const outRoot = process.env.RECIPE_RENDER_OUTPUT_ROOT || path.join(repoRoot, 'wiki', 'images', 'recipe');
const vanillaRoot = process.env.VANILLA_ASSET_ROOT || path.join(workflowRoot, '.cache', 'vanilla-assets', 'active');
const bgPath = path.join(workflowRoot, 'tools', 'gui_backgrounds', 'crafting_grid.png');
const OUTPUT_SCALE = Number(process.env.RECIPE_OUTPUT_SCALE || 2);
const ICON_SIZE = Number(process.env.RECIPE_ICON_SIZE || 16);
const SLOT_OFFSET_X = Number(process.env.RECIPE_SLOT_ICON_OFFSET_X || 0);
const SLOT_OFFSET_Y = Number(process.env.RECIPE_SLOT_ICON_OFFSET_Y || 0);
const CELL = 32;

function exists(p){ try{return fs.existsSync(p)}catch{return false} }
function stat(p){ try{return fs.statSync(p)}catch{return null} }
function readJson(p){ try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null} }
function s(v, fb=''){ if(v==null)return fb; if(typeof v==='string')return v; if(typeof v==='number'||typeof v==='boolean')return String(v); if(typeof v==='object')return s(v.id??v.value??v.item??v.tag??v.model??v.name,fb); return fb; }
function idParts(id, def='minecraft'){ const raw=s(id).replace(/^#/,''); const i=raw.indexOf(':'); return i>=0?[raw.slice(0,i),raw.slice(i+1)]:[def,raw]; }
function clean(name, ext){ return s(name).replace(/\\/g,'/').replace(new RegExp(`${ext.replace('.','\\.')}$`),''); }
function findAsset(ns, kind, name, ext='.json'){ const c=clean(name,ext); const p1=path.join(repoRoot,'assets',ns,kind,`${c}${ext}`); if(exists(p1))return p1; const p2=path.join(vanillaRoot,'assets',ns,kind,`${c}${ext}`); return exists(p2)?p2:null; }
function findData(ns, kind, name, ext='.json'){ const c=clean(name,ext); const p1=path.join(repoRoot,'data',ns,kind,`${c}${ext}`); if(exists(p1))return p1; const p2=path.join(vanillaRoot,'data',ns,kind,`${c}${ext}`); return exists(p2)?p2:null; }
function textureFile(id){ let [ns,name]=idParts(id); name=name.replace(/^textures\//,'').replace(/\.png$/,''); return findAsset(ns,'textures',name,'.png'); }
function normalizeTagPath(name){ return s(name).replace(/^#/,'').replace(/^tags\/items?\//,'').replace(/^items?\//,''); }
function normalizeBlockModelJson(obj){ if(!obj||typeof obj!=='object')return obj; const m=Object.assign({},obj); delete m.format_version; delete m.credit; if(Array.isArray(m.elements))m.elements=m.elements.map(el=>{const e=Object.assign({},el);const r=e.rotation;if(r&&typeof r==='object'&&('x'in r||'y'in r||'z'in r)&&!('axis'in r)){let axis='y',angle=0;for(const a of['x','y','z']){if(r[a]!=null&&Math.abs(r[a])>Math.abs(angle)){axis=a;angle=r[a];}}e.rotation={angle,axis,origin:r.origin||[8,8,8]};}return e;}); return m; }
function resolveItemTag(tagId, seen=new Set()){ const [ns,raw]=idParts(tagId,'minecraft'); const name=normalizeTagPath(raw); const key=`${ns}:${name}`; if(seen.has(key))return []; seen.add(key); const file=findData(ns,'tags/item',name,'.json')||findData(ns,'tags/items',name,'.json'); const json=file?readJson(file):null; const vals=Array.isArray(json?.values)?json.values:[]; const out=[]; for(const e of vals){ let v=e; if(e&&typeof e==='object')v=e.id??e.value??e.item??e.tag; v=s(v); if(!v)continue; if(v.startsWith('#'))out.push(...resolveItemTag(v.slice(1),seen)); else out.push({item:v}); } return [...new Map(out.map(v=>[v.item,v])).values()]; }

class Resources{
  constructor(){ this.blockModels=new Map(); this.itemModels=new Map(); this.texMap=new Map(); this.texList=[]; this.atlasPng=null; }
  getItemComponents(id){ return new Map([['minecraft:item_model', new NbtString(id.toString())]]); }
  getItemModel(id){ const key=id.toString(); if(this.itemModels.has(key))return this.itemModels.get(key); const [ns,name]=idParts(key); const file=findAsset(ns,'items',name,'.json'); let obj=file?readJson(file):null; let model; try { model = ItemModel.fromJson(obj?.model ?? {type:'minecraft:model', model:`${ns}:item/${name}`}); } catch(e){ let bref=null; const mn=obj?.model; if(mn){const mt=s(mn.type).replace(/^minecraft:/,''); if(mt==='model')bref=s(mn.model)||null; else{const fb=mn.fallback??(mn.on_false??mn.on_true)??(mn.cases||[])[0]?.model??(mn.entries||[])[0]?.model; if(fb&&typeof fb==='object')bref=s(fb.model)||null;}} try{ model=ItemModel.fromJson(bref?{type:'minecraft:model',model:bref}:{type:'minecraft:model',model:`${ns}:item/${name}`}); }catch{ model=ItemModel.fromJson({type:'minecraft:model',model:`${ns}:item/${name}`}); } } this.itemModels.set(key,model); return model; }
  getBlockModel(id){ const key=id.toString(); if(this.blockModels.has(key))return this.blockModels.get(key); const [ns,name]=idParts(key); let obj=null; if(key==='minecraft:item/generated') obj={parent:'builtin/generated'}; else if(key==='minecraft:item/handheld') obj={parent:'minecraft:item/generated'}; else obj=normalizeBlockModelJson(readJson(findAsset(ns,'models',name,'.json')));
    if(!obj){ this.blockModels.set(key,null); return null; }
    let m; try{ m=BlockModel.fromJson(obj); }catch(e){ this.blockModels.set(key,null); return null; } this.blockModels.set(key,m); try{ m.flatten(this); }catch(e){} return m; }
  getTextureUV(id){ const key=id.toString(); if(!this.texMap.has(key)){ const file=textureFile(key); const idx=this.texList.length; this.texMap.set(key,{idx,file,key}); this.texList.push({idx,file,key}); }
    const rec=this.texMap.get(key); const cols=Math.max(1,Math.ceil(Math.sqrt(Math.max(1,this.texList.length)))); const x=rec.idx%cols, y=Math.floor(rec.idx/cols); return [x/cols,y/cols,(x+1)/cols,(y+1)/cols]; }
  getPixelSize(){ return 1/CELL; }
  async buildAtlas(){ const count=Math.max(1,this.texList.length); const cols=Math.ceil(Math.sqrt(count)), rows=Math.ceil(count/cols); const base=sharp({create:{width:cols*CELL,height:rows*CELL,channels:4,background:{r:0,g:0,b:0,alpha:0}}}); const comps=[]; for(const t of this.texList){ let input; if(t.file&&exists(t.file)) input=await sharp(t.file).ensureAlpha().resize(CELL,CELL,{fit:'fill',kernel:'nearest'}).png().toBuffer(); else input=await missingTexture(); comps.push({input,left:(t.idx%cols)*CELL,top:Math.floor(t.idx/cols)*CELL}); } this.atlasPng=PNG.sync.read(await base.composite(comps).png().toBuffer()); return this.atlasPng; }
  getTextureAtlas(){ return null; }
}
async function missingTexture(){ return sharp({create:{width:CELL,height:CELL,channels:4,background:{r:255,g:0,b:255,alpha:1}}}).png().toBuffer(); }
function componentsToNbtMap(components){ const map=new Map(); if(!components)return map; for(const [k,v] of Object.entries(components)){ if(k==='minecraft:item_model'||k==='item_model'||k==='itemModel') map.set('minecraft:item_model', new NbtString(s(v))); else if(k==='minecraft:potion_contents'||k==='potion_contents'){ const c=new NbtCompound(); if(v&&typeof v==='object'&&v.custom_color!=null)c.set('custom_color',new NbtInt(Number(v.custom_color))); map.set('minecraft:potion_contents', c); } } return map; }
function itemStack(obj){ const id=Identifier.parse(s(obj?.item??obj?.id??obj)); return new ItemStack(id,1,componentsToNbtMap(obj?.components)); }
function sample(tex,u,v){ const x=Math.max(0,Math.min(tex.width-1,Math.floor(u*(tex.width-1)))); const y=Math.max(0,Math.min(tex.height-1,Math.floor(v*(tex.height-1)))); const i=(y*tex.width+x)*4; return [tex.data[i],tex.data[i+1],tex.data[i+2],tex.data[i+3]]; }
function blend(dst,zbuf,x,y,z,c){ x=Math.floor(x); y=Math.floor(y); if(x<0||y<0||x>=dst.width||y>=dst.height||c[3]<=0)return; const zi=y*dst.width+x; if(z<zbuf[zi])return; zbuf[zi]=z; const i=zi*4, sa=c[3]/255, da=dst.data[i+3]/255, oa=sa+da*(1-sa); if(oa<=0)return; dst.data[i]=Math.round((c[0]*sa+dst.data[i]*da*(1-sa))/oa); dst.data[i+1]=Math.round((c[1]*sa+dst.data[i+1]*da*(1-sa))/oa); dst.data[i+2]=Math.round((c[2]*sa+dst.data[i+2]*da*(1-sa))/oa); dst.data[i+3]=Math.round(oa*255); }
function tri(dst,zbuf,atlas,a,b,c,ta,tb,tc,ca,cb,cc){ const minX=Math.floor(Math.min(a[0],b[0],c[0])), maxX=Math.ceil(Math.max(a[0],b[0],c[0])), minY=Math.floor(Math.min(a[1],b[1],c[1])), maxY=Math.ceil(Math.max(a[1],b[1],c[1])); const den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]); if(Math.abs(den)<1e-6)return; for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){ const w1=((b[1]-c[1])*(x+.5-c[0])+(c[0]-b[0])*(y+.5-c[1]))/den; const w2=((c[1]-a[1])*(x+.5-c[0])+(a[0]-c[0])*(y+.5-c[1]))/den; const w3=1-w1-w2; if(w1>=-0.001&&w2>=-0.001&&w3>=-0.001){ const u=w1*ta[0]+w2*tb[0]+w3*tc[0], v=w1*ta[1]+w2*tb[1]+w3*tc[1], z=w1*a[2]+w2*b[2]+w3*c[2]; const px=sample(atlas,u,v); const cr=w1*ca[0]+w2*cb[0]+w3*cc[0], cg=w1*ca[1]+w2*cb[1]+w3*cc[1], cbv=w1*ca[2]+w2*cb[2]+w3*cc[2]; blend(dst,zbuf,x,y,z,[Math.round(px[0]*cr),Math.round(px[1]*cg),Math.round(px[2]*cbv),px[3]]); } } }
function rasterMesh(mesh, atlas, size=ICON_SIZE){ const dst=new PNG({width:size,height:size}); const zbuf=new Float32Array(size*size).fill(-1e9); for(const q of mesh.quads){ const vs=q.vertices(); const pts=vs.map(v=>[v.pos.x*size/16, (16-v.pos.y)*size/16, v.pos.z]); const tex=vs.map(v=>v.texture||[0,0]); const col=vs.map(v=>v.color||[1,1,1]); // backface in screen space: skip only clearly clockwise? zbuffer handles most; do not cull generated planes
    tri(dst,zbuf,atlas,pts[0],pts[1],pts[2],tex[0],tex[1],tex[2],col[0],col[1],col[2]); tri(dst,zbuf,atlas,pts[0],pts[2],pts[3],tex[0],tex[2],tex[3],col[0],col[2],col[3]); }
  return PNG.sync.write(dst); }
async function normalize(buf,size=ICON_SIZE){ let trimmed=buf; try{trimmed=await sharp(buf).ensureAlpha().trim({background:{r:0,g:0,b:0,alpha:0},threshold:1}).png().toBuffer();}catch{} const resized=await sharp(trimmed).resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(); return sharp({create:{width:size,height:size,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:resized,gravity:'center'}]).png().toBuffer(); }

function simpleItemModelId(item){
  const comps=item?.components||{};
  const cm=s(comps['minecraft:item_model']??comps.item_model??comps.itemModel,'');
  if(cm) return cm;
  const [ns,name]=idParts(item?.item||item?.id||item);
  const defFile=findAsset(ns,'items',name,'.json');
  const def=defFile?readJson(defFile):null;
  const node=def?.model;
  if(typeof node==='string') return node;
  if(node&&typeof node==='object'){
    if((s(node.type).endsWith(':model')||s(node.type)==='model')&&node.model) return s(node.model);
    if(node.fallback) { const f=node.fallback; if(typeof f==='object'&&f.model)return s(f.model); }
  }
  return `${ns}:item/${name}`;
}
function simpleResolveModel(modelId, defaultNs='minecraft', seen=new Set()){
  let [ns,name]=idParts(modelId,defaultNs);
  if(!name.startsWith('item/')&&!name.startsWith('block/')) name=`item/${name}`;
  const key=`${ns}:${name}`;
  if(seen.has(key)) return null;
  seen.add(key);
  const file=findAsset(ns,'models',name,'.json');
  let m=file?readJson(file):null;
  if(!m){ if(key==='minecraft:item/generated') return {__generated:true,textures:{},__ns:ns,__id:key}; if(key==='minecraft:item/handheld') return simpleResolveModel('minecraft:item/generated','minecraft',seen); return null; }
  m=JSON.parse(JSON.stringify(m));
  if(m.parent){ const parent=s(m.parent); const pid=parent.includes(':')?parent:`${ns}:${parent}`; const pm=simpleResolveModel(pid,ns,seen); if(pm){ m={...pm,...m,textures:{...(pm.textures||{}),...(m.textures||{})}}; if(pm.__generated)m.__generated=true; } }
  m.__ns=ns; m.__id=key; return m;
}
async function renderSimpleGenerated(item,size=ICON_SIZE){
  const model=simpleResolveModel(simpleItemModelId(item));
  const textures=model?.textures||{};
  const keys=Object.keys(textures).filter(k=>/^layer\d+$/.test(k)).sort((a,b)=>Number(a.slice(5))-Number(b.slice(5)));
  const [ins,iname]=idParts(item?.item||item?.id||item);
  const direct=findAsset(ins,'textures',`item/${iname}`,'.png');
  if(!keys.length && direct) return normalize(await sharp(direct).ensureAlpha().resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(),size);
  if(!keys.length) return null;
  const comps=[];
  const potion=s(item?.item||item?.id||item).includes('potion');
  const tint=potion?[56,97,255]:null;
  for(const key of keys){
    const tex=resolveTextureFromSimple(`#${key}`,textures,model.__ns||'minecraft');
    if(!tex) continue;
    let buf=await sharp(tex).ensureAlpha().resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    if(tint && key==='layer0') buf=await sharp(buf).ensureAlpha().tint({r:tint[0],g:tint[1],b:tint[2]}).png().toBuffer();
    comps.push({input:buf,left:0,top:0});
  }
  if(!comps.length) return null;
  return normalize(await sharp({create:{width:size,height:size,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(comps).png().toBuffer(),size);
}
function resolveTextureFromSimple(ref,textures,ns){ let v=s(ref); let guard=0; while(v.startsWith('#')&&guard++<32)v=s(textures[v.slice(1)]); return v?textureFile(v,ns):null; }

async function renderItemIcon(item,size=ICON_SIZE){ if(!item)return null; if(item.tag)return sharp({create:{width:size,height:size,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer(); const simple=await renderSimpleGenerated(item,size); if(simple)return simple; const res=new Resources(); let mesh; try{ mesh=DS.ItemRenderer.getItemMesh(itemStack(item),res,{display_context:'gui'}); }catch(e){ mesh=null; } if(mesh && !mesh.isEmpty()){ const atlas=await res.buildAtlas(); return normalize(rasterMesh(mesh,atlas,size),size); }
  // fallback direct texture
  const [ns,name]=idParts(item.item||item.id||item); const tex=findAsset(ns,'textures',`item/${name}`,'.png')||findAsset(ns,'textures',`block/${name}`,'.png'); if(tex)return normalize(await sharp(tex).ensureAlpha().resize(size,size,{fit:'inside',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(),size); return sharp({create:{width:size,height:size,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer(); }
async function bg(){return exists(bgPath)?sharp(bgPath).ensureAlpha().png().toBuffer():sharp({create:{width:176,height:81,channels:4,background:{r:198,g:198,b:198,alpha:1}}}).png().toBuffer();}
function layout(bg){const p=PNG.sync.read(bg),sx=p.width/176,sy=p.height/81;const centers=[];for(let y=0;y<3;y++)for(let x=0;x<3;x++)centers.push([Math.round((38+x*18)*sx),Math.round((25+y*18)*sy)]);return{inputCenters:centers,outputCenter:[Math.round(132*sx),Math.round(42*sy)],iconSize:Math.max(10,Math.min(16,Math.round(16*Math.min(sx,sy))))};}
function ingredientOptions(ing){ if(!ing)return[null]; if(Array.isArray(ing))return ing.flatMap(ingredientOptions).filter(Boolean); if(typeof ing==='string'){ if(String(ing).startsWith('#')){const r=resolveItemTag(String(ing).slice(1));return r.length?r:[{tag:String(ing).slice(1)}];} return[{item:String(ing)}]; } if(typeof ing==='object'){let item=ing.item??ing.id,tag=ing.tag;if(item&&typeof item==='object')item=item.id??item.value??item.item;if(tag&&typeof tag==='object')tag=tag.id??tag.value??tag.tag;if(item)return[{item:String(item),components:ing.components||ing.components_patch||ing.componentsPatch}];if(tag){const r=resolveItemTag(String(tag));return r.length?r:[{tag:String(tag)}];}} return[null];}
function outputOptions(r){ if(!r)return[]; if(typeof r==='string')return[{item:r}]; if(Array.isArray(r))return r.flatMap(outputOptions); if(typeof r==='object'){let item=r.item??r.id;if(item&&typeof item==='object')item=item.id??item.value??item.item;if(item)return[{item:String(item),components:r.components||r.components_patch||r.componentsPatch}];} return[];}
function recipeSlots(r){ const slots=Array(9).fill(null), type=s(r.type).replace(/^minecraft:/,''); if(type==='crafting_shaped'){const pat=r.pattern||[],key=r.key||{};for(let y=0;y<Math.min(3,pat.length);y++)for(let x=0;x<Math.min(3,String(pat[y]).length);x++){const ch=String(pat[y])[x];if(ch&&ch!==' ')slots[y*3+x]=ingredientOptions(key[ch]);}} else {const arr=r.ingredients||[];for(let i=0;i<Math.min(9,arr.length);i++)slots[i]=ingredientOptions(arr[i]);} return slots.map(v=>v&&v.length?v:[null]);}
function collectRecipes(){const out=[],data=path.join(repoRoot,'data');if(!exists(data))return out;for(const ns of fs.readdirSync(data)){const nsDir=path.join(data,ns);if(!stat(nsDir)?.isDirectory())continue;for(const folder of ['recipe','recipes']){const root=path.join(nsDir,folder);if(!exists(root))continue;const stack=[root];while(stack.length){const dir=stack.pop();for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())stack.push(p);else if(e.isFile()&&e.name.endsWith('.json')){const j=readJson(p),t=s(j?.type).replace(/^minecraft:/,'');if(t==='crafting_shaped'||t==='crafting_shapeless')out.push({namespace:ns,file:p,json:j,rel:path.relative(root,p)});}}}}}return out;}
function crc32(buf){let table=crc32.table;if(!table){table=crc32.table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);table[n]=c>>>0;}}let c=0xffffffff;for(let i=0;i<buf.length;i++)c=table[(c^buf[i])&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function chunk(type,data=Buffer.alloc(0)){const t=Buffer.from(type,'ascii'),o=Buffer.alloc(12+data.length);o.writeUInt32BE(data.length,0);t.copy(o,4);data.copy(o,8);o.writeUInt32BE(crc32(Buffer.concat([t,data])),8+data.length);return o;}
function rawIdat(rgba,w,h){const stride=w*4,raw=Buffer.alloc((stride+1)*h);for(let y=0;y<h;y++){raw[y*(stride+1)]=0;rgba.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);}return zlib.deflateSync(raw,{level:9});}
function encodeApng(frameBuffers,delayMs=700){const frames=frameBuffers.map(b=>PNG.sync.read(b)),width=frames[0].width,height=frames[0].height;const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;const chunks=[sig,chunk('IHDR',ihdr)];const actl=Buffer.alloc(8);actl.writeUInt32BE(frames.length,0);actl.writeUInt32BE(0,4);chunks.push(chunk('acTL',actl));let seq=0;for(let i=0;i<frames.length;i++){const f=frames[i],fc=Buffer.alloc(26);fc.writeUInt32BE(seq++,0);fc.writeUInt32BE(width,4);fc.writeUInt32BE(height,8);fc.writeUInt32BE(0,12);fc.writeUInt32BE(0,16);fc.writeUInt16BE(delayMs,20);fc.writeUInt16BE(1000,22);fc[24]=0;fc[25]=0;chunks.push(chunk('fcTL',fc));const comp=rawIdat(f.data,width,height);if(i===0)chunks.push(chunk('IDAT',comp));else{const fd=Buffer.alloc(4+comp.length);fd.writeUInt32BE(seq++,0);comp.copy(fd,4);chunks.push(chunk('fdAT',fd));}}chunks.push(chunk('IEND'));return Buffer.concat(chunks);}
async function scale(buf){if(OUTPUT_SCALE<=1)return buf;const m=await sharp(buf).metadata();return sharp(buf).resize({width:m.width*OUTPUT_SCALE,height:m.height*OUTPUT_SCALE,kernel:'nearest'}).png().toBuffer();}
async function renderFrame(rec,idx,bgBuffer,lay){const slots=recipeSlots(rec.json),outs=outputOptions(rec.json.result||rec.json.output||rec.json.results),comps=[];for(let i=0;i<9;i++){const opts=slots[i].filter(Boolean);if(!opts.length)continue;const icon=await renderItemIcon(opts[idx%opts.length],lay.iconSize);const half=Math.floor(lay.iconSize/2);if(icon)comps.push({input:icon,left:lay.inputCenters[i][0]-half+SLOT_OFFSET_X,top:lay.inputCenters[i][1]-half+SLOT_OFFSET_Y});}if(outs.length){const icon=await renderItemIcon(outs[idx%outs.length],lay.iconSize);const half=Math.floor(lay.iconSize/2);if(icon)comps.push({input:icon,left:lay.outputCenter[0]-half+SLOT_OFFSET_X,top:lay.outputCenter[1]-half+SLOT_OFFSET_Y});}return sharp(bgBuffer).composite(comps).png().toBuffer();}
async function renderRecipe(rec){const bgBuffer=await bg(),lay=layout(bgBuffer),slots=recipeSlots(rec.json),outs=outputOptions(rec.json.result||rec.json.output||rec.json.results);const frameCount=Math.max(1,...slots.map(s=>Math.max(1,s.filter(Boolean).length)),Math.max(1,outs.length));const outDir=path.join(outRoot,rec.namespace,path.dirname(rec.rel));fs.mkdirSync(outDir,{recursive:true});const outFile=path.join(outDir,path.basename(rec.rel,'.json')+'.png');if(frameCount<=1)fs.writeFileSync(outFile,await scale(await renderFrame(rec,0,bgBuffer,lay)));else{const frames=[];for(let i=0;i<frameCount;i++)frames.push(await scale(await renderFrame(rec,i,bgBuffer,lay)));fs.writeFileSync(outFile,encodeApng(frames,700));}return outFile;}
async function main(){const recipes=collectRecipes();let c=0;for(const r of recipes){try{await renderRecipe(r);c++;}catch(e){console.warn(`Recipe render failed for ${path.relative(repoRoot,r.file)}: ${e.message}`);}}if(c)console.log(`Rendered ${c} recipe PNG/APNG preview(s).`);}
main().catch(e=>{console.error(e);process.exit(1);});
