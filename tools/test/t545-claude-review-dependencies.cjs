'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), Module=require('node:module');
const output=process.env.T545_CLAUDE_MANIFEST;
if(!output) throw Error('T545_CLAUDE_MANIFEST is required');
const roots=[process.env.T545_APP_ROOT,process.env.T545_ENGINE_ROOT].map(x=>fs.realpathSync(x));
const inside=p=>roots.some(r=>{const rel=path.relative(r,p);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel))});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rows=new Map(), original=Module._load;
function observe(p){
 if(typeof p!=='string'||!path.isAbsolute(p))return;
 if(!inside(p))throw Error('Review dependency outside explicit checkouts: '+p);
 const real=fs.realpathSync(p);if(!inside(real))throw Error('Review dependency resolves outside checkouts');
 if(!rows.has(real))rows.set(real,{path:real,before:hash(real)});
}
for(const file of JSON.parse(process.env.T545_CLAUDE_EXTRA_FILES||'[]'))observe(file);
Module._load=function(request,parent,...args){
 const resolved=Module._resolveFilename(request,parent);
 observe(resolved);
 return original.call(this,request,parent,...args);
};
process.on('exit',()=>{
 Module._load=original;
 for(const row of rows.values()){row.after=hash(row.path);row.stable=row.before===row.after;}
 const manifest={runtime:{execPath:process.execPath,node:process.version,platform:process.platform,arch:process.arch,sha256:hash(process.execPath)},dependencies:[...rows.values()]};
 if(!inside(output))throw Error('Manifest destination outside checkouts');
 fs.writeFileSync(output,JSON.stringify(manifest,null,2)+'\n');
});
