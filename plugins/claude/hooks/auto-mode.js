                                                    
                                                   
import { captureContext } from './mod-control.js';
                                                                
                                                                         
export async function observeAutoDecision($,attributes){
  if(attributes?.decision!=='reject'||attributes.classifier_verdict!=='unavailable'||attributes.permission_mode!=='auto')return;
  const context=await captureContext($);
  if(attributes['session.id']!==context.sessionId||context.nativeAutoMode?.unavailable)return;
  const tool=typeof attributes.tool_name==='string'&&attributes.tool_name?attributes.tool_name.slice(0,128):'unknown',id=attributes.tool_use_id,at=Date.now();
  context.nativeAutoMode={unavailable:{at,tool,...(typeof id==='string'&&id.length<=200?{toolUseId:id}:{}),...(attributes.agent_id?{agent:true}:{})},observedAt:at};
  return context;
}
                                                        
export async function observeStop($,event){
  if(event.agent_id||event.agent_transcript_path)return;
  const context=await captureContext($);
  if(event.session_id!==context.sessionId)return;
  const count=value=>Array.isArray(value)?value.length:undefined,tasks=count(event.background_tasks),crons=count(event.session_crons);
  context.nativeBackground={...(tasks!==undefined?{tasks}:{}),...(crons!==undefined?{crons}:{}),observedAt:Date.now()};
  return context;
}
                                                        
                                                                                                     
const short80=v=>typeof v==='string'&&v?v.slice(0,80):undefined;
export function autoModeText(h){
  if(!h?.phase)return undefined;
  if(h.phase==='pending')return '自动模式在这个会话里用不了（安全检查过不去）：等这一轮和后台任务都结束，nxbridge 会换成手动模式的副本接着跑（保留对话历史，配对不变）';
  if(['stopping','launching','binding'].includes(h.phase))return '正在换成手动模式的副本接着跑（保留对话历史，配对不变），换好后这个会话不再收消息';
                                                 
  if(h.phase==='blocked')return `自动模式在这个会话里用不了，nxbridge 没有自动换成手动模式${short80(h.error)?`（${short80(h.error)}）`:''}；消息照常投递，需要安全检查的操作仍会被拒，可运行 nxbridge open claude 处理`;
  if(h.phase==='unknown')return `换成手动模式的副本结果不明${short80(h.error)?`（${short80(h.error)}）`:''}，不会自动重试；消息已保留，可运行 nxbridge open claude 在前台处理`;
  return undefined;
}
