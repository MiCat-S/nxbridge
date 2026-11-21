import { randomUUID } from 'node:crypto';
import { SILENCE_MS, type TurnHealth } from '../../broker/health/turn-health.js';

                                  
export class ClaudeStreamHealth {
  value?:TurnHealth;
  human?:{kind:'approval'|'question';tool:string};
  constructor(private now=Date.now){}
  get():TurnHealth|undefined{
    if(!this.value)return;
    const v=this.value;
    return{...v,tools:[...v.tools],state:['ready','failed','needsHuman'].includes(v.state)?v.state:v.retry?'networkRetrying':v.tools.length?'waitingTool':this.now()-v.lastProgressAt>=SILENCE_MS?'silent':'running'};
  }
  observe(message:any):void{
    const now=this.now(),type=message?.type;
    if(type==='system'&&message.subtype==='status'&&message.status==='requesting'){
      if(!this.value||['ready','failed'].includes(this.value.state))this.value={turnId:message.uuid??randomUUID(),lastProgressAt:now,lastEventAt:now,state:'running',tools:[]};return;
    }
    if(type==='control_request'&&message.request?.subtype==='can_use_tool'){
      const tool=String(message.request.tool_name??'unknown');this.human={kind:tool==='AskUserQuestion'?'question':'approval',tool};
      this.value??={turnId:randomUUID(),lastProgressAt:now,lastEventAt:now,state:'running',tools:[]};this.value.state='needsHuman';this.value.lastEventAt=now;return;
    }
    if(type==='system'&&message.subtype==='api_retry'){
      this.value??={turnId:randomUUID(),lastProgressAt:now,lastEventAt:now,state:'running',tools:[]};
      this.value.lastEventAt=now;this.value.retry={message:'Claude 原生 API 重试',since:this.value.retry?.since??now,...(typeof message.attempt==='number'?{attempt:message.attempt}:{}),...(typeof message.max_retries==='number'?{max:message.max_retries}:{})};return;
    }
    const event=type==='stream_event'?message.event:undefined;
    if(event?.type==='message_start'||type==='assistant'){
      if(!this.value||['ready','failed'].includes(this.value.state))this.value={turnId:message.uuid??randomUUID(),lastProgressAt:now,lastEventAt:now,state:'running',tools:[]};
    }
    const v=this.value;if(!v)return;
    if(type==='result'){
      v.state=message.is_error?'failed':'ready';v.completion=message.subtype;v.error=message.is_error?'Claude 原生 turn 失败（'+String(message.subtype??'unknown')+'）':undefined;v.tools=[];delete v.retry;this.human=undefined;v.lastEventAt=now;v.observedProgressAt=now;return;
    }
    const blocks=type==='assistant'?message.message?.content:type==='user'?message.message?.content:[];
    if(Array.isArray(blocks))for(const block of blocks){
      if(block.type==='tool_use')v.tools=[...new Set([...v.tools,block.id])];
      if(block.type==='tool_result')v.tools=v.tools.filter(id=>id!==block.tool_use_id);
    }
    if(event?.type==='content_block_delta'||event?.type==='content_block_start'||type==='assistant'||type==='user'&&Array.isArray(blocks)&&blocks.some(b=>b.type==='tool_result')){
      v.lastProgressAt=now;v.lastEventAt=now;v.observedProgressAt=now;
      if(!this.human)v.state='running';delete v.retry;
    }
  }
}
