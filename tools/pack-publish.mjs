                                                            
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {verifyPublish} from '../dist/install/runtime-install.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=path.join(root,'publish');
const manifest=verifyPublish(source),top='nxbridge-'+manifest.version;
                                                
const releases=path.join(root,'artifacts','releases'),archive=path.join(releases,'nxbridge-'+manifest.buildId+'.zip');
const expected=[...Object.keys(manifest.files),'publish.json'].sort();
const sevenZip=process.platform==='win32'?'C:/Program Files/7-Zip/7z.exe':'7z';
                                                   
const tar=process.platform==='win32'?path.join(process.env.SystemRoot??'C:/Windows','System32','tar.exe'):process.platform==='linux'?'bsdtar':'tar';
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',windowsHide:true,...options});
let hasSevenZip=false;try{run(sevenZip,['i'],{stdio:'ignore'});hasSevenZip=true;}catch{}

function check(file){
  const entries=run(tar,['-tf',file]).split(/\r?\n/).filter(Boolean);
  if(entries.some(name=>!name.startsWith(top+'/')||name.split('/').some(part=>part==='.'||part==='..')||name.includes('\\')))
    throw Error('ZIP 条目必须位于 '+top+'/，且不能包含 ./ 或反斜杠');
  const files=entries.filter(name=>!name.endsWith('/')).map(name=>name.slice(top.length+1)).sort();
  if(JSON.stringify(files)!==JSON.stringify(expected))throw Error('ZIP 文件清单与发布清单不一致');
  const directories=new Set([top+'/']);
                                         
  const addDirectories=(directory,prefix)=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory()){const relative=prefix+entry.name+'/';directories.add(relative);addDirectories(path.join(directory,entry.name),relative);}};
  addDirectories(source,top+'/');
  const details=run(tar,['-tvf',file]).split(/\r?\n/).filter(Boolean);
  if(details.length!==entries.length)throw Error('ZIP 条目类型清单无法核验');
  for(const [index,name] of entries.entries()){
    const directory=name.endsWith('/');
    if(details[index].trimStart()[0]!== (directory?'d':'-'))throw Error('ZIP 只能包含普通文件和目录：'+name);
    if(directory&&!directories.has(name))throw Error('ZIP 包含发布清单之外的目录：'+name);
  }
  if(hasSevenZip){
    const details=run(sevenZip,['l','-slt',file]);
    if(/^Attributes = .*C/m.test(details))throw Error('ZIP 条目带有 NTFS 压缩属性 C');
    run(sevenZip,['t',file],{stdio:'ignore'});
  }
                                                
  for(const name of expected){
    const sourceFile=path.join(source,name),wanted=name==='publish.json'?createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'):manifest.files[name];
    let content;
    try{content=run(tar,['-xOf',file,top+'/'+name],{encoding:'buffer',maxBuffer:Math.max(1,fs.statSync(sourceFile).size)+1});}
    catch(error){throw new Error('无法完整读取 ZIP 条目：'+name,{cause:error});}
    if(createHash('sha256').update(content).digest('hex')!==wanted)throw Error('ZIP 内容与已测试的发布目录不一致：'+name);
  }
  return{entries:entries.length,files:files.length,root:top+'/',ntfsCompressedAttributes:false,contentMatchesPublish:true};
}

let checked;
if(!process.argv.includes('--check')){
  fs.mkdirSync(releases,{recursive:true});
  if(fs.existsSync(archive)&&!process.argv.includes('--overwrite'))throw Error('发布包已经存在，显式传入 --overwrite 才可覆盖：'+archive);
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nxbridge-stage-')),staged=path.join(stage,top),temporary=path.join(stage,'release.zip');
  try{
    fs.cpSync(source,staged,{recursive:true});
    if(process.platform==='win32'){
      const compact=path.join(process.env.SystemRoot??'C:/Windows','System32','compact.exe');
      run(compact,['/u','/s','/q','/i'],{cwd:staged,stdio:'ignore'});
      run(compact,['/u','/q','/i',staged],{stdio:'ignore'});
    }
    if(hasSevenZip)run(sevenZip,['a','-tzip','-mx=9','-mm=Deflate','-mfb=258','-mpass=15',temporary,top],{cwd:stage,stdio:'ignore'});
    else run(tar,['-a','-cf',temporary,'-C',stage,top]);
    checked=check(temporary);
    const pending=archive+'.tmp-'+randomUUID();
    try{fs.copyFileSync(temporary,pending,fs.constants.COPYFILE_EXCL);fs.renameSync(pending,archive);}
    finally{fs.rmSync(pending,{force:true});}
  }finally{
    if(path.dirname(stage)!==path.resolve(os.tmpdir())||!path.basename(stage).startsWith('nxbridge-stage-'))throw Error('暂存目录越界');
    fs.rmSync(stage,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
}
const result=checked??check(archive),sha256=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
console.log(JSON.stringify({archive,buildId:manifest.buildId,bytes:fs.statSync(archive).size,sha256,...result}));
