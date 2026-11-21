import { randomUUID } from 'node:crypto';
import { externalTerminalOrigin } from '../../hosts/user-origin.js';
import { brokerCall, serviceOrigin } from '../../ipc/ipc.js';
import {bridgeHome} from '../../shared/local-paths.js';
import {delay} from '../../shared/time.js';
import {BridgeError,DeliveryError,describeError} from '../../shared/errors.js';
import type { TargetSelector } from '../../broker/pairing/admin-target.js';
import type { RestartSelector } from '../../hosts/codex/codex-restart.js';

export async function restartCommand(params:RestartSelector,home=bridgeHome()):Promise<{text:string}>{
  try{return await performRestart(params,home);}catch(error){
    if(!params.partner)throw error;
    const code=(error as {code?:string}).code??'restart_failed',retry=['session_busy','subagent_active','question_pending','delivery_unsettled','context_transition','stale_context','pair_paused','history_not_persisted','restart_in_progress'].includes(code),message=describeError(error)+(retry?' 完成待处理工作并确认空闲后再尝试一次；不要轮询重启。':' 停止自动重试，将原因告知用户。');
    if(error instanceof DeliveryError)throw new DeliveryError(code,message,error.uncertain);
    throw new BridgeError(code,message);
  }
}

async function performRestart(params:RestartSelector,home:string):Promise<{text:string}>{
  const target=await brokerCall<{owner:string;session_id?:string;peer_id?:string;pair_id?:string;text?:string;runtime?:{pid:number;procStart:string};broker?:{pid:number;generation?:string;windowsIndependent?:boolean}}>('codex.restart.target',params,{home});
  if(target.owner==='user'&&target.text)return{text:target.text};
  const runtime=target.runtime;
  const origin=await serviceOrigin();
  if(runtime&&origin.some(value=>value.pid===runtime.pid&&value.startedAt===runtime.procStart)||target.session_id&&[process.env.CODEX_THREAD_ID,process.env.CODEX_SESSION_ID].includes(target.session_id))throw new BridgeError('self_restart','请从目标 Codex 之外的终端执行重启；当前命令属于目标宿主，停止它会同时中断调用方。');
  if(process.platform==='win32'&&!target.broker?.windowsIndependent)throw new BridgeError('bootstrap_required','协调器尚未核验为独立后台，请先在普通 PowerShell 运行 nxbridge bootstrap；本次未停止任何会话。');
  const request_id=randomUUID();
  try{return await brokerCall('codex.restart',{...(params.partner?{...params,peer_id:target.peer_id,pair_id:target.pair_id,session_id:target.session_id}:target.peer_id?{peer_id:target.peer_id}:{...params,session_id:target.session_id??params.session_id}),request_id,...(target.broker?.generation?{broker_pid:target.broker.pid,broker_generation:target.broker.generation}:{})},{home,start:false,mutation:true,timeout:60000});}
  catch(error){
    if(error instanceof DeliveryError&&error.uncertain){
                                              
      const deadline=Date.now()+30000;
      do{
        try{return await brokerCall('codex.restart.result',{request_id},{home,start:false,timeout:Math.min(3000,Math.max(1,deadline-Date.now()))});}
        catch(resultError){if(!['restart_result_missing','starting','disconnected','timeout','broker_timeout','ENOENT','ECONNREFUSED','ECONNRESET','EPIPE'].includes((resultError as {code?:string}).code??''))throw resultError;}
        if(Date.now()<deadline)await delay(200);
      }while(Date.now()<deadline);
      throw new DeliveryError('restart_unconfirmed',`重启请求 ${request_id} 的完成结果暂时无法确认；没有重复重启。请用 nxbridge status 核对原会话；仅看到新进程不能证明这次请求已完整完成。`,true);
    }
    throw error;
  }
}

export async function recoverCommand(params:TargetSelector&{turn_id?:string;preview?:boolean},home=bridgeHome()):Promise<unknown>{
  const target=await brokerCall<{peer_id:string;runtime?:{pid:number;procStart:string}}>('codex.recover',{...params,turn_id:undefined,preview:true},{home});
  if(params.preview)return target;
  if(!params.preview){
    const runtime=target.runtime;
    if(runtime&&(await serviceOrigin()).some(p=>p.pid===runtime.pid&&p.startedAt===runtime.procStart))throw new BridgeError('self_recovery','请从目标 Codex 之外的终端执行恢复，避免中断正在执行恢复命令的 turn。');
  }
  const request_id=randomUUID();
  try{return await brokerCall('codex.recover',{peer_id:target.peer_id,turn_id:params.turn_id,preview:false,request_id,terminal_origin:await externalTerminalOrigin()},{home,start:false,mutation:true,timeout:45000});}
  catch(error){
    if(error instanceof DeliveryError&&error.uncertain)try{return await brokerCall('codex.recover.result',{request_id},{home,start:false,timeout:3000});}catch{}
    throw error;
  }
}
