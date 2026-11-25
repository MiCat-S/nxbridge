import {open} from 'node:fs/promises';

interface PendingTool {id:string;at:number}
export interface CodexPendingTools {calls:PendingTool[];complete:boolean}
const HEADER_BYTES=2*1024*1024,HEADER_CHUNK=64*1024,TAIL_BYTES=1024*1024;

                                              
export async function readCodexPendingTools(file:unknown,sessionId:string,turnId:string):Promise<CodexPendingTools|undefined>{
  if(typeof file!=='string'||!file)return;
  const fd=await open(file,'r').catch(()=>undefined);if(!fd)return;
  try{
    const stat=await fd.stat(),chunks:Buffer[]=[];let offset=0,headerEnd=-1;
                                                           
    while(offset<HEADER_BYTES&&headerEnd<0){
      const head=Buffer.allocUnsafe(Math.min(HEADER_CHUNK,HEADER_BYTES-offset)),{bytesRead}=await fd.read(head,0,head.length,offset);
      if(!bytesRead)break;
      const end=head.subarray(0,bytesRead).indexOf(10);chunks.push(head.subarray(0,end<0?bytesRead:end));
      if(end>=0)headerEnd=offset+end;offset+=bytesRead;
    }
    if(headerEnd<0)return;
    const meta=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(meta.type!=='session_meta'||meta.payload?.id!==sessionId)return;
    const start=Math.max(headerEnd+1,stat.size-TAIL_BYTES),tail=Buffer.alloc(stat.size-start);
    const {bytesRead}=await fd.read(tail,0,tail.length,start),text=tail.subarray(0,bytesRead).toString('utf8'),lines=text.split('\n');
    let complete=true,context:string|undefined,closed=false,matched=false;
    if(start>headerEnd+1)lines.shift();
    const partial=lines.pop()!==''||bytesRead!==tail.length;
    const pending=new Map<string,PendingTool>();
    for(const line of lines){
      if(!line.trim())continue;
      let row:any;try{row=JSON.parse(line);}catch{complete=false;continue;}
      const p=row.payload;if(!p||row.metadata?.compaction_output)continue;
      if(row.type==='event_msg'){
        if(p.type==='thread_rolled_back'){pending.clear();complete=false;context=undefined;closed=true;}
        else if(['task_started','turn_started'].includes(p.type)){
          context=p.turn_id;closed=context!==turnId;
          if(context===turnId){pending.clear();complete=true;matched=true;}
        }else if(['task_complete','turn_complete','turn_aborted'].includes(p.type)&&p.turn_id===turnId){pending.clear();closed=true;}
        else if(p.type==='item_completed'&&p.thread_id===sessionId){
          if(!closed&&typeof p.turn_id==='string')context=p.turn_id;
          if(p.turn_id===turnId)matched=true;
          if(p.turn_id===turnId&&typeof p.item?.id==='string')pending.delete(p.item.id);
        }
        continue;
      }
      if(row.type!=='response_item')continue;
      const explicitScope=p.internal_chat_message_metadata_passthrough?.turn_id??row.metadata?.retained_source?.id?.turn_id;
      if(explicitScope===turnId)matched=true;
      if(p.type==='function_call'||p.type==='custom_tool_call'){
        const scope=explicitScope??context;
        if(scope===undefined)complete=false;
        if(closed||scope!==turnId||typeof p.call_id!=='string'||!p.call_id)continue;
        matched=true;
        const at=Date.parse(row.timestamp);if(!Number.isFinite(at)){complete=false;continue;}
                                                                
        pending.set(p.call_id,{id:p.call_id,at});
      }else if((p.type==='function_call_output'||p.type==='custom_tool_call_output')&&(explicitScope===undefined||explicitScope===turnId))pending.delete(p.call_id);
      else if(typeof p.type==='string'&&p.type.endsWith('_call'))complete=false;
    }
    return{calls:[...pending.values()],complete:complete&&matched&&!closed&&!partial&&(await fd.stat()).size===stat.size};
  }catch{return;}finally{await fd.close();}
}
