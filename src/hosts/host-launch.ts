import path from 'node:path';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {atomicJson,sameDirectory} from '../shared/files.js';
import {bridgeHome} from '../shared/local-paths.js';
import {resolveCli,runCli,type Executable} from '../process/host-command.js';
import { chooseUserProfile, profileAvailability, profileMetadata, profileState, type LaunchProfile } from './launch-profiles.js';
import { cleanInstanceEnvironment, foregroundEnvironment, environmentPath, configHomeFor, loopbackProxyNames, neutralEnvironment, persistentEnvironment, referencedAuthEnvironment, type EnvironmentReport } from '../process/environment.js';
import {BridgeError} from '../shared/errors.js';
import {type BridgeConfig,type Host} from '../types.js';
import { redactCommand } from '../config/configuration.js';
import {claudeBackground} from './claude/claude-capability.js';
import { claudeLaunchPrerequisite } from './claude/claude-autonomy.js';
import { processOwnershipEnvironment } from '../process/owned-processes.js';
import { desktopHostImages, relaunchHostImage, verifyHostImage } from './host-image.js';
import { codexPackageEnvironment } from './codex/codex-package.js';
import { profileVersionSupported } from './host-version.js';
import { claudeLaunchArgs } from '../broker/profiles/profile-arguments.js';

export interface HostLaunch {host:Host;executable:Executable;configHome:string;cwd:string;env:NodeJS.ProcessEnv;method:'command'|'pin'|'paired-profile'|'profile'|'daemon'|'fallback';notes:string[];profile?:LaunchProfile;environment:EnvironmentReport;updatedFrom?:string;version?:string;selectionReason?:string;explicitExecutable?:boolean}
export interface HostLaunchOptions {cwd?:string;home?:string;baseline?:NodeJS.ProcessEnv;current?:NodeJS.ProcessEnv;sessionId?:string;configHome?:string;requesterSession?:string;executable?:string;profileId?:string;foreground?:boolean;record?:LaunchProfile;unobserved?:boolean}
export const homeKey=(host:Host)=>host==='codex'?'codexHome':'claudeHome';
const binaryKey=(host:Host)=>host==='codex'?'codexBinary':'claudeBinary';
export const commandKey=(host:Host)=>host==='codex'?'codexCommand':'claudeCommand';
export const sameHostImage=(first:string,second:string,host:Host)=>sameDirectory(first,second)||sameDirectory(relaunchHostImage(first,host),relaunchHostImage(second,host));
function missingLaunch(host:Host,kind:'exe'|'home'|'cwd',value:string):BridgeError{
  const pin=`在系统终端运行 nxbridge config set hosts.${host}.binary <程序完整路径>`;
  return new BridgeError('launch_profile_missing',kind==='exe'?`记录的 ${host} 程序已不存在：${value}，同一安装渠道里也没找到可用的新版本。重新安装或更新这个 ${host} 后会自动重试；要改用别的程序，${pin}。`:kind==='home'?`记录的 ${host} 配置目录已不存在：${value}。原会话的历史和设置都在这个目录里，不能换到别的目录接着跑；把它恢复到原位置后会自动重试。`:`原会话的项目目录已不存在：${value}。把目录恢复到原位置后会自动重试；不再需要这个会话的话，可以另选搭档。`);
}

function commandExecutable(argv:string[],env:NodeJS.ProcessEnv):Executable{
  const [name,...args]=argv;if(!name)throw new BridgeError('launch_command_invalid','自定义启动命令不能为空。');
  let file=name;
  if(!path.isAbsolute(file)&&!/[\\/]/.test(file)){
    const extensions=process.platform==='win32'?['.exe','.js','.mjs','.cjs','']:[''];
    const found=environmentPath(env).split(path.delimiter).filter(Boolean).flatMap(directory=>extensions.map(extension=>path.join(directory,file.toLowerCase().endsWith(extension.toLowerCase())?file:file+extension))).find(candidate=>existsSync(candidate));
    if(!found)throw new BridgeError('launch_command_missing',`在系统保存的 PATH 中找不到启动命令 ${name}；请改用完整的可执行文件路径。`);file=found;
  }
  const resolved=resolveCli('codex',path.resolve(file));return{command:resolved.command,prefix:[...resolved.prefix,...args]};
}

                                                          
export const codexTerminalVariables=['TERM_PROGRAM','TERM_PROGRAM_VERSION','GHOSTTY_RESOURCES_DIR','WEZTERM_VERSION','ITERM_SESSION_ID','ITERM_PROFILE','ITERM_PROFILE_NAME','KITTY_WINDOW_ID','ALACRITTY_SOCKET','KONSOLE_VERSION','GNOME_TERMINAL_SCREEN','VTE_VERSION','WT_SESSION','TERM','TMUX','TMUX_PANE','ZELLIJ','ZELLIJ_SESSION_NAME'] as const;

export function selectHostLaunch(host:Host,config:BridgeConfig,options:HostLaunchOptions={},state=profileState(options.home??bridgeHome())):HostLaunch{
  const home=options.home??bridgeHome(),cwd=path.resolve(options.cwd??process.cwd()),current=options.current??process.env,live=options.foreground?foregroundEnvironment(current):undefined,base=options.baseline??live?.env??persistentEnvironment();
  const observations=state.observations??[],matches=options.sessionId?observations.filter(value=>value.host===host&&value.sourceSession===options.sessionId&&(!options.configHome||sameDirectory(value.configHome,options.configHome))):[];
  const affinity=[...observations,...state.profiles].filter(value=>value.host===host&&(!options.configHome||sameDirectory(value.configHome,options.configHome))&&(!options.executable||sameHostImage(value.exe,options.executable,host)));
  const bound=options.record??(options.profileId?affinity.find(value=>value.id===options.profileId):matches.sort((a,b)=>b.capturedAt-a.capturedAt)[0]);
  const command=config[commandKey(host)],binary=config[binaryKey(host)],pinHome=config[homeKey(host)];
  const mismatch=options.record&&(options.record.host!==host||options.configHome&&!sameDirectory(options.record.configHome,options.configHome)||options.executable&&!sameHostImage(options.record.exe,options.executable,host));
  if(!command&&!binary&&(mismatch||options.profileId&&!bound&&!options.executable))throw new BridgeError('launch_profile_missing',`原来选定的 ${host} 启动记录和现在的配置目录或程序对不上，没有改用别的记录。在系统终端运行 nxbridge config set hosts.${host}.binary <程序完整路径> 指定程序；或者另选搭档。`);
  const picked=!command&&!binary&&!pinHome&&!options.unobserved?(options.foreground&&!options.sessionId&&!options.executable&&!options.profileId?{notes:[]}:bound?{profile:bound,notes:[]}:options.sessionId||options.executable?{notes:[]}:chooseUserProfile(home,host,cwd,state)):{notes:[]},profile=picked.profile;
  let env:NodeJS.ProcessEnv,environment:EnvironmentReport,method:HostLaunch['method'],executable:Executable,configHome:string;
  const notes=[...picked.notes];
  if(profile){
    const image=relaunchHostImage(profile.exe,host);
    if(!existsSync(image))throw missingLaunch(host,'exe',image);
    if(!existsSync(profile.configHome))throw missingLaunch(host,'home',profile.configHome);
    const clean=live??(profile.kind?neutralEnvironment():cleanInstanceEnvironment(profile.env));env=clean.env;environment=clean.report;configHome=profile.configHome;executable={command:image,prefix:[]};method=profile.kind==='daemon'?'daemon':state.preferred[host]===profile.sourceSession?'paired-profile':'profile';
  }else{
    const neutral=live??(options.baseline?{env:base,report:{source:'injected-test-baseline',dropped:[],replaced:[],inheritedLoopbackProxy:[]} as EnvironmentReport}:neutralEnvironment());
    const recordedHome='configHome' in picked?picked.configHome:undefined;
    env={...neutral.env};environment=neutral.report;configHome=path.resolve(pinHome??recordedHome??(!options.foreground&&command?chooseUserProfile(home,host,cwd,state).profile?.configHome:undefined)??configHomeFor(host,env));
    if(recordedHome&&!existsSync(recordedHome)){
      const homes=[...new Set([...state.profiles,...observations].filter(value=>value.host===host).map(value=>value.configHome))],otherHomes=homes.some(value=>!sameDirectory(value,recordedHome)&&existsSync(value));
      const remedy=`把目录恢复到原位置；或者正常打开一次 ${host}，nxbridge 会记下新的配置目录；也可以在系统终端运行 nxbridge config set hosts.${host}.home <配置目录> 指定。`;
      const message=otherHomes?`之前用的 ${host} 配置目录已不存在：${recordedHome}。其他配置目录里也有记录，但没有自动换过去，免得用错账号或设置。${remedy}`:`之前记录的 ${host} 配置目录都已不存在（${homes.join('、')}），没有自动改用默认目录，免得用错账号或设置。${remedy}`;
      throw Object.assign(new BridgeError('launch_profile_missing',message),{missingHome:recordedHome});
    }
    const auth=referencedAuthEnvironment(host,configHome,current);for(const [key,value]of Object.entries(auth))if(env[key]===undefined)env[key]=value;
    if(config.codexAuthTokenEnv&&env[config.codexAuthTokenEnv]===undefined&&current[config.codexAuthTokenEnv]!==undefined)env[config.codexAuthTokenEnv]=current[config.codexAuthTokenEnv];
    method=command?'command':binary||pinHome?'pin':'fallback';
    executable=command?commandExecutable(command,env):options.executable&&!binary?{command:relaunchHostImage(options.executable,host),prefix:[]}:resolveCli(host,binary,environmentPath(env));
    if(method==='fallback'&&!notes.length&&!options.foreground)notes.push(`还没有记录到你平时启动 ${host} 的方式，这次改用${process.platform==='win32'?'系统保存的环境变量和 PATH':'当前进程继承并过滤会话变量后的环境和 PATH'}。想固定启动方式，可以在 setup 中指定启动命令，或指定程序和配置目录。`);
  }
  if(options.sessionId&&options.configHome&&pinHome&&!sameDirectory(pinHome,options.configHome))throw new BridgeError('original_home_changed','固定配置目录与原会话不同，请恢复原目录配置，或在原生窗口手动恢复并重新选择搭档。');
  if(options.configHome&&!pinHome){configHome=path.resolve(options.configHome);}
  if(options.configHome&&(options.sessionId||options.executable||options.profileId||options.record)&&!existsSync(configHome))throw missingLaunch(host,'home',configHome);
  if(options.executable&&!command&&!binary)executable={command:relaunchHostImage(options.executable,host),prefix:[]};
  if(host==='codex'&&!options.foreground){
    const requester=options.requesterSession?[...observations,...state.profiles].filter(value=>value.host==='claude'&&value.sourceSession===options.requesterSession).sort((a,b)=>b.capturedAt-a.capturedAt)[0]:undefined;
    const terminal=requester??profile??bound??chooseUserProfile(home,'codex',cwd,state).profile;
    for(const key of codexTerminalVariables){delete env[key];if(terminal?.env[key]!==undefined)env[key]=terminal.env[key];}
  }
  if(host==='codex')env=codexPackageEnvironment(executable,env);
  env={...env,...processOwnershipEnvironment(),NXBRIDGE_HOME:home,[host==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']:configHome,PWD:cwd};
  const original=options.executable??picked.profile?.exe,updatedFrom=original&&original!==executable.command&&!command&&!binary?original:undefined;
  const desktop=!command&&!binary&&(profile||updatedFrom)?desktopHostImages(original??executable.command,host):undefined;
  if(updatedFrom){
    const oldVersion=picked.profile?.version??original;
    notes.push(desktop&&!existsSync(updatedFrom)?`记录的 Claude 桌面端自带程序（${oldVersion}）已被桌面端更新删除，改用同一目录里的新版本 ${desktop.version}：${executable.command}；启动时会再核验版本。`:`记录的 ${host} 程序已被同一安装渠道的更新替换，改用 ${executable.command}；启动时会再核验版本。`);
  }
  if(desktop&&desktop.images.length>1)notes.push(`Claude 桌面端 ${desktop.version} 目录下有 ${desktop.images.length} 份程序，启动时会先核验它们的版本和架构一致，再固定选用其中一份。`);
  const selectionReason=method==='pin'&&!binary?`配置目录用你固定的 ${configHome}；程序没有固定，用${process.platform==='win32'?'系统保存的环境变量和 PATH':'当前进程继承并过滤会话变量后的环境和 PATH'}中的 ${executable.command}`:method==='command'||method==='pin'?'沿用用户显式固定的启动入口':method==='paired-profile'?'沿用用户明确选择的配对窗口入口':profile?'同配置目录优先采用已记录较新版本；实际新建后台前重新探测版本。来源：'+launchSource(profile.exe,profile.kind)+'（'+profile.version+'）':'尚无可用启动记录，使用当前有效 PATH 入口';
  return{host,executable,configHome,cwd,env,method,notes,profile,environment,selectionReason,explicitExecutable:!!(command||binary),...(updatedFrom?{updatedFrom}:{})};
}

export function launchSource(executable:string,kind?:LaunchProfile['kind']):string{return /[\\/]ChatGPT\.app[\\/]/i.test(executable)?'ChatGPT 应用自带':/[\\/](?:Cellar|Caskroom|opt)[\\/]/.test(executable)?'Homebrew':kind==='daemon'||/[\\/]app-server-daemon[\\/]/.test(executable)?'daemon':kind==='managed'?'已核验托管入口':executable;}
export function launchMetadata(launch:HostLaunch){return{host:launch.host,method:launch.method,executable:launch.executable.command,command:redactCommand([launch.executable.command,...launch.executable.prefix]),configHome:launch.configHome,cwd:launch.cwd,profile:launch.profile?profileMetadata(launch.profile):null,notes:launch.notes,environment:launch.environment,selectionReason:launch.selectionReason};}
export function launchStatus(home:string,config:BridgeConfig,cwd=process.cwd()){
  const state=profileState(home),selections=Object.fromEntries((['codex','claude'] as const).map(host=>{try{return[host,launchMetadata(selectHostLaunch(host,config,{cwd,home},state))];}catch(error){return[host,{error:error instanceof Error?error.message:String(error)}];}}));
  const background=claudeBackground(home,config),claude=selections.claude;
  const metadata=(profile:LaunchProfile)=>({...profileMetadata(profile),availability:profileAvailability(profile)});
  const stale=[...state.profiles,...(state.observations??[])].some(value=>!profileAvailability(value).available);
  return{profiles:state.profiles.map(metadata),observations:(state.observations??[]).map(metadata),selections,...(stale?{notice:'失效的旧记录会保留，只是不再选用，不用手动清理。'}:{}),claudeBackground:background??null,...('configHome' in claude?{claudeAutonomy:claudeLaunchPrerequisite(claude.configHome,cwd)}:{})};
}

export async function prepareOwnedLaunch(launch:HostLaunch):Promise<HostLaunch>{
  assertLaunchPreconditions(launch);
  if(!launch.explicitExecutable&&(launch.updatedFrom||launch.version===undefined&&(desktopHostImages(launch.executable.command,launch.host)?.images.length??0)>1)){
                                           
    const stdout=launch.version??await runCli(launch.host,['--version'],{launch,home:launch.env.NXBRIDGE_HOME,timeout:8000});
    if(!profileVersionSupported(stdout,stdout))throw new BridgeError('launch_profile_missing',`${launch.host} 安装渠道里的新版本 ${launch.executable.command} 没有报出可识别的版本号，所以没有用它启动。可能是更新还没完成，完成后会自动重试；也可以在系统终端运行 nxbridge config set hosts.${launch.host}.binary <程序完整路径>。`);
    launch.version=stdout.trim();
  }
  if(launch.profile)for(const name of loopbackProxyNames(launch.env)){
    const url=new URL(launch.env[name]!),hostname=url.hostname.replace(/^\[|\]$/g,'');
    const live=await new Promise<boolean>(resolve=>{const socket=net.createConnection({host:hostname,port:Number(url.port|| (url.protocol==='https:'?443:80))});const finish=(ok:boolean)=>{socket.destroy();resolve(ok);};socket.setTimeout(1000,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});
    if(!live)throw new BridgeError('launch_proxy_unavailable',`记录中 ${launch.host} 使用的本地代理（${name}）现在连不上，未启动，也没有替换代理。请先恢复该代理；如果它由启动包装器提供，建议用 setup 把启动命令设为该包装器，每次启动都重新运行它。`);
  }
  return{...launch,env:{...launch.env,NXBRIDGE_OWNED_LAUNCH:launch.host+':'+randomUUID()}};
}
                                                 
export function assertLaunchPreconditions(launch:HostLaunch):void{
  if(!existsSync(launch.executable.command))throw missingLaunch(launch.host,'exe',launch.executable.command);
  if(!existsSync(launch.cwd))throw missingLaunch(launch.host,'cwd',launch.cwd);
  if(launch.host==='codex'){
    const file=path.join(launch.configHome,'config.toml');if(existsSync(file))try{parseToml(readFileSync(file,'utf8'));}catch{throw new BridgeError('invalid_config','Codex 配置无法解析，请在原配置目录修复后重试。');}
  }else{
    const file=path.join(launch.configHome,'.claude.json');if(!existsSync(file))return;
    let config:any;try{config=JSON.parse(readFileSync(file,'utf8'));}catch{throw new BridgeError('invalid_config','Claude 配置无法解析，请在原配置目录修复后重试。');}
    if(!config.projects||typeof config.projects!=='object')return;
    const key=launch.cwd.replaceAll('\\','/'),project=config.projects[key]??config.projects[launch.cwd];
    if(project?.hasTrustDialogAccepted===false||config.hasCompletedOnboarding===true&&project?.hasTrustDialogAccepted!==true)throw new BridgeError('workspace_untrusted','Claude 尚未信任这个工程；请在此目录按平时的方式打开 Claude 并完成原生信任提示，原消息已保留。');
  }
}
const imageProofs=new Map<string,Promise<{image:string;output:string}>>();
                                              
export async function verifyLaunchImages(launch:HostLaunch,probe:(image:string)=>Promise<string>):Promise<string|undefined>{
  if(launch.explicitExecutable)return;
  const original=launch.updatedFrom??launch.profile?.exe??launch.executable.command,candidates=desktopHostImages(original,launch.host);
  if(!candidates||candidates.images.length<2)return;
  const key=JSON.stringify([launch.host,launch.cwd,launch.configHome,Object.entries(launch.env).sort(([a],[b])=>a.localeCompare(b)),candidates.version,candidates.revision]);
  let work=imageProofs.get(key);
  if(!work){
    work=(async()=>{const outputs=new Map<string,string>(),checked=await verifyHostImage(candidates,async image=>{const output=await probe(image);outputs.set(image,output);return output;});return{image:checked.image,output:outputs.get(checked.image)!};})();
    imageProofs.set(key,work);void work.catch(()=>{if(imageProofs.get(key)===work)imageProofs.delete(key);});
    if(imageProofs.size>64)imageProofs.delete(imageProofs.keys().next().value!);
  }
  const checked=await work;
  if(!sameDirectory(checked.image,launch.executable.command)){
    launch.updatedFrom??=launch.executable.command;
    launch.executable={command:checked.image,prefix:[]};
  }
  const note=`Claude 桌面端 ${candidates.version} 目录下有 ${candidates.images.length} 份程序，核验后版本和架构一致，固定使用 ${checked.image}。`;
  if(!launch.notes.includes(note))launch.notes.push(note);
  return checked.output;
}
export function recordHostLaunch(home:string,role:string,launch:HostLaunch,pid?:number):void{
  const run=path.join(home,'run');if(existsSync(run))atomicJson(path.join(run,`launch-${role}.json`),{...launchMetadata(launch),pid:pid??null,spawnedAt:Date.now()},{durability:'buffered'});
}
export function spawnSelectedHost(launch:HostLaunch,args:string[],options:Parameters<typeof spawn>[2]={}){
  const argv=launch.host==='claude'?claudeLaunchArgs(launch.executable.prefix,args,typeof options?.cwd==='string'?options.cwd:launch.cwd):[...launch.executable.prefix,...args];
  return spawn(launch.executable.command,argv,{windowsHide:true,cwd:launch.cwd,...options,env:launch.env,shell:false});
}
