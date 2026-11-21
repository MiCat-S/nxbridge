import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { TurnHealth } from '../../broker/health/turn-health.js';

export interface ModelRequestStatus {
  state:'retrying'|'failed'|'succeeded';kind:'http'|'auth'|'quota'|'network'|'timeout'|'request';
  statusCode?:number;at:number;source:'native-log'|'app-server';attempt?:number;blocking?:boolean;
}
interface LogRow {ts:number;ts_nanos:number;target:string;process_uuid:string;feedback_log_body:string}

                                                   
export function modelRequestLog(row:LogRow,turnId:string,pid:number):ModelRequestStatus|undefined{
  if(row.target!=='codex_http_client::client'&&row.target!=='codex_core::session::turn')return;
  if(!row.process_uuid.startsWith('pid:'+pid+':'))return;
  const text=row.feedback_log_body,turns=[...text.matchAll(/\bturn(?:\.id|_id)="?([a-zA-Z0-9_-]+)/g)].map(match=>match[1]);
  if(!turns.length||turns.some(id=>id!==turnId))return;
  const at=row.ts*1000+Math.floor(row.ts_nanos/1e6);
  if(!Number.isFinite(at))return;
                                               
  if(row.target==='codex_core::session::turn'){
    const error=/(?:^|:\s*)Turn error:\s*(\{.*\})\s*$/s.exec(text);if(!error)return;
    try{
      const value=JSON.parse(error[1]!);
      if(value?.type!=='error'||!value.error||typeof value.error!=='object'||Array.isArray(value.error)||!Number.isInteger(value.status)||value.status<400||value.status>=600)return;
      return{state:'failed',kind:[401,403].includes(value.status)?'auth':value.status===429?'quota':'http',statusCode:value.status,at,source:'native-log'};
    }catch{return;}
  }
  if(row.target!=='codex_http_client::client'||!text.includes('api.path="/responses"'))return;
  const event=text.slice(text.lastIndexOf('}:')+2).split(/\b(?:headers|body)=/)[0]!;
  const status=/^\s*Request completed method=POST .*?\bstatus=(\d{3})\b/.exec(event);
  if(status){
    const code=Number(status[1]);if(code<200||code>=600)return;
    return{state:code<400?'succeeded':'retrying',kind:[401,403].includes(code)?'auth':code===429?'quota':'http',statusCode:code,at,source:'native-log'};
  }
  if(/^\s*Request failed\b/.test(event)){
    if(/\b(?:TimedOut|Timeout|is_timeout=true)\b/.test(event))return{state:'retrying',kind:'timeout',at,source:'native-log'};
    if(/\b(?:Connect|is_connect=true|ConnectionRefused|Dns)\b/.test(event))return{state:'retrying',kind:'network',at,source:'native-log'};
    return{state:'retrying',kind:'request',at,source:'native-log'};
  }
}

                                           
export class CodexModelRequests {
  private cache=new Map<string,{at:number;value?:ModelRequestStatus}>();
  read(home:string,sessionId:string,turnId:string,pid:number):ModelRequestStatus|undefined{
    const key=JSON.stringify([home,sessionId,turnId,pid]),cached=this.cache.get(key),now=Date.now();
    if(cached&&now-cached.at<5000)return cached.value;
    let db:DatabaseSync|undefined,value:ModelRequestStatus|undefined;
    try{
      const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
      db=new DatabaseSync(path.join(home,'logs_2.sqlite'),{readOnly:true,timeout:50});
      {
        const rows=db.prepare("SELECT ts,ts_nanos,target,process_uuid,feedback_log_body FROM logs WHERE thread_id=? ORDER BY ts DESC,ts_nanos DESC,id DESC LIMIT 256").all(sessionId) as unknown as LogRow[];
        for(const row of rows){value=modelRequestLog(row,turnId,pid);if(value)break;}
      }
    }catch{}finally{db?.close();}
    this.cache.delete(key);this.cache.set(key,{at:now,value});while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}

export function providerBlocked(health:TurnHealth|undefined):boolean{
  const request=health?.modelRequest;
  return !!request&&request.state==='retrying'&&request.at>=health!.lastProgressAt&&!['ready','failed','needsHuman'].includes(health!.state)&&!health!.tools.length;
}
export function withModelRequest(health:TurnHealth,request:ModelRequestStatus|undefined):TurnHealth{
  if(!request)return health;
  const result:TurnHealth={...health,modelRequest:{...request,state:request.state!=='retrying'?request.state:health.state==='failed'||request.at<health.lastProgressAt||health.state==='ready'?'failed':'retrying'}};
  result.modelRequest!.blocking=providerBlocked(result);return result;
}
export function modelRequestText(request:ModelRequestStatus):string{
  const cause=request.kind==='auth'?'模型服务拒绝了登录凭据':request.kind==='quota'?'模型服务限流或额度不足':request.statusCode&&request.statusCode>=500?`模型服务暂时不可用（返回 ${request.statusCode}）`:request.statusCode?`模型服务返回 ${request.statusCode}`:request.kind==='timeout'?'模型请求超时':request.kind==='request'?'模型请求失败':'连不上模型服务';
  return `${cause}，${request.state==='failed'?'本轮已停止':request.state==='succeeded'?'最近请求已成功':'正在等待重试'}（最近一次 ${new Date(request.at).toLocaleTimeString('zh-CN',{hour12:false})}）`;
}
