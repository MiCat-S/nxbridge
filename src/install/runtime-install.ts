import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {atomicJson,readJson,sameDirectory} from '../shared/files.js';
import {CLI_PATH,PACKAGE_ROOT} from '../shared/package-location.js';
import { inside, managedMarker } from './installation.js';
import { liveProcess, processIdentity } from '../process/process.js';
import {BridgeError} from '../shared/errors.js';
import { resolveNodeRuntime } from './node-runtime.js';
import { retryWindowsFileOperation } from '../storage/atomic-file.js';

const execute=promisify(execFile),OWNER='nxbridge-publish-v1';
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export interface RuntimeReference {buildId:string;directory:string;entry:string;version:string}
export interface RuntimeManifest {owner:typeof OWNER;buildId:string;version:string;files:Record<string,string>;dependencies:Record<string,string>}
export interface RuntimeCandidate extends RuntimeReference {manifest:RuntimeManifest;reused:boolean;source:string}
export interface RuntimePointer extends RuntimeReference {owner:string;node:string;home:string;source?:string;previous?:RuntimeReference}
interface RuntimeProcess {owner:string;pid:number;generation:string;entry:string;buildId?:string}
export interface InstallReceipt {owner:string;buildId:string;roots:{directory:string;files:Record<string,string>}[]}

                                        
export function runtimeEntriesChanged(previous:RuntimeManifest|undefined,candidate:RuntimeCandidate,entries:string[]):boolean{
  const pending=[...entries],seen=new Set<string>();
  while(pending.length){
    const name=pending.pop()!;if(seen.has(name))continue;seen.add(name);
    if(previous?.files[name]!==candidate.manifest.files[name])return true;
    const source=readFileSync(path.join(candidate.directory,name),'utf8');
                                                  
    for(const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/g)){
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(name),match[1]!));
      if(Object.hasOwn(candidate.manifest.files,dependency))pending.push(dependency);
    }
  }
  return false;
}

export function fileHashes(root:string,ignore:string[]=[],contents?:Map<string,Buffer>):Record<string,string>{
  const files:Record<string,string>={};
  const walk=(directory:string,prefix:string)=>{
    for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(directory,item.name),relative=prefix+item.name;if(ignore.includes(relative))continue;
      if(item.isSymbolicLink())throw new BridgeError('runtime_path','发布文件不能通过链接引用目录外的内容：'+file);
      if(item.isDirectory())walk(file,relative+'/');else if(item.isFile()){const content=readFileSync(file);files[relative]=digest(content);contents?.set(relative,content);}else throw new BridgeError('runtime_path','发布目录不能包含非普通文件：'+file);
    }
  };
  walk(root,'');return files;
}
export function runtimeManifest(root=PACKAGE_ROOT):RuntimeManifest|undefined{
  try{const value=readJson<RuntimeManifest>(path.join(root,'publish.json'));return value.owner===OWNER&&typeof value.buildId==='string'&&typeof value.version==='string'&&!!value.files?value:undefined;}catch{return;}
}
export function ownsRuntime(home:string,directory:string):boolean{
  const root=path.join(home,'runtime');
  try{return inside(root,directory)&&sameDirectory(path.dirname(directory),root)&&inside(realpathSync.native(root),realpathSync.native(directory))&&readJson<any>(path.join(directory,'.nxbridge-runtime.json')).owner===managedMarker(home)&&runtimeManifest(directory)?.buildId===path.basename(directory);}catch{return false;}
}
export function activeRuntime(home:string):RuntimePointer|undefined{
  try{const value=readJson<RuntimePointer>(path.join(home,'bin','runtime.json'));return value.owner===managedMarker(home)?value:undefined;}catch{return;}
}
export function installedEntry(home:string):{node:string;entry:string}{const current=activeRuntime(home);return current?{node:resolveNodeRuntime(current.node),entry:current.entry}:{node:process.execPath,entry:CLI_PATH};}
export function publishSource(home:string,from?:string):{directory:string;repair:boolean}{
  if(from){const directory=path.resolve(from);return{directory:runtimeManifest(directory)?directory:path.join(directory,'publish'),repair:false};}
  if(!runtimeManifest(PACKAGE_ROOT))return{directory:path.join(PACKAGE_ROOT,'publish'),repair:false};
  const current=activeRuntime(home),source=current?.source;
  if(source&&existsSync(path.join(source,'publish.json'))&&!sameDirectory(source,PACKAGE_ROOT))return{directory:source,repair:false};
  return{directory:PACKAGE_ROOT,repair:ownsRuntime(home,PACKAGE_ROOT)};
}
export function verifyPublish(root:string):RuntimeManifest{
  const manifest=runtimeManifest(root);
  if(!manifest)throw new BridgeError('publish_missing','没有找到构建好的 publish 目录。请在工程目录里先运行 npm run build:publish，或用 --from 指定一个 publish 目录。');
  if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version))throw new BridgeError('publish_invalid','发布版本号无效。');
  const files=fileHashes(root,['publish.json','.nxbridge-runtime.json']);
  if(JSON.stringify(files)!==JSON.stringify(manifest.files)||manifest.buildId!==manifest.version+'-'+digest(JSON.stringify({files,dependencies:manifest.dependencies})).slice(0,12))throw new BridgeError('runtime_drift','发布目录与构建清单不一致，未切换当前版本。');
  for(const name of ['nxbridge.mjs','question-control.mjs','plugins/claude/bridge.cjs','plugins/codex/bridge.cjs','nxbridge-collaboration.md'])if(!files[name])throw new BridgeError('publish_missing','发布目录缺少必要运行文件：'+name);
  if(Object.keys(files).some(file=>/(?:^|\/)(?:node_modules|tests|native-tests)(?:\/|$)|\.map$|\.d\.ts$/.test(file)))throw new BridgeError('publish_invalid','发布目录包含开发文件或未内联的依赖。');
  return manifest;
}
export async function stageRuntime(home:string,source:string):Promise<RuntimeCandidate>{
  const manifest=runtimeManifest(source);
  if(!manifest)throw new BridgeError('publish_missing','没有找到构建好的 publish 目录。请在工程目录里先运行 npm run build:publish，或用 --from 指定一个 publish 目录。');
  const {buildId,version}=manifest,root=path.join(home,'runtime'),directory=path.join(root,buildId),entry=path.join(directory,'nxbridge.mjs');
  if(!inside(root,directory)||!sameDirectory(path.dirname(directory),root))throw new BridgeError('publish_invalid','发布构建编号不能包含目录路径。');
  mkdirSync(root,{recursive:true});
  if(existsSync(directory)){
    if(!ownsRuntime(home,directory))throw new BridgeError('runtime_conflict','目标运行时目录不属于本次安装，未覆盖。');
    verifyPublish(directory);
    if(process.platform==='win32')await execute(process.execPath,['--no-warnings',entry,'prepare-native'],{cwd:directory,env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:35000,maxBuffer:1024*1024});
    return{buildId,version,directory,entry,manifest,reused:true,source};
  }
  const work=path.join(root,'.stage-'+randomUUID());mkdirSync(work);
  try{
    for(const relative of Object.keys(manifest.files)){
      const destination=path.join(work,relative);
      if(!inside(work,destination))throw new BridgeError('publish_invalid','发布清单引用了目录外的文件：'+relative);
      mkdirSync(path.dirname(destination),{recursive:true});copyFileSync(path.join(source,relative),destination);
    }
    atomicJson(path.join(work,'publish.json'),manifest);
                                                 
    verifyPublish(work);
    if(process.platform==='win32')await execute(process.execPath,['--no-warnings',path.join(work,'nxbridge.mjs'),'prepare-native'],{cwd:work,env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:35000,maxBuffer:1024*1024});
    else await execute(process.execPath,['--no-warnings',path.join(work,'nxbridge.mjs'),'--version'],{cwd:work,env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:15000,maxBuffer:1024*1024});
    atomicJson(path.join(work,'.nxbridge-runtime.json'),{owner:managedMarker(home),buildId});retryWindowsFileOperation(()=>renameSync(work,directory),directory);
    return{buildId,version,directory,entry,manifest,reused:false,source};
  }finally{if(existsSync(work))rmSync(work,{recursive:true,force:true});}
}
export function pointerDetails(home:string,candidate:RuntimeCandidate):Record<string,unknown>{
  const old=activeRuntime(home),previous=old?.buildId===candidate.buildId?old.previous:old?.buildId&&old.directory?{buildId:old.buildId,directory:old.directory,entry:old.entry,version:old.version}:undefined;
  return{buildId:candidate.buildId,directory:candidate.directory,version:candidate.version,source:candidate.source,...(previous?{previous}:{})};
}
export async function registerRuntimeProcess(home:string):Promise<{file:string;record:RuntimeProcess}>{
  const generation=(await processIdentity(process.pid)).startedAt,buildId=runtimeManifest()?.buildId,record={owner:managedMarker(home),pid:process.pid,generation,entry:CLI_PATH,...(buildId?{buildId}:{})};
  const file=path.join(home,'run',`runtime-${process.pid}-${generation.replace(/[^\w-]/g,'_')}.json`);atomicJson(file,record);return{file,record};
}
export async function pruneRuntimes(home:string,removeAll=false):Promise<{removed:string[];protected:string[];notes:string[]}>{
  const root=path.join(home,'runtime'),run=path.join(home,'run'),pointer=activeRuntime(home),keep=new Set<string>(),protectedDirs=new Set<string>(),notes:string[]=[],removed:string[]=[];
  if(!existsSync(root))return{removed,protected:[],notes};
  const realRoot=realpathSync.native(root);
  if(!removeAll){if(pointer?.directory)keep.add(path.resolve(pointer.directory));if(pointer?.previous?.directory)keep.add(path.resolve(pointer.previous.directory));}
  const directories=readdirSync(root,{withFileTypes:true}).filter(item=>item.isDirectory()&&!item.name.startsWith('.')).map(item=>path.join(root,item.name));
  if(existsSync(run))for(const name of readdirSync(run).filter(name=>/^runtime-.*\.json$/.test(name))){
    const file=path.join(run,name);let record:RuntimeProcess;try{record=readJson(file);}catch{continue;}
    if(record.owner!==managedMarker(home))continue;
    let alive=liveProcess(record.pid);
    if(alive)try{alive=(await processIdentity(record.pid)).startedAt===record.generation;}catch{notes.push(`无法核验进程 ${record.pid} 的运行时引用，暂时保留。`);}
    if(!alive){unlinkSync(file);continue;}
                                                   
                                     
    let realEntry=record.entry;
    try{realEntry=path.join(realpathSync.native(path.dirname(record.entry)),path.basename(record.entry));}catch{                         }
    for(const directory of directories){
      const physicalDirectory=path.join(realRoot,path.basename(directory));
      if(inside(directory,record.entry)||inside(physicalDirectory,record.entry)||inside(physicalDirectory,realEntry))protectedDirs.add(path.resolve(directory));
    }
  }
  for(const directory of directories){
    if(!ownsRuntime(home,directory)||keep.has(path.resolve(directory))||protectedDirs.has(path.resolve(directory)))continue;
    rmSync(directory,{recursive:true,force:true});removed.push(directory);
  }
  if([...protectedDirs].some(directory=>!keep.has(directory)))notes.push('旧运行时仍被存活托管进程引用，已保留；该进程退出后会在下次更新时清理。');
  return{removed,protected:[...protectedDirs],notes};
}
export function inspectRuntime(home:string):Record<string,unknown>{
  const pointer=activeRuntime(home);if(!pointer?.buildId)return{independent:false};
  const drift:string[]=[];
  try{verifyPublish(pointer.directory);}catch(error){drift.push(error instanceof Error?error.message:String(error));}
  const receiptFile=path.join(home,'install-manifest.json');
  if(existsSync(receiptFile))try{
    const receipt=readJson<InstallReceipt>(receiptFile);
    if(receipt.owner===managedMarker(home))for(const root of receipt.roots){
      const actual=existsSync(root.directory)?fileHashes(root.directory):{};
      for(const file of new Set([...Object.keys(root.files),...Object.keys(actual)]))if(actual[file]!==root.files[file])drift.push(path.join(root.directory,file));
    }
  }catch(error){drift.push(String(error));}
  return{independent:true,buildId:pointer.buildId,entry:pointer.entry,source:pointer.source,previous:pointer.previous??null,drift,liveLoading:'磁盘上的文件和正在运行的 broker 分别核对版本；已打开的 MCP 连接和 Codex 会话是否已加载新版，需要各自确认。'};
}
