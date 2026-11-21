import type { Endpoint, Peer } from '../../types.js';
import type { TurnHealth } from '../health/turn-health.js';

export interface DeliveryWait {
  state:'waiting_native_input'|'waiting_native_interaction'|'paused'|'needs_human'|'context_changing'|'offline';
  host:'codex';member_id:string;session_id:string|null;name:string;pending:number;message:string;
  reason?:'native_context_changed'|'native_approval'|'native_input'|'awaiting_first_prompt'|'native_thread_state';
  open_command?:string;
  resume_command?:string;
  native_request?:{turn_id:string;item_id?:string;method:string};
}

                                         
export function nativeDeliveryWait(peer:Peer,endpoint:Endpoint|undefined,pending:number,health?:TurnHealth):{delivery_wait?:DeliveryWait}{
  if(peer.host!=='codex')return{};
  if(endpoint?.pendingContext&&!peer.sessionId)return{delivery_wait:{state:'waiting_native_input',reason:'awaiting_first_prompt',host:'codex',member_id:peer.id,session_id:null,name:peer.name,pending,message:'所选 Codex 窗口尚未建立原生会话。请先在那个窗口输入一条消息，建立会话后会继续投递；无需更改权限或重发正文。'}};
  if(peer.state!=='needsHuman')return{};
  const request=health?.humanRequests?.[0],method=request?.method,reason=method?.includes('UserInput')?'native_input':'native_approval';
  const open=peer.owner==='nxbridge'&&endpoint?.active&&endpoint.mode==='app-server'&&!endpoint.daemon&&peer.sessionId?`nxbridge open codex --member ${peer.id}`:undefined;
  return{delivery_wait:{state:'needs_human',reason,host:'codex',member_id:peer.id,session_id:peer.sessionId,name:peer.name,pending,...(open?{open_command:open}:{}),...(request&&health?{native_request:{turn_id:health.turnId,...(request.itemId?{item_id:request.itemId}:{}),method:request.method}}:{}),message:open?'后台 Codex 正在等待原生审批或问题；在这个项目目录的终端运行 nxbridge open codex，可接续原轮次亲自处理；精确目标：'+open+'。消息保留，无需重跑，nxbridge 不会自动批准。':'需要你先在 Codex 窗口「'+peer.name+'」（会话 '+peer.sessionId+'）处理原生审批或问题；如窗口已关闭，请重新打开并恢复这个会话。消息保留，nxbridge 不会自动批准。'}};
}

                                                 
export function daemonDelivery(peer:Peer,endpoint:Endpoint|undefined,pending:number,transitioning=false,directReady=false,pairPaused=false,contextChanged=false):{delivery_mode?:'daemon-pull'|'daemon-direct';delivery_wait?:DeliveryWait}{
  if(peer.host!=='codex'||!endpoint?.daemon)return{};
  if(directReady&&!pairPaused&&!contextChanged)return{delivery_mode:'daemon-direct'};
  if(!pending&&peer.state!=='needsHuman')return{delivery_mode:'daemon-pull'};
  const state:DeliveryWait['state']=peer.state==='needsHuman'?'needs_human':transitioning||endpoint.pendingContext||contextChanged?'context_changing':!endpoint.active||peer.state==='offline'?'offline':peer.state==='paused'||pairPaused?'paused':peer.state==='busy'?'waiting_native_interaction':'waiting_native_input';
  const target='Codex 窗口「'+peer.name+'」（会话 '+peer.sessionId+'）';
  const pickup='在'+target+'输入 nxbridge pickup 取件',resume=peer.sessionId?'如原窗口已关闭，请先在原项目终端运行 codex resume '+peer.sessionId+'，恢复同一会话后输入 nxbridge pickup。':'';
  const action=state==='waiting_native_input'?'请'+pickup:state==='waiting_native_interaction'?'等待'+target+'下一次原生交互取件；当前轮次可能在工具调用后取件，空闲后也可输入 nxbridge pickup':state==='paused'?(pairPaused?'配对已暂停，需要你先恢复配对，再'+pickup:'该窗口已暂停，需要先继续，再'+pickup):state==='needs_human'?'需要你先在'+target+'处理待办审批或问题，然后输入 nxbridge pickup；nxbridge 不会自动批准':state==='context_changing'?(contextChanged?'同一项目的 Codex 可能已切到新对话；请在要使用的对话中输入 nxbridge pair 重新配对，或回原会话输入 nxbridge pickup。原消息保留，不会自动转发':'等待'+target+'完成上下文核验后，输入 nxbridge pickup 取件'):'目标原生线程当前不可用，请确认原窗口是否仍打开';
  return{delivery_mode:'daemon-pull',delivery_wait:{state,...(contextChanged&&state==='context_changing'?{reason:'native_context_changed' as const}:{}),host:'codex',member_id:peer.id,session_id:peer.sessionId,name:peer.name,pending,...(peer.sessionId?{resume_command:'codex resume '+peer.sessionId}:{}),message:(pending?pending+' 条消息已保存在 nxbridge 收件箱；尚未确认进入 Codex 上下文。':'该 Codex 会话正在等待人工处理。')+action+'。'+resume+(pending?'不要宣称已送达，也不要重发正文。':'')}};
}

export function daemonCandidateNotice(state:Peer['state']):string{
  return state==='busy'?'共享 daemon：当前忙碌，等待原生交互取件或空闲后核验唤醒条件':state==='needsHuman'?'共享 daemon：需要先在该 Codex 窗口处理审批或问题':state==='paused'?'共享 daemon：需要你在该 Codex 窗口继续后取件':'共享 daemon：明确选择后，空闲且能核验同配置目录的活跃 Codex 终端时可自动唤醒；否则在原窗口输入消息 nxbridge pickup 取件，或使用 nxbridge 收信';
}
