import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { PairCandidate } from './pair-selection.js';
import { hostLabel } from './pair-presentation.js';

interface SelectionView {status:string;selection_id:string;host:'claude'|'codex';candidates:PairCandidate[];allowed_actions:string[];pairing_code?:string;expires_at:number;mode?:'change';current_partner?:{name:string;owner:string;state:string}}
type SelectionRpc=(method:string,params:Record<string,unknown>)=>Promise<any>;

                                      
export async function elicitPartner(server:Pick<Server,'getClientCapabilities'|'elicitInput'>,initial:unknown,rpc:SelectionRpc,options?:RequestOptions):Promise<unknown>{
  const value=initial as SelectionView,capabilities=server.getClientCapabilities()?.elicitation;
  if(!['selection_required','launch_precondition','bootstrap_required'].includes(value?.status))return initial;
  let view=await rpc('pair.selection.resolve',{selection_id:value.selection_id}) as SelectionView;
  const inChat=()=>({...view,status:'pick_in_chat',message:'Partner choice could not be confirmed in the native form; draft kept, nothing changed/sent. Ask the user to choose in this conversation; commit only their explicit choice via select_partner using selection_id + key/action. Never choose yourself or resend the draft. Pairing code also works in the target window.'});
  if(view.status!=='selection_required')return view;
  if(!capabilities||Object.keys(capabilities).length&&!capabilities.form)return inChat();
  for(let attempt=0;attempt<2;attempt++){
    const label=hostLabel(view.host),candidates=view.candidates,previous=candidates.filter(candidate=>candidate.former_partner&&candidate.owner==='nxbridge'),live=candidates.filter(candidate=>!previous.includes(candidate)),choices:{const:string;title:string;candidates?:PairCandidate[]}[]=[];
    const group=(values:PairCandidate[],key:string,prefix:string)=>{
      const only=values.length===1?values[0]:undefined;
      return only?{const:only.key,title:prefix+'「'+(only.label??only.name)+'」 · '+(only.former_partner&&only.owner==='nxbridge'?'接回它原来的会话，保留之前的上下文 · ':'')+(only.description??'状态未知')}:{const:key,title:prefix+'（'+values.length+' 个） · 先和 AI 说清楚要哪个，再确认配对',candidates:values};
    };
    if(live.length)choices.push(group(live,'existing','现有窗口'));
    if(previous.length)choices.push(group(previous,'previous','之前的后台 '+label));
    if(view.allowed_actions.includes('create'))choices.push({const:'create',title:`新建后台 ${label} · 由 nxbridge 在后台启动一个新的 ${label}，不占用已打开的窗口`});
    if(view.allowed_actions.includes('unpair'))choices.push({const:'unpair',title:'解除配对 · 只解除当前搭档，不会另开窗口'});
    choices.push({const:'cancel',title:view.mode==='change'?'保持不变 · 继续使用当前搭档':'暂不配对 · 消息不发送，之后可以再发一次'});
    if(choices.length>4)choices.splice(0,2,group(candidates,'existing_or_previous','现有窗口或之前的后台 '+label));
    const message=(view.mode==='change'?`当前搭档：${label}「${view.current_partner?.name??''}」。要怎么处理？`:previous.length?(live.length?'要使用现有窗口、接回之前的后台搭档，还是新建后台搭档？':view.allowed_actions.includes('create')?`要接回之前的后台 ${label}，还是新建一个后台搭档？`:`要接回之前的后台 ${label} 吗？`):live.length===1?`这个项目已经开着一个 ${label} 窗口（${live[0]!.label??live[0]!.name}），要和它配对吗？`:'要使用现有窗口，还是新建一个后台搭档？')+(view.pairing_code?`分不清是哪个窗口的话，在那个 ${label} 窗口里输入 ${view.host==='claude'?'/':''}nxbridge pair ${view.pairing_code}（${Math.max(1,Math.ceil((view.expires_at-Date.now())/60000))} 分钟内有效）。`:'');
    let result:Awaited<ReturnType<Server['elicitInput']>>;
    try{result=await server.elicitInput({mode:'form',message,requestedSchema:{type:'object',properties:{choice:{type:'string',title:'选择搭档',oneOf:choices}},required:['choice']}},options);}
    catch(error){if(options?.signal?.aborted)throw error;return inChat();}
    const current=await rpc('pair.selection.get',{selection_id:value.selection_id});
    if(current.status==='paired'||current.status==='unpaired')return current;
    const choice=result.action==='accept'?result.content?.choice:undefined;
                                                          
                             
    if(result.action!=='accept'||!choices.some(option=>option.const===choice))return inChat();
    const groupCandidates=choices.find(option=>option.const===choice)?.candidates;
    if(groupCandidates)return{...view,candidates:groupCandidates,status:'pick_in_chat',message:'nothing changed/sent; draft kept. Discuss these candidates with user (former_partner=earlier bg partner, resumes its own session); commit only their explicit choice via select_partner using selection_id + key. Never choose yourself; do not resend original draft. Pairing code also works in target window.'};
    const candidate=candidates.find(c=>c.key===choice),action=candidate?'choose':choice==='create'?'create':choice==='unpair'?'unpair':'cancel';
    try{return await rpc('pair.selection.commit',{selection_id:value.selection_id,action,...(candidate?{key:candidate.key}:{})});}
    catch(error){
      if((error as {code?:string}).code!=='selection_expired')throw error;
      if(attempt){await rpc('pair.selection.commit',{selection_id:value.selection_id,action:'cancel'});return{status:'selection_declined',message:'nothing sent: candidates changed; resend to choose again'};}
      await rpc('pair.selection.refresh',{selection_id:value.selection_id});
      view=await rpc('pair.selection.resolve',{selection_id:value.selection_id});
      if(view.status!=='selection_required')return view;
    }
  }
  return initial;
}
