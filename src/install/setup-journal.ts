import {embeddedSource} from "../shared/embedded-source.js";
import { existsSync, readFileSync, mkdirSync, chmodSync, unlinkSync, lstatSync, readdirSync, rmdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteFile, atomicWriteText, retryWindowsFileOperation } from '../storage/atomic-file.js';
import {stateDirectory} from '../storage/state-directory.js';
import { managedMarker, inside, ownsFile, cacheBelongsTo, type ManagedFile } from './installation.js';
import { fileHashes, type InstallReceipt } from './runtime-install.js';
import { processIdentity, liveProcess } from '../process/process.js';
import {BridgeError} from '../shared/errors.js';
import type { DatabaseSync } from 'node:sqlite';

type Checkpoint=(step:string)=>void;
interface Write {file:string;before:string|null;after:string}
interface Base {version:1;owner:string;process:{pid:number;startedAt:string};label:string}
interface FilesIntent extends Base {kind:'files';writes:Write[]}
interface CacheIntent extends Base {kind:'cache';host:'codex'|'claude';hostHome:string;source:string;target:string;before:Record<string,string>;after:Record<string,string>}
type Intent=FilesIntent|CacheIntent;
interface CacheSnapshot {current:Record<string,string>;contents:Map<string,Buffer>}
const pendingFile=(home:string)=>path.join(home,'setup-pending.json');
const text=(file:string)=>{
  try{if(!lstatSync(file).isFile())conflict([file],'目标不再是原来的普通文件');return readFileSync(file,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;if((error as NodeJS.ErrnoException).code==='ENOTDIR')conflict([file],'目标的上级目录被替换为文件');throw error;}
};
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
let identity:ReturnType<typeof processIdentity>|undefined;
const owner=()=>identity??=processIdentity(process.pid);
const key=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const same=(a:string,b:string)=>key(a)===key(b);

function conflict(files:string[],reason='文件与提交前或预定内容不符'):never{
  throw new BridgeError('setup_recovery_conflict',`中断的安装尚未恢复：${reason}。未覆盖以下文件：\n${files.join('\n')}\n请先保存这些文件的副本，再依据 setup-pending.json 中的提交前/预定内容（缓存的预定内容在记录的 source 目录）恢复这些文件，然后再运行一次同样的命令。不要删除配置或修改权限；恢复记录仍保留。`);
}

function safeTree(scope:string,file:string):void{
  try{if(lstatSync(file).isSymbolicLink())conflict([file],'恢复路径被替换为链接');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  let parent=file;while(!existsSync(parent))parent=path.dirname(parent);
  let base:string,actual:string;
  try{base=realpathSync.native(scope);actual=realpathSync.native(parent);}catch{conflict([file],'无法核验恢复路径，请先恢复它原来的上级目录');}
  if(!same(base,actual)&&!inside(base,actual))conflict([file],'恢复路径实际指向记录目录之外');
}

function snapshot(directory:string,contents?:Map<string,Buffer>):Record<string,string>{
  try{return fileHashes(directory,[],contents);}catch(error){conflict([directory],`无法核验插件目录，请先恢复该目录：${error instanceof Error?error.message:String(error)}`);}
}

function cacheChanges(intent:CacheIntent,current:Record<string,string>):string[]{
  return [...new Set([...Object.keys(current),...Object.keys(intent.before),...Object.keys(intent.after)])].filter(file=>current[file]!==intent.before[file]&&current[file]!==intent.after[file]);
}

function removeEmptyDirectories(directory:string):void{
  if(!existsSync(directory))return;
  for(const item of readdirSync(directory,{withFileTypes:true}))if(item.isDirectory()){
    const child=path.join(directory,item.name);removeEmptyDirectories(child);
    if(!readdirSync(child).length)retryWindowsFileOperation(()=>rmdirSync(child),child);
  }
}

function apply(home:string,intent:Intent,checkpoint:Checkpoint=()=>{},cached?:CacheSnapshot):void{
  if(intent.kind==='files'){
    const changed=intent.writes.filter(w=>{const value=text(w.file);return value!==w.before&&value!==w.after;});
    if(changed.length)conflict(changed.map(w=>w.file));
    for(let index=0;index<intent.writes.length;index++){
      const w=intent.writes[index]!;
      if(text(w.file)!==w.after){stateDirectory(path.dirname(w.file));atomicWriteText(w.file,w.after);}
      if(process.platform!=='win32'&&path.basename(w.file)==='nxbridge')chmodSync(w.file,0o755);
      checkpoint(intent.label+':write:'+index);
    }
  }else{
    if(!cached){
      safeTree(home,intent.source);safeTree(intent.hostHome,intent.target);
      const contents=new Map<string,Buffer>();
      if(!existsSync(intent.source)||!isDeepStrictEqual(snapshot(intent.source,contents),intent.after))conflict([intent.source],'插件恢复来源缺失或已改变，请恢复该目录后重试');
      cached={current:existsSync(intent.target)?snapshot(intent.target):{},contents};
    }
    const changed=cacheChanges(intent,cached.current);if(changed.length)conflict(changed.map(file=>path.join(intent.target,file)));
                                               
    for(const file of Object.keys(intent.before).filter(file=>intent.after[file]===undefined)){
      const target=path.join(intent.target,file);
      if(existsSync(target))retryWindowsFileOperation(()=>unlinkSync(target),target);
      checkpoint(intent.label+':remove:'+file);
    }
    removeEmptyDirectories(intent.target);checkpoint(intent.label+':removed');
    for(const [file,hash] of Object.entries(intent.after)){
      const content=cached.contents.get(file)!;
      const target=path.join(intent.target,file);
      if(cached.current[file]!==hash){stateDirectory(path.dirname(target));atomicWriteFile(target,content);}
      checkpoint(intent.label+':write:'+file);
    }
    checkpoint(intent.label+':copied');
  }
  retryWindowsFileOperation(()=>unlinkSync(pendingFile(home)),pendingFile(home));
  checkpoint(intent.label+':complete');
}

function commit(home:string,intent:Omit<FilesIntent,'process'|'version'|'owner'>|Omit<CacheIntent,'process'|'version'|'owner'>,process:Base['process'],checkpoint:Checkpoint=()=>{},cached?:CacheSnapshot):void{
  if(existsSync(pendingFile(home)))throw new BridgeError('setup_pending','已有未完成的安装提交；请再运行一次同样的命令自动恢复。');
  const value={...intent,version:1 as const,owner:managedMarker(home),process} as Intent;
                                          
  atomicWriteText(pendingFile(home),json(value),{exclusive:true});checkpoint(value.label+':intent');
  apply(home,value,checkpoint,cached);
}

export async function recoverSetup(home:string,dryRun=false):Promise<string[]>{
  if(!existsSync(pendingFile(home)))return[];
                                              
                                    
  let lock:DatabaseSync|undefined;
  if(!dryRun){
    const file=path.join(home,'setup-recovery.db');
    try{const {DatabaseSync:RecoveryDatabase}=await import('node:sqlite');lock=new RecoveryDatabase(file);lock.exec(                          embeddedSource("sql", `BEGIN EXCLUSIVE`));}
    catch(error){lock?.close();if((error as {errcode?:number}).errcode===5)throw new BridgeError('setup_in_progress','另一个进程正在恢复安装，请等它结束后重试；没有停止该进程。');throw new BridgeError('setup_recovery_lock',`无法取得安装恢复锁 ${file}：${error instanceof Error?error.message:String(error)}。请先关闭正在恢复的 setup/update，再运行一次同样的命令；未修改配置或权限。`);}
  }
  try{
                                    
  if(!existsSync(pendingFile(home)))return[];
  let intent:Intent;try{intent=JSON.parse(readFileSync(pendingFile(home),'utf8'));}catch{conflict([pendingFile(home)],'恢复记录无法读取，请从备份恢复该记录后重试');}
                                        
  if(intent?.version!==1||intent.owner!==managedMarker(home))conflict([pendingFile(home)],'恢复记录版本或归属无效，请使用对应版本恢复后重试');
  if(intent.process.pid!==process.pid&&liveProcess(intent.process.pid)){
    let live=false;try{live=(await processIdentity(intent.process.pid)).startedAt===intent.process.startedAt;}catch(error){if((error as BridgeError).code!=='process_missing')throw error;}
    if(live)throw new BridgeError('setup_in_progress',`进程 ${intent.process.pid} 正在安装，请等待它结束后重试；没有停止该进程。`);
  }
  if(dryRun)throw new BridgeError('setup_recovery_pending',`检测到中断的安装（${pendingFile(home)}）。去掉 --dry-run 再运行一次同样的命令，就会接着装完；这次没有写入任何内容。`);
  apply(home,intent);
  return['已自动完成中断的安装提交，保留原来的配对和用户配置。'];
  }finally{lock?.close();}
}

export async function commitActivation(home:string,state:{managedFiles?:ManagedFile[];[key:string]:any},files:ManagedFile[],receipt:InstallReceipt,checkpoint?:Checkpoint):Promise<void>{
  const writer=await owner();
  for(const old of state.managedFiles??[]){const current=text(old.file);if(current!==null&&current!==old.content)conflict([old.file],'已登记的命令文件在提交前被修改');}
  for(const file of files)if(text(file.file)!==null&&!ownsFile(file.file,home))conflict([file.file],'新命令位置出现了不属于本次安装的文件');
  const obsolete=(state.managedFiles??[]).filter(old=>!files.some(f=>same(f.file,old.file)));
  const next={...state,managedFiles:[...files,...obsolete]};
  const outputs=[...files,{file:path.join(home,'setup-state.json'),content:json(next)},{file:path.join(home,'install-manifest.json'),content:json(receipt)}];
  const writes=outputs.map(f=>({file:f.file,before:text(f.file),after:f.content}));
  commit(home,{kind:'files',label:'activation',writes},{pid:writer.pid,startedAt:writer.startedAt},checkpoint);state.managedFiles=next.managedFiles;
}

export async function commitCache(home:string,host:'codex'|'claude',hostHome:string,source:string,target:string,checkpoint?:Checkpoint):Promise<void>{
  const writer=await owner();
  if(!cacheBelongsTo(target,host,home))throw new BridgeError('cache_conflict',`${target} 无法核验为 ${home} 这套 nxbridge 安装的自有缓存，未覆盖。请确认当前 NXBRIDGE_HOME 与 ${host} 配置目录是否配套；若缓存属于另一套安装，请使用那套安装维护，或让不同安装使用独立的 ${host} 配置目录后重新执行 setup。`);
  safeTree(home,source);safeTree(hostHome,target);
                                              
  const contents=new Map<string,Buffer>(),before=snapshot(target),after=snapshot(source,contents);
  commit(home,{kind:'cache',label:'cache:'+host,host,hostHome,source,target,before,after},{pid:writer.pid,startedAt:writer.startedAt},checkpoint,{current:before,contents});
}
