import { createReadStream, statSync, openSync, readSync, closeSync } from 'node:fs';

export interface HistoryReceipt {messageId:string;turnId:string;itemId:string;callId:string}
export interface HistoryCursor {dev:number;ino:number;offset:number}
export interface HistoryEvidence {status:'supported'|'unsupported'|'unavailable';receipts:HistoryReceipt[];calls:string[];complete?:boolean;reason?:string;cursor?:HistoryCursor;bytesRead?:number;checkpoint?:HistoryCheckpoint}
interface Call {count:number;receive:boolean;turnId:string}
interface Output {count:number;ids:string[];itemId:string;afterCall:boolean}
export interface HistoryCheckpoint {cursor:HistoryCursor;turnId:string;calls:[string,Call][];outputs:[string,Output][]}
interface ReadOptions {cursor?:HistoryCursor;tail?:boolean;since?:number;checkpoint?:boolean;resume?:HistoryCheckpoint}
interface Cache {dev:number;ino:number;size:number;mtime:number;offset:number;readOffset:number;tail:Buffer;skipping:boolean;verified:boolean;invalid:boolean;turnId:string;calls:Map<string,Call>;outputs:Map<string,Output>;result?:HistoryEvidence}
const READ_BYTES=8*1024*1024,LINE_BYTES=2*1024*1024,READ_MS=75;
const caches=new Map<string,Cache>(),pending=new Map<string,Promise<HistoryEvidence>>();

                                                 
function recentOffset(fd:number,size:number,since:number):number{
  const start=Math.max(0,size-READ_BYTES/2),bytes=Buffer.alloc(size-start),length=readSync(fd,bytes,0,bytes.length,start),first=start?bytes.indexOf(10)+1:0;
  if(start&&first===0)return size;
  let end=bytes.lastIndexOf(10,length-1);
  while(end>=first){
    const previous=end===0?-1:bytes.lastIndexOf(10,end-1),line=previous+1;
    if(line<first)break;
    const timestamp=/^\s*\{\s*"timestamp"\s*:\s*"([^"]+)"/.exec(bytes.subarray(line,Math.min(end,line+512)).toString('utf8'));
    if(timestamp&&Date.parse(timestamp[1]!)<since)return start+line;
    end=previous;
  }
  return start+first;
}
                                        
function irrelevantLargeLine(head:string,cache:Cache):boolean{
  let depth=0,payloadDepth=0,rowType:string|undefined;
  const fields:Record<string,string>={};
  for(let i=0;i<head.length;i++){
    const char=head[i];if(char==='{'){depth++;continue;}if(char==='}'){depth--;continue;}if(char!=='"')continue;
    const start=i++;for(;i<head.length;i++){if(head[i]==='\\'){i++;continue;}if(head[i]==='"')break;}if(i>=head.length)return false;
    let key:string;try{key=JSON.parse(head.slice(start,i+1));}catch{return false;}
    let next=i+1;while(/\s/.test(head[next]??'')&&next<head.length)next++;if(head[next]!==':')continue;next++;while(/\s/.test(head[next]??'')&&next<head.length)next++;
    if(depth===1&&key==='payload'&&head[next]==='{')payloadDepth=2;
    if(depth!==1&&depth!==payloadDepth||head[next]!=='"')continue;
    let end=next+1;for(;end<head.length;end++){if(head[end]==='\\'){end++;continue;}if(head[end]==='"')break;}if(end>=head.length)return false;
    let type:string;try{type=JSON.parse(head.slice(next,end+1));}catch{return false;}
    if(depth===1&&key==='type'){rowType=type;if(type!=='response_item')return true;}
    else if(depth===payloadDepth)fields[key]=type;
    if(rowType==='response_item'&&fields.type){
      if(!['function_call','function_call_output'].includes(fields.type))return true;
      if(fields.call_id?.startsWith('nxbridge-'))return false;
      if(fields.type==='function_call'&&fields.name)return !['receive_messages','mcp__claude__receive_messages'].includes(fields.name);
      if(fields.type==='function_call_output'&&fields.call_id){const call=cache.calls.get(fields.call_id);if(call)return !call.receive;}
    }
  }
  return false;
}
function outputMessages(output:unknown,skipPlainText=false):any[]{
  if(typeof output==='string'){
                                                 
    if(skipPlainText&&!/^\s*(?:\{|\[|")/.test(output))return[];
    try{return outputMessages(JSON.parse(output),skipPlainText);}catch{return[];}
  }
  if(Array.isArray(output))return output.filter(item=>item?.type==='text'||item?.type==='input_text').flatMap(item=>outputMessages(item.text,skipPlainText));
  if(!output||typeof output!=='object')return[];
  const value=output as any;
  if(Array.isArray(value.messages)||Array.isArray(value.notices))return[...(value.messages??[]),...(value.notices??[]).map((notice:any)=>({message_id:notice?.notice_id}))];
  return Array.isArray(value.content)?value.content.filter((item:any)=>item?.type==='text').flatMap((item:any)=>outputMessages(item.text,skipPlainText)):[];
}
const receiveCall=(item:any)=>item.type==='function_call'&&(item.name==='mcp__claude__receive_messages'||item.name==='receive_messages'&&item.namespace==='claude');
function accept(cache:Cache,line:string,sessionId:string):void{
  if(!line.trim())return;
                                              
  if(cache.verified&&!/function_call|task_started|session_meta/.test(line)){if(!line.trimEnd().endsWith('}'))cache.invalid=true;return;}
  let row:any;try{row=JSON.parse(line);}catch{cache.invalid=true;return;}
  if(!cache.verified){if(row.type!=='session_meta'||row.payload?.id!==sessionId){cache.invalid=true;return;}cache.verified=true;return;}
                                        
  if(row.type==='session_meta')return;
  if(row.type==='event_msg'&&row.payload?.type==='task_started'&&typeof row.payload.turn_id==='string')cache.turnId=row.payload.turn_id;
  if(row.type!=='response_item')return;
  const item=row.payload;if(!item||typeof item!=='object'){cache.invalid=true;return;}
  if(item.type!=='function_call'&&item.type!=='function_call_output'||typeof item.call_id!=='string'||!item.call_id)return;
  if(item.type==='function_call'){const old=cache.calls.get(item.call_id);cache.calls.set(item.call_id,{count:(old?.count??0)+1,receive:receiveCall(item),turnId:cache.turnId});return;}
  const old=cache.outputs.get(item.call_id),call=cache.calls.get(item.call_id),valid=(item.name===undefined||['receive_messages','mcp__claude__receive_messages'].includes(item.name))&&(item.namespace===undefined||item.namespace==='claude');
  cache.outputs.set(item.call_id,{count:(old?.count??0)+1,afterCall:cache.calls.has(item.call_id),itemId:typeof item.id==='string'?item.id:item.call_id,ids:valid?outputMessages(item.output,call?.count===1&&!call.receive&&!old).flatMap(message=>typeof message?.message_id==='string'&&message.message_id?[message.message_id]:[]):[]});
}
                                                         
export async function readCodexHistory(filename:unknown,sessionId:string,options:ReadOptions={}):Promise<HistoryEvidence>{
  if(typeof filename!=='string'||!filename)return{status:'unavailable',receipts:[],calls:[],reason:'官方线程没有提供可读取的持久历史路径'};
  const key=JSON.stringify([filename,sessionId,options.checkpoint?'repair':options.cursor??(options.since===undefined?options.tail?'tail':'full':{since:options.since})]),running=pending.get(key);if(running)return running;
  const work=read(filename,sessionId,key,options).finally(()=>pending.delete(key));pending.set(key,work);return work;
}
async function read(filename:string,sessionId:string,key:string,options:ReadOptions):Promise<HistoryEvidence>{
  let stream:ReturnType<typeof createReadStream>|undefined;
  try{
    const stat=statSync(filename);let cache=caches.get(key);
    const cursor=options.cursor??options.resume?.cursor;
    if(cursor&&(cursor.dev!==stat.dev||cursor.ino!==stat.ino||cursor.offset>stat.size))return{status:'unavailable',receipts:[],calls:[],complete:false,reason:'持久历史已轮换或截断，旧游标不能证明提交结果'};
    if(cache&&cache.dev===stat.dev&&cache.ino===stat.ino&&cache.size===stat.size&&cache.mtime===stat.mtimeMs&&cache.readOffset>=stat.size&&cache.result)return{...cache.result,bytesRead:0};
    if(!cache||cache.dev!==stat.dev||cache.ino!==stat.ino||stat.size<cache.size||stat.size===cache.size&&cache.mtime!==stat.mtimeMs){
      cache={dev:stat.dev,ino:stat.ino,size:0,mtime:0,offset:0,readOffset:0,tail:Buffer.alloc(0),skipping:false,verified:false,invalid:false,turnId:'persisted-history',calls:new Map(),outputs:new Map()};
      if(cursor||options.tail||options.since!==undefined){
        const fd=openSync(filename,'r');try{
          const head=Buffer.alloc(Math.min(stat.size,65536)),length=readSync(fd,head,0,head.length,0),newline=head.subarray(0,length).indexOf(10);
          if(newline<0)return{status:'unavailable',receipts:[],calls:[],complete:false,reason:'持久历史首条身份记录尚不完整'};
          accept(cache,head.subarray(0,newline).toString('utf8'),sessionId);
          if(!cache.verified||cache.invalid)return{status:'unsupported',receipts:[],calls:[],complete:false,reason:'持久历史首条身份与目标不符'};
          if(cursor){cache.offset=cursor.offset;if(options.resume){cache.turnId=options.resume.turnId;cache.calls=new Map(options.resume.calls);cache.outputs=new Map(options.resume.outputs);}}
          else if(options.since!==undefined)cache.offset=recentOffset(fd,stat.size,options.since);
          else if(stat.size){
            const tail=Buffer.alloc(Math.min(stat.size,65536));readSync(fd,tail,0,tail.length,stat.size-tail.length);const last=tail.lastIndexOf(10);
            if(last<0)return{status:'unavailable',receipts:[],calls:[],complete:false,reason:'持久历史尾部尚无可核验的完整行边界'};
            cache.offset=stat.size-tail.length+last+1;
          }
          cache.readOffset=cache.offset;
        }finally{closeSync(fd);}
      }
    }
    caches.delete(key);caches.set(key,cache);while(caches.size>16)caches.delete(caches.keys().next().value!);
    const started=performance.now(),before=cache.readOffset;
    if(stat.size>cache.readOffset){
      stream=createReadStream(filename,{start:cache.readOffset,end:Math.min(stat.size,cache.readOffset+READ_BYTES)-1,highWaterMark:65536});
      for await(const chunk of stream){
        const bytes=chunk as Buffer;cache.readOffset+=bytes.length;let tail=Buffer.concat([cache.tail,bytes]),newline:number;
        if(cache.skipping){const end=tail.indexOf(10);if(end<0){cache.tail=Buffer.alloc(0);continue;}cache.skipping=false;tail=tail.subarray(end+1);cache.offset=cache.readOffset-tail.length;}
        while((newline=tail.indexOf(10))>=0){
          const line=tail.subarray(0,newline);tail=tail.subarray(newline+1);
          if(line.length>LINE_BYTES){if(!irrelevantLargeLine(line.subarray(0,65536).toString('utf8'),cache))cache.invalid=true;}else accept(cache,line.toString('utf8'),sessionId);
          cache.offset=cache.readOffset-tail.length;
        }
        if(tail.length>LINE_BYTES){cache.skipping=true;if(!irrelevantLargeLine(tail.subarray(0,65536).toString('utf8'),cache))cache.invalid=true;tail=Buffer.alloc(0);}
        cache.tail=Buffer.from(tail);if(performance.now()-started>=READ_MS)break;
      }
    }
    cache.size=stat.size;cache.mtime=stat.mtimeMs;
    const extra={complete:cache.readOffset>=stat.size&&!cache.tail.length&&!cache.skipping,cursor:{dev:stat.dev,ino:stat.ino,offset:cache.offset},bytesRead:cache.readOffset-before};
    if(!cache.verified||cache.invalid)return cache.result={status:'unsupported',receipts:[],calls:[],...extra,complete:false,reason:'原生持久历史格式、行大小或目标线程无法完整核验'};
    const receipts:HistoryReceipt[]=[];
    for(const [callId,value] of cache.outputs){const call=cache.calls.get(callId);if(!call?.receive||call.count!==1||value.count!==1||!value.afterCall)continue;for(const messageId of value.ids)receipts.push({messageId,callId,turnId:call.turnId,itemId:value.itemId});}
    return cache.result={status:'supported',receipts,calls:[...new Set([...cache.calls.keys(),...cache.outputs.keys()])],...extra,...(options.checkpoint&&!extra.complete?{checkpoint:{cursor:extra.cursor,turnId:cache.turnId,calls:[...cache.calls],outputs:[...cache.outputs]}}:{})};
  }catch(error){return{status:'unavailable',receipts:[],calls:[],reason:'原生持久历史不可读取：'+(error as NodeJS.ErrnoException).code};}
  finally{stream?.destroy();}
}
