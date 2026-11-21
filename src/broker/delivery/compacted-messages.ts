import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';

type Exchange='send_message'|'receive_messages';
function exchange(item:any):Exchange|undefined{
  const name=typeof item?.name==='string'?item.name:'',namespace=item?.namespace;
  if(namespace==='claude'&&['send_message','receive_messages'].includes(name))return name as Exchange;
  const match=/^(?:mcp__)?claude(?:__|\.)(send_message|receive_messages)$/.exec(name);
  return match?.[1] as Exchange|undefined;
}

                                               
function outputIds(value:any,kind:Exchange,ids:Set<string>):void{
  if(typeof value==='string'){try{outputIds(JSON.parse(value),kind,ids);}catch{}return;}
  if(Array.isArray(value)){for(const block of value)if(['text','input_text','output_text'].includes(block?.type))outputIds(block.text,kind,ids);return;}
  if(!value||typeof value!=='object')return;
  const add=(id:unknown)=>{if(typeof id==='string'&&id.length&&id.length<=128)ids.add(id);};
  if(kind==='receive_messages'&&Array.isArray(value.messages))for(const message of value.messages)if(typeof message?.message==='string')add(message.message_id);
  if(kind==='send_message'&&value.persisted===true)add(value.message_id);
  if(Array.isArray(value.content))outputIds(value.content,kind,ids);
  if(value.structuredContent)outputIds(value.structuredContent,kind,ids);
}

                                            
async function windowStart(file:FileHandle,size:number,check:()=>void):Promise<number>{
  let position=size,boundaries=0,fragments:Buffer[]=[];
  const boundary=(parts:Buffer[])=>{
                                             
    const line=parts.length===1?parts[0]!:Buffer.concat(parts);
    if(!line.includes('"compacted"'))return false;
    try{return JSON.parse(line.toString('utf8')).type==='compacted';}catch{return false;}
  };
  while(position>0){
    check();const start=Math.max(0,position-64*1024),chunk=Buffer.allocUnsafe(position-start);
    const {bytesRead}=await file.read(chunk,0,chunk.length,start);check();
    let end=bytesRead;
    for(let newline=chunk.lastIndexOf(10,end-1);newline>=0;newline=chunk.lastIndexOf(10,end-1)){
      check();const parts=[chunk.subarray(newline+1,end),...fragments.toReversed()];fragments=[];
      if(boundary(parts)&&++boundaries===2)return start+newline+1;
      end=newline;if(!end)break;
    }
    fragments.push(chunk.subarray(0,end));position=start;
  }
  return 0;
}

                                       
export async function compactedMessageIds(transcript:string,budgetMs=3000):Promise<string[]>{
  const deadline=performance.now()+budgetMs,signal=AbortSignal.timeout(budgetMs),check=()=>{signal.throwIfAborted();if(performance.now()>=deadline)throw Error('压缩窗口读取超过时间预算');};
  check();const file=await open(transcript,'r');let start:number,size:number;
  try{size=(await file.stat()).size;start=await windowStart(file,size,check);}finally{await file.close();}
  if(!size)return[];check();
  let ids=new Set<string>(),calls=new Map<string,Exchange>(),compacted:string[]=[];
  const consume=(item:any)=>{
    if(!item||typeof item!=='object')return;
    const kind=exchange(item);
    if(['function_call','custom_tool_call'].includes(item.type)&&typeof item.call_id==='string'&&kind)calls.set(item.call_id,kind);
    if(item.type==='function_call_output'||item.type==='custom_tool_call_output'){
      const source=kind??calls.get(item.call_id);if(source)outputIds(item.output,source,ids);
    }
  };
  const stream=createReadStream(transcript,{encoding:'utf8',start,end:size-1,signal}),lines=createInterface({input:stream,crlfDelay:Infinity});
  try{
    for await(const line of lines){
      check();
      let row:any;try{row=JSON.parse(line);}catch{continue;}
      if(row.type==='response_item')consume(row.payload);
      else if(row.type==='compacted'){
        compacted=[...ids];ids=new Set();calls=new Map();
        if(Array.isArray(row.payload?.replacement_history))for(const item of row.payload.replacement_history)consume(item);
      }
    }
  }finally{lines.close();stream.destroy();}
  return compacted;
}
