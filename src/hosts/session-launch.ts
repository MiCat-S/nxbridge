import path from 'node:path';
import { globSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { selectHostLaunch, sameHostImage, homeKey, commandKey, launchSource, launchStatus, launchMetadata, type HostLaunch, type HostLaunchOptions } from './host-launch.js';
import { profileState, type LaunchProfile } from './launch-profiles.js';
import { profileVersionSupported } from './host-version.js';
import { readSessionProfile, sessionFile } from './codex/codex-session-profile.js';
import {bridgeHome} from '../shared/local-paths.js';
import {runCli} from '../process/host-command.js';
import {sameDirectory} from '../shared/files.js';
import {BridgeError} from '../shared/errors.js';
import {type BridgeConfig,type Host} from '../types.js';
import { deterministicEntryFailure } from './launch-failure.js';

export interface LaunchCandidate {executable:string;version?:string;source:string;reason?:string;code?:string}
const failureText:Record<string,string>={launch_image_ambiguous:'同一版本有多份程序，报出的版本或架构不一致',launch_profile_missing:'程序或配置目录已不存在',launch_command_missing:'找不到配置的启动命令',launch_command_invalid:'启动命令格式无效',session_not_found:'找不到原会话历史',rollout_not_found:'找不到原会话历史',invalid_config:'原生配置无法解析',timeout:'版本核验超时',host_control_timeout:'入口正在执行其他控制命令',ENOENT:'找不到程序或原会话文件',EACCES:'当前账户无权读取或运行入口',EPERM:'当前账户无权读取或运行入口'};
const versions=new Map<string,Promise<string>>();
export function executableStamp(file:string):unknown[]{
  try{const stat=statSync(file);return[file,realpathSync(file),stat.size,stat.mtimeMs];}catch{return[file,'missing'];}
}
export function sessionEvidenceFile(host:Host,home:string,id:string):string|undefined{
  if(host==='codex')return sessionFile(home,id);
  if(!/^[\w-]+$/.test(id))return;
  try{const file=globSync('projects/**/'+id+'.jsonl',{cwd:home})[0];return file?path.join(home,file):undefined;}catch{return;}
}
                                         
export async function sessionWriterVersion(host:Host,home:string,id:string):Promise<string|undefined>{
  if(host==='codex')return(await readSessionProfile(sessionFile(home,id),id)).meta.cli_version;
  if(!/^[\w-]+$/.test(id))return;
  const file=sessionEvidenceFile(host,home,id);if(!file)return;
  let fd:number|undefined;
  try{fd=openSync(file,'r');const bytes=Buffer.alloc(65536),size=readSync(fd,bytes,0,bytes.length,0);for(const line of bytes.toString('utf8',0,size).split('\n').slice(0,-1))try{const row=JSON.parse(line);if(row.sessionId===id&&typeof row.version==='string'&&/^\d+\.\d+\.\d+/.test(row.version))return row.version;}catch{                  }}
  finally{if(fd!==undefined)closeSync(fd);}
}
async function versionOf(launch:HostLaunch):Promise<string>{
  const key=JSON.stringify([launch.host,launch.executable,executableStamp(launch.executable.command),...launch.executable.prefix.slice(0,1).map(executableStamp)]);
  let work=versions.get(key);if(!work){work=runCli(launch.host,['--version'],{launch,timeout:8000}).then(value=>value.trim());versions.set(key,work);void work.catch(()=>versions.delete(key));if(versions.size>128)versions.delete(versions.keys().next().value!);}return work;
}
                                                   
export async function selectNewSessionLaunch(host:Host,config:BridgeConfig,options:HostLaunchOptions={},probe=versionOf):Promise<HostLaunch>{
  const state=profileState(options.home??bridgeHome()),initial=selectHostLaunch(host,config,options,state);
  if(host!=='codex'||options.sessionId||options.executable||options.profileId||['command','pin','paired-profile'].includes(initial.method))return initial;
  const records=[...(initial.profile?[initial.profile]:[]),...state.profiles,...(state.observations??[]).filter(record=>!!record.kind)].filter(record=>record.host===host&&sameDirectory(record.configHome,initial.configHome));
  const candidates:HostLaunch[]=[],seen=new Set<string>();
  for(const record of records)try{const launch=selectHostLaunch(host,config,{...options,record,configHome:initial.configHome},state),key=JSON.stringify(launch.executable);if(!seen.has(key)){seen.add(key);candidates.push(launch);}}catch{                                }
  if(!candidates.length)return initial;
  const verified=await Promise.allSettled(candidates.map(async launch=>{const version=await probe(launch);if(!profileVersionSupported(version,version))throw new BridgeError('launch_probe_unavailable','入口没有返回可比较的原生版本。');return{...launch,version};}));
  let chosen:HostLaunch|undefined;
  for(const value of verified)if(value.status==='fulfilled'&&(!chosen||profileVersionSupported(value.value.version,chosen.version??'')&&!profileVersionSupported(chosen.version??'',value.value.version)))chosen=value.value;
  if(!chosen)throw new BridgeError('launch_probe_unavailable','同配置目录的 Codex 入口版本均暂时无法核验，未新建后台；请运行 nxbridge doctor 检查入口。');
  chosen.selectionReason='同配置目录中按启动前重新核验的版本选择较新入口：'+launchSource(chosen.executable.command,chosen.profile?.kind)+'（'+chosen.version+'）；配置目录 '+chosen.configHome+'。';
  return chosen;
}
export async function verifiedLaunchStatus(home:string,config:BridgeConfig,cwd=process.cwd()){
  const status=launchStatus(home,config,cwd);
  try{status.selections.codex=launchMetadata(await selectNewSessionLaunch('codex',config,{home,cwd}));}catch(error){status.selections.codex={error:error instanceof Error?error.message:String(error)};}
  return status;
}
                                                 
export async function selectSessionLaunch(host:Host,config:BridgeConfig,options:HostLaunchOptions={},dependencies:{version?:(launch:HostLaunch)=>Promise<string>;writer?:string}={}):Promise<HostLaunch>{
  if(!options.sessionId)return selectNewSessionLaunch(host,config,options,dependencies.version??versionOf);
  const home=options.home??bridgeHome(),state=profileState(home),all=[...(state.observations??[]),...state.profiles].filter(value=>value.host===host&&(!options.configHome||sameDirectory(value.configHome,options.configHome)));
  const pinned=!!(config[commandKey(host)]||(host==='codex'?config.codexBinary:config.claudeBinary)),exact=all.filter(value=>value.sourceSession===options.sessionId),bound=options.profileId?all.find(value=>value.id===options.profileId):undefined;
  const candidates:{record?:LaunchProfile;executable?:string;source:string}[]=pinned?[{source:'显式配置'}]:[
    ...(options.executable?[{record:bound??exact.find(value=>sameHostImage(value.exe,options.executable!,host)),executable:options.executable,source:'原启动证明'}]:[]),
    ...exact.filter(value=>!options.executable||sameHostImage(value.exe,options.executable,host)).sort((a,b)=>b.capturedAt-a.capturedAt).map(record=>({record,source:record.kind==='daemon'?'本会话 daemon':record.kind==='managed'?'本会话托管后台':'本会话窗口'})),
    ...(!options.executable&&!exact.length?(bound?[bound]:all.filter(value=>!value.kind)).sort((a,b)=>Number(sameDirectory(b.cwd,options.cwd??process.cwd()))-Number(sameDirectory(a.cwd,options.cwd??process.cwd()))||b.capturedAt-a.capturedAt).map(record=>({record,source:'同配置目录的兼容记录'})):[])
  ];
                                                         
  if(!candidates.length&&!options.configHome)candidates.push({source:'默认启动入口'});
  const checked:LaunchCandidate[]=[],seen=new Set<string>();
  let writer=dependencies.writer;
  for(const candidate of candidates){
    let launch:HostLaunch|undefined;
    try{
      launch=selectHostLaunch(host,config,{...options,...candidate,record:candidate.record,profileId:candidate.record?.id,unobserved:!candidate.record,executable:candidate.executable??candidate.record?.exe},state);
      const key=JSON.stringify([launch.executable,candidate.record?.id]);if(seen.has(key))continue;seen.add(key);
      writer??=await sessionWriterVersion(host,options.configHome??config[homeKey(host)]??launch.configHome,options.sessionId);
      const version=await(dependencies.version??versionOf)(launch),entry:LaunchCandidate={executable:launch.executable.command,version,source:candidate.source};checked.push(entry);
      if(writer&&!profileVersionSupported(version,writer)){
        if(host==='claude'&&pinned)launch.notes.push('用户显式指定的 Claude '+version+' 早于会话写入版本 '+writer+'；继续使用指定入口，由原生恢复检查兼容性。');
        else{entry.reason='早于会话写入版本 '+writer;entry.code='profile_version_unsupported';continue;}
      }
      launch.version=version;
      if(candidate.source==='同配置目录的兼容记录')launch.notes.push('原会话没有独立启动记录，使用同配置目录中已核验兼容的 '+entry.executable+'（'+version+'）。');
      return launch;
    }catch(error){const code=(error as {code?:string}).code;if(code==='original_home_changed'||code&&/^(?:session_|rollout_|resume_)/.test(code))throw error;checked.push({executable:launch?.executable.command??candidate.executable??candidate.record?.exe??'显式配置',source:candidate.source,reason:code&&failureText[code]||'版本或入口无法核验',...(code?{code}:{})});}
  }
                                       
  const code=!checked.length?'launch_provenance_missing':checked.some(value=>!deterministicEntryFailure(value.code))?'launch_probe_unavailable':checked.some(value=>value.code==='launch_image_ambiguous')?'launch_image_ambiguous':checked.some(value=>value.version)?'profile_version_unsupported':'launch_profile_missing';
  const detail=checked.length?checked.map(value=>value.executable+'（'+(value.version??'版本未知')+'）：'+value.reason).join('；'):'此会话尚未留下可核验的程序来源';
  const pins=[...(config[commandKey(host)]?['command']:[]),...((host==='codex'?config.codexBinary:config.claudeBinary)?['binary']:[])];
  const configHome=options.configHome??config[homeKey(host)]??'<原配置目录>';
  const repair=pins.length?`先在系统终端取消固定入口：${pins.map(key=>'nxbridge config unset hosts.'+host+'.'+key).join('；')}；或者把它改成支持原会话版本的程序完整路径。`:`在系统终端运行 nxbridge config set hosts.${host}.binary <程序完整路径>，指定原安装渠道里能用的 ${host}（配置目录仍用 ${configHome}）；也可以在 ${options.cwd??process.cwd()} 里用平时的方式按会话 ID ${options.sessionId} 打开它，nxbridge 会记下新的程序。`;
  throw Object.assign(new BridgeError(code,`无法恢复原 ${host} 会话${writer?'（写入版本 '+writer+'）':''}。检查过：${detail}。${repair}原消息已保留；${code==='launch_probe_unavailable'?'临时的核验失败会按退避自动重试。':'入口或配置一变就会重新核验。'}`),{launchCandidates:checked});
}
