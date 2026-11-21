import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import {atomicJson,readJson,sameDirectory} from '../shared/files.js';
import {bridgeHome} from '../shared/local-paths.js';
import {CLI_PATH,PACKAGE_ROOT,COLLABORATION_GUIDE_PATH} from '../shared/package-location.js';
import {delay} from '../shared/time.js';
import {ensureHome} from '../ipc/home.js';
import {loadConfig} from '../config/load.js';
import {privateDirectory} from '../process/permissions.js';
import {runCli} from '../process/host-command.js';
import {BridgeError,describeError} from '../shared/errors.js';
import {type Host} from '../types.js';
import { commandKey, homeKey, launchMetadata, selectHostLaunch } from '../hosts/host-launch.js';
import { chooseUserProfile } from '../hosts/launch-profiles.js';
import { managedRuntimes, managedRuntimeState } from '../hosts/managed-runtimes.js';
import { ensureConfiguration, writeConfiguration } from '../config/configuration.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { pruneProcessOwnership, releaseOwnedOfflineStatus } from '../process/process-cleanup.js';
import { brokerCall } from '../ipc/ipc.js';
import { removeInstalledWrappers, updateInstalledWrappers } from '../hosts/shell.js';
import { cacheBelongsTo, installedCacheDirectories, inside, markMarketplace, ownsMarketplace, planShim, recoverManagedFiles, removeManagedFiles, type ManagedFile } from './installation.js';
import { liveProcess, processIdentity } from '../process/process.js';
import { knownNativeProcesses } from '../process/native-processes.js';
import { processRegistryRoot } from '../process/owned-processes.js';
import { reserveBrokerStartup, type StartupReservation } from '../broker/broker-startup.js';
import { activeRuntime, fileHashes, ownsRuntime, pointerDetails, pruneRuntimes, publishSource, runtimeEntriesChanged, runtimeManifest, stageRuntime, verifyPublish, type InstallReceipt } from './runtime-install.js';
import { managedMarker } from './installation.js';
import { probeClaudeBackground, saveClaudeBackground } from '../hosts/claude/claude-capability.js';
import { platformCompatibility, versionCompatibility, requireCodexVersion } from './compatibility.js';
import { hostControlFailure } from '../hosts/host-control.js';
import { commitActivation, commitCache, recoverSetup } from './setup-journal.js';
import { pruneRetainedCodexCaches, recoverRetainedCaches, withRetainedCodexCaches } from './plugin-cache-retention.js';
import { atomicWriteFile } from '../storage/atomic-file.js';
import { processRegistryDirectory } from '../process/owned-processes.js';
import { verifyBackgroundContext } from '../hosts/background-preflight.js';
import { claudeLaunchPrerequisite } from '../hosts/claude/claude-autonomy.js';
import { windowsHookIdentityHelper, withWindowsIdentityHome } from '../process/windows/windows-hook-identity.js';
import { registerTestDirectory } from '../process/test-processes.js';

export const MARKETPLACE='nxbridge-local';
                                        
const pluginInventoryArgs=(host:Host)=>['plugin','list','--json',...(host==='codex'?['--marketplace',MARKETPLACE]:[])];
interface ConfigChange {keyPath:string;before:unknown;after:unknown}
interface PendingSetup {runtimeDirectory:string;buildId:string;source:string;binDirectory:string|null;commands?:Partial<Record<Host,string[]|null>>;hostHomes:Record<Host,string>;requestedHomes?:Partial<Record<Host,string>>}
interface SetupState {version:1;changes:ConfigChange[];claudeInstalled:boolean;codexInstalled:boolean;marketplace:string;claudeMarketplace?:boolean;codexMarketplace?:boolean;disabled?:boolean;managedFiles?:ManagedFile[];cacheDirectories?:{host:Host;directory:string}[];cacheInventory?:{host:Host;directory:string;nativeVersion:string|null;observedAt:string}[];hostHomes?:Record<Host,string>;pendingSetup?:PendingSetup}
export interface SetupServices {
  run:(host:Host,args:string[])=>Promise<string>;
  control:typeof configClient;
  broker:typeof brokerCall;
  codexDirectory:string;
  claudeDirectory:string;
  binDirectories:string[];
  pathValue:string;
  nodeVersion:string;
  entry:string;
                                          
  nativeProcesses:()=>Promise<{pid:number;startedAt:string}[]>;
  backgroundPreflight:(home:string)=>Promise<void>;
  checkpoint?:(step:string)=>void;
}
const freshState=(home:string):SetupState=>({version:1,changes:[],claudeInstalled:false,codexInstalled:false,marketplace:path.join(home,'marketplace')});
const servicesFor=(home:string,input:Partial<SetupServices>,config=loadConfig(home))=>{
                                           
  let codexDirectory=input.codexDirectory,claudeDirectory=input.claudeDirectory;
  return{run:(host:Host,args:string[])=>runCli(host,args,{config,home,timeout:30000}),control:()=>configClient(config,home),broker:brokerCall,nodeVersion:process.versions.node,entry:CLI_PATH,nativeProcesses:()=>knownNativeProcesses(home,'codex',codexDirectory??selectHostLaunch('codex',config,{home}).configHome),backgroundPreflight:verifyBackgroundContext,...input,
    get codexDirectory(){return codexDirectory??=selectHostLaunch('codex',config,{home}).configHome;},set codexDirectory(value:string){codexDirectory=value;},
    get claudeDirectory(){return claudeDirectory??=selectHostLaunch('claude',config,{home}).configHome;},set claudeDirectory(value:string){claudeDirectory=value;},
  };
};
const items=(raw:string):any[]=>{const value=JSON.parse(raw);return Array.isArray(value)?value:value.marketplaces??value.plugins??value.installed??value.data??[];};
const ownedPlugin=(value:any)=>value.id===`nxbridge@${MARKETPLACE}`||value.pluginId===`nxbridge@${MARKETPLACE}`||value.name===`nxbridge@${MARKETPLACE}`||value.name==='nxbridge'&&(value.marketplace===MARKETPLACE||value.marketplaceName===MARKETPLACE);
const pluginPresent=(values:any[])=>values.some(value=>ownedPlugin(value)&&value.installed!==false);
const marketplaceSource=(value:any)=>value?.source?.path??value?.source?.source?.path??value?.path??value?.root??value?.installLocation;
const alreadyGone=(error:unknown)=>/not found|not installed|不存在|未安装|unknown marketplace/i.test(describeError(error));
function legacyMarketplace(root:string,home:string):boolean{
  try{return sameDirectory(readJson<{home:string}>(path.join(root,'plugins','codex','runtime.json')).home,home)&&readJson<{name:string}>(path.join(root,'.agents','plugins','marketplace.json')).name===MARKETPLACE;}catch{return false;}
}
function ownedMarketplace(root:string,home:string,state?:SetupState):boolean{
  return ownsMarketplace(root,home)||legacyMarketplace(root,home)||!!state&&sameDirectory(state.marketplace,root);
}
function assertMarketplace(home:string,state?:SetupState):void{
  const root=path.join(home,'marketplace');
  if(existsSync(root)&&readdirSync(root).length&&!ownedMarketplace(root,home,state))throw new BridgeError('marketplace_conflict',`${root} 已有非 nxbridge 管理的内容，未覆盖。`);
}

const object=(value:unknown):Record<string,any>=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,any>:{};
const feature=(value:unknown):Record<string,any>=>typeof value==='boolean'?{enabled:value}:object(value);
const append=(value:unknown,name:string):string[]=>[...new Set([...(Array.isArray(value)?value.filter(v=>typeof v==='string'):[]),name])];
const equal=(a:unknown,b:unknown)=>a!==undefined&&isDeepStrictEqual(JSON.parse(JSON.stringify(a)),b);

export function namespaceChanges(config:Record<string,any>):ConfigChange[]{
  const features=object(config.features),names=feature(features.non_prefixed_mcp_tool_names),code=feature(features.code_mode);
  return[
    {keyPath:'features.non_prefixed_mcp_tool_names',before:features.non_prefixed_mcp_tool_names??null,after:{...names,enabled:true,...(names.enabled===true&&names.server_names===undefined?{}:{server_names:append(names.server_names,'claude')})}},
    {keyPath:'features.code_mode',before:features.code_mode??null,after:{...code,direct_only_tool_namespaces:append(code.direct_only_tool_namespaces,'claude')}},
  ];
}

export async function preparePlugins(home=bridgeHome(),options:{packageRoot?:string;launcher?:string}={}):Promise<string>{
  await ensureHome(home,true);
  if(process.platform==='win32'&&existsSync(processRegistryRoot())){
    await privateDirectory(processRegistryRoot(),true);
    const ownRegistry=processRegistryDirectory(home);if(existsSync(ownRegistry))await privateDirectory(ownRegistry,true,true);
  }
  const root=path.join(home,'marketplace');
  const stateFile=path.join(home,'setup-state.json');assertMarketplace(home,existsSync(stateFile)?readJson<SetupState>(stateFile):undefined);
  mkdirSync(root,{recursive:true});markMarketplace(root,home);
  for(const host of['claude','codex'] as const){
    const target=path.join(root,'plugins',host);
    const source=path.join(options.packageRoot??PACKAGE_ROOT,'plugins',host),files=new Map(Object.keys(fileHashes(source)).map(file=>[file,readFileSync(path.join(source,file))]));
    const json=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
    files.set('skills/partner/references/collaboration.md',readFileSync(options.packageRoot?path.join(options.packageRoot,'nxbridge-collaboration.md'):COLLABORATION_GUIDE_PATH));
    files.set('runtime.json',json({node:process.execPath,entry:options.launcher??CLI_PATH,home,...(options.launcher?{launcher:options.launcher}:{})}));
    const mcp=JSON.parse(files.get('.mcp.json')!.toString('utf8'));
    const server=mcp.mcpServers[host==='codex'?'claude':'codex'];
    server.command=process.execPath;
    server.args[0]=path.join(target,'bridge.cjs');
    files.set('.mcp.json',json(mcp));
    const previous=existsSync(target)?fileHashes(target):{};
                                                   
    for(const [file,content] of files){
      const destination=path.join(target,file);
      if(existsSync(destination)&&readFileSync(destination).equals(content))continue;
      mkdirSync(path.dirname(destination),{recursive:true});atomicWriteFile(destination,content);
    }
    for(const file of Object.keys(previous))if(!files.has(file))unlinkSync(path.join(target,file));
  }
  mkdirSync(path.join(root,'.agents','plugins'),{recursive:true});
  atomicJson(path.join(root,'.agents','plugins','marketplace.json'),{name:MARKETPLACE,plugins:[{name:'nxbridge',source:{source:'local',path:'./plugins/codex'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]});
  mkdirSync(path.join(root,'.claude-plugin'),{recursive:true});
                                             
  const version=readJson<{version:string}>(path.join(root,'plugins','claude','.claude-plugin','plugin.json')).version;
  atomicJson(path.join(root,'.claude-plugin','marketplace.json'),{name:MARKETPLACE,owner:{name:'nxbridge'},plugins:[{name:'nxbridge',source:'./plugins/claude',description:'Claude 与 Codex 的平等搭档通信',version}]});
  ensureConfiguration(home);
  return root;
}

                                                           
                                                                                           
                                                             
export interface CodexUpdateTargets {owned:{id:string;name:string}[];user:{name:string;sessionId?:string}[]}
                                                        
function codexReloadSteps(targets?:CodexUpdateTargets):string[]{
  if(!targets)return['nxbridge 后台的 Codex：等它空闲后，在 Codex 之外的终端执行 nxbridge restart codex（有多组配对时加 --member <成员ID>，成员 ID 见 nxbridge status）。你自己开的 Codex 窗口：新开会话，或退出后用原会话 ID 恢复。正在运行的 Codex 会话在这之前一直用旧版的工具和技能。'];
  const owned=targets.owned.map(peer=>`「${peer.name}」：nxbridge restart codex --member ${peer.id}`);
  const user=targets.user.map(peer=>peer.sessionId?`「${peer.name}」：退出后运行 codex resume ${peer.sessionId}`:`「${peer.name}」：退出后用原会话 ID 恢复`);
  return[
    ...(owned.length?['nxbridge 后台的 Codex：等它空闲后，在 Codex 之外的终端执行（完成前不要关闭终端）：'+owned.join('；')+'。']:[]),
    ...(user.length?['你自己开的 Codex 窗口：空闲时新开会话或恢复原会话，才会用上新的工具和技能：'+user.join('；')+'。']:[]),
  ];
}
function updateGuidance(reloadRequired:Record<Host,boolean>,hookTrustRequired?:boolean,codexTargets?:CodexUpdateTargets):{next:string[];notice:string}{
  const trust=hookTrustRequired===true?'Codex：nxbridge 的 hook 需要重新信任才会生效。在使用同一配置目录的任意一个 Codex 窗口里打开 /hooks 确认一次即可；用了别的配置目录的 Codex 要分别确认。'
    :hookTrustRequired===undefined&&reloadRequired.codex?'Codex：如果 /hooks 里 nxbridge 的 hook 显示内容已变更，需要重新信任才会生效。在使用同一配置目录的任意一个 Codex 窗口里确认一次即可；用了别的配置目录的 Codex 要分别确认。':undefined;
  const next=[
    ...(reloadRequired.claude?['已打开的 Claude 窗口：空闲时会自动重新加载插件，也可以自己执行 /reload-plugins 立即生效；没能自动加载（如远程连接）时状态栏会提示。如在用 codex MCP 备用入口，再到 /mcp 重新连接。']:[]),
    ...(trust?[trust]:[]),
    ...(reloadRequired.codex?codexReloadSteps(codexTargets):[]),
  ];
  const base='更新完成，运行文件已复制到 nxbridge 私有目录，原工程目录可以移走或删除。';
  const notice=reloadRequired.claude||reloadRequired.codex?base+'插件内容有变化，已打开的窗口按下面的步骤操作后才会用上新版本。'
    :trust?base+'插件内容没有变化，但 Codex 里 nxbridge 的 hook 还没有重新信任，请按下面的步骤确认。'
    :base+'插件内容没有变化，已打开的 Claude 和 Codex 窗口不需要任何操作。';
  return{next,notice};
}

export async function setup(options:{home?:string;prepareOnly?:boolean;dryRun?:boolean;binDirectory?:string;from?:string;commands?:Partial<Record<Host,string[]|null>>;hostHomes?:Partial<Record<Host,string>>}={},input:Partial<SetupServices>={}):Promise<unknown>{
                                        
  const controlHome=options.dryRun&&!options.prepareOnly?mkdtempSync(path.join(tmpdir(),'nxbridge-preflight-')):undefined,created=new Set<string>();
  if(options.dryRun)for(const root of [options.home??bridgeHome(),...(controlHome?[controlHome]:[])])for(let directory=processRegistryDirectory(root);!existsSync(directory);directory=path.dirname(directory))created.add(directory);
  let result:unknown;
  try{
    if(controlHome){registerTestDirectory(controlHome);return result=await withWindowsIdentityHome(controlHome,()=>setupInner(options,input,controlHome));}
    return result=await setupInner(options,input);
  }
  finally{
                                              
    for(const directory of [...created].sort((a,b)=>b.length-a.length))try{rmdirSync(directory);}catch{                           }
    if(controlHome)try{rmSync(controlHome,{recursive:true,maxRetries:6,retryDelay:200});}catch(error){
      const note=`预检临时目录未能清理，已保留 ${controlHome}（可以手动删除）：${describeError(error)}`;
      if(result&&typeof result==='object'){const output=result as {notes?:string[]};(output.notes??=[]).push(note);}else process.stderr.write(note+'\n');
    }
  }
}

async function setupInner(options:NonNullable<Parameters<typeof setup>[0]>,input:Partial<SetupServices>,controlHome?:string):Promise<unknown>{
  const home=options.home??bridgeHome(),recoveredCaches=await recoverRetainedCaches(home,options.dryRun||options.prepareOnly),recoveryNotes=await recoverSetup(home,options.dryRun||options.prepareOnly),config=loadConfig(home);
  const statePath=path.join(home,'setup-state.json'),state:SetupState=existsSync(statePath)?readJson(statePath):freshState(home);
  const pending=state.pendingSetup;
  if(pending){
    if(options.dryRun||options.prepareOnly)throw new BridgeError('setup_recovery_pending',`检测到上次没装完的安装（${statePath}）。去掉 ${options.dryRun?'--dry-run':'--prepare-only'} 再运行一次同样的命令，就会接着装完；这次没有写入任何内容。`);
    const requested=options.from?publishSource(home,options.from).directory:undefined;
    if(requested&&!sameDirectory(requested,pending.source)&&!sameDirectory(requested,pending.runtimeDirectory)||options.binDirectory&&!sameDirectory(options.binDirectory,pending.binDirectory??'')||options.commands&&!isDeepStrictEqual(options.commands,pending.commands)||options.hostHomes&&!Object.entries(options.hostHomes).every(([host,value])=>sameDirectory(value!,pending.hostHomes[host as Host])))throw new BridgeError('setup_recovery_pending',`上次的安装还没完成（${statePath}）。先不带新选项再运行一次同样的命令把它装完，再按新的选项运行 setup。`);
    options={...options,binDirectory:pending.binDirectory??undefined,commands:pending.commands,hostHomes:pending.requestedHomes};
    recoveryNotes.push('已沿用中断前的发布版本和命令位置，继续完成安装。');
  }
  for(const host of ['codex','claude'] as const){const command=options.commands?.[host];if(command===null)delete config[commandKey(host)];else if(command!==undefined){if(!command.length||!command[0])throw new BridgeError('launch_command_invalid','自定义启动命令不能为空。');config[commandKey(host)]=command;}if(options.hostHomes?.[host])config[homeKey(host)]=path.resolve(options.hostHomes[host]!);}
                                        
  const installationConfig={...config};
  for(const host of ['codex','claude'] as const){const recorded=state.hostHomes?.[host];if(recorded&&!options.hostHomes?.[host])installationConfig[homeKey(host)]=recorded;}
  const services=servicesFor(home,input,installationConfig),root=path.join(home,'marketplace');
  if(pending?.binDirectory===null)services.binDirectories=[];
  if(options.prepareOnly){if(options.dryRun)return{dryRun:true,actions:[`生成 ${root} 下的插件文件`],notice:'未写入文件。'};return{prepared:true,marketplace:await preparePlugins(home),notice:'只生成 nxbridge 自有插件文件，没有修改两家 CLI 配置。'};}
  if(!/^(24|25|26)\./.test(services.nodeVersion))throw new BridgeError('node_version',`需要 Node.js 24～26（当前 ${services.nodeVersion}），未执行安装。`);
  try{await import('node:sqlite');}catch{throw new BridgeError('sqlite_missing','当前 Node.js 不支持 node:sqlite，未执行安装。');}
  if(!existsSync(services.entry))throw new BridgeError('runtime_missing','没有找到构建好的运行文件；请先运行 npm run build:publish，或用 --from 指定一个 publish 目录。');
  const installationFailure=(host:Host,error:unknown)=>{
    const code=error instanceof BridgeError?error.code:'launch_probe_unavailable',name=config[commandKey(host)]?.[0]??(host==='codex'?config.codexBinary:config.claudeBinary)??host;
    const cause=code==='launch_command_invalid'?'设置的启动命令格式无效':['launch_command_missing','cli_missing'].includes(code)?`找不到程序 ${name}`:code==='launch_profile_missing'?'程序或配置目录已不存在':describeError(error);
    const remedy=pending?`这次没有改动任何文件，上次没装完的安装保持原样。在 ${path.join(home,'config.toml')} 里加上下面两行，再运行同样的命令接着安装：\n[hosts.${host}]\nbinary = "<程序完整路径>"`:`还没有写入任何文件。用 --${host}-command <程序完整路径> 指定程序后，重新运行 setup。`;
    return new BridgeError(code,`setup 需要运行 ${host} 来登记插件，但${cause}。${remedy}`);
  };
                                       
  const selectedLaunches=input.run?undefined:Object.fromEntries((['codex','claude'] as const).map(host=>{
    try{return[host,selectHostLaunch(host,installationConfig,{home})];}catch(error){throw installationFailure(host,error);}
  }));
  if(selectedLaunches)services.run=(host,args)=>runCli(host,args,{config:installationConfig,home:controlHome??home,timeout:30000,launch:selectedLaunches[host]});
  if(controlHome&&!input.control)services.control=value=>configClient(value,controlHome,selectedLaunches?.codex??selectHostLaunch('codex',value,{home}));
                                                  
  const versions=await Promise.all((['claude','codex'] as const).map(async host=>{
    try{return{host,version:(await services.run(host,['--version'])).trim()};}catch(error){throw installationFailure(host,error);}
  }));
  requireCodexVersion(versions.find(value=>value.host==='codex')!.version);
  if(process.platform==='win32'&&!input.run&&!options.dryRun)await windowsHookIdentityHelper(home,30000,true);
  const versionNotes=versions.filter(({host,version})=>config[commandKey(host)]&&versionCompatibility(host,version).status==='unrecognized').map(({host})=>`自定义 ${host} 命令的版本输出无法识别；本次安装以必需能力检查结果为准。`);
  assertMarketplace(home,existsSync(statePath)?state:undefined);
  const preflightFailure=(host:Host,capability:string,error:unknown)=>{const version=versions.find(value=>value.host===host)!.version,compatibility=versionCompatibility(host,version);return new BridgeError('preflight_failed',`${host} ${version} 的必需能力 ${capability} 未通过；${compatibility.notice}\n${describeError(error)}`);};
  const control=await services.control(installationConfig).catch(error=>{throw preflightFailure('codex','App Server initialize',error);});let effective:Record<string,any>,requirements:any;
  try{const reads=await Promise.all([control.request('config/read',{includeLayers:true,cwd:process.cwd()}),control.request('configRequirements/read',{})]).catch(error=>{throw preflightFailure('codex','config/read 或 configRequirements/read',error);});effective=reads[0].config??{};requirements=reads[1].requirements;
    const userLayer=reads[0].layers?.find((layer:any)=>layer.name?.type==='user'&&typeof layer.name.file==='string');
    if(!input.codexDirectory&&userLayer)services.codexDirectory=path.dirname(userLayer.name.file);
    if(installationConfig.codexCommand&&!installationConfig.codexHome&&!input.codexDirectory&&!userLayer&&!chooseUserProfile(home,'codex',process.cwd()).profile)throw new BridgeError('launch_home_unknown','无法确认自定义 Codex 命令使用的配置目录；请用 --codex-home 指定。');
  }finally{await control.close();}
  const configFile=path.join(services.codexDirectory,'config.toml'),current=existsSync(configFile)?parse(readFileSync(configFile,'utf8')) as Record<string,any>:{};
  if(current.mcp_servers?.claude)throw new BridgeError('namespace_conflict','用户已配置名为 claude 的 MCP 服务，不能覆盖。请先处理命名冲突。');
  let shim=planShim(home,{directories:options.binDirectory?[options.binDirectory]:services.binDirectories,pathValue:services.pathValue,entry:services.entry});
                                               
  for(const file of state.managedFiles??[])if(existsSync(file.file)&&readFileSync(file.file,'utf8')!==file.content)throw new BridgeError('managed_file_modified',`${file.file} 被改动过，未覆盖；确认不需要这些改动后删除该文件，再重新执行 setup。`);
  const inventories=await Promise.all((['claude','codex'] as const).map(async host=>{
    const version=versions.find(value=>value.host===host)!.version;
    const readInventory=async(args:string[])=>{let raw:string|undefined;try{raw=await services.run(host,args);const result=items(raw);if(!Array.isArray(result))throw Error('返回内容不是清单数组');return result;}catch(error){throw preflightFailure(host,args.join(' '),raw===undefined?error:hostControlFailure(host,args,{code:0,stdout:raw,detail:describeError(error)}));}};
    const marketplaces=await readInventory(['plugin','marketplace','list','--json']),plugins=await readInventory(pluginInventoryArgs(host));
    if(host==='claude'&&!input.claudeDirectory&&!installationConfig.claudeHome&&!chooseUserProfile(home,'claude',process.cwd()).profile){const installed=plugins.find(value=>ownedPlugin(value)&&typeof value.installPath==='string');if(installed)services.claudeDirectory=path.resolve(installed.installPath,'../../../../..');else if(config.claudeCommand)throw new BridgeError('launch_home_unknown','还不能确认自定义 Claude 命令使用的配置目录；请用它正常打开一次 Claude 窗口让 nxbridge 记录，或用 --claude-home 指定。');}
    const existing=marketplaces.find(value=>value.name===MARKETPLACE);
    if(existing){
      const source=marketplaceSource(existing);
      if(typeof source!=='string'||!sameDirectory(source,root))throw new BridgeError('marketplace_conflict',`${host} 已有其他来源的 ${MARKETPLACE}，未覆盖。`);
    }
    return{host,version:version.trim(),marketplace:!!existing,installed:pluginPresent(plugins),plugins:plugins.filter(ownedPlugin)};
  }));
  const background=await probeClaudeBackground(args=>services.run('claude',args));
  const direct=effective.features?.code_mode_only_strict_3p_tools!==true&&current.features?.code_mode_only_strict_3p_tools!==true;
  if(direct&&requirements?.featureRequirements?.non_prefixed_mcp_tool_names===false)throw new BridgeError('namespace_policy_conflict','Codex 管理策略禁止 nxbridge 需要的命名空间设置，未执行安装；nxbridge 不会改动该策略，如需安装请联系策略管理员。');
  const source=pending?{directory:pending.runtimeDirectory,repair:false}:publishSource(home,options.from);
  for(const host of ['codex','claude'] as const){const cache=state.cacheDirectories?.find(value=>value.host===host),oldHome=state.hostHomes?.[host]??(cache?path.resolve(cache.directory,'../../../../..'):undefined),nextHome=host==='codex'?services.codexDirectory:services.claudeDirectory;if(oldHome&&state[host==='codex'?'codexInstalled':'claudeInstalled']&&!sameDirectory(oldHome,nextHome))throw new BridgeError('launch_home_changed',`${host} 的配置目录和安装时不同。为避免改乱另一套配置，请先执行 uninstall 卸载原安装，再对新目录执行 setup。`);}
  const launches=Object.fromEntries((['codex','claude'] as const).map(host=>{
    const configHome=host==='codex'?services.codexDirectory:services.claudeDirectory,version= inventories.find(value=>value.host===host)!.version;
    if(input.run)return[host,{method:'injected-test-services',configHome,versionProbe:version}];
    const launch=selectedLaunches![host]!,selectedConfigHome=launch.configHome;
    return[host,{...launchMetadata({...launch,configHome}),purpose:'installation-control',...(!sameDirectory(selectedConfigHome,configHome)?{selectedConfigHome}:{}),versionProbe:version,versionVerification:'probe-only',...(launch.profile?{capturedVersionDiffers:launch.profile.version.trim()!==version}:{})}];
  }));
                                            
  type RuntimeSelection=(ReturnType<typeof launchMetadata>&{purpose:string})|{error:string;code:string;missingHome?:string};
  const runtimeLaunches=Object.fromEntries((['codex','claude'] as const).map((host):[Host,RuntimeSelection]=>{
    try{return[host,{...launchMetadata(selectHostLaunch(host,config,{home})),purpose:'runtime-default'}];}
    catch(error){const missingHome=(error as {missingHome?:string})?.missingHome;return[host,{error:describeError(error),code:error instanceof BridgeError?error.code:'launch_selection_failed',...(missingHome?{missingHome}:{})}];}
  }));
  const runtimeNotes=[...versionNotes,...Object.entries(runtimeLaunches).flatMap(([host,launch])=>{
    if(!('error' in launch))return launch.notes;
    const key=config[commandKey(host as Host)]?'command':config[host==='codex'?'codexBinary':'claudeBinary']?'binary':config[homeKey(host as Host)]?'home':undefined;
    const name=config[commandKey(host as Host)]?.[0]??config[host==='codex'?'codexBinary':'claudeBinary']??host;
    const causes:Record<string,string>={launch_profile_missing:'记录的程序已不存在，同一安装渠道里也没有新版本',launch_command_missing:`找不到程序 ${name}`,cli_missing:`找不到程序 ${name}`,launch_command_invalid:'设置的启动命令格式无效',invalid_config:'原生配置无法解析',launch_image_ambiguous:'同一版本有多份程序，报出的版本或架构不一致'};
    const cause=launch.missingHome?`之前用的配置目录已不存在（${launch.missingHome}）`:causes[launch.code]??`默认启动入口无法解析（${launch.code}）`;
    const remedy=launch.missingHome?`把目录恢复到原位置；或者正常打开一次 ${host}，nxbridge 会记下新的配置目录；也可以在系统终端运行 nxbridge config set hosts.${host}.home <配置目录> 指定。`:key?`检查你设置的 hosts.${host}.${key}（运行 nxbridge config get hosts.${host}.${key} 查看）并改正。`:`在系统终端运行 nxbridge config set hosts.${host}.binary <程序完整路径>。`;
    return[`安装不受影响，但修好之前，nxbridge 没法在后台启动 ${host}：${cause}。${remedy}`];
  })];
  const claudeAutonomy=background.mode==='native'?claudeLaunchPrerequisite(services.claudeDirectory,process.cwd()):undefined;
  const preflight={requiredCapabilities:{passed:true,codex:['App Server initialize','config/read','configRequirements/read','plugin marketplace list','plugin list','命名空间策略'],claude:['plugin marketplace list','plugin list']},claudeBackground:background,...(claudeAutonomy?{claudeAutonomy}:{}),compatibility:{hosts:Object.fromEntries(versions.map(({host,version})=>[host,versionCompatibility(host,version)])),platform:platformCompatibility()},notice:'必需的只读能力检查通过；不调用模型，不证明已有窗口已加载插件或完整会话协议可用。'};
  const binPlan={directory:shim.directory,reason:shim.reason,command:shim.command,...(shim.notice?{notice:shim.notice}:{})};
  const actions=[`把 ${source.directory} 复制到 nxbridge 私有目录；保留当前版和上一版，仍在被运行中进程使用的旧版稍后再清理`,`准备 ${root} 下的插件文件`,`同步两端已安装插件；保留已有启用状态，不代为批准 hooks`,shim.directory?`安装自有命令 ${shim.files[0]!.file}`:shim.notice!,`Codex 配置中只更新 claude 命名空间相关的设置`,`平滑重启 broker；现有会话和 App Server 不受影响`];
  if(options.dryRun){verifyPublish(source.directory);return{dryRun:true,actions,bin:binPlan,launches,runtimeLaunches,notes:runtimeNotes,preflight,claudeBackground:background,versions,notice:'仅预览，没有写入文件、配置或停止进程。'};}
  const previousRuntime=activeRuntime(home),previousManifest=previousRuntime?runtimeManifest(previousRuntime.directory):undefined;
  const candidate=await stageRuntime(home,source.directory),launcher=path.join(home,'bin','nxbridge.cjs');
  if(pending&&candidate.buildId!==pending.buildId)throw new BridgeError('setup_recovery_conflict',`${pending.runtimeDirectory} 的发布版本已改变，未切换中断前选定的运行时。请恢复原版本后再运行一次同样的命令。`);
  const entryChanged=(names:string[])=>!!previousRuntime&&runtimeEntriesChanged(previousManifest,candidate,names);
  if(pending)candidate.source=pending.source;
  state.hostHomes={codex:services.codexDirectory,claude:services.claudeDirectory};
  shim=planShim(home,{directories:options.binDirectory?[options.binDirectory]:services.binDirectories,pathValue:services.pathValue,entry:candidate.entry,runtime:pointerDetails(home,candidate)});
  state.pendingSetup={runtimeDirectory:candidate.directory,buildId:candidate.buildId,source:candidate.source,binDirectory:shim.directory,commands:options.commands,hostHomes:state.hostHomes,requestedHomes:options.hostHomes};
  atomicJson(statePath,state);services.checkpoint?.('plan');
  if(options.commands||options.hostHomes)writeConfiguration(home,(['codex','claude'] as const).flatMap(host=>[...(options.commands?.[host]!==undefined?[{key:`hosts.${host}.command`,value:options.commands[host]??undefined}]:[]),...(options.hostHomes?.[host]?[{key:`hosts.${host}.home`,value:path.resolve(options.hostHomes[host]!)}]:[])]),'setup');
  await preparePlugins(home,{packageRoot:candidate.directory,launcher});state.disabled=false;state.marketplace=root;atomicJson(statePath,state);
  services.checkpoint?.('prepared');
  const notes:string[]=[...recoveryNotes,...runtimeNotes,...(source.repair?['原来的安装来源已经不在了，这次用私有目录里已安装的版本做修复；要升级，请用 --from 指定新的 publish 目录。']:[])],updates:unknown[]=[],reloadRequired={claude:false,codex:false};
  if(background){saveClaudeBackground(home,config,background);if(background.notice)notes.push(background.notice);}
  for(const inventory of inventories){
    const {host}=inventory,marketKey=host==='claude'?'claudeMarketplace':'codexMarketplace',installedKey=host==='claude'?'claudeInstalled':'codexInstalled';
    const beforeHomes=[host==='codex'?services.codexDirectory:services.claudeDirectory,...inventory.plugins.filter(value=>typeof value.installPath==='string').map(value=>path.resolve(value.installPath,'../../../../..'))];
    const beforeDirectories=[...new Set(beforeHomes.flatMap(directory=>installedCacheDirectories(directory,host)))].filter(directory=>inventory.plugins.some(value=>value.installed!==false&&(typeof value.installPath==='string'?sameDirectory(value.installPath,directory):path.basename(directory)===value.version)));
    const preparedFiles=fileHashes(path.join(root,'plugins',host));
                                           
    reloadRequired[host]=entryChanged(host==='codex'?['mcp-entry.mjs']:['mod-entry.mjs','mcp-entry.mjs'])||!beforeDirectories.length||beforeDirectories.some(directory=>!isDeepStrictEqual(fileHashes(directory),preparedFiles));
    const targetVersion=readJson<{version:string}>(path.join(root,'plugins',host,host==='codex'?'.codex-plugin':'.claude-plugin','plugin.json')).version;
    const retainedCaches=[...recoveredCaches],installCodex=async()=>{
      const homes=[services.codexDirectory,...inventory.plugins.filter(value=>typeof value.installPath==='string').map(value=>path.resolve(value.installPath,'../../../../..'))];
      const result=await withRetainedCodexCaches(home,homes,targetVersion,()=>services.run('codex',['plugin','add',`nxbridge@${MARKETPLACE}`,'--json']));
      retainedCaches.push(...result.restored);
      if(result.restored.length)notes.push('已恢复旧版 Codex 插件缓存的原字节，升级前开始的轮次可继续使用；官方 add 执行期间仍有短暂路径切换窗口，下一轮任务会自动选择新版。');
      if(result.unretained.length)notes.push('local、同版本或更高版本的 Codex 缓存不能在原路径并存，否则会遮住目标版本；这些路径沿用官方替换行为，下一轮任务刷新。');
    };
    if(!inventory.marketplace){await services.run(host,['plugin','marketplace','add',root,...(host==='codex'?['--json']:[])]);}
    state[marketKey]=true;atomicJson(statePath,state);
    services.checkpoint?.('market:'+host);
    let mode='official-install';
    if(!inventory.installed){if(host==='codex')await installCodex();else await services.run(host,['plugin','install',`nxbridge@${MARKETPLACE}`]);}
    else if(host==='claude'){
      try{await services.run(host,['plugin','update',`nxbridge@${MARKETPLACE}`,'--json']);mode='official-update';}
      catch(error){notes.push(`Claude 官方更新未完成，将检查现有自有缓存：${describeError(error)}`);mode='file-sync-fallback';}
    }else{
      const records=inventory.plugins.filter(value=>value.installed!==false),versionChanged=records.some(value=>value.version!==targetVersion);
                                             
      let noKnownHosts=false,hostsUnknown=false;
      if(versionChanged&&records.every(value=>value.enabled===true))try{noKnownHosts=(await services.nativeProcesses()).length===0;}catch{hostsUnknown=true;                       }
      if(versionChanged&&records.every(value=>value.enabled===true)&&noKnownHosts){
        await installCodex();mode='official-update';
      }else{
        mode='file-sync-fallback';
        if(versionChanged)notes.push(records.every(value=>value.enabled===true)?(hostsUnknown?'无法核验本次安装已登记的 Codex 进程，只同步了插件文件；原生清单版本可能仍显示旧版，不影响使用，之后这些进程退出时再执行一次 nxbridge update 即可刷新。':'本次安装已登记的 Codex 进程仍在运行，为不打断它只同步了插件文件；原生清单版本可能仍显示旧版，不影响使用，之后这些进程退出时再执行一次 nxbridge update 即可刷新。'):'Codex 插件保持原有禁用或未确认的启用状态，只同步文件；原生清单版本可能仍显示旧版，启用后重新运行 update 可刷新。');
      }
    }
    const installed=items(await services.run(host,pluginInventoryArgs(host))).filter(ownedPlugin);
    if(!pluginPresent(installed))throw new BridgeError('plugin_registration_missing',`${host} 未报告 nxbridge 安装成功，保留安装记录以便修复。`);
    const homes=[host==='claude'?services.claudeDirectory:services.codexDirectory,...installed.filter(value=>typeof value.installPath==='string').map(value=>path.resolve(value.installPath,'../../../../..'))];
    let directories=[...new Set(homes.flatMap(directory=>installedCacheDirectories(directory,host)))];
    if(!directories.length)throw new BridgeError('installed_cache_missing',`${host} 没有可核验的 nxbridge 插件缓存；安装记录保留，可重新执行 setup 修复。`);
    const activeDirectories=host==='codex'?directories.filter(directory=>installed.some(value=>value.installed!==false&&(typeof value.installPath==='string'?sameDirectory(value.installPath,directory):path.basename(directory)===value.version))):directories;
    if(!activeDirectories.length)throw new BridgeError('installed_cache_missing',`${host} 没有可核验的活动插件缓存，保留旧目录以便修复。`);
    if(host==='codex'){
      const pruned=await pruneRetainedCodexCaches(home,directories,activeDirectories,retainedCaches,services.nativeProcesses);notes.push(...pruned.notes);directories=directories.filter(directory=>!pruned.removed.includes(directory));
    }
    for(const directory of activeDirectories){
      await commitCache(home,host,path.resolve(directory,'../../../../..'),path.join(root,'plugins',host),directory,services.checkpoint);
    }
    if(mode==='file-sync-fallback')notes.push(`${host} 使用自有缓存文件同步；未卸载再安装，保留已有启用状态，不修改 hooks 信任记录。`);
    const observedAt=new Date().toISOString(),cacheInventory=activeDirectories.map(directory=>({host,directory,nativeVersion:installed.find(value=>typeof value.installPath==='string'?sameDirectory(value.installPath,directory):path.basename(directory)===value.version)?.version??null,observedAt}));
    updates.push({host,mode,paths:activeDirectories,contentChanged:reloadRequired[host],cacheVersions:cacheInventory.map(value=>({...value,cacheVersion:targetVersion,nativeInventoryLag:value.nativeVersion!==null&&value.nativeVersion!==targetVersion})),...(host==='codex'?{retainedCaches:directories.filter(directory=>!activeDirectories.includes(directory))}:{})});state[installedKey]=true;state.cacheInventory=[...(state.cacheInventory??[]).filter(value=>value.host!==host),...cacheInventory];state.cacheDirectories=[...(state.cacheDirectories??[]).filter(value=>value.host!==host),...directories.map(directory=>({host,directory}))];atomicJson(statePath,state);
    services.checkpoint?.('cache-state:'+host);
  }
                                              
  let hookTrustRequired:boolean|undefined;
  const hookClient=await services.control(installationConfig).catch(()=>undefined);
  if(hookClient)try{
    const result=await hookClient.request('hooks/list',{cwds:[process.cwd()]},{timeout:12000});
    const hooks=(result.data??[]).flatMap((item:any)=>item.hooks??[]).filter((hook:any)=>hook.pluginId===`nxbridge@${MARKETPLACE}`);
    if(hooks.some((hook:any)=>['untrusted','modified'].includes(hook.trustStatus)))hookTrustRequired=true;
    else if(hooks.length&&hooks.every((hook:any)=>['trusted','managed'].includes(hook.trustStatus)))hookTrustRequired=false;
  }catch{                                     }
  finally{await hookClient.close();}
  if(direct){
    state.changes=namespaceChanges(current).map(change=>{const previous=state.changes.find(value=>value.keyPath===change.keyPath);return previous&&equal(change.before,previous.after)?previous:change;});atomicJson(statePath,state);
    services.checkpoint?.('namespace-state');
    const edits=state.changes.filter(change=>!equal(change.keyPath.split('.').reduce<any>((value,key)=>value?.[key],current),change.after)).map(change=>({keyPath:change.keyPath,value:change.after,mergeStrategy:'replace'}));
    if(edits.length){const client=await services.control(loadConfig(home));try{await client.request('config/batchWrite',{edits,filePath:configFile},{mutation:true});}finally{await client.close();}}
  }
  const newFiles=[...shim.launcher,...shim.files],obsolete=(state.managedFiles??[]).filter(file=>!newFiles.some(value=>sameDirectory(value.file,file.file)));
  const receipt:InstallReceipt={owner:managedMarker(home),buildId:candidate.buildId,roots:[root,...(state.cacheDirectories??[]).map(cache=>cache.directory)].map(directory=>({directory,files:fileHashes(directory)}))};
  await commitActivation(home,state,newFiles,receipt,services.checkpoint);
  const cleaned=removeManagedFiles(obsolete,home);notes.push(...cleaned.notes);state.managedFiles=[...newFiles,...cleaned.remaining];delete state.pendingSetup;atomicJson(statePath,state);
  services.checkpoint?.('obsolete-state');
  if(shim.notice)notes.push(shim.notice);
  notes.push(...updateInstalledWrappers(home).notes);
  let brokerRestarted=false;
  let releaseStartup:StartupReservation|undefined;
  try{
                                                
    if(process.platform==='win32'){await services.backgroundPreflight(home);releaseStartup=await reserveBrokerStartup(home,await processIdentity(process.pid));}
    const before=await services.broker<{pid:number;runtime?:{generation:string}}>('ping',{}, {home,start:false});
    await services.broker('shutdown',{releaseOwned:false,...(releaseStartup?{startupToken:releaseStartup.token}:{}),expectedBroker:{pid:before.pid,generation:before.runtime?.generation}},{home,start:false,mutation:true,timeout:60000});
    const end=Date.now()+15000;while(liveProcess(before.pid)){if(Date.now()>end)throw new BridgeError('broker_stop_timeout','broker 尚未退出，未启动第二个实例。');await delay(50);}
    await releaseStartup?.assertCurrent();
    await services.broker('ping',{}, {home,...(releaseStartup?{reserved:true}:{})});brokerRestarted=true;
  }catch(error){if(!['ENOENT','ECONNREFUSED','EPIPE'].includes((error as NodeJS.ErrnoException).code??''))notes.push('broker 更新状态：'+describeError(error));}
  finally{await releaseStartup?.();}
  const runtimes=await pruneRuntimes(home);notes.push(...runtimes.notes);
  if(process.platform==='win32'){
    let independent=false;try{independent=(await services.broker<{runtime?:{windowsIndependent?:boolean}}>('ping',{}, {home,start:false})).runtime?.windowsIndependent===true;}catch{}
    if(!independent)notes.push('已安装。多组配对所需的独立后台还没启动：请在普通 PowerShell 运行 nxbridge bootstrap。');
  }
  let codexTargets:CodexUpdateTargets|undefined;
  if(reloadRequired.codex)try{
    const status=await services.broker<{peers:{id:string;host:Host;name:string;owner:string;kind:string;enabled?:boolean;sessionId?:string}[];endpoints:{peerId:string;active:boolean;pendingContext?:boolean}[]}>('status',{}, {home,start:false});
    const affected=status.peers.filter(peer=>peer.host==='codex'&&peer.kind==='root'&&peer.enabled!==false&&status.endpoints.some(endpoint=>endpoint.peerId===peer.id&&endpoint.active&&!endpoint.pendingContext));
    codexTargets={owned:affected.filter(peer=>peer.owner==='nxbridge').map(({id,name})=>({id,name})),user:affected.filter(peer=>peer.owner==='user').map(({name,sessionId})=>({name,...(sessionId?{sessionId}:{})}))};
  }catch{                                    }
  const guidance=updateGuidance(reloadRequired,hookTrustRequired,codexTargets);
  if(claudeAutonomy?.message){guidance.next.push(claudeAutonomy.message);guidance.notice+=' 新建后台 Claude 还有以下原生前置条件。';}
  return{installed:true,marketplace:root,command:shim.command,bin:binPlan,runtime:activeRuntime(home),retainedRuntimes:runtimes,launches,runtimeLaunches,versions,preflight,compatibility:preflight.compatibility,updates,reloadRequired,hookTrustRequired:hookTrustRequired??null,brokerRestarted,toolMode:direct?'direct-namespace':'policy-controlled-mcp',notes,...guidance};
}

export async function uninstall(home=bridgeHome(),options:{dryRun?:boolean;purge?:boolean}={},input:Partial<SetupServices>={}):Promise<unknown>{
  await recoverRetainedCaches(home,options.dryRun);
  const recoveryNotes=await recoverSetup(home,options.dryRun);
  const filename=path.join(home,'setup-state.json'),recorded=existsSync(filename);
  const selfInstalled=ownsRuntime(home,PACKAGE_ROOT),sourcePath=existsSync(PACKAGE_ROOT)?realpathSync.native(PACKAGE_ROOT):path.resolve(PACKAGE_ROOT);
  const state:SetupState=recorded?readJson(filename):freshState(home),root=path.join(home,'marketplace'),notes:string[]=[...recoveryNotes],failures:string[]=[],actions:string[]=[];
  const config=loadConfig(home);if(state.hostHomes){config.codexHome=state.hostHomes.codex;config.claudeHome=state.hostHomes.claude;}
  const services=servicesFor(home,{...(state.hostHomes?{codexDirectory:state.hostHomes.codex,claudeDirectory:state.hostHomes.claude}:{}),...input},config);
  const ownedRoot=ownedMarketplace(root,home,recorded?state:undefined);
  if(!recorded)state.managedFiles=recoverManagedFiles(home,services.pathValue);
  if(ownedRoot){
    for(const host of ['claude','codex'] as const){
      try{
        const [marketplaces,plugins]=await Promise.all([services.run(host,['plugin','marketplace','list','--json']),services.run(host,pluginInventoryArgs(host))]);
        const existing=items(marketplaces).find(value=>value.name===MARKETPLACE),source=marketplaceSource(existing);
        if(existing&&(typeof source!=='string'||!sameDirectory(source,root))){failures.push(`${host} 的同名市场已改变来源，保留当前安装。`);continue;}
        state[host==='claude'?'claudeInstalled':'codexInstalled']=pluginPresent(items(plugins));
        state[host==='claude'?'claudeMarketplace':'codexMarketplace']=!!existing;
        const homes=[host==='claude'?services.claudeDirectory:services.codexDirectory,...items(plugins).filter(ownedPlugin).filter(value=>typeof value.installPath==='string').map(value=>path.resolve(value.installPath,'../../../../..'))];
        const directories=[...new Set(homes.flatMap(directory=>installedCacheDirectories(directory,host)))];
        state.cacheDirectories=[...(state.cacheDirectories??[]).filter(value=>value.host!==host),...directories.map(directory=>({host,directory}))];
      }catch(error){notes.push(`${host} 安装清单读取失败，按已有记录处理：${describeError(error)}`);}
    }
  }
  for(const host of ['claude','codex'] as const){
    if(state[host==='claude'?'claudeInstalled':'codexInstalled'])actions.push(`卸载 ${host} 的 nxbridge 插件`);
    if(state[host==='claude'?'claudeMarketplace':'codexMarketplace'])actions.push(`移除 ${host} 的自有 ${MARKETPLACE} 市场`);
  }
  for(const cache of state.cacheDirectories??[])if(cacheBelongsTo(cache.directory,cache.host,home))actions.push(`删除 ${cache.host} 的自有缓存 ${cache.directory}`);
  actions.push('停止 broker，仅回收可核验的自有后台运行时','恢复仍与安装记录一致的命名空间配置','移除未改动的自有命令与 shell wrapper');
  actions.push('删除已无活 broker 引用的自有版本目录');
  if(ownedRoot)actions.push(`删除自有插件目录 ${root}`);
  if(options.purge)actions.push(`清除 nxbridge 私有目录 ${home}；不删除两端原生会话历史`);
  if(options.dryRun)return{dryRun:true,purge:options.purge??false,actions,notes,failures,notice:'仅预览；没有写入配置、删除文件或停止进程。'};
  const save=()=>atomicJson(filename,state);
  if(recorded||ownedRoot||existsSync(path.join(home,'run','token'))){state.disabled=true;delete state.pendingSetup;save();}
  let stopped=true;
  try{
    const identity=await services.broker<{pid:number;runtime?:{generation:string}}>('ping',{}, {home,start:false});
    const result=await services.broker<{notes:string[]}>('shutdown',{releaseOwned:true,reason:'uninstall',expectedBroker:{pid:identity.pid,...(identity.runtime?.generation?{generation:identity.runtime.generation}:{})}},{home,start:false,mutation:true,timeout:60000});notes.push(...result.notes);
    const end=Date.now()+15000;while(liveProcess(identity.pid)){if(Date.now()>end){stopped=false;failures.push('broker 尚未退出。');break;}await delay(50);}
  }catch(error){if(!['ENOENT','ECONNREFUSED','EPIPE'].includes((error as NodeJS.ErrnoException).code??'')){stopped=false;failures.push('停止 broker 失败：'+describeError(error));}}
  try{const fallback=await releaseOwnedOfflineStatus(home,config,{purge:options.purge});notes.push(...fallback.notes);if(fallback.pending)stopped=false;}catch(error){stopped=false;failures.push('自有进程离线回收未完成：'+describeError(error));}
  for(const host of ['codex','claude'] as const){
    if(failures.some(value=>value.startsWith(host+' 的同名市场')))continue;
    const installed=host==='claude'?'claudeInstalled':'codexInstalled',market=host==='claude'?'claudeMarketplace':'codexMarketplace';
    for(const [key,args] of [[installed,['plugin',host==='claude'?'uninstall':'remove',`nxbridge@${MARKETPLACE}`]],[market,['plugin','marketplace','remove',MARKETPLACE]]] as const){
      if(!state[key]||key===market&&state[installed])continue;
      try{await services.run(host,[...args]);state[key]=false;save();}
      catch(error){if(alreadyGone(error)){state[key]=false;save();}else failures.push(`${host} ${args.join(' ')}：${describeError(error)}`);}
    }
  }
  if(!state.codexInstalled&&state.changes.length){
    try{
      const configFile=path.join(services.codexDirectory,'config.toml'),current=existsSync(configFile)?parse(readFileSync(configFile,'utf8')) as Record<string,any>:{},edits=[];
      for(const change of state.changes){
        const value=change.keyPath.split('.').reduce<any>((parent,key)=>parent?.[key],current);
        if(equal(value,change.after)){
                                             
          if(typeof change.before==='boolean')edits.push({keyPath:change.keyPath,value:null,mergeStrategy:'replace'});
          edits.push({keyPath:change.keyPath,value:change.before,mergeStrategy:'replace'});
        }else notes.push(`${change.keyPath} 已被用户修改，保留当前值。`);
      }
      if(edits.length){const client=await services.control(loadConfig(home));try{await client.request('config/batchWrite',{edits,filePath:configFile},{mutation:true});}finally{await client.close();}}
      state.changes=[];save();
    }catch(error){failures.push('恢复命名空间配置失败：'+describeError(error));}
  }
  const remainingCaches:NonNullable<SetupState['cacheDirectories']>=[];
  for(const cache of state.cacheDirectories??[]){
    if(!existsSync(cache.directory))continue;
    const installed=cache.host==='claude'?state.claudeInstalled:state.codexInstalled;
    if(installed||failures.some(value=>value.startsWith(cache.host+' 的同名市场'))||!cacheBelongsTo(cache.directory,cache.host,home)){remainingCaches.push(cache);continue;}
    try{rmSync(cache.directory,{recursive:true,force:true});}catch(error){remainingCaches.push(cache);failures.push(`删除 ${cache.host} 自有缓存失败：${describeError(error)}`);}
  }
  state.cacheDirectories=remainingCaches;
  let wrappers:{removed:string[];notes:string[]}={removed:[],notes:[]};
  try{wrappers=removeInstalledWrappers(home);notes.push(...wrappers.notes);}catch(error){wrappers.notes.push('shell wrapper 记录无法读取，保留现有文件。');failures.push('清理 shell wrapper 失败：'+describeError(error));}
  const allRemoved=!state.claudeInstalled&&!state.codexInstalled&&!state.claudeMarketplace&&!state.codexMarketplace;
  if(!allRemoved&&(recorded||ownedRoot))save();
  let managed={removed:[] as string[],notes:[] as string[],remaining:state.managedFiles??[]};
  if(allRemoved){managed=removeManagedFiles(state.managedFiles??[],home);state.managedFiles=managed.remaining;notes.push(...managed.notes);if(recorded||ownedRoot)save();if(ownedRoot)try{rmSync(root,{recursive:true,force:true});}catch(error){failures.push('删除自有插件目录失败：'+describeError(error));}}
  if(allRemoved&&stopped)try{
    const cleanup=await pruneRuntimes(home,true);notes.push(...cleanup.notes);
    if(cleanup.protected.length)failures.push('仍有活 broker 引用旧运行代码，版本目录暂时保留。');
    else if(existsSync(path.join(home,'install-manifest.json')))rmSync(path.join(home,'install-manifest.json'));
  }catch(error){failures.push('清理自有运行代码失败：'+describeError(error));}
  const processes=await pruneProcessOwnership(home,options.purge??false);notes.push(...processes.notes);if(processes.notes.length)stopped=false;
  let purged=false;
  if(options.purge){
    let runtimePending=true;
    try{runtimePending=(await Promise.all(managedRuntimes(home).map(record=>managedRuntimeState(home,record.value)))).some(state=>state!=='dead');}catch(error){notes.push('托管运行时记录无法核验，保留私有目录：'+describeError(error));}
    if(!stopped||failures.length||!allRemoved||managed.remaining.length||remainingCaches.length||wrappers.notes.length||runtimePending)failures.push('还有未完成的清理或仍在运行的进程，私有目录暂不删除；处理后可重新执行 uninstall --purge。');
    else if(!recorded&&!ownedRoot||path.dirname(path.resolve(home))===path.resolve(home)||sameDirectory(home,homedir())||sameDirectory(home,process.cwd())||inside(home,PACKAGE_ROOT)&&!selfInstalled)failures.push('无法确认该目录是 nxbridge 独立使用的私有目录，未删除。');
    else{
      const target=realpathSync.native(home),source=sourcePath,cwd=realpathSync.native(process.cwd());
      if(sameDirectory(target,homedir())||sameDirectory(target,cwd)||sameDirectory(target,source)||inside(target,source)&&!selfInstalled||inside(target,cwd))failures.push('私有目录实际指向工作目录或用户目录，未删除。');
      else try{rmSync(target,{recursive:true,force:true});purged=true;}catch(error){failures.push('清除私有目录失败：'+describeError(error));}
    }
  }
  return{removed:allRemoved&&failures.length===0,wrappers,files:managed.removed,processes,purged,notes,failures,notice:options.purge&&purged?'已清除 nxbridge 私有数据；两端原生会话历史保留。':'nxbridge 的配置、配对账本和消息记录已保留；要一并清除，执行 uninstall --purge。'};
}
