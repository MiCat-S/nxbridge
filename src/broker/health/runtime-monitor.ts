import { randomUUID } from 'node:crypto';
import { connectBroker, installationEnabled } from '../../ipc/ipc.js';
import {loadConfig} from '../../config/load.js';
import { probeProcesses } from '../../process/process.js';
import {acknowledgeContextSnapshot,readHealthSnapshot,updateHealthSnapshot,type HealthSnapshot} from './snapshot.js';
import {probeAppServer,probePeerRuntime} from './probe.js';
import {type RuntimeNotice} from './contracts.js';
import type { Host } from '../../types.js';
import { lossNotices, pairLossKey } from '../pairing/pair-loss.js';
import { changeNotices, pairChangeKey } from '../pairing/pair-changes.js';
import { noticeSignal } from './notice-policy.js';
import { brokerOutageNotice, isBrokerOutageNotice, releaseBrokerOutageClaim } from '../broker-outage.js';
import { startupHeldElsewhere } from '../broker-startup.js';
import { retryStorageReceipt } from '../../storage/storage-errors.js';
import { remainingTime } from '../../shared/time-budget.js';
import { assertClaudeSession } from '../../hosts/claude/claude-session.js';

type Native={pid:number;procStart:string};
function sameNative(value:HealthSnapshot,native:Native):boolean{
  const endpoint=value.senderEndpoint,recorded=endpoint?.native??(endpoint?.pid?{pid:endpoint.pid,procStart:endpoint.procStart}:undefined);
  return recorded?.pid===native.pid&&recorded.procStart===native.procStart;
}
                                                        
export async function collectRuntimeNotices(home:string,host:Host,sessionId:string,native:Native,contextKey?:string,modVersion?:string,modRevision?:string,options:{admit?:boolean;noticeId?:string;binding?:{key:string;epoch:string};deadline?:number}={}):Promise<RuntimeNotice[]>{
  const timeout=(limit:number)=>remainingTime(options.deadline,limit);
  if(!installationEnabled(home))return[];
  const value=readHealthSnapshot(home,host,sessionId,contextKey,native,timeout(300));
  if(!value||!sameNative(value,native))return[];
  if(value.sender.enabled===false)return[];
  const claimant={host,peerId:value.sender.id,sessionId,...native};
  if(options.binding&&(value.binding?.key!==options.binding.key||value.binding.epoch!==options.binding.epoch))return[];
                                   
  if(options.admit!==false&&options.deadline!==undefined&&options.deadline-performance.now()<4500)return[];
  if(value.change&&!value.change.admitted)return updateHealthSnapshot(home,host,sessionId,contextKey,(_health,current,storage)=>sameNative(current,native)?changeNotices(storage,current.sender,options):[],native,timeout(3000))??[];
  if(value.pair.archived&&!value.loss)return[];
  if(value.partner.enabled===false)return[];
                                                
  if(value.loss)return updateHealthSnapshot(home,host,sessionId,contextKey,(_health,current,storage)=>{
    if(!current.loss||current.loss.id!==value.loss!.id||!sameNative(current,native))return[];
    return lossNotices(storage,current.sender,current.loss,options);
  },native,timeout(3000))??[];
  let brokerState:'blocked'|'unknown'='blocked',brokerFailure='broker endpoint unavailable';
  let requested=false;
  try{
    const rpc=await connectBroker(home,timeout(500));
    try{
      const requestTimeout=timeout(3500);requested=true;
      const result=(await rpc.request<{notices:RuntimeNotice[]}>('health.monitor',{actor:{host,memberId:value.sender.id,sessionId,callId:randomUUID(),...(value.binding?{binding:value.binding}:{})},...(contextKey?{context_key:contextKey}:{}),...(modVersion?{mod_version:modVersion}:{}),...(modRevision?{mod_revision:modRevision}:{}),admit:options.admit!==false,...(options.noticeId?{notice_id:options.noticeId}:{})},{timeout:requestTimeout,mutation:options.admit!==false})).notices;
      return result;
    }
    finally{rpc.close();}
  }catch(error){
                                            
    if(requested&&options.admit!==false&&(error as {uncertain?:boolean}).uncertain===true)throw error;
    const code=(error as {code?:string}).code??'';
    if(!['ENOENT','ECONNREFUSED','ECONNRESET','EPIPE','disconnected','broker_timeout','timeout','ETIMEDOUT'].includes(code))throw error;
    if(['broker_timeout','timeout','ETIMEDOUT'].includes(code)){brokerState='unknown';brokerFailure='broker runtime monitor timed out; delivery unverified';}
  }
  let suppressed=false;try{suppressed=await startupHeldElsewhere(home,timeout(1500));}catch(error){process.stderr.write('nxbridge startup reservation unverified: '+String((error as Error).message)+'\n');}
  const inbound=value.senderEndpoint?.nativeInbound,permission=value.senderEndpoint?.nativePermission?.permission??inbound?.permission;
  const eligible=value.sender.owner==='user'&&['root','fork'].includes(value.sender.kind)&&['ready','busy'].includes(value.sender.state)&&!value.pair.paused&&!value.pair.archived&&(!inbound||!['hold','refuse'].includes(inbound.policy))&&(inbound?.policy!=='default'||!!permission&&permission!=='unknown');
  const outage=await brokerOutageNotice(home,claimant,{...options,suppressed,eligible},records=>probeProcesses(records,timeout(1500)));
  if(outage)return[options.admit===false?noticeSignal(outage) as RuntimeNotice:outage];
  const config=loadConfig(home),token=config.codexAuthTokenEnv?process.env[config.codexAuthTokenEnv]:undefined;
  const [availability,bridge]=await Promise.all([
    probePeerRuntime(value.partner,value.endpoint,home,()=>value.endpoint?probeAppServer(value.endpoint.address,token,timeout(750)):Promise.resolve(false),options.deadline).catch(()=>({state:'unknown' as const,reasons:['partner runtime check failed'],checked_at:Date.now()})),
    host==='codex'&&value.senderEndpoint?.bridge&&!value.senderEndpoint.daemon?probeProcesses([value.senderEndpoint.bridge],timeout(1500)):Promise.resolve([]),
  ]);
  if(availability.state!=='blocked')availability.state=brokerState;
  availability.reasons.unshift(brokerFailure);
  if(bridge[0]&&bridge[0]!=='alive')availability.reasons.push(bridge[0]==='dead'?'sender MCP bridge exited or PID generation changed':'sender MCP bridge PID generation unverifiable');
  return updateHealthSnapshot(home,host,sessionId,contextKey,(health,current)=>{
    if(current.scope!==value.scope||!sameNative(current,native))return[];
    health.observe(current.pair,current.sender,current.partner,current.counts,availability,true,current.scope);
    if(['paused','needsHuman','offline'].includes(current.sender.state))return[];
    const notices=options.noticeId?([health.get(current.pair.id,current.sender.id,options.noticeId)].filter(Boolean) as RuntimeNotice[]):options.admit===false?health.peek(current.pair.id,current.sender.id,true):health.take(current.pair.id,current.sender.id,true);
                                                     
    const fresh=notices.filter(n=>!n.source);
    return options.admit===false?fresh.map(n=>noticeSignal(n) as RuntimeNotice):fresh.flatMap(n=>{const prepared=health.prepare(current.pair.id,current.sender.id,n.id,current.scope,true);return prepared?[prepared]:[];});
  },native,timeout(3000))??[];
}
export async function acknowledgeRuntimeNotice(home:string,host:Host,sessionId:string,native:Native,id:string,state:'submitted'|'denied'|'unknown',error?:string,contextKey?:string,timeoutMs=3000):Promise<void>{
  if(isBrokerOutageNotice(id)){
    if(state==='denied'){const value=readHealthSnapshot(home,host,sessionId,contextKey,native);if(value&&sameNative(value,native)){if(host==='claude')assertClaudeSession(value.senderEndpoint?.configHome,sessionId,native);releaseBrokerOutageClaim(home,{host,peerId:value.sender.id,sessionId,...native},id);}}
    return;
  }
  await retryStorageReceipt(remaining=>{
  if(state==='submitted')acknowledgeContextSnapshot(home,host,sessionId,native,id,contextKey,remaining());
  updateHealthSnapshot(home,host,sessionId,contextKey,(health,value,storage)=>{
    if(!sameNative(value,native))return;
    if(value.change?.id===id){if(value.change.admitted)storage.setSetting(pairChangeKey(value.sender.id),{...value.change,state,...(error?{error:error.slice(0,1200)}:{})});}
    else if(value.loss?.id===id){if(value.loss.admitted)storage.setSetting(pairLossKey(value.sender.id),{...value.loss,state,...(error?{error:error.slice(0,1200)}:{})});}
    else health.outcome(value.pair.id,value.sender.id,id,state,error?.slice(0,1200));
  },native,remaining());
  },timeoutMs);
}
