import { brokerCall } from '../../ipc/ipc.js';
import {delay} from '../../shared/time.js';
import {describeError} from '../../shared/errors.js';
import {type DeliveryState,type Message,type Peer} from '../../types.js';
import type { PartnerQuestion } from './questions.js';

export const DELIVERY_LABELS:Record<DeliveryState,string>={accepted:'已持久化',sending:'正在提交',runtimeQueued:'运行时已接受',held:'等待人工放行',contextObserved:'已观察到上下文记录',responded:'已有明确关联回复',refused:'已拒收',expired:'已过期',unknown:'接受情况待核对'};
                                        
export const terminalText=(value:string)=>value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));

export function formatMessage(message:Message,peers:Peer[]):string{
  const name=(id:string)=>terminalText(peers.find(p=>p.id===id)?.name??id);
  return `[${new Date(message.createdAt).toISOString()}] ${name(message.from)} → ${name(message.to)} · ${DELIVERY_LABELS[message.state]}\n消息 ${message.id}${message.inReplyTo?' · 回复 '+message.inReplyTo:''}${message.via?' · 经 '+terminalText(message.via):''}\n${terminalText(message.body)}\n${message.evidence?'证据：'+terminalText(message.evidence)+'\n':''}${message.error?'待处理：'+terminalText(message.error)+'\n':''}`;
}
export function formatQuestion(q:PartnerQuestion):string{
  return terminalText(`问题 ${q.id} · ${q.status}${q.status==='pending'?' · 等待搭档':''}\n截止 ${new Date(q.expiresAt).toISOString()}\n${q.items.map(item=>`${item.id} ${item.header}：${item.question}${item.multiSelect?'（多选）':''}\n${(item.options??[]).map(option=>`- ${option.label}：${option.description}${option.preview?'\n'+option.preview:''}`).join('\n')}`).join('\n')}\n${q.status==='timed_out'?'搭档未答复。可自行决定改问用户或重新提问。\n':''}${q.answers?'答案：'+JSON.stringify(q.answers)+'\n来源：'+JSON.stringify(q.source)+'\n理由：'+q.rationale+'\n':''}`);
}

                                        
const lossReason=(reason:string)=>({broker_shutdown:'后台服务被关停',identity_mismatch:'会话身份与记录不符',window_exit:'对方窗口已退出',external_release:'后台进程被回收',session_deleted:'原搭档的会话记录已被删除'} as Record<string,string>)[reason]??'原因未知';
const lossTime=(at:number)=>new Date(at).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'});
                                                         
const lossRestore=(loss:any)=>loss.reason==='session_deleted'?(loss.restore_state==='resumable'?'原会话的记录已经找回，可以恢复：'+loss.restore_command+'\n':'原会话的记录已不在，找回之前无法恢复。')+(loss.replacement?.state==='uncertain'?'自动新建搭档的结果不明（'+loss.replacement.error+'）：等新会话向 nxbridge 登记、确认身份后再继续，期间不会再自动新建第二个。':loss.replacement?.state==='failed'&&loss.replacement.terminal?'自动新建搭档多次没有成功（'+loss.replacement.error+'），已停止自动重试。':loss.replacement?.state==='failed'?'自动新建搭档没有成功（'+loss.replacement.error+'），'+lossTime(loss.replacement.next_at)+' 会再试一次。':loss.replacement_suppressed?'已按你的选择，不自动新建搭档。':'')+(loss.held_message_ids?.length?'原搭档留下 '+loss.held_message_ids.length+' 条还没送达的消息，已保留，可以让 AI 查看。':'')+'需要新搭档时，让 AI 打开搭档选择即可。':loss.restore_state==='gone'?'原会话已不存在，无法恢复。':(loss.restore_state==='resumable'?'可以恢复：':'可尝试恢复：')+loss.restore_command;
                                                         
const providerCause=(r:any)=>{
  const code=r.statusCode?`返回 ${r.statusCode}`:'';
  return r.kind==='auth'?`模型服务拒绝了登录凭据（${code||'认证失败'}）`:r.kind==='quota'?`模型服务限流或额度不足（${code||'限流'}）`:r.kind==='timeout'?'模型服务请求超时':r.kind==='network'?'连不上模型服务':r.kind==='request'?'模型请求失败':r.statusCode>=500?`模型服务暂时不可用（${code}）`:`模型服务拒绝了请求（${code||'请求失败'}）`;
};
export function providerStatusText(health:any):string|undefined{
  const r=health?.modelRequest;if(r?.blocking!==true||typeof r.at!=='number')return;
  const at=new Date(r.at).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'}),next=r.kind==='auth'?'需要你检查 Codex 的登录或密钥':'等服务恢复，或到供应商那边查看';
  return r.state==='failed'?`这一轮已停止：${providerCause(r)}，最近一次 ${at}；${next}`:`在等模型服务：${providerCause(r)}，正在自动重试，最近一次 ${at}；${next}`;
}
const profileText=(p:{model?:string;effort?:string|number}|undefined)=>[p?.model!==undefined?'模型 '+p.model:'',p?.effort!==undefined?'推理强度 '+p.effort:''].filter(Boolean).join('，');
                               
function profileNotice(member:any):string[]{
  const view=member?.partner_profile,wanted=profileText(view?.requested),who='后台 '+(member?.host==='codex'?'Codex':'Claude');
  if(!view||!wanted||!view.delivery_held&&view.status!=='failed'||!['pending','failed','applied'].includes(view.status))return[];
  const reason=String(view.error?.message??'原因未知').trim().replace(/[。.]+$/,'');
  if(view.status==='pending')return[`${who}正在换成并核对${wanted}，完成之前新消息先不发给它；一直停在这里时：nxbridge partner-profile ${member.host} --reset`];
  if(view.status==='applied')return[`${who}正在重新核对${wanted}是否仍然生效，核对完之前新消息先不发给它；一直停在这里时：nxbridge partner-profile ${member.host} --reset`];
  return[view.delivery_held?`${who}换成${wanted}的结果不明，或者实际设置和指定的不一致：${reason}。新消息先不发给它；放弃这次修改：nxbridge partner-profile ${member.host} --reset`:`${who}没能换成${wanted}：${reason}。它继续用原来的设置。`];
}
export function formatStatus(status:any):string{
  const labels:Record<string,string>={ready:'就绪',busy:'工作中',needsHuman:'等待用户',offline:'离线',unknown:'未知',paused:'已暂停',starting:'启动中'};
  const health=(p:any)=>providerStatusText(p.health)?` · ${providerStatusText(p.health)}`:p.health?.state==='networkRetrying'?` · 网络重连中${p.health.retry?.attempt!==undefined?`，第 ${p.health.retry.attempt}/${p.health.retry.max} 次`:''}，从 ${new Date(p.health.retry.since).toLocaleString('zh-CN',{hour12:false})} 开始`:p.health?.state==='silent'?(p.health.progressEvidence===false?' · 进度暂时无法观测（读不到最新一步，不代表卡住）':` · 已 ${Math.floor((Date.now()-p.health.lastProgressAt)/60000)} 分钟没有进展，原因未知`):p.health?.state==='waitingTool'?' · 正在等待工具或命令执行完成':p.health?.state==='failed'?` · 这一轮执行失败：${p.health.error??'原因未知'}`:'';
  const line=(title:string,p:any)=>`${title}：${p.name} · ${labels[p.state]??p.state}${p.launchFailure?' · 启动失败：'+p.launchFailure.message+'；消息已保留。修复后重试：nxbridge open '+p.host+' --member '+p.id:''}${p.context?.transitioning?' · 正在切换对话，消息等新对话开始后送达':''}${p.model?' · '+p.model:''}${p.effort!==undefined?' / '+p.effort:''}${health(p)}${p.backgroundMode==='child'?' · 托管子进程；接管：'+p.takeoverCommand:''}`;
  const summary=!status.paired?(status.pair_lost?'原配对 '+status.pair_lost.pair_id+' 被意外解除；原搭档「'+status.pair_lost.partner_name+'」。原因：'+lossReason(status.pair_lost.reason)+(status.pair_lost.actor?'（'+status.pair_lost.actor+'）':'')+'。\n'+lossRestore(status.pair_lost)+'\n不再需要时清除提示：nxbridge unpair --member '+status.self.id:'待配对。首次发信按需配对。'):[
    `${status.paused?'配对已暂停（nxbridge resume'+(status.self?.id?' --member '+status.self.id:'')+' 恢复）':'已配对'}`,
    line('本窗口',status.self),line('搭档',status.partner),
    ...[status.self,status.partner].flatMap(p=>p.delivery_wait?[p.delivery_wait.message]:[]),
    ...(status.self.enabled===false?['本窗口的 nxbridge 已关闭；窗口和配对保留。']:[]),
    ...(status.partner.enabled===false?['搭档的 nxbridge 已关闭；发信已停用，不会自动启动替代窗口。']:[]),
    ...(status.partner.retryBudget?.warning?[status.partner.retryBudget.warning]:[]),
    ...[status.self,status.partner].flatMap(profileNotice),
                                      
    ...[status.self,status.partner].flatMap(p=>p?.childCompletions?.hold?.reason?[`Codex 的子代理已做完，尚未确认主线程接着处理：${p.childCompletions.hold.reason}。没动的话到原 Codex 窗口说一句继续，不用重跑子代理`]:[]),
    `待处理消息：${status.pending}；待处理问题：${status.questions?.length??0}`,
    ...(status.identityIssues??[]).map((issue:{message:string})=>'Codex 客户端身份：'+issue.message),
    ...(status.communicationTips?[`发送提示：长报告 ${status.communicationTips.firings.report} 次，引用复用 ${status.communicationTips.firings.reuse} 次；最近 ${status.communicationTips.window.samples} 条字符中位数 ${status.communicationTips.window.median}，P90 ${status.communicationTips.window.p90}；详细统计见 nxbridge status/doctor`]:[]),
  ].join('\n');return terminalText(summary+(status.profile_warnings??[]).map((warning:string)=>'\n搭档默认设置：'+warning).join('')+(status.resources?.summary?'\n'+status.resources.summary:'')+(status.claudeBackground?.available===false?'\n'+status.claudeBackground.notice:''));
}

export function formatGlobalStatus(status:any):string{
  const pairs=status.pairs??(status.pair?[status.pair]:[]);
  const sections=pairs.map((pair:any,index:number)=>{
    const claude=status.peers.find((p:Peer)=>p.id===pair.claude),codex=status.peers.find((p:Peer)=>p.id===pair.codex);
    return `配对 ${index+1} · ${terminalText(claude.cwd)}\n`+formatStatus({paired:true,paused:pair.paused,self:claude,partner:codex,pending:status.messages.filter((m:Message)=>m.pairId===pair.id&&['accepted','sending','runtimeQueued','held','unknown'].includes(m.state)).length,questions:status.questions.filter((q:PartnerQuestion)=>q.pairId===pair.id&&['pending','awaiting_user','needs_user'].includes(q.status))});
  });
  sections.push(...(status.capabilities?.identityIssues??[]).map((issue:{message:string})=>terminalText('Codex 客户端身份：'+issue.message)));
  const lost=[...new Map((status.lostPairs??[]).map((loss:any)=>[loss.pair_id,loss])).values()] as any[];
  sections.push(...lost.map(loss=>terminalText('原配对 '+loss.pair_id+' 被意外解除：「'+loss.member_name+'」与「'+loss.partner_name+'」，原因：'+lossReason(loss.reason)+(loss.actor?'（'+loss.actor+'）':'')+'。\n'+lossRestore(loss))));
  sections.push(...Object.entries(status.capabilities?.frozen_profiles??{}).flatMap(([host,profile]:[string,any])=>profileText(profile)?[`新建的后台 ${host==='codex'?'Codex':'Claude'} 固定用：${profileText(profile)}（${new Date(profile.at).toLocaleString('zh-CN',{hour12:false})} 记下）`]:[]));
  sections.push(...(status.capabilities?.profile_warnings??[]).map((warning:string)=>terminalText('搭档默认设置：'+warning)));
  const members=new Set(pairs.flatMap((pair:any)=>[pair.claude,pair.codex])),unpaired=status.peers.filter((p:Peer)=>!members.has(p.id)&&p.sessionId&&['root','fork'].includes(p.kind));
  return sections.join('\n\n')+(sections.length?'\n':'暂无配对。\n')+`未配对主窗口：${unpaired.length}；选择窗口：nxbridge pair；完整记录：nxbridge status --json\n`+(status.capabilities?.resources?.summary?status.capabilities.resources.summary+'\n':'')+(status.codexRegistration?.issues??[]).map((issue:{message:string})=>terminalText(issue.message)+'\n').join('');
}

export async function watch(options:{once?:boolean;json?:boolean}={}):Promise<void>{
  const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
  if(options.once){const status=await brokerCall('status');for(const m of status.messages)options.json?output(m):process.stdout.write(formatMessage(m,status.peers)+'\n');for(const q of status.questions??[])options.json?output({type:'question',question:q}):process.stdout.write(formatQuestion(q)+'\n');return;}
  let after=0,running=true,lastError='';
  const stop=()=>{running=false;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{while(running){
    try{
      const events=await brokerCall<any[]>('events',{after}),status=events.length?await brokerCall('status'):undefined;
      for(const event of events){
        const message:Message|undefined=event.data.messageId?await brokerCall('message',{message_id:event.data.messageId}):undefined;
        const question=event.type==='question.state'?status.questions?.find((q:PartnerQuestion)=>q.id===event.data.request_id):undefined;
        if(options.json)output({...event,...(message?{message}:{}),...(question?{question}:{})});
        else if(question)process.stdout.write(formatQuestion(question)+'\n');
        else if(event.type==='message.accepted'&&message)process.stdout.write(formatMessage({...message,state:'accepted'},status.peers)+'\n');
        else if(event.type==='message.state')process.stdout.write(`${event.data.messageId} · ${DELIVERY_LABELS[event.data.state as DeliveryState]}${event.data.evidence?' · '+terminalText(event.data.evidence):''}\n`);
        else process.stdout.write(`[${event.type}] ${terminalText(JSON.stringify(event.data))}\n`);
        after=Number(event.seq);
      }
      lastError='';
    }catch(error){const message=describeError(error);if(message!==lastError)process.stderr.write(`nxbridge：${message}；正在重新连接。\n`);lastError=message;}
    if(running)await delay(1000);
  }}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
