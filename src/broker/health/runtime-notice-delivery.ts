import path from 'node:path';
import {BridgeError,DeliveryError} from '../../shared/errors.js';
import {type Peer} from '../../types.js';
import {claudeHome} from '../../shared/local-paths.js';
import {readJson} from '../../shared/files.js';
import { deliverClaudeInbox, type SessionRecord } from '../../hosts/claude/claude-inbox.js';
import {readHealthSnapshot,updateHealthSnapshot} from './snapshot.js';
import type { DeliveryMessage } from '../delivery/file-references.js';
import { claimBrokerOutageEnqueue, isBrokerOutageNotice, releaseBrokerOutageClaim } from '../broker-outage.js';
import { preSubmitError } from '../../storage/storage-errors.js';
import { remainingTime } from '../../shared/time-budget.js';

export const RUNTIME_NOTICE_SUMMARY='nxbridge 运行状态有更新；本会话的 AI 将核验详情，必要时向你说明。';

                                          
export async function queueRuntimeNotice(home:string,sessionId:string,native:{pid:number;procStart:string},binding:{key:string;epoch:string},inbox:string,id:string,revision:string,permission?:Peer['permission']):Promise<{queued:true}|{drop:string}|{deferred:true}>{
  const current=(deadline?:number)=>{
    try{
    const value=readHealthSnapshot(home,'claude',sessionId,undefined,native,remainingTime(deadline,300)),endpoint=value?.senderEndpoint;
    if(!value||!endpoint||endpoint.mode!=='claude-inbox'||endpoint.modRevision!==revision||endpoint.address!==inbox||endpoint.pid!==native.pid||endpoint.procStart!==native.procStart||value.binding?.key!==binding.key||value.binding.epoch!==binding.epoch)return;
    const record=readJson<SessionRecord>(path.join(endpoint.configHome??claudeHome(),'sessions',native.pid+'.json'));
    if(record.sessionId===sessionId&&(record.procStartFt??record.procStart)===native.procStart)return value;
    }catch(error){throw preSubmitError(error,'notice.current','enqueue');}
  };
  const value=current();if(!value){if(isBrokerOutageNotice(id)){const prior=readHealthSnapshot(home,'claude',sessionId,undefined,native);if(prior)releaseBrokerOutageClaim(home,{host:'claude',peerId:prior.sender.id,sessionId,...native},id);}throw preSubmitError(new BridgeError('session_changed','通知所属的原生会话或上下文已改变，未入队。'),'notice.current','enqueue');}
  let ownsEnqueue=false,deferred=false;
  const pending=(deadline?:number)=>{try{return isBrokerOutageNotice(id)?(ownsEnqueue=claimBrokerOutageEnqueue(home,{host:'claude',peerId:value.sender.id,sessionId,...native},id)):updateHealthSnapshot(home,'claude',sessionId,undefined,(health,fresh)=>{
    if(fresh.binding?.key!==binding.key||fresh.binding.epoch!==binding.epoch)return false;
    if(health.get(fresh.pair.id,fresh.sender.id,id)?.readyOnly&&fresh.sender.state!=='ready'){deferred=true;return false;}
    return health.peek(fresh.pair.id,fresh.sender.id).some(n=>n.wake===true&&(n.id===id||n.componentIds?.includes(id)));
  },native,remainingTime(deadline,3000))===true;}catch(error){throw preSubmitError(error,'notice.pending','enqueue');}};
  const now=Date.now(),message:DeliveryMessage={id,pairId:value.pair.id,from:value.sender.id,to:value.sender.id,body:RUNTIME_NOTICE_SUMMARY,inReplyTo:null,via:null,callId:id,state:'accepted',createdAt:now,updatedAt:now,evidence:null,error:null,attempts:0,notice:true,beforeSubmit:async deadline=>!!current(deadline)&&pending(deadline)};
                                             
                                                                      
  const observed=permission??value.senderEndpoint!.nativePermission?.permission??value.senderEndpoint!.nativeInbound?.permission??'unknown';
  let result;
  try{result=await deliverClaudeInbox(value.sender,value.senderEndpoint!,message,{...value.sender,name:'nxbridge runtime monitor',permission:observed},()=>value.senderEndpoint!.configHome??claudeHome());}
  catch(error){if(isBrokerOutageNotice(id)&&error instanceof DeliveryError&&!error.uncertain)try{releaseBrokerOutageClaim(home,{host:'claude',peerId:value.sender.id,sessionId,...native},id,ownsEnqueue?'enqueued':'reserved');}catch(cleanup){process.stderr.write('nxbridge 通知租约清理：'+String(cleanup)+'\n');}throw error;}
  return deferred?{deferred:true}:result.state==='expired'?{drop:'condition resolved before delivery'}:{queued:true};
}
