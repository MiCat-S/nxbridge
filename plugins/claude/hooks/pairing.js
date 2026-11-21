import { call, captureContext } from './mod-control.js';
import { inputSource, attestedHuman, refuseHuman } from './human-origin.js';
import { modelMessage } from './errors.js';
import { nativeForm } from './native-form.js';
import { hostingModel, hostingText, policyText } from './hosting.js';
import { pairPermission } from './admission.js';

const SPEC={name:'select_partner',isDeferred:false,description:"commit user's explicit partner choice only; never choose yourself. pass saved selection_id plus either key of the candidate the user picked (action=choose) or action: create = new bg partner, cancel; after partner window closed also adopt = continue original session in bg, wait = wait for user to reopen window, unpair. create may include model + effort for the new bg partner",inputSchema:{type:'object',properties:{selection_id:{type:'string'},key:{type:'string'},action:{type:'string',enum:['choose','create','cancel','adopt','wait','unpair']},model:{type:'string'},effort:{anyOf:[{type:'string'},{type:'number',minimum:0}]}},required:['selection_id'],additionalProperties:false}};
                                                             
const PROFILE_SPEC={name:'partner_profile',isDeferred:true,description:'view/change model + effort of your current partner (nxbridge-owned bg only; user windows refused). set: model and/or effort, any value host accepts (no list; strengths/cost: partner skill). never interrupts: busy -> pending, applied at idle. result = effective (host-reported) + requested + status + delivery_held. host rejects -> partner keeps current profile; uncertain/mismatch -> delivery held till reconciled or reset. model switch resets partner prompt cache -> switch only for real reason. claude native bg: live change unsupported -> create new partner w/ profile. reset: drop member choice, live profile kept. global defaults: config propose (user confirms)',inputSchema:{type:'object',properties:{action:{type:'string',enum:['get','set','reset']},model:{type:'string'},effort:{anyOf:[{type:'string'},{type:'number',minimum:0}]}},additionalProperties:false}};
                                                   
                                                                     
const OPEN_SPEC={name:'choose_partner',isDeferred:true,description:"open native partner picker for the user (existing window / previous bg partner / new background / unpair). use when user asks to change or rebind partner; you never pick, user does",inputSchema:{type:'object',properties:{},additionalProperties:false}};
let tool,openTool,profileTool,interactiveWindow=false;
export const setPairingInteractive=value=>{interactiveWindow=value;};
export async function pairingStart($){tool=(await $.tool.register(SPEC)).tool;openTool=(await $.tool.register(OPEN_SPEC)).tool;profileTool=(await $.tool.register(PROFILE_SPEC)).tool;}
                                                                        
                                                                                                                                                                
export const pickInChat=result=>`user chose a Codex partner from the list; ask user which one (list below; prev=earlier bg partner, resumes its own session+context), then call select_partner with selection_id=${result.selection_id} and the key user picked; never pick yourself; valid ~${Math.max(1,Math.ceil((result.expires_at-Date.now())/60000))} min${result.pairing_code?'; or user types nxbridge pair '+result.pairing_code+' in the target window':''}. candidates: `+JSON.stringify(result.candidates.map(c=>({key:c.key,name:c.label??c.name,info:c.description,...(c.former_partner&&c.owner==='nxbridge'?{prev:true}:{})})));
                                                                         
const startPending=result=>result.status==='launch_precondition'&&result.pair_id;
const startReason=result=>(result.launch_precondition?.message??result.message??'原因未知').trim().replace(/[。.]+$/,'');
                                                                                                                  
export const pairingModelResult=result=>result.status==='pick_in_chat'?pickInChat(result):result.status==='no_pair_options'?noPairOptionsModel(result):[startPending(result)?'paired'+(result.partner_name?' with "'+result.partner_name+'"':'')+'; bg start pending: '+startReason(result)+'; pairing kept, do not re-pick':result.status==='paired'&&!result.hosting?'paired'+(result.partner_name?' with "'+result.partner_name+'"':'')+(pairPermission(result.permission_guidance)?'; '+pairPermission(result.permission_guidance).model:''):result.status==='unpaired'?'unpaired':result.hosting?hostingModel(result.hosting):'unchanged',
  result.cancelled_message_ids?.length?'cancelled_message_ids='+result.cancelled_message_ids.join(',')+' (never delivered to old partner; resend to new partner only if still needed)':'',
  result.uncertain_message_ids?.length?'uncertain_message_ids='+result.uncertain_message_ids.join(',')+' (old partner may have seen them; do not resend)':''].filter(Boolean).join('; ');
export async function openPartnerCall($,e,next){
  if(!openTool||e.tool!==openTool)return next(e);
  if(e.agentId)return{deny:'choose_partner: root session only'};
  if(!interactiveWindow)return{result:'not opened: no interactive user here; tell user to type /nxbridge pair'};
  try{return{result:pairingModelResult(await changePartner($,true))};}
  catch(error){return{result:'picker failed: '+modelMessage(error)+'; tell user to type /nxbridge pair'};}
}
export async function pairingCall($,e,next){
  if(e.tool!==tool)return next(e);
  if(e.agentId)return{deny:'partner selection: root session only'};
  try{return{result:JSON.stringify(await call($,'selection-commit',{selection_id:e.selection_id,key:e.key,action:e.action,...profileInput(e),callId:e.tool_use_id}))};}
  catch(error){return{deny:modelMessage(error)};}
}
const profileInput=e=>({...(e.model!==undefined?{model:e.model}:{}),...(e.effort!==undefined?{effort:e.effort}:{})});
export async function partnerProfileCall($,e,next){
  if(e.tool!==profileTool)return next(e);
  if(e.agentId)return{deny:'partner profile: root session only'};
  try{return{result:JSON.stringify(await call($,'partner-profile',{action:e.action??'get',...profileInput(e),callId:e.tool_use_id}))};}
  catch(error){return{deny:modelMessage(error)};}
}
                                   
const LOST_REASON={broker_shutdown:'后台服务被关停',identity_mismatch:'会话身份与记录不符',window_exit:'Codex 窗口已退出',external_release:'后台进程被回收',session_deleted:'原搭档的会话记录已被删除'};
export const lostReasonText=lost=>LOST_REASON[lost?.reason]??'原因未知';
export const lostPartnerName=lost=>lost?.partner_name??'原搭档';
                                                 
function lostOptions(selection){
  const lost=selection.pair_lost??{},former=selection.candidates.find(candidate=>candidate.member_id===lost.partner_id);
  const others=selection.candidates.filter(candidate=>candidate!==former),options=[];
  if(former&&former.restore_state!=='gone')options.push({label:`恢复原搭档「${former.label??former.name??lostPartnerName(lost)}」`,description:former.restore_state==='resumable'?'接回原来的 Codex 会话，保留它之前的上下文':'重新接回原搭档；暂时无法确认它是否还在，消息会等它恢复后送达',action:'choose',key:former.key});
  if(others.length)options.push(existingOption(others,others.some(candidate=>candidate.former_partner)?'其他窗口或之前的后台 Codex':'其他现有窗口'));
  if(selection.allowed_actions.includes('create'))options.push({label:'新建后台 Codex',description:'新开一个 Codex，它看不到原搭档之前的上下文',action:'create'});
  options.push({label:'暂不配对',description:'消息不发送；之后再发信时会再问一次',action:'cancel'});
  const gone=former?.restore_state==='gone'||!former&&lost.restore_state==='gone';
  const question=`与 Codex「${lostPartnerName(lost)}」的配对被意外解除（${lostReasonText(lost)}）。`+(gone?'原来的会话已不存在，无法恢复。':'')+'要怎么处理？';
  return{options,question:question+codeHint(selection)};
}
                                                       
                                            
function hostingOptions(selection){
  const h=selection.hosting??{},allowed=selection.allowed_actions??[],options=[];
  if(allowed.includes('adopt'))options.push({label:'在后台继续原会话',description:'由 nxbridge 在后台接着跑这个会话，保留上下文和配对；以后关掉窗口也自动转到后台',action:'adopt'});
  if(allowed.includes('wait'))options.push({label:'等我重新打开窗口',description:'消息先留着，你用任意方式重新打开这个会话后送达',action:'wait'});
  if(allowed.includes('create'))options.push({label:'新建后台 Codex',description:'新开一个 Codex，它看不到原会话的上下文',action:'create'});
  if(allowed.includes('unpair'))options.push({label:'解除配对',description:'本窗口暂时不配搭档；之后再发信时会再问你',action:'unpair'});
  const question=`Codex 会话${h.name?'「'+h.name+'」':''}的窗口已关闭${h.held_unsent?`，有 ${h.held_unsent} 条消息在等它`:''}。要怎么处理？`;
  return{options,question};
}
                                                                              
function existingOption(candidates,prefix='现有窗口'){
  if(candidates.length===1){const only=candidates[0],previous=only.former_partner&&only.owner==='nxbridge';return{label:`${previous?'之前的后台 Codex':prefix}「${only.label??only.name}」`,description:previous?'接回它原来的会话，保留之前的上下文'+(only.description?' · '+only.description:''):only.description??'状态未知',action:'choose',key:only.key};}
  return{label:`${prefix}（${candidates.length} 个）`,description:'接下来 Claude 会在对话里问你选哪个',action:'chat',candidates};
}
                                      
const codeHint=(selection,prefix='也可以在')=>selection.pairing_code?`${prefix}要配对的那个 Codex 窗口里输入 nxbridge pair ${selection.pairing_code}（${Math.max(1,Math.ceil((selection.expires_at-Date.now())/60000))} 分钟内有效）。`:'';
export const noPairOptionsText=result=>'没有可选的 Codex 搭档：现在没有可以配对的 Codex 窗口，当前配置也禁止新建后台搭档。'+(codeHint(result,'请在')||'打开要配对的 Codex 窗口后，再运行 /nxbridge pair。');
const noPairOptionsModel=result=>'no selectable Codex partner: no eligible window, and the current configuration disables creating a background partner; '+(result.pairing_code?'tell user to type nxbridge pair '+result.pairing_code+' in the target Codex window':'tell user to open the target Codex window and run /nxbridge pair again');
const STATE_TEXT={ready:'空闲',busy:'忙碌',needsHuman:'等待人工处理',paused:'已暂停',offline:'离线',starting:'启动中'};
function windowOptions(selection){
  const candidates=selection.candidates??[],previous=candidates.filter(candidate=>candidate.former_partner&&candidate.owner==='nxbridge'),live=candidates.filter(candidate=>!previous.includes(candidate)),options=[],change=selection.mode==='change',current=selection.current_partner??{};
  if(live.length)options.push(existingOption(live));
  if(previous.length)options.push(existingOption(previous,'之前的后台 Codex'));
  if(selection.allowed_actions?.includes('create'))options.push({label:'新建后台 Codex',description:'由 nxbridge 在后台启动一个新的 Codex，不占用已打开的窗口',action:'create'});
  if(change)options.push({label:'解除配对',description:'本窗口暂时不配搭档；之后再发信时会再问你',action:'unpair'});
  options.push(change?{label:'保持不变',description:`继续和「${current.name??'当前搭档'}」配对`,action:'cancel'}:{label:'暂不配对',description:'消息不发送，之后可以再发一次',action:'cancel'});
  if(options.length>4)options.splice(0,2,existingOption(candidates,'现有窗口或之前的后台 Codex'));
  const question=change?`当前搭档：Codex「${current.name??'未知'}」（${current.owner==='nxbridge'?'后台':'你开的窗口'}·${STATE_TEXT[current.state]??'状态未知'}）。要换成什么？`
    :previous.length?(live.length?'要使用现有窗口、接回之前的后台搭档，还是新建后台 Codex？':selection.allowed_actions?.includes('create')?'要接回之前的后台 Codex，还是新建一个？':'要接回之前的后台 Codex 吗？')
    :live.length===1?`这个项目里已经开着一个还没配对的 Codex 窗口（${live[0].label??live[0].name}），要和它配对吗？`
    :live.length?`这个项目里有 ${live.length} 个还没配对的 Codex 窗口，要怎么配对？`:'要怎么配对 Codex？';
  return{options,question:question+codeHint(selection)};
}
                                                          
                                                   
async function resolveSelection($,selection,context){
  if(selection?.status!=='selection_required')return selection;
  return call($,'selection-resolve',{selection_id:selection.selection_id,context});
}
export async function choosePartner($,initial,interactive,inTurn=true,resolve=true){
  if(initial.status!=='selection_required')return initial;
  const context=await captureContext($),id=initial.selection_id;let selection=resolve?await resolveSelection($,initial,context):initial;
  if(selection.status!=='selection_required'||!interactive)return selection;
  let waitingForChoice=false;
  try{
    for(let attempt=0;attempt<2;attempt++){
      if(attempt>0&&resolve){selection=await resolveSelection($,selection,context);if(selection.status!=='selection_required')return selection;}
      const {options,question}=selection.reason==='pair_lost'?lostOptions(selection):selection.reason==='hosting'?hostingOptions(selection):windowOptions(selection);
      if(!options.length)return await call($,'selection-commit',{selection_id:id,action:'cancel',context});
                                                       
      if(options.length===1&&options[0].action==='cancel'){
        const result={status:'no_pair_options'};
        if(selection.pairing_code&&selection.expires_at>Date.now())return{...result,pairing_code:selection.pairing_code,expires_at:selection.expires_at};
        const settled=await call($,'selection-commit',{selection_id:id,action:'cancel',context});
        return settled.status==='selection_declined'?result:settled;
      }
      if(inTurn&&!waitingForChoice){waitingForChoice=true;await call($,'state',{state:'needsHuman',context});}
      let answer;
      try{const result=await nativeForm($,[{header:'选择搭档',question,options:options.map(({label,description})=>({label,description})),multiSelect:false}]);answer=result.result?.answers?.[question];}catch{}
      const current=await call($,'selection-get',{selection_id:id,context});
      if(current.status==='paired')return current;
      const picked=options.find(option=>option.label===answer),action=picked?.action??'cancel';
                                                
      if(action==='chat')return{status:'pick_in_chat',selection_id:id,expires_at:selection.expires_at,pairing_code:selection.pairing_code,candidates:picked.candidates};
      try{return await call($,'selection-commit',{selection_id:id,...(action==='choose'?{key:picked.key}:{}),action,context});}
      catch(error){
        if(error.code!=='selection_expired')throw error;
        if(attempt===1){const settled=await call($,'selection-commit',{selection_id:id,action:'cancel',context});if(selection.reason==='hosting')return settled;return{status:'selection_declined',message:'nothing sent: candidates changed; resend to choose again'};}
        selection=await call($,'selection-refresh',{selection_id:id,context});
      }
    }
  }finally{if(waitingForChoice)try{await call($,'state',{state:'busy',context});}catch{}}
}
                                                            
async function changePartner($,inTurn){
  const selection=await call($,'pair-code');
  if(selection.status!=='selection_required')return selection;
  return choosePartner($,selection,true,inTurn,false);
}
                                    
function humanResult(result){
  if(result.status==='pick_in_chat')return `有 ${result.candidates.length} 个可选的 Codex 搭档：`+result.candidates.map((c,i)=>`${i+1}. ${c.former_partner&&c.owner==='nxbridge'?'之前的后台 ':''}${c.label??c.name}（${c.description??'状态未知'}）`).join('；')+`。直接告诉 Claude 要配哪个${result.pairing_code?`，或在那个 Codex 窗口里输入 nxbridge pair ${result.pairing_code}`:''}。`;
  if(result.status==='no_pair_options')return noPairOptionsText(result);
  if(result.hosting?.phase&&result.status!=='unpaired')return result.hosting.phase==='background'?'已在后台继续原会话，配对不变。'+(policyText(result.hosting.policy)?policyText(result.hosting.policy)+'。':''):hostingText(result.hosting)??'已记下你的选择，消息保留。';
  const head=startPending(result)?(result.restored_previous_partner?`已接回之前的后台 Codex「${result.partner_name??'原搭档'}」`:`已与 Codex「${result.partner_name??'新搭档'}」配对`)+`，但它暂时没能在后台启动：${startReason(result)}。配对已保留，不用重新选择；可以用 nxbridge status 查看进度。`
    :result.status==='paired'?(result.restored_previous_partner?`已接回之前的后台 Codex「${result.partner_name??'原搭档'}」，继续它原来的会话。`:`已与 Codex「${result.partner_name??'新搭档'}」配对。`)+(pairPermission(result.permission_guidance)?pairPermission(result.permission_guidance).user+'。':''):result.status==='unpaired'?'已解除配对，之后再发信时会再问你。':'配对没有改变。';
  return head+(result.cancelled_message_ids?.length?`有 ${result.cancelled_message_ids.length} 条消息还没送到旧搭档，已作废，需要时 Claude 会重发给新搭档。`:'')
    +(result.uncertain_message_ids?.length?`另有 ${result.uncertain_message_ids.length} 条可能已被旧搭档看到，不会重发。`:'');
}
export async function pairingCommand($,e){
  const source=await inputSource($,e);
  if(!attestedHuman(e,source))return refuseHuman($,'pair',source,'配对码必须由你本人在这个 Claude 窗口的输入框里提交。也可以在系统终端（Terminal.app、Windows Terminal 等，不是 Claude 里的终端面板）运行 nxbridge pair，从列表里选要配对的 Claude 和 Codex 窗口。');
  const match=/^pair(?:\s+(\d{4}))?\s*$/.exec(e.args?.trim()??'');
  if(!match)return{text:'用法：/nxbridge pair，或 /nxbridge pair 四位配对码。'};
  if(match[1]){
    const result=await call($,'pair-code-commit',{code:match[1],origin:'composer',agentId:e.agentId});
    return{text:`已与 Codex 窗口「${result.requester_name}」配对。`+(result.message_id?'对方的消息已送出。':'')+(pairPermission(result.permission_guidance)?pairPermission(result.permission_guidance).user+'。':'')};
  }
  try{return{text:humanResult(await changePartner($,false))};}
  catch(error){return{text:'没能打开搭档选择框：'+(error?.message??String(error))+'。也可以在要配对的 Codex 窗口里输入 nxbridge pair 加配对码。'};}
}
