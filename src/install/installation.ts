import {embeddedSource} from "../shared/embedded-source.js";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {atomicJson,readJson,sameDirectory} from '../shared/files.js';
import {CLI_PATH} from '../shared/package-location.js';
import {BridgeError} from '../shared/errors.js';
import { persistentEnvironment, temporaryPath } from '../process/environment.js';
import { windowsNodeDiscovery } from './node-runtime.js';
import { atomicWriteText } from '../storage/atomic-file.js';

export interface ManagedFile {file:string;content:string}
export interface ShimPlan {directory:string|null;files:ManagedFile[];launcher:ManagedFile[];command:string;reason:string;notice?:string}
const MARKER='nxbridge-owned-v1';
const key=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const quoteSh=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
function writableParent(directory:string):boolean{
  let current=directory;
  while(!existsSync(current)){const parent=path.dirname(current);if(parent===current)return false;current=parent;}
  try{if(!statSync(current).isDirectory())return false;accessSync(current,constants.W_OK);return true;}catch{return false;}
}

export function inside(directory:string,filename:string):boolean{
  const relative=path.relative(key(directory),key(filename));return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
}

export function managedMarker(home:string):string{return `${MARKER} ${path.resolve(home)}`;}
export function ownsFile(filename:string,home:string):boolean{
  try{const content=readFileSync(filename,'utf8');return path.extname(filename)==='.json'?JSON.parse(content).owner===managedMarker(home):content.split(/\r?\n/).slice(0,3).some(line=>line.includes(managedMarker(home)));}catch{return false;}
}

export function toolSpecificBin(directory:string):boolean{
  return /(?:^|[\\/])(?:\.cargo|\.rustup|\.?pyenv|\.?rbenv|\.?asdf|\.?nvm|\.?fnm|\.?volta|\.?mise)(?:[\\/]|$)|(?:^|[\\/])go[\\/]bin(?:[\\/]|$)/i.test(directory);
}

export function preferredBinDirectories(userHome:string,env:NodeJS.ProcessEnv,platform:NodeJS.Platform=process.platform,nodeDirectory?:string):{directory:string;reason:string}[]{
  const paths=platform==='win32'?path.win32:path.posix;
  const prefix=env.npm_config_prefix??env.NPM_CONFIG_PREFIX;
  const relative=prefix?paths.relative(userHome,prefix):undefined;
  const userPrefix=relative!==undefined&&relative!==''&&relative!=='..'&&!relative.startsWith('..'+paths.sep)&&!paths.isAbsolute(relative);
  const npmBin=prefix&&userPrefix?(platform==='win32'?prefix:paths.join(prefix,'bin')):undefined;
  return[
    {directory:paths.join(userHome,'.local','bin'),reason:'优先使用通用用户命令目录 ~/.local/bin'},
    {directory:paths.join(userHome,'bin'),reason:'优先使用通用用户命令目录 ~/bin'},
    ...(npmBin&&(!nodeDirectory||!sameDirectory(npmBin,nodeDirectory))?[{directory:npmBin,reason:'使用用户目录内的 npm 全局前缀命令目录'}]:[]),
    ...(platform==='win32'&&env.APPDATA?[{directory:paths.join(env.APPDATA,'npm'),reason:'使用用户 npm 全局命令目录'}]:[]),
    ...['.npm-global','.npm'].map(name=>({directory:paths.join(userHome,name,'bin'),reason:'使用用户 npm 全局命令目录'})),
    ...(env.HOMEBREW_PREFIX?[{directory:paths.join(env.HOMEBREW_PREFIX,'bin'),reason:'使用当前用户可写的 Homebrew 命令目录'}]:[]),
    ...(platform==='darwin'?['/opt/homebrew/bin','/usr/local/bin'].map(directory=>({directory,reason:'使用当前用户可写的 Homebrew 常用命令目录'})):[]),
  ].filter(value=>!toolSpecificBin(value.directory));
}

export function planShim(home:string,options:{directories?:string[];pathValue?:string;entry?:string;node?:string;platform?:NodeJS.Platform;runtime?:Record<string,unknown>}={}):ShimPlan{
  const platform=options.platform??process.platform,delimiter=platform==='win32'?';':':';
  const persistent=options.pathValue===undefined&&!options.directories?persistentEnvironment():undefined;
  const directories=[...new Set((options.pathValue??persistent?.PATH??process.env.PATH??'').split(delimiter).filter(Boolean).map(directory=>path.resolve(directory.replace(/^"|"$/g,''))))];
  const stable=directories.filter(directory=>!temporaryPath(directory,persistent??process.env));
  const names=platform==='win32'?['nxbridge.exe','nxbridge.ps1','nxbridge.cmd','nxbridge','nxbridge.cjs']:['nxbridge'];
                                                             
  const existing=stable.filter(directory=>names.some(name=>ownsFile(path.join(directory,name),home)));
  const userHome=persistent?.USERPROFILE??persistent?.HOME??homedir();
                                                   
  const node=options.node??process.execPath,nodeDirectory=path.dirname(node);
  const candidates=options.directories?.map(directory=>({directory,reason:'使用显式指定且已经在 PATH 中的目录'}))??[
    ...existing.map(directory=>({directory,reason:'保留已有的 nxbridge 自有命令位置'})),
    ...preferredBinDirectories(userHome,{...process.env,...persistent},platform,nodeDirectory).filter(value=>stable.some(directory=>sameDirectory(directory,value.directory))),
    ...stable.filter(directory=>inside(userHome,directory)&&!toolSpecificBin(directory)&&!sameDirectory(directory,nodeDirectory)).map(directory=>({directory,reason:'使用其他已经在 PATH 中的可写用户目录；未选择工具专属目录'})),
  ];
  const entry=options.entry??CLI_PATH,bin=path.join(home,'bin'),launcherPath=path.join(bin,'nxbridge.cjs');
  const launcher=[
    {file:path.join(bin,'node-discovery.ps1'),content:`# ${managedMarker(home)}\n${windowsNodeDiscovery()}\n`},
    {file:launcherPath,content:                                 embeddedSource("javascript", `// ${managedMarker(home)}
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
if(process.argv[2]==='hook'&&!process.env.NXBRIDGE_HOOK_STARTED_AT)process.env.NXBRIDGE_HOOK_STARTED_AT=String(performance.timeOrigin);
const runtime=JSON.parse(fs.readFileSync(path.join(__dirname,'runtime.json'),'utf8'));
const node=fs.existsSync(runtime.node)?runtime.node:process.execPath;
const native=file=>{const value=fs.realpathSync.native(file);return process.platform==='win32'?value.toLowerCase():value;};
const sameNode=native(node)===native(process.execPath);
if(sameNode&&!/^(24|25|26)\\./.test(process.versions.node))throw new Error('nxbridge 需要 Node.js 24～26；请安装兼容版本后运行 bin/nxbridge.cjs update。');
const args=process.argv.slice(2),dedicated=path.join(path.dirname(runtime.entry),args[0]+'-entry.mjs'),entry=['mcp','mod','hook'].includes(args[0])&&fs.existsSync(dedicated)?dedicated:runtime.entry;
const compileCache=['mcp','mod'].includes(args[0])?path.join(process.env.NXBRIDGE_HOME||runtime.home,'run','compile-cache'):undefined;
if(sameNode){process.env.NXBRIDGE_HOME=process.env.NXBRIDGE_HOME||runtime.home;if(compileCache)require('node:module').enableCompileCache(compileCache);import(pathToFileURL(entry).href).catch(error=>{process.stderr.write('nxbridge：'+error.message+'\\n');process.exitCode=1;});}
else{const child=spawn(node,[entry,...args],{stdio:'inherit',windowsHide:true,shell:false,env:{...process.env,NXBRIDGE_HOME:process.env.NXBRIDGE_HOME||runtime.home,...(compileCache&&!process.env.NODE_COMPILE_CACHE?{NODE_COMPILE_CACHE:compileCache}:{})}});
child.on('error',error=>{process.stderr.write('nxbridge：'+error.message+'\\n');process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});}
`)},
    {file:path.join(bin,'runtime.json'),content:JSON.stringify({...options.runtime,owner:managedMarker(home),node,entry,home},null,2)+'\n'},
  ];
  for(const file of launcher)if(existsSync(file.file)&&!ownsFile(file.file,home))throw new BridgeError('launcher_conflict',`运行入口存在非 nxbridge 文件：${file.file}，未覆盖。`);
  let directory:string|null=null,reason='没有符合条件的可写 PATH 目录；不修改 PATH，也不自动安装到工具专属目录';
  for(const candidate of candidates){
    if(!directories.some(value=>key(value)===key(candidate.directory)))continue;
    if(writableParent(candidate.directory)){directory=path.resolve(candidate.directory);reason=candidate.reason;break;}
  }
  const quotePs=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  const discover=Buffer.from(`& ([scriptblock]::Create([IO.File]::ReadAllText(${quotePs(path.join(bin,'node-discovery.ps1'))})))`,'utf16le').toString('base64');
  const command=platform==='win32'?`& ${quotePs(node)} ${quotePs(launcherPath)}`:`${quoteSh(node)} ${quoteSh(launcherPath)}`;
  if(!directory)return{directory,files:[],launcher,command,reason,notice:'没有找到既在 PATH 中又可写的通用用户目录，未安装 nxbridge 命令，也没有修改 PATH。请用下面的完整命令运行，或用 --bin-dir 指定一个已在 PATH 中的目录。'};
  for(const name of names){
    const filename=path.join(directory,name);
    if(existsSync(filename)&&!ownsFile(filename,home))throw new BridgeError('shim_conflict',`${filename} 已有一个不属于本次安装的 nxbridge 命令，未覆盖。`);
  }
  const shadow=directories.slice(0,directories.findIndex(value=>key(value)===key(directory))).flatMap(value=>names.map(name=>path.join(value,name))).find(filename=>existsSync(filename)&&!ownsFile(filename,home));
  const notice=shadow?`PATH 中较早的 ${shadow} 会遮住本次安装的命令。请调整 PATH 顺序，或用完整命令 ${command} 运行。`:undefined;
  const content=platform==='win32'?                          embeddedSource("cmd", `@echo off
:: ${managedMarker(home)}
setlocal
set "NXBRIDGE_NODE=${node}"
if exist "%NXBRIDGE_NODE%" goto launch
set "NXBRIDGE_NODE="
for /f "delims=" %%N in ('"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${discover}') do set "NXBRIDGE_NODE=%%N"
if not defined NXBRIDGE_NODE exit /b 1
:launch
"%NXBRIDGE_NODE%" "%~dp0nxbridge.cjs" %*
exit /b %errorlevel%
`)
    :                         embeddedSource("sh", `#!/bin/sh
# ${managedMarker(home)}
node=${quoteSh(node)}
[ -x "$node" ] || node=node
exec "$node" ${quoteSh(launcherPath)} "$@"
`);
  return{directory,files:[{file:path.join(directory,platform==='win32'?'nxbridge.cmd':'nxbridge'),content},...(platform==='win32'&&!sameDirectory(path.join(directory,'nxbridge.cjs'),launcherPath)?[{file:path.join(directory,'nxbridge.cjs'),content:                                 embeddedSource("javascript", `// ${managedMarker(home)}
require(${JSON.stringify(launcherPath)});
`)}]:[])],launcher,command:'nxbridge',reason,...(notice?{notice}:{})};
}

export function installShim(plan:ShimPlan):ManagedFile[]{
  for(const file of [...plan.launcher,...plan.files]){
    mkdirSync(path.dirname(file.file),{recursive:true});
    atomicWriteText(file.file,file.content);
    if(process.platform!=='win32'&&path.basename(file.file)==='nxbridge')chmodSync(file.file,0o755);
  }
  return[...plan.launcher,...plan.files];
}

export function recoverManagedFiles(home:string,pathValue=process.env.PATH??''):ManagedFile[]{
  const filenames=[path.join(home,'bin','nxbridge.cjs'),path.join(home,'bin','runtime.json'),path.join(home,'bin','node-discovery.ps1'),...pathValue.split(path.delimiter).filter(Boolean).flatMap(directory=>['nxbridge','nxbridge.cmd','nxbridge.ps1','nxbridge.cjs'].map(name=>path.join(directory,name)))];
  return[...new Set(filenames)].filter(filename=>ownsFile(filename,home)).map(file=>({file,content:readFileSync(file,'utf8')}));
}

export function removeManagedFiles(files:ManagedFile[],home:string,dryRun=false):{removed:string[];notes:string[];remaining:ManagedFile[]}{
  const removed:string[]=[],notes:string[]=[],remaining:ManagedFile[]=[];
  for(const file of files){
    if(!existsSync(file.file))continue;
    try{
      if(!ownsFile(file.file,home)||readFileSync(file.file,'utf8')!==file.content){notes.push(`${file.file} 已改变，保留当前内容。`);remaining.push(file);continue;}
      if(!dryRun)rmSync(file.file);removed.push(file.file);
    }catch(error){notes.push(`无法删除 ${file.file}：${String(error)}`);remaining.push(file);}
  }
  return{removed,notes,remaining};
}

export function markMarketplace(root:string,home:string):void{atomicJson(path.join(root,'.nxbridge-owned.json'),{owner:managedMarker(home)});}
export function ownsMarketplace(root:string,home:string):boolean{
  try{return inside(home,root)&&readJson<{owner:string}>(path.join(root,'.nxbridge-owned.json')).owner===managedMarker(home);}catch{return false;}
}

function cacheDirectory(realRoot:string,directory:string,host:'claude'|'codex'):boolean{
  return inside(realRoot,realpathSync.native(directory))&&readJson<{name:string}>(path.join(directory,host==='claude'?'.claude-plugin':'.codex-plugin','plugin.json')).name==='nxbridge';
}

export function installedCacheDirectories(hostHome:string,host:'claude'|'codex'):string[]{
  const root=path.join(hostHome,'plugins','cache','nxbridge-local','nxbridge');
  if(!existsSync(root))return[];
  const realRoot=realpathSync.native(root);
  if(!inside(realpathSync.native(hostHome),realRoot))return[];
  return readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.join(root,entry.name)).filter(directory=>{
    try{return cacheDirectory(realRoot,directory,host);}catch{return false;}
  });
}

export function cacheBelongsTo(directory:string,host:'claude'|'codex',home:string):boolean{
  const root=path.dirname(directory),hostHome=path.resolve(directory,'../../../../..');
  try{
    if(!sameDirectory(root,path.join(hostHome,'plugins','cache','nxbridge-local','nxbridge')))return false;
    const realRoot=realpathSync.native(root);
    return inside(realpathSync.native(hostHome),realRoot)&&cacheDirectory(realRoot,directory,host)&&sameDirectory(readJson<{home:string}>(path.join(directory,'runtime.json')).home,home);
  }catch{return false;}
}

export function inspectInstallation(home:string):Record<string,unknown>{
  const filename=path.join(home,'setup-state.json');
  if(!existsSync(filename))return{recorded:false};
  try{
    const state=readJson<{disabled?:boolean;managedFiles?:ManagedFile[]}>(filename);
    return{recorded:true,disabled:state.disabled??false,managedFiles:(state.managedFiles??[]).map(file=>({file:file.file,state:!existsSync(file.file)?'missing':readFileSync(file.file,'utf8')===file.content?'current':'modified'})),runtime:'独立发布运行时位于 nxbridge 私有目录，由稳定入口读取当前版本指针',liveLoading:'文件已同步不等于已打开的窗口已加载：Claude 执行 /reload-plugins，MCP 备用入口到 /mcp 重连，Codex 空闲后执行 restart codex 或原生冷恢复。'};
  }catch(error){return{recorded:true,error:String(error)};}
}

                                        
export function installedCacheStatus(home:string):{host:'claude'|'codex';directory:string;cacheVersion:string|null;nativeVersionAtUpdate:string|null;inventoryObservedAt:string|null;nativeInventoryLag:boolean;notice?:string}[]{
  try{
    const state=readJson<{cacheDirectories?:{host:'claude'|'codex';directory:string}[];cacheInventory?:{directory:string;nativeVersion:string|null;observedAt:string}[]}>(path.join(home,'setup-state.json'));
                                           
    const inventories=new Map<string,string[]>();
    return(state.cacheDirectories??[]).filter(value=>{
      try{
        const hostHome=path.resolve(value.directory,'../../../../..'),key=value.host+':'+hostHome;
        let directories=inventories.get(key);if(!directories){directories=installedCacheDirectories(hostHome,value.host);inventories.set(key,directories);}
        return directories.some(directory=>sameDirectory(directory,value.directory))&&sameDirectory(readJson<{home:string}>(path.join(value.directory,'runtime.json')).home,home);
      }catch{return false;}
    }).map(value=>{
      const version=readJson<{version:string}>(path.join(value.directory,value.host==='codex'?'.codex-plugin':'.claude-plugin','plugin.json')).version;
      const inventory=state.cacheInventory?.find(record=>sameDirectory(record.directory,value.directory)),native=inventory?.nativeVersion??null,lag=native!==null&&native!==version;
      return{...value,cacheVersion:version??null,nativeVersionAtUpdate:native,inventoryObservedAt:inventory?.observedAt??null,nativeInventoryLag:lag,...(lag?{notice:`上次更新时原生插件清单显示 nxbridge ${native}，插件文件实际是 ${version}（只同步了文件）；不影响使用，想对齐时再执行一次 nxbridge update（需插件已启用，且本次安装已登记的 Codex 进程均已退出）。`}:{})};
    });
  }catch{return[];}
}
