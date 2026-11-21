import { createHash } from 'node:crypto';
import type { RpcMessage } from '../../ipc/rpc.js';
import type { ModelRequestStatus } from '../../hosts/codex/codex-model-request.js';

export const SILENCE_MS=10*60*1000,RECENT_PROGRESS_MS=30000;
export interface NativeHumanRequest {id:string;method:string;itemId?:string}
export interface NativeIssue {kind:'tool_failed'|'approval_denied'|'sandbox_denied';turn_id:string;item_id?:string;tool?:string;exit_code?:number;message?:string;at:number}
                                         
export function nativeToolIssue(item:any,turnId:string,at:number):NativeIssue|undefined{
  const failed=item?.status==='failed'||item?.status==='declined'||item?.error||typeof item?.exitCode==='number'&&item.exitCode!==0;
  if(!failed)return;
  const code=typeof item.error?.code==='string'?item.error.code.toLowerCase():'';
  const kind=code==='sandbox_denied'?'sandbox_denied':['permission_denied','approval_denied','user_denied','user_declined'].includes(code)||item.status==='declined'?'approval_denied':'tool_failed';
  return{kind,turn_id:turnId,...(typeof item.id==='string'?{item_id:item.id}:{}),...(typeof item.type==='string'?{tool:item.type}:{}),...(typeof item.exitCode==='number'?{exit_code:item.exitCode}:{}),...(typeof item.error?.message==='string'?{message:item.error.message.slice(0,800)}:{}),at};
}
export function providerRetryInfo(config:any):Record<string,unknown>{
  const provider=config?.model_provider??'openai',value=config?.model_providers?.[provider]??{},request=value.request_max_retries??4,stream=value.stream_max_retries??5;
  const scope=createHash('sha256').update(JSON.stringify([provider,value.base_url??'',value.wire_api??''])).digest('hex').slice(0,24);
  return{provider,scope,requestMaxRetries:request,streamMaxRetries:stream,streamIdleTimeoutMs:value.stream_idle_timeout_ms??300000,...(request>=20||stream>=20?{warning:`模型供应商 ${provider} 配置了请求重试 ${request} 次、流重试 ${stream} 次（官方默认 4 次、5 次）；断网时 Codex 可能长时间没有任何输出。nxbridge 不会改动这些设置。`}:{})};
}
export interface TurnHealth {
  turnId:string;lastProgressAt:number;lastEventAt:number;state:'running'|'networkRetrying'|'silent'|'waitingTool'|'needsHuman'|'ready'|'failed';
  retry?:{message:string;attempt?:number;max?:number;since:number};tools:string[];observedProgressAt?:number;
  completion?:string;error?:string;
  source?:'native-hook'|'native-mod';
  humanRequests?:NativeHumanRequest[];nativeIssue?:NativeIssue;
  modelRequest?:ModelRequestStatus;
  progressEvidence?:boolean;
}
export function currentHealthIssue(value:TurnHealth,now=Date.now()):TurnHealth{
  if(value.nativeIssue&&(now-value.nativeIssue.at>15*60*1000||value.nativeIssue.kind==='tool_failed'&&value.state==='ready'&&value.completion!=='failed')){const result={...value};delete result.nativeIssue;return result;}
  return value;
}
const incoming=(item:any)=>item?.type==='functionCallOutput'&&item.namespace==='claude'&&item.name==='receive_messages';
const tool=(item:any)=>/^(?:commandExecution|mcpToolCall|dynamicToolCall|functionCall|customToolCall|webSearch|fileChange)$/i.test(item?.type??'');
function turnFingerprint(turn:any,items:any[]):string{
  const hash=createHash('sha256').update(JSON.stringify([turn.id,turn.status,items.length]));
  for(const item of items){
    const text=item.text,raw=typeof text==='string',encoding=raw&&!/[\uD800-\uDFFF]/u.test(text)?'utf8':'utf16le';
    hash.update(JSON.stringify([item.id,item.type,item.status,item.updatedAt??item.updated_at,raw,raw?text.length:text,...(raw?[encoding]:[])]));
                                                        
    if(raw)hash.update(text,encoding);
  }
  return hash.digest('hex');
}
export class TurnHealthTracker {
  private turns=new Map<string,{health:TurnHealth;fingerprint?:string;revision:number;nativeStarted?:boolean}>();
  private sequence=0;
  constructor(private now=Date.now){}
  key(address:string,id:string):string{return address+'|'+id;}
  revision(address:string,id:string):number{return this.turns.get(this.key(address,id))?.revision??0;}
  hasSnapshot(address:string,id:string):boolean{return this.turns.get(this.key(address,id))?.fingerprint!==undefined;}
  unverified(address:string,id:string,expectedRevision:number):void{
    const value=this.turns.get(this.key(address,id));if(value?.revision===expectedRevision)value.health.progressEvidence=false;
  }
  get(address:string,id:string):TurnHealth|undefined{
    const value=this.turns.get(this.key(address,id))?.health;if(!value)return;
    const state=['ready','failed','needsHuman'].includes(value.state)?value.state:value.retry?'networkRetrying':value.tools.length?'waitingTool':this.now()-value.lastProgressAt>=SILENCE_MS?'silent':'running';
    return currentHealthIssue({...value,state,tools:[...value.tools]},this.now());
  }
  forget(address:string):void{for(const key of this.turns.keys())if(key.startsWith(address+'|'))this.turns.delete(key);}
  prune(retained:ReadonlySet<string>,before:number):void{for(const[key,value]of this.turns)if(!retained.has(key)&&value.health.lastEventAt<before)this.turns.delete(key);}
  observe(address:string,message:RpcMessage):void{
    const p=message.params??{},id=p.threadId;if(typeof id!=='string')return;
    const key=this.key(address,id),now=this.now(),turnId=p.turnId??p.turn?.id,method=message.method??'';
    let value=this.turns.get(key)?.health;
    if(method==='turn/started'&&value?.turnId===turnId)return;
    if(method==='turn/started'||!value&&typeof turnId==='string'){
      value={turnId,lastProgressAt:now,lastEventAt:now,state:'running',tools:[]};this.turns.set(key,{health:value,revision:++this.sequence,nativeStarted:method==='turn/started'});
    }
    if(!value||turnId&&value.turnId!==turnId)return;
                                   
    if(['ready','failed'].includes(value.state)&&method!=='turn/completed'&&method!=='thread/status/changed')return;
    this.turns.get(key)!.revision=++this.sequence;
    value.lastEventAt=now;
    if(/(?:requestApproval|requestUserInput)$/.test(method)){
      const request={id:String(message.id),method,...(typeof p.itemId==='string'?{itemId:p.itemId}:{})};
      value.humanRequests=[...(value.humanRequests??[]).filter(row=>row.id!==request.id),request].slice(-64);value.state='needsHuman';return;
    }
    if(method==='error'&&p.willRetry===true){
      const text=String(p.error?.message??p.message??'native retry'),match=/(?:reconnect|retry)\D*(\d+)\s*\/\s*(\d+)/i.exec(text);
      value.retry={message:text.slice(0,1200),since:value.retry?.since??now,...(match?{attempt:Number(match[1]),max:Number(match[2])}:{})};return;
    }
    if(method==='thread/status/changed'){
      if((p.status?.activeFlags??[]).some((flag:string)=>/approval|input/i.test(flag))){value.state='needsHuman';if(!value.humanRequests?.length)value.humanRequests=[{id:'native-status',method:'thread/status/changed',...(value.tools.length===1?{itemId:value.tools[0]}:{})}];}
      else if(p.status?.type==='idle'||p.status?.type==='notLoaded'){value.state=value.completion==='failed'?'failed':'ready';delete value.retry;value.tools=[];delete value.humanRequests;}
      else if(p.status?.type==='active'){delete value.humanRequests;if(value.state==='needsHuman')value.state='running';}
      return;
    }
    if(method==='turn/completed'){value.state=p.turn?.status==='failed'?'failed':'ready';value.completion=p.turn?.status;value.error=p.turn?.error?.message?.slice(0,1200);value.observedProgressAt=now;delete value.retry;delete value.humanRequests;value.tools=[];return;}
                                    
    if((method==='item/started'||method==='item/completed')&&!incoming(p.item)){
      if(tool(p.item)&&typeof p.item.id==='string')value.tools=method==='item/started'?[...new Set([...value.tools,p.item.id])]:value.tools.filter(id=>id!==p.item.id);
      if(method==='item/completed'){
        value.humanRequests=value.humanRequests?.filter(request=>!request.itemId||request.itemId!==p.item?.id);
        const issue=nativeToolIssue(p.item,value.turnId,now);if(issue)value.nativeIssue=issue;else if(value.nativeIssue?.item_id===p.item?.id)delete value.nativeIssue;
      }
      value.lastProgressAt=now;value.observedProgressAt=now;value.state=value.humanRequests?.length?'needsHuman':'running';delete value.retry;
      value.progressEvidence=true;
    }else if(/^item\/(?:agentMessage|reasoning|commandExecution)\/.*(?:Delta|delta)$/.test(method)){
      value.lastProgressAt=now;value.observedProgressAt=now;if(value.state!=='needsHuman')value.state='running';delete value.retry;
      value.progressEvidence=true;
    }
  }
  read(address:string,thread:any,expectedRevision?:number):TurnHealth|undefined{
    if(typeof thread?.id!=='string')return;
                                         
    if(expectedRevision!==undefined&&this.revision(address,thread.id)!==expectedRevision)return this.get(address,thread.id);
    const key=this.key(address,thread.id),turn=thread.turns?.at(-1),inactive=['idle','notLoaded'].includes(thread.status?.type),now=this.now();
    if(!turn?.id){
      const tracked=this.turns.get(key);
      if(tracked&&thread.progressEvidence===false)tracked.health.progressEvidence=false;
      if(inactive&&tracked){const value=tracked.health;tracked.revision=++this.sequence;value.lastEventAt=now;value.state=value.state==='failed'?'failed':'ready';value.completion??='inactive';value.tools=[];delete value.retry;delete value.humanRequests;}
      return this.get(address,thread.id);
    }
    const items=(turn.items??[]).filter((item:any)=>!incoming(item));
    let tracked=this.turns.get(key);
    const onlyIncoming=(turn.items??[]).length>0&&!items.length;
    const fingerprint=onlyIncoming&&tracked&&tracked.health.turnId===turn.id&&tracked.fingerprint!==undefined?tracked.fingerprint:turnFingerprint(turn,items);
    if(!inactive&&tracked?.nativeStarted&&tracked.health.turnId!==turn.id&&!thread.turns.some((row:any)=>row.id===tracked!.health.turnId))return this.get(address,thread.id);
    if(tracked&&tracked.health.turnId===turn.id&&['ready','failed'].includes(tracked.health.state)&&turn.status==='inProgress')return this.get(address,thread.id);
    if(!tracked||tracked.health.turnId!==turn.id){tracked={health:{turnId:turn.id,lastProgressAt:now,lastEventAt:now,state:'running',tools:[]},fingerprint:thread.progressEvidence===false?undefined:fingerprint,revision:++this.sequence};this.turns.set(key,tracked);}
    else if(thread.progressEvidence!==false&&tracked.fingerprint!==undefined&&tracked.fingerprint!==fingerprint){tracked.health.lastProgressAt=now;tracked.health.observedProgressAt=now;delete tracked.health.retry;}
    if(thread.progressEvidence!==false)tracked.fingerprint=fingerprint;
    tracked.revision=++this.sequence;
    const value=tracked.health;
    value.progressEvidence=thread.progressEvidence!==false;
    value.lastEventAt=now;
    value.tools=items.filter((item:any)=>tool(item)&&item.status==='inProgress').map((item:any)=>item.id);
    const waiting=(thread.status?.activeFlags??[]).some((flag:string)=>/approval|input/i.test(flag));
    if(!waiting&&thread.status)delete value.humanRequests;
    if(waiting&&!value.humanRequests?.length)value.humanRequests=[{id:'native-status',method:'thread/read',...(value.tools.length===1?{itemId:value.tools[0]}:{})}];
    const issue=items.map((item:any)=>nativeToolIssue(item,turn.id,now)).filter(Boolean).at(-1);
    if(issue){if(!value.nativeIssue||value.nativeIssue.item_id!==issue.item_id||value.nativeIssue.kind!==issue.kind||value.nativeIssue.exit_code!==issue.exit_code)value.nativeIssue=issue;}else if(value.nativeIssue&&items.some((item:any)=>item.id===value.nativeIssue!.item_id&&item.status!=='inProgress'))delete value.nativeIssue;
    value.state=turn.status==='failed'?'failed':inactive?'ready':waiting?'needsHuman':turn.status!=='inProgress'?'ready':'running';
    value.completion=inactive&&turn.status==='inProgress'?'inactive':turn.status;value.error=turn.error?.message?.slice(0,1200);
    if(['ready','failed'].includes(value.state)){value.tools=[];delete value.retry;delete value.humanRequests;}
    return this.get(address,thread.id);
  }
}
