import { open } from 'node:fs/promises';
import { BridgeError } from '../../shared/errors.js';

                                          
export async function codexHookContext(input:Record<string,unknown>,threadId:string,independentWithoutTranscript:boolean):Promise<Record<string,unknown>>{
  if(input.hook_event_name!=='PostToolUse')throw new BridgeError('unverified_identity','隐藏入口只接受 PostToolUse。');
  const result={...input};delete result.agent_id;delete result.agent_type;delete result.agent_transcript_path;
  if(typeof input.transcript_path!=='string'||!input.transcript_path){
    if(!independentWithoutTranscript||input.session_id!==threadId)throw new BridgeError('unverified_identity','缺少可核验的原生 hook 会话来源。');
    return result;
  }
  const file=await open(input.transcript_path,'r');
  try{
    const chunks:Buffer[]=[];let size=0;
                                                   
    while(size<2*1024*1024){
      const bytes=Buffer.allocUnsafe(4096),{bytesRead}=await file.read(bytes,0,bytes.length,null);
      if(!bytesRead)break;
      const end=bytes.subarray(0,bytesRead).indexOf(10);chunks.push(bytes.subarray(0,end<0?bytesRead:end));size+=bytesRead;
      if(end>=0){
        const row=JSON.parse(Buffer.concat(chunks).toString('utf8')),meta=row?.payload;
        if(row.type!=='session_meta'||meta?.id!==threadId)throw new BridgeError('unverified_identity','rollout 首条身份与当前 hook 不符。');
                                                                          
        if(meta.parent_thread_id||meta.source?.subagent||meta.source?.subAgent||meta.thread_source==='subagent'){
                                                                           
          result.agent_id=threadId;
          if(typeof meta.agent_role==='string')result.agent_type=meta.agent_role;
        }else if(input.session_id!==threadId)throw new BridgeError('unverified_identity','根会话 hook 与 MCP threadId 不符。');
        return result;
      }
    }
    throw new BridgeError('unverified_identity','rollout 首条元数据不完整或超过读取上限。');
  }finally{await file.close();}
}
