import { brokerCall } from '../ipc/ipc.js';
import {bridgeHome} from '../shared/local-paths.js';
import {loadConfig} from '../config/load.js';
import {runCli} from '../process/host-command.js';
import {sameDirectory} from '../shared/files.js';
import {managedRemoteAuthentication,managedRuntimes,runtimeFor} from './managed-runtimes.js';
import { connectAppServer } from './codex/adapter.js';
import { codexServerVersion } from './codex/codex-client-identity.js';
import {BridgeError} from '../shared/errors.js';
import {type Host} from '../types.js';
import { selectHostLaunch, spawnSelectedHost, type HostLaunch } from './host-launch.js';
import type { TargetSelector } from '../broker/pairing/admin-target.js';
import { processIdentity, liveProcess } from '../process/process.js';
import { externalTerminalOrigin } from './user-origin.js';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { claudeProfileArgs, claudeProfileSettings } from '../broker/profiles/profile-arguments.js';

interface LaunchSelection { mode:'native'|'remote';endpoint?:string;tokenEnv?:string }
const commands=new Set(['agents','exec','e','review','app-server','remote-control','app','mcp','plugin','login','logout','features','queue','completion','sandbox','debug','apply','a','cloud','update','doctor','archive','delete','unarchive','migrate-rollouts','migrate-nfs-db','exec-server','help']);
const values=new Set(['--remote','--remote-auth-token-env','-C','--cd','-m','--model','-s','--sandbox','-a','--ask-for-approval','-i','--image','--add-dir','-p','--profile','-c','--config','--enable','--disable','--local-provider']);
export function resumeThreadArgument(args:string[]):string|undefined{
  let resume=false;
  for(let i=0;i<args.length;i++){const arg=args[i]!;if(arg==='--')break;if(arg==='resume'){resume=true;continue;}if(arg==='fork'||arg==='--last')return;
    const equal=arg.indexOf('='),short=/^-[Cmcpsai].+/.test(arg),key=short?arg.slice(0,2):equal>=0?arg.slice(0,equal):arg;
    if(values.has(key)){if(equal<0&&!short)i++;continue;}if(resume&&!arg.startsWith('-'))return/^[a-f0-9-]{36}$/i.test(arg)?arg:undefined;
  }
}

export function launchMode(args:string[]):LaunchSelection{
  let endpoint:string|undefined,tokenEnv:string|undefined;
  for(let i=0;i<args.length;i++){
    const arg=args[i]!;if(arg==='--')break;
    if(['--help','-h','--version','-V'].includes(arg)||commands.has(arg))return{mode:'native'};
    const eq=arg.indexOf('='),short=/^-[Cmcpsai].+/.test(arg),key=short?arg.slice(0,2):eq>=0?arg.slice(0,eq):arg;
    if(values.has(key)){
      const value=short?arg.slice(2).replace(/^=/,''):eq>=0?arg.slice(eq+1):args[++i];
      if(value===undefined)throw new BridgeError('invalid_arguments',`${key} 缺少参数。`);
      if(key==='--remote')endpoint=value;
      if(key==='--remote-auth-token-env')tokenEnv=value;
    }
  }
                                        
  if(endpoint)return{mode:'remote',endpoint,...(tokenEnv?{tokenEnv}:{})};
  return{mode:'native'};
}

export function tokenFromEnvironment(name?:string):string|undefined{
  if(!name)return undefined;
  const token=process.env[name];if(!token)throw new BridgeError('token_missing',`缺少环境变量 ${name}。`);return token;
}

export async function interactive(host:Host,args:string[],onStarted?:(child:ChildProcess)=>Promise<void>,options?:{cwd?:string;sessionId?:string;configHome?:string;launch?:HostLaunch}):Promise<number>{
  const authentication=host==='codex'?await managedRemoteAuthentication(bridgeHome(),args):{args,env:{}},selection=options?.launch??selectHostLaunch(host,loadConfig(),{...options,foreground:true});
  Object.assign(selection.env,authentication.env);
  if(host==='codex'){
    const index=args.indexOf('--remote'),endpoint=index>=0?args[index+1]:args.find(arg=>arg.startsWith('--remote='))?.slice(9);
    if(endpoint)try{if(runtimeFor(bridgeHome(),{endpoint})){
      const [server,current]=await Promise.all([connectAppServer(endpoint,loadConfig(),undefined,bridgeHome(),{readOnly:true}).then(async rpc=>{try{return codexServerVersion(rpc);}finally{await rpc.close();}}),runCli('codex',['--version'],{launch:selection,timeout:3000})]);
      const version=/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\b/.exec(current)?.[1];
      if(server&&version&&server!==version)process.stderr.write(`nxbridge：此会话仍在 Codex ${server} 后台中，当前窗口为 ${version}；本次继续接入原会话。请先结束原后台工作，再按原方式恢复会话以使用当前版本。\n`);}
    }catch{                                  }
  }
  const child=spawnSelectedHost(selection,authentication.args,{stdio:'inherit',windowsHide:false});
  return new Promise((resolve,reject)=>{let started=Promise.resolve();child.once('error',reject);child.once('spawn',()=>{if(onStarted){started=onStarted(child);void started.catch(()=>{});}});child.once('exit',code=>{void started.then(()=>resolve(code??1),reject);});});
}

export async function launchCodex(args:string[]):Promise<number>{
  const config=loadConfig(),home=bridgeHome(),selected=launchMode(args),sessionId=resumeThreadArgument(args),launchProfile=selectHostLaunch('codex',config,{foreground:true,...(process.env.CODEX_HOME?{configHome:process.env.CODEX_HOME}:{})});
  let endpoint=selected.endpoint;
                                                 
  if(sessionId&&!endpoint){
    let target:any;
    try{if(managedRuntimes(home).some(({value})=>value.state==='ready'&&value.pid&&liveProcess(value.pid)&&value.configHome&&sameDirectory(value.configHome,launchProfile.configHome))){
      target=await brokerCall<any>('hosting.resolve',{session_id:sessionId,home:launchProfile.configHome,loaded_only:true});
    }}catch(error){process.stderr.write('nxbridge：后台会话归属暂无法核验，使用官方恢复：'+String(error)+'\n');}
    if(target?.unavailable)throw new BridgeError('background_retiring',target.unavailable);
    if(target?.endpoint){if(target.member_id&&target.owner==='nxbridge')return openPartner('codex',{peer_id:target.member_id},args);endpoint=target.endpoint;}
  }
  if(!endpoint)return interactive('codex',args,undefined,{launch:launchProfile});
  const launch=selected.endpoint?args:['--remote',endpoint,...args];
  let foreground:{pid:number;procStart:string}|undefined;
  try{return await interactive('codex',launch,async child=>{
    const identity=await processIdentity(child.pid!);foreground={pid:identity.pid,procStart:identity.startedAt};
                                      
    try{await brokerCall('codex.foreground.started',{endpoint,...(sessionId?{session_id:sessionId}:{}),foreground},{timeout:5000,mutation:true});await brokerCall('codex.connect',{endpoint,...(selected.endpoint?{bearerToken:tokenFromEnvironment(selected.tokenEnv)}:{})},{timeout:15000});if(sessionId)await brokerCall('codex.foreground.prepare',{endpoint,session_id:sessionId,cwd:launchProfile.cwd,home:launchProfile.configHome},{timeout:15000,mutation:true});}
    catch(error){process.stderr.write('nxbridge：原生窗口已启动，通信观察暂未连接：'+String(error)+'\n');}
  },{launch:launchProfile});}
  finally{
    if(foreground)try{await brokerCall('codex.foreground.end',{endpoint,...(sessionId?{session_id:sessionId}:{}),foreground},{mutation:true,timeout:15000});}catch(error){process.stderr.write('nxbridge：原窗口退出状态待核验：'+String(error)+'\n');}
    if(sessionId&&!selected.endpoint)process.stderr.write(`nxbridge：再次恢复原会话请运行 codex resume ${sessionId}。\n`);
  }
}

export async function openPartner(host:Host,options:TargetSelector&{interrupt?:boolean}={},codexArgs?:string[]):Promise<number>{
  const controller=await processIdentity(process.pid);
  const {peer,endpoint,handle,mode,handoffId,leaseId,notice,resume,modelProfile}=await brokerCall<any>('open',{...options,host,interrupt:options.interrupt??false,request_id:randomUUID(),terminal_origin:await externalTerminalOrigin(),controller:{pid:controller.pid,procStart:controller.startedAt}},{timeout:40000});
  if(!peer.sessionId)throw new BridgeError('partner_starting','搭档尚未就绪。');
  const claim=async(child:ChildProcess)=>{const identity=await processIdentity(child.pid!);await brokerCall('open.claim',{peer_id:peer.id,session_id:peer.sessionId,handoff_id:handoffId,lease_id:leaseId,foreground:{pid:identity.pid,procStart:identity.startedAt}},{mutation:true});};
  try{
  if(mode==='child'){
    if(notice)process.stderr.write(notice+'\n');
    const profile=modelProfile??{},settings=claudeProfileSettings(profile);
    return await interactive('claude',[resume?'--resume':'--session-id',peer.sessionId,...(Object.keys(settings).length?['--settings',JSON.stringify(settings)]:[]),...claudeProfileArgs(profile)],claim,{cwd:peer.cwd,sessionId:peer.sessionId,configHome:endpoint?.configHome});
  }
  const args=host==='claude'?['attach',handle]:endpoint?.mode==='app-server'?['--remote',endpoint.address,'--cd',peer.cwd,...(codexArgs??['resume',peer.sessionId])]:null;
  if(!args)throw new BridgeError('embedded_active','已有 embedded 窗口不能同时恢复成第二个运行时。请先释放原窗口，再用 nxbridge codex resume <ID> 冷恢复。');
  return await interactive(host,args,claim,{cwd:peer.cwd,sessionId:peer.sessionId,configHome:endpoint?.configHome});
  }finally{if(leaseId)try{await brokerCall('open.return',{peer_id:peer.id,session_id:peer.sessionId,handoff_id:handoffId,lease_id:leaseId,foreground_ended:true},{mutation:true});}catch(error){process.stderr.write(`nxbridge：接管归还待核对：${String(error)}\n`);}if(host==='codex')process.stderr.write(`nxbridge：再次打开此搭档请运行 nxbridge open codex --member ${peer.id}。\n`);}
}
