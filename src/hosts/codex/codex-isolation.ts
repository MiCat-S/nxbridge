import { lstatSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostLaunch } from '../host-launch.js';
import {runCli} from '../../process/host-command.js';
import { codexArguments, codexDedicatedEndpointArguments, type ProcessIdentity } from '../../process/process.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import { proveUnixCodexSocket } from '../../ipc/unix-socket.js';

const capabilities=new Map<string,Promise<{authenticatedWebsocket:boolean}>>();
const restoreCapabilities=new Map<string,Promise<void>>();
export const CODEX_RESTORE_BOOTSTRAP=['-c','default_permissions="nxbridge_bootstrap"','-c','permissions.nxbridge_bootstrap.filesystem={":root"="none"}','-c','permissions.nxbridge_bootstrap.network.enabled=false','-c','approval_policy="on-request"'];
const execute=promisify(execFile);
export const restoreBootstrapKey=(launch:HostLaunch)=>JSON.stringify([launch.executable,launch.profile?.version,(()=>{try{return lstatSync(launch.executable.command).mtimeMs;}catch{return 0;}})()]);
export function bootstrapPolicyRejected(error:unknown):boolean{
  const native=((error as Error)?.cause??error) as {code?:unknown;signal?:unknown;stderr?:unknown};
  const diagnostic=String(native?.stderr??'');
  return typeof native?.code==='number'&&native.code!==0&&!native.signal&&!/TOML parse|parse error|invalid TOML|unterminated/i.test(diagnostic)&&/\bnxbridge_bootstrap\b/i.test(diagnostic)&&/unknown|unexpected (?:argument|field|option)|unrecognized|unsupported|not found|does not exist|not supported|invalid (?:value|type|argument|permission profile)/i.test(diagnostic);
}
                                                 
export async function requireRestoreBootstrap(launch:HostLaunch):Promise<void>{
  const key=restoreBootstrapKey(launch);
  let work=restoreCapabilities.get(key);
  if(!work){
    work=runCli('codex',['--no-daemon',...CODEX_RESTORE_BOOTSTRAP,'features','list'],{launch,timeout:8000}).then(()=>{},error=>{
      restoreCapabilities.delete(key);
      if(!bootstrapPolicyRejected(error))throw error;
      throw Object.assign(new BridgeError('bootstrap_policy_unsupported',`所选 Codex ${launch.executable.command}（${launch.profile?.version??'版本未知'}）拒绝命名权限启动配置。请更新此 Codex，或用 nxbridge setup --codex-command 指定支持的入口；检测到入口更新后会重新核验，也可显式重试 nxbridge adopt codex。原消息继续保留。原因：${describeError(error).slice(0,600)}`),{bootstrapProbeKey:key});
    });restoreCapabilities.set(key,work);
  }
  return work;
}
                                       
export async function requireDedicatedCodex(launch:HostLaunch,home?:string):Promise<{authenticatedWebsocket:boolean}>{
  const key=JSON.stringify([launch.executable,(()=>{try{return lstatSync(launch.executable.command).mtimeMs;}catch{return 0;}})()]);
  let work=capabilities.get(key);
  if(!work){work=runCli('codex',['--no-daemon','app-server','--help'],{launch,home,timeout:8000}).then(help=>({authenticatedWebsocket:/--ws-auth\b/.test(help)&&/--ws-token-file\b/.test(help)}),error=>{capabilities.delete(key);if(/(?:unexpected argument|unrecognized (?:option|argument)|unknown option).{0,30}--no-daemon/i.test(String(error)))throw new BridgeError('dedicated_mode_unsupported','所选 Codex 不支持专用 App Server；请在原窗口恢复同一会话，并用 nxbridge status 核对。');throw error;});capabilities.set(key,work);}
  return work;
}
export async function verifyDedicatedCodex(endpoint:string,native:ProcessIdentity):Promise<void>{
  const args=await codexArguments(native),subcommand=args.indexOf('app-server');
  if(subcommand<0||!args.slice(0,subcommand).includes('--no-daemon')||!codexDedicatedEndpointArguments(args,endpoint))throw new BridgeError('shared_backend','原生 App Server 没有可核验的专用模式，未授权停止共享后台。');
  if(endpoint.startsWith('unix://')){
    const filename=path.resolve(endpoint.slice(7));let stat;
    try{stat=lstatSync(filename);}catch(error){
      if(process.platform!=='win32'||!['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;
                                                                                       
      const {stdout}=await execute('fsutil.exe',['reparsepoint','query',filename],{windowsHide:true,timeout:5000,encoding:'utf8'});
      if(!/0x80000023\b/i.test(stdout))throw new BridgeError('shared_backend','Windows socket 的原生类型无法核验，未授权停止。');return;
    }
    if(process.platform==='win32'){
      if(stat.isSymbolicLink())throw new BridgeError('shared_backend','Windows socket 指向另一个后台，未授权停止共享后台。');
    }else await proveUnixCodexSocket(filename,native);
  }
}
