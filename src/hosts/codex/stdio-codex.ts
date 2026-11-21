import { createInterface } from 'node:readline';
import { backendCodexClient } from './codex-client-identity.js';
import { selectHostLaunch, type HostLaunch } from '../host-launch.js';
import { acquireHostControl, hostControlFailure } from '../host-control.js';
import { RpcClient, type RpcMessage } from '../../ipc/rpc.js';
import type { BridgeConfig } from '../../types.js';
import {bridgeHome} from '../../shared/local-paths.js';
import { spawnContainedCommand, containedCommandFailure, containedCommandExit, closeContainedCommand } from '../../process/contained-command.js';
import type { ChildProcess } from 'node:child_process';

class ControlRpcClient extends RpcClient {
  constructor(send:(message:RpcMessage)=>void,private finish:()=>Promise<void>){super(send,()=>{void finish();});}
  override close():Promise<void>{super.close();return this.finish();}
}

                                  
export async function configClient(config:BridgeConfig,home?:string,launch?:HostLaunch):Promise<RpcClient>{
  const selectedHome=home??bridgeHome();
  return backendCodexClient(()=>openConfigTransport(config,selectedHome,launch));
}

async function openConfigTransport(config:BridgeConfig,home:string,selectedLaunch?:HostLaunch):Promise<RpcClient>{
  const launch=selectedLaunch??selectHostLaunch('codex',config,{home});
  const args=['--no-daemon','app-server','--listen','stdio://'],release=await acquireHostControl(launch.executable.command);
  let child:ChildProcess;
  try{child=await spawnContainedCommand(launch.executable.command,[...launch.executable.prefix,...args],{home,cwd:launch.cwd,env:launch.env,stdio:['pipe','pipe','pipe']});}catch(error){release();throw hostControlFailure('codex',args,{code:'host_ownership_unknown',detail:String(error)});}
  let stderr='',stdout='';
  let closing:Promise<void>|undefined;
  const finish=():Promise<void>=>{
    if(!closing){
      closing=closeContainedCommand(child).finally(()=>{
        lines.close();child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
      });
                                                
      void closing.catch(error=>process.stderr.write('控制进程回收未完成：'+String(error)+'\n'));
    }
    return closing;
  };
  const rpc=new ControlRpcClient(message=>child.stdin!.write(JSON.stringify(message)+'\n'),finish);
  const lines=createInterface({input:child.stdout!});
  lines.on('line',line=>{stdout=(stdout+line+'\n').slice(-4096);try{rpc.receive(JSON.parse(line));}catch{}});
  child.stderr?.setEncoding('utf8').on('data',value=>stderr=(stderr+value).slice(-4096));
  child.on('error',error=>rpc.disconnected(hostControlFailure('codex',args,{...error,stderr,stdout}).message));
  child.on('close',(code,signal)=>{release();({code,signal}=containedCommandExit(child,code,signal));const failure=containedCommandFailure(child);rpc.disconnected(hostControlFailure('codex',args,{code:(failure as NodeJS.ErrnoException|undefined)?.code??code,signal,stderr,stdout,detail:failure?.message}).message);lines.close();});
  if(rpc.closed)throw hostControlFailure('codex',args,{code:child.exitCode,signal:child.signalCode,stderr,stdout});return rpc;
}
