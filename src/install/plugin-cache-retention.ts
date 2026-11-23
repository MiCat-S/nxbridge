import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {readJson,sameDirectory} from '../shared/files.js';
import { cacheBelongsTo, installedCacheDirectories, inside, managedMarker } from './installation.js';
import { fileHashes } from './runtime-install.js';
import {BridgeError} from '../shared/errors.js';
import { atomicWriteFile, atomicWriteText } from '../storage/atomic-file.js';
import { processIdentity, probeProcesses } from '../process/process.js';

interface SavedCache {hostHome:string;directory:string;backup:string;files:Record<string,string>}
interface PendingCaches {owner:string;root:string;process:{pid:number;startedAt:string};caches:SavedCache[]}
const pendingFile=(home:string)=>path.join(home,'cache-retention-pending.json');
const fail=(file:string,reason:string):never=>{throw new BridgeError('cache_retention_pending',`${reason}：${file}。现有缓存及恢复资料已保留，请重新运行 nxbridge update 恢复；不要删除恢复记录。`);};

function safeParent(scope:string,file:string):void{
  let parent=file;while(!existsSync(parent))parent=path.dirname(parent);
  const base=realpathSync.native(scope),actual=realpathSync.native(parent);
  if(!sameDirectory(base,actual)&&!inside(base,actual))fail(file,'缓存恢复路径超出了原配置目录');
}

function removeBackupRoot(home:string,root:string):void{
  const directory=path.resolve(root);if(!existsSync(directory))return;
                                            
  const backups=path.join(realpathSync.native(home),'cache-retention-backups');
  if(path.relative(backups,realpathSync.native(path.dirname(directory)))!=='')throw new BridgeError('cache_retention_pending',`缓存副本清理目录超出了本次安装的 cache-retention-backups，未删除：${root}。请确认它的实际父目录为 ${backups}，修复后重新运行 nxbridge update；现有目录及已写入的恢复记录均已保留。`);
  rmSync(directory,{recursive:true});
}

                                      
export async function recoverRetainedCaches(home:string,dryRun=false):Promise<string[]>{
  const file=pendingFile(home);if(!existsSync(file))return[];
  const value=(()=>{try{return readJson<PendingCaches>(file);}catch{return fail(file,'缓存恢复记录无法读取');}})();
  if(value?.owner!==managedMarker(home))fail(file,'缓存恢复记录的归属无效');
  if(value.process.pid!==process.pid&&(await probeProcesses([{pid:value.process.pid,procStart:value.process.startedAt}]))[0]!=='dead')fail(file,'原安装进程尚未退出或无法核验');
  if(dryRun)fail(file,'检测到中断的旧缓存保留，本次预览未修改文件');
  const restored:string[]=[];
  for(const cache of value.caches){
    const root=path.join(cache.hostHome,'plugins','cache','nxbridge-local','nxbridge');
    safeParent(cache.hostHome,cache.directory);safeParent(home,cache.backup);
    if(existsSync(cache.directory)){
      const current=fileHashes(cache.directory);
      if(Object.entries(current).some(([file,hash])=>cache.files[file]!==hash))fail(cache.directory,'旧缓存位置已有不同内容，未覆盖');
      if(!isDeepStrictEqual(current,cache.files)){
        if(!isDeepStrictEqual(fileHashes(cache.backup),cache.files))fail(cache.backup,'旧缓存副本已改变');
                                                  
        for(const file of Object.keys(cache.files))if(current[file]===undefined){const destination=path.join(cache.directory,file);mkdirSync(path.dirname(destination),{recursive:true});atomicWriteFile(destination,readFileSync(path.join(cache.backup,file)),{exclusive:true});}
      }
    }else{
      if(!isDeepStrictEqual(fileHashes(cache.backup),cache.files))fail(cache.backup,'旧缓存副本已改变');
                                      
      const stage=path.join(path.dirname(root),'.nxbridge-restore-'+randomUUID());
      try{await cp(cache.backup,stage,{recursive:true});mkdirSync(root,{recursive:true});renameSync(stage,cache.directory);}
      finally{if(existsSync(stage))rmSync(stage,{recursive:true});}
    }
    restored.push(cache.directory);
  }
  removeBackupRoot(home,value.root);unlinkSync(file);
  return restored;
}

                                               
export function compareCacheVersions(left:string,right:string):number{
  if(left==='local'||right==='local')return left===right?0:left==='local'?1:-1;
  const parse=(value:string)=>/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  const a=parse(left),b=parse(right),order=(x:string,y:string)=>x===y?0:x<y?-1:1;
  if(!a||!b||[a[4],b[4]].some(pre=>pre?.split('.').some(part=>/^0\d+$/.test(part))))return order(left,right);
  for(let i=1;i<=3;i++){const x=BigInt(a[i]!),y=BigInt(b[i]!);if(x!==y)return x<y?-1:1;}
  if(a[4]===b[4])return 0;if(!a[4]||!b[4])return !a[4]?1:-1;
  const x=a[4].split('.'),y=b[4].split('.');
  for(let i=0;i<Math.max(x.length,y.length);i++){
    if(x[i]===undefined||y[i]===undefined)return x[i]===undefined?-1:1;
    if(x[i]===y[i])continue;
    const xn=/^\d+$/.test(x[i]!),yn=/^\d+$/.test(y[i]!);
    return xn&&yn?BigInt(x[i]!)<BigInt(y[i]!)?-1:1:xn!==yn?xn?-1:1:order(x[i]!,y[i]!);
  }
  return 0;
}

export async function withRetainedCodexCaches<T>(home:string,hostHomes:string[],targetVersion:string,work:()=>Promise<T>):Promise<{value:T;restored:string[];unretained:string[]}>{
  if(existsSync(pendingFile(home)))fail(pendingFile(home),'上次缓存保留尚未恢复');
  const all=[...new Set(hostHomes.flatMap(hostHome=>installedCacheDirectories(hostHome,'codex')))];
  for(const directory of all)if(!cacheBelongsTo(directory,'codex',home))fail(directory,'旧缓存无法核验为本次安装所有');
  const directories=all.filter(directory=>compareCacheVersions(path.basename(directory),targetVersion)<0),unretained=all.filter(directory=>compareCacheVersions(path.basename(directory),targetVersion)>=0);
  const root=path.join(home,'cache-retention-backups',randomUUID()),caches:SavedCache[]=[];
  let published=false;
  try{
    for(const directory of directories){
      const backup=path.join(root,String(caches.length)),files=fileHashes(directory);
      await cp(directory,backup,{recursive:true});
      if(!isDeepStrictEqual(fileHashes(backup),files))fail(backup,'旧缓存复制过程中发生变化');
      caches.push({hostHome:path.resolve(directory,'../../../../..'),directory,backup,files});
    }
    if(!caches.length)return{value:await work(),restored:[],unretained};
    const identity=await processIdentity(process.pid),record:PendingCaches={owner:managedMarker(home),root,process:{pid:identity.pid,startedAt:identity.startedAt},caches};
    atomicWriteText(pendingFile(home),JSON.stringify(record,null,2)+'\n',{exclusive:true});published=true;
  }catch(error){
                                        
    let referenced=published;
    if(!referenced)try{referenced=JSON.parse(readFileSync(pendingFile(home),'utf8')).root===root;}
    catch(readError){referenced=(readError as NodeJS.ErrnoException).code!=='ENOENT';}
    if(!referenced)removeBackupRoot(home,root);throw error;
  }
  let value:T;
  try{value=await work();}finally{await recoverRetainedCaches(home);}
  return{value,restored:directories,unretained};
}

                                        
export async function pruneRetainedCodexCaches(home:string,directories:string[],active:string[],restored:string[],nativeProcesses:()=>Promise<{pid:number;startedAt:string}[]>):Promise<{removed:string[];retained:string[];notes:string[]}>{
  const old=directories.filter(directory=>!active.some(current=>sameDirectory(current,directory))&&!restored.some(current=>sameDirectory(current,directory)));
  const removed:string[]=[],retained=directories.filter(directory=>restored.some(current=>sameDirectory(current,directory))),notes:string[]=[];
  if(!old.length)return{removed,retained,notes};
  let live:{pid:number;startedAt:string}[];
  try{live=await nativeProcesses();}catch{notes.push('无法核验本次安装已登记的 Codex 原生进程，旧插件缓存暂时保留。');return{removed,retained:[...retained,...old],notes};}
  if(live.length){notes.push('本次安装已登记的 Codex 原生进程仍在运行，旧插件缓存已保留；这些进程退出后的下次 update 会重新核验并清理。');return{removed,retained:[...retained,...old],notes};}
  for(const directory of old){
    if(!cacheBelongsTo(directory,'codex',home)){notes.push(`旧缓存归属无法核验，已保留 ${directory}`);retained.push(directory);continue;}
    rmSync(directory,{recursive:true});removed.push(directory);
  }
  return{removed,retained,notes};
}
