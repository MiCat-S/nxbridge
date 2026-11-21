import type { RpcClient } from '../../ipc/rpc.js';
import {BridgeError} from '../../shared/errors.js';
import type { CodexThread } from './adapter.js';
import { codexThreadUnmaterialized } from './codex-thread-state.js';

const capabilities=new WeakMap<RpcClient,Set<string>>();
const threadCapabilities=new WeakMap<RpcClient,Set<string>>();
const pending=new WeakMap<RpcClient,Map<string,Promise<CodexThread>>>();
const unsupported=(error:unknown)=>/method not found|unknown (?:method|variant)|not supported|unsupported|unrecognized.*method/i.test(String((error as Error)?.message??error))||String((error as {code?:unknown})?.code)==='-32601';
const unavailable=(rpc:RpcClient,method:string,threadId:string)=>capabilities.get(rpc)?.has(method)||threadCapabilities.get(rpc)?.has(method+'|'+threadId);
function rememberUnsupported(rpc:RpcClient,method:string,threadId:string,error:unknown):void{
  const global=String((error as {code?:unknown}).code)==='-32601'||/method not found|unknown method/i.test(String((error as Error).message)),map=global?capabilities:threadCapabilities;
  let values=map.get(rpc);if(!values){values=new Set();map.set(rpc,values);}values.add(global?method:method+'|'+threadId);
}

                                             
export function readCodexThread(rpc:RpcClient,threadId:string,options:{turnId?:string;timeout?:number;progress?:boolean}={}):Promise<CodexThread>{
  let reads=pending.get(rpc);if(!reads){reads=new Map();pending.set(rpc,reads);}
  const key=threadId+'|'+(options.turnId??'')+'|'+!!options.progress,active=reads.get(key);if(active)return active;
  const work=(async()=>{
    const {thread}=await rpc.request('thread/read',{threadId,includeTurns:false},{timeout:options.timeout??5000});
    if(thread?.id!==threadId)throw new BridgeError('session_changed','原生证据返回了不同的线程。');
    if(unavailable(rpc,'thread/turns/list',threadId))return{...thread,turns:[],...(options.progress?{progressEvidence:false}:{})};
    try{
      const page=await rpc.request('thread/turns/list',{threadId,limit:options.turnId?16:1,sortDirection:'desc',itemsView:'summary'},{timeout:options.timeout??5000});
                                           
      const value={...thread,turns:[...(page.data??[])].reverse()};
      return options.progress?await readProgress(rpc,value,options.timeout):value;
    }catch(error){
      if(codexThreadUnmaterialized(error as {code?:unknown;message?:string},threadId))return{...thread,turns:[],...(options.progress&&thread.status?.type==='active'?{progressEvidence:false}:{})};
      if(!unsupported(error))throw error;rememberUnsupported(rpc,'thread/turns/list',threadId,error);return{...thread,turns:[],...(options.progress?{progressEvidence:false}:{})};
    }
  })().finally(()=>reads!.delete(key));reads.set(key,work);return work;
}

                                       
async function readProgress(rpc:RpcClient,thread:CodexThread,timeout=3000):Promise<CodexThread>{
  const turn=thread.turns?.at(-1);if(!turn?.id)return{...thread,progressEvidence:thread.status?.type!=='active'};
  if(turn.status!=='inProgress')return thread;
  if(unavailable(rpc,'thread/items/list',thread.id))return{...thread,progressEvidence:false};
  try{
    const page=await rpc.request<ItemPage>('thread/items/list',{threadId:thread.id,turnId:turn.id,limit:1,sortDirection:'desc'},{timeout});
    if(!Array.isArray(page.data))return{...thread,progressEvidence:false};
    const entry=page.data[0],item=entry?.item??entry;
    if(entry&&(entry.turnId&&entry.turnId!==turn.id||typeof item?.id!=='string'))return{...thread,progressEvidence:false};
    return{...thread,progressEvidence:true,turns:[...thread.turns!.slice(0,-1),{...turn,items:item?[item]:[]}]};
  }catch(error){if(!unsupported(error))throw error;rememberUnsupported(rpc,'thread/items/list',thread.id,error);return{...thread,progressEvidence:false};}
}

interface ItemPage {data:any[];nextCursor?:string|null}
interface ItemFrontier {seen:Set<string>}
export interface ItemEvidence {items:any[];complete:boolean;reason?:string}
const frontiers=new WeakMap<RpcClient,Map<string,ItemFrontier>>();

                                         
export async function readCodexItems(rpc:RpcClient,threadId:string,turnId?:string):Promise<ItemEvidence>{
  if(unavailable(rpc,'thread/items/list',threadId))return{items:[],complete:false,reason:'原生宿主不支持此线程的有界条目读取'};
  let values=frontiers.get(rpc);if(!values){values=new Map();frontiers.set(rpc,values);}
  const key=threadId+'|'+(turnId??''),previous=values.get(key);
  const result:any[]=[],seen=new Set<string>();let cursor:string|undefined,complete=false;
  try{
    for(let pageIndex=0;pageIndex<2;pageIndex++){
      const page=await rpc.request<ItemPage>('thread/items/list',{threadId,...(turnId?{turnId}:{}),limit:16,sortDirection:'desc',...(cursor?{cursor}:{})},{timeout:3000});
      let caughtUp=false;for(const entry of page.data??[]){const id=entry?.item?.id??entry?.id;if(typeof id==='string'){if(previous?.seen.has(id)){caughtUp=true;break;}if(!seen.has(id)){result.push(entry);seen.add(id);}}}
      if(caughtUp){complete=true;break;}
      cursor=page.nextCursor??undefined;if(!cursor){complete=true;break;}
    }
                                         
    if((complete||!previous)&&seen.size)values.set(key,{seen});
    while(values.size>32)values.delete(values.keys().next().value!);
    return{items:result,complete,...(!complete?{reason:'新近条目超出本轮分页预算，缺席结果未知'}:{})};
  }catch(error){if(unsupported(error)){rememberUnsupported(rpc,'thread/items/list',threadId,error);return{items:[],complete:false,reason:'原生宿主不支持有界条目读取'};}throw error;}
}
