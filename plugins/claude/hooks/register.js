import { questionSubmit, questionCall, questionStart, questionAppend, questionTurn, questionComplete, questionReset, turnSource, QUESTION_NOTE } from './questions.js';
import { modelMessage, referenceDeny } from './errors.js';
import { configurationStart, configurationCall, configurationCommand } from './configuration.js';
import { call, read, captureContext, markContextEnd, setModVersion, observePermission, noteReceiptFailure, observeInbound, observeProfile, beginEffortCommand, observeEffortAppend, scheduleProfileRead, ownedProfileContext, predictedHold, isOff, markContextStarted, publishFacts, observeDecision, observeInteractive } from './mod-control.js';
import { observeAutoDecision, observeStop, autoModeText } from './auto-mode.js';
import { switchStart, switchCall, switchCommand, SWITCH_COMMAND } from './switch.js';
import { pairingStart, pairingCall, partnerProfileCall, pairingCommand, choosePartner, lostReasonText, lostPartnerName, openPartnerCall, setPairingInteractive, pickInChat, pairingModelResult, noPairOptionsText } from './pairing.js';
import { nativeFormCall, nativeFormFailure } from './native-form.js';
import { recoveryStart, recoveryCall, recoveryCompact, compactions } from './recovery.js';
import { MOD_REVISION } from './integration-revision.js';
import { deliverNotice, noticePrompt, noticeFailure, isMonitorRecipient, preSubmitBusy, retryable, hasHeld, takeHeld, settleHeld, noticePickup, upgradeHeld } from './notices.js';
import { reloadStart, reloadCall, reloadComplete, autoReload, reloadUnapplied, reloadUnappliedText } from './reload.js';
import { startProgress, progress, streamProgress } from './progress.js';
import { hostingText, hostingModel } from './hosting.js';
import { HumanTurns } from './human-turns.js';
import { providerText, failedText } from './provider.js';
import { humanPrompt } from './human-origin.js';
import { permissionText, pairPermission, admissionText } from './admission.js';
                                         
const ADDRESS = 'nxbridge:codex';
                                                         
const INTEGRATION_TEXT = {
                                                             
  mod_stale: 'nxbridge 已更新，本窗口还在用旧插件（空闲时会自动重新加载；也可自己执行 /reload-plugins）',
  mod_missing: 'nxbridge 插件未登记或无响应（执行 /reload-plugins，或运行 nxbridge doctor 检查）',
                                                
                                                      
  hooks_trust_required: issue => issue?.config_home
    ? `Codex 的 nxbridge hooks 需要重新信任（在使用配置目录 ${issue.config_home} 的 Codex 窗口里打开 /hooks，信任 nxbridge）`
    : 'Codex 的 nxbridge hooks 需要重新信任（在 Codex 的 /hooks 里信任 nxbridge）',
                                                                     
  hooks_restart_required: {
    nxbridge: 'Codex 已信任新版 hooks，但这个后台 Codex 会话还在用旧版：Claude 会在它空闲时自动重启，不用你操作',
    user: issue => `Codex 已信任新版 hooks，但你开的这个 Codex 窗口${issueName(issue)}还在用旧版：等它空闲后退出，再${resumeStep(issue)}`,
    unknown: 'Codex 已信任新版 hooks，但该会话还在用旧版：nxbridge 后台的 Codex 会由 Claude 在它空闲时自动重启；你自己开的 Codex 窗口请重新打开会话',
  },
  hooks_blocked: 'Codex 的 nxbridge hook 执行失败（Claude 会先自动诊断；也可在 Codex 的 /hooks 和 nxbridge doctor 里检查）',
  hooks_timeout: 'Codex 的 nxbridge hook 多次超时（可能机器负载高），消息可能延迟',
                                                  
  hooks_missing: 'Codex 的 nxbridge hooks 似乎没有生效（在 Codex 的 /hooks 里确认 nxbridge 已启用并信任，或运行 nxbridge doctor 查看）',
  inbound_refuse: 'Claude 设置为拒收其他会话的消息，Codex 的消息送不进来（在 /config 或设置里调整 crossSessionInbound）',
  inbound_hold: 'Codex 的消息会被拦下等你逐条审核：两边权限模式不同（把两边切成同类模式，或在 /config 允许接收其他会话的消息）',
  wake_queue_unverified: 'Codex 的唤醒队列无法核验，消息可能延迟（Claude 会先自动诊断；也可运行 nxbridge doctor 查看）',
                                                       
  contract_inactive: {
    daemon: issue => `Codex 还没加载新版规则，暂时检测不到“停下未回复”：在你开的那个 Codex 窗口${issueName(issue)}里继续对话即可生效，不用重开或恢复`,
    nxbridge: 'Codex 还没加载新版规则，暂时检测不到“停下未回复”（这个后台 Codex 会由 Claude 择机自动重启，之后生效）',
    user: issue => `Codex 还没加载新版规则，暂时检测不到“停下未回复”（你开的这个 Codex 窗口${issueName(issue)}空闲后退出，再${resumeStep(issue)}即可生效）`,
    unknown: 'Codex 还没加载新版规则，暂时检测不到“停下未回复”（重启该 Codex 会话后生效；nxbridge 后台的 Codex 会由 Claude 择机自动重启）',
  },
  launch_failed: '后台搭档启动失败，消息已保留（运行 /nxbridge 查看原因和重试命令）',
                                                           
  subagent_completion_held: {
    nxbridge: 'Codex 的子代理已做完，尚未确认后台 Codex 接着处理（运行 /nxbridge 查看原因）',
    user: issue => `Codex 的子代理已做完，尚未确认你开的 Codex 窗口${issueName(issue)}接着处理：到那个窗口看一眼，没动就说一句继续，不用重跑子代理`,
    unknown: 'Codex 的子代理已做完，尚未确认主线程接着处理（运行 /nxbridge 查看原因；你开的窗口没动就到原窗口说一句继续）',
  },
};
                                                 
const issueName = issue => typeof issue?.name === 'string' && issue.name ? `「${issue.name}」` : '';
const resumeStep = issue => typeof issue?.session_id === 'string' && issue.session_id ? `在项目目录的终端运行 codex resume ${issue.session_id} 恢复` : '按原会话 ID 恢复';
                                                                     
const launchFailedText = issue => typeof issue?.message === 'string' && issue.message && issue.message.length <= 200 ? issue.message
  : typeof issue?.retry_command === 'string' && issue.retry_command ? `后台搭档启动失败，消息已保留：修复原因后运行 ${issue.retry_command} 重试（原因见 /nxbridge）`
  : INTEGRATION_TEXT.launch_failed;
const integrationText = status => {
                                                              
  const self = status?.self?.id;
  const issues = (status?.integrationIssues ?? []).filter(issue => !(issue?.code === 'contract_inactive' && self && issue.peerId === self));
  const codeOf = issue => issue?.code ?? issue;
  const code = Object.keys(INTEGRATION_TEXT).find(key => issues.some(issue => codeOf(issue) === key));
                                                         
  const unapplied = code === 'mod_stale' && reloadUnapplied();
  if (unapplied) return reloadUnappliedText(unapplied);
  const text = code && INTEGRATION_TEXT[code];
  const matching = issues.filter(issue => codeOf(issue) === code);
                              
  if (typeof text === 'function') return text(matching.length === 1 ? matching[0] : undefined);
  if (typeof text !== 'object') return text;
                          
  const owners = new Set(matching.map(issue => issue?.owner));
  const owner = owners.size === 1 ? [...owners][0] : undefined;
  const daemon = text.daemon && /^daemon-/.test(status?.partner?.delivery_mode ?? '');
  const variant = daemon ? text.daemon : text[owner === 'nxbridge' || owner === 'user' ? owner : 'unknown'];
  return typeof variant === 'function' ? variant(matching.length === 1 ? matching[0] : undefined) : variant;
};
                                                           
const waitName = wait => wait?.name ? `「${wait.name}」` : "";
                                                                         
const resumeHint = wait => typeof wait?.resume_command === "string" && wait.resume_command ? `（窗口已关的话，先在项目目录的终端运行 ${wait.resume_command} 重新打开）` : "";
const waitText = wait => !wait?.pending ? undefined
  : wait.state === "waiting_native_input" ? `有 ${wait.pending} 条消息还没送到 Codex 窗口${waitName(wait)}：这个会话现在不能自动唤醒，到那个窗口输入 nxbridge pickup 即可取件${resumeHint(wait)}`
  : wait.state === "waiting_native_interaction" ? `有 ${wait.pending} 条消息在等 Codex 窗口${waitName(wait)}下一次原生交互时取件（这个会话现在不能自动唤醒；空闲时到那个窗口输入 nxbridge pickup 即可取件）${resumeHint(wait)}`
                                                               
  : wait.state === "context_changing" && wait.reason === "native_context_changed" ? `有 ${wait.pending} 条消息还没送到 Codex 会话${waitName(wait)}：这个项目里开了新的 Codex 对话，原会话暂不唤醒；在要用的对话里输入 nxbridge pair 重新配对，或回原会话输入一次`
                                   
  : wait.state === "context_changing" ? `有 ${wait.pending} 条消息在等 Codex 会话${waitName(wait)}完成上下文核验后取件`
  : undefined;
                                                  
const firstPromptText = wait => wait?.reason === "awaiting_first_prompt" ? `Codex 窗口${waitName(wait)}还没开始对话${wait.pending ? '，有 ' + wait.pending + ' 条消息在等' : ''}：先在那个窗口输入一句，消息随后送达` : undefined;
                                                        
                    
                                                         
const profileWanted = view => [view?.requested?.model !== undefined ? '模型 ' + view.requested.model : '', view?.requested?.effort !== undefined ? '推理强度 ' + view.requested.effort : ''].filter(Boolean).join('，');
const profileHeldText = view => !view?.delivery_held || !profileWanted(view) ? undefined
  : view.status === 'pending' ? `后台 Codex 正在换成${profileWanted(view)}，换好后再收新消息（一直停在这里时运行 nxbridge partner-profile codex --reset）`
  : view.status === 'applied' ? `后台 Codex 正在重新核对${profileWanted(view)}是否仍然生效，核对完再收新消息（一直停在这里时运行 nxbridge partner-profile codex --reset）`
  : `后台 Codex 换成${profileWanted(view)}的结果不明，新消息先不发给它（运行 nxbridge partner-profile codex --reset 放弃这次修改）`;
const pausedText = partner => partner?.pause_reason === 'restart_incomplete' ? '后台 Codex 的重启没有完整完成，已暂停投递，消息已保留（运行 nxbridge status 查看）'
  : partner?.pause_reason === 'interrupted' && partner.owner === 'nxbridge' ? '后台 Codex 这一轮被中断了，消息在等待（运行 nxbridge status 查看）'
  : partner?.pause_reason === 'interrupted' || partner?.owner === undefined ? 'Codex 窗口被你中断了，消息在等待（在该窗口继续后送达）'
  : partner.owner === 'nxbridge' ? '后台 Codex 已暂停，消息已保留（运行 nxbridge status 查看原因）'
  : 'Codex 窗口暂停了，消息在等待（在该窗口继续后送达）';
                                                
const humanAsk = wait => wait?.reason === 'native_input' ? '回答问题' : wait?.reason === 'native_approval' ? '批准操作' : undefined;
const humanAskModel = wait => wait?.reason === 'native_input' ? 'user answer to its question' : 'user approval';
                                                                     
const humanWaitText = wait => wait?.open_command
  ? `Codex${waitName(wait)}在等你${humanAsk(wait) ?? "处理"}：在这个项目目录的终端运行 ${wait.open_command} 打开原会话处理（不会自动批准）`
  : wait?.name ? `Codex 窗口「${wait.name}」在等你${humanAsk(wait) ? humanAsk(wait) + "（" : "处理（如需批准操作；"}窗口已关的话${wait.resume_command ? '在项目目录的终端运行 ' + wait.resume_command + ' ' : ''}重新打开那个会话，不会自动批准）` : undefined;
                                                                          
const PRECONDITION_TEXT = {
  workspace_untrusted: '项目目录还没被信任', trust_required: '项目目录还没被信任',
  launch_proxy_unavailable: '本机代理暂时不可用', bootstrap_required: '需要运行一次 nxbridge bootstrap',
  launch_profile_missing: '找不到原来的启动配置', launch_command_missing: '原来的启动命令不可用', launch_command_invalid: '原来的启动命令不可用',
  claude_background_unavailable: '这台机器上 Claude 不能后台运行', invalid_config: '配置文件读取失败',
  session_not_found: '原配置目录里找不到原会话', resume_not_found: '原配置目录里找不到原会话', rollout_not_found: '原配置目录里找不到原会话',
  dedicated_mode_unsupported: '无法确认这个版本的 Codex 由 nxbridge 单独运行',
  session_conflict: '同一会话正开在你的窗口里，需要先选用哪一个', legacy_takeover_unverified: '旧版本接手过这个会话，无法确认已经交还',
  launch_provenance_missing: '找不到原来的启动记录', original_home_changed: '原来的配置目录已经变了',
  bootstrap_policy_unsupported: '这个 Codex 版本不支持 nxbridge 启动时用的严格权限，为免权限变宽先不启动',
  policy_verification_failed: '恢复后的权限和原会话对不上', policy_unknown_unstartable: '读不到原来的权限，而最严格的权限下 Codex 起不来',
};
const recoveryText = (r, who) => {
  if (!r?.state) return undefined;
  const held = r.held ? `，${r.held} 条消息在等` : '';
  const uncertain = r.uncertain ? `；${r.uncertain} 条消息结果不明，不会自动重发` : '';
  const step = r.user_step ? `（${r.user_step}）` : '';
  if (r.state === 'ready') return r.adopted
    ? `已把你打开的 ${who} 窗口接回原配对，同一会话继续；关掉这个窗口后自动交还后台（可用 /nxbridge pair 换绑或解除）${uncertain}`
    : `后台 ${who} 已按原会话自动恢复，不用手动 resume${r.held ? `，${r.held} 条待送消息会继续投递` : ''}${uncertain}`;
  if (r.state === 'recovering') return `后台 ${who} 掉线了，正在按原会话自动恢复${r.attempts_used ? `（第 ${r.attempts_used}/${r.attempts_max} 次）` : ''}${held}${uncertain}`;
  if (r.state === 'blocked') return `后台 ${who} 掉线了，暂时无法自动恢复：${PRECONDITION_TEXT[r.precondition] ?? '启动条件不满足'}${step}；条件满足后会自动接着恢复，消息已保留${uncertain}`;
  if (r.state === 'exhausted') return `后台 ${who} 自动恢复${r.attempts_used ? ' ' + r.attempts_used + ' 次' : ''}都没成功，消息已保留：${r.user_step ? r.user_step : '运行 nxbridge status 查看原因'}${r.extra_used ? '' : '（Claude 也可能写明理由再试一次）'}${uncertain}`;
  if (r.state === 'unknown') return `后台 ${who} 掉线了，上一次恢复结果不明，正在核对；核对清楚前不会再启动，避免同一会话同时运行两份（运行 nxbridge status 查看）${uncertain}`;
  return undefined;
};
                                          
const selfRecoveryText = r => r?.state === 'ready' && r.adopted ? '本窗口已接回原配对，同一会话继续（可用 /nxbridge pair 换绑或解除）' : undefined;
                                                                       
                                                                                        
const noteLines = response => (Array.isArray(response?.notes) ? response.notes : []).map(note => typeof note?.text === 'string' ? note.text.trim() : '').filter(Boolean).slice(0, 3);
const extraFacts = response => [
  response?.permission_guidance ? 'permission: ' + response.permission_guidance.state + (response.permission_guidance.message ? ' - ' + response.permission_guidance.message : '') : '',
  response?.native_issue && response.native_issue.kind !== 'tool_failed' ? `codex native issue: ${response.native_issue.kind}${response.native_issue.tool ? ' tool=' + response.native_issue.tool : ''}${response.native_issue.message ? ' - ' + response.native_issue.message : ''}` : '',
  ...noteLines(response),
].filter(Boolean).join('\n');
                                        
const incidentText = status => {
  const list = (Array.isArray(status?.incidents) ? status.incidents : []).filter(item => typeof item?.userText === 'string' && item.userText.trim());
  const item = list.find(value => value.action?.owner === 'user') ?? list[0];
  if (!item) return undefined;
                                  
  const step = item.action?.owner === 'user' && typeof item.action.text === 'string' && item.action.text.trim() && !item.userText.includes(item.action.text.trim()) ? `；你需要：${item.action.text.trim()}` : '';
  return (step ? item.userText.trim().replace(/[。.]$/, '') : item.userText.trim()) + step + (item.state !== 'blocked' && item.attempts > 1 ? `（已重试 ${item.attempts} 次）` : '');
};
                                                                
const REPLY_MARK = /^\s*\[reply\]\s*/i;
                                          
                                                            
const lostTime = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const lostNext = lost => lost.reason === 'session_deleted'
  ? (lost.restore_state === 'resumable' ? '原会话记录已找回，下次发信时可选择恢复' : lost.replacement?.state === 'uncertain' ? '原会话记录不在了' : '原会话记录不在了，下次发信可新建搭档')
  : lost.restore_state === 'gone' ? '原会话已不存在，下次发信可新建搭档' : '下次发信时可选择恢复原搭档';
const lostProgress = lost => lost.replacement?.state === 'uncertain' ? '；自动新建的搭档结果不明，正在等它登记确认，不会再建第二个'
  : lost.replacement?.state === 'failed' && lost.replacement.terminal ? '；自动新建多次没成功，已停止'
  : lost.replacement?.state === 'failed' ? '；自动新建没成功' + (lostTime(lost.replacement.next_at) ? '，' + lostTime(lost.replacement.next_at) + ' 再试' : '')
  : lost.replacement_suppressed ? '；已按你的选择不自动新建' : '';
const lostHeld = lost => Array.isArray(lost.held_message_ids) && lost.held_message_ids.length ? '；原搭档留下的 ' + lost.held_message_ids.length + ' 条未读消息已保留' : '';
const lostStatusText = lost => `与 Codex 的配对被意外解除（${lostReasonText(lost)}），` + lostNext(lost) + lostProgress(lost) + lostHeld(lost);
                                                                                                                  
const lostModelLine = lost => `codex peer: none; former pair ${lost.pair_id ?? 'unknown'} (${lostPartnerName(lost)}) ended involuntarily: ${lost.reason ?? 'unknown'}${lost.actor ? ' by ' + lost.actor : ''}${lost.at ? ' at ' + new Date(lost.at).toISOString() : ''}; restore ${lost.restore_state ?? 'unverified'}${lost.restore_command ? ' via `' + lost.restore_command + '`' : ''}; next SendMessage to ${ADDRESS} asks user restore/new/cancel (never silently new). tell user`;
                                            
const KNOWN_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const profiles = new Map();
const profileText = peer => [peer?.model, peer?.effort !== undefined ? `effort=${peer.effort}` : undefined].filter(v => v !== undefined).join(' ');
                                 
async function permissionObserved($,e,next){try{const context=await captureContext($),before=context.nativePermission?.mode;await observePermission($,e);const after=context.nativePermission?.mode;if(after!==before&&after!=='unknown')await observeDecision($);await publishFacts($,context);}catch{}return next(e);}
function currentProgress(value,turns){return value&&turns.get('root')?.context===value.context&&turns.get('root')?.turnId===value.turnId&&value.context.nativeHealth?.turnId===value.turnId&&(!value.toolId||value.context.nativeHealth.tools.includes(value.toolId));}
async function healthFor($,e,turns,agentProgress){
  const context=await captureContext($);
  if(!e.agentId)return{context,turnId:e.turnId??turns.get('root')?.turnId};
  const value=agentProgress.get(e.agentId);
  return value?.context===context&&currentProgress(value,turns)?value:undefined;
}
                                                
                                                                                  
const HOST_UPDATE_TEXT='Claude 程序在本窗口运行期间已更新，nxbridge 无法核验本窗口身份，消息和回执都会失败：请关闭并重新打开本窗口（/resume 可回到原会话）；重新加载插件无效';
function receiptCause(state){return state.code==='host_update_unverified'?'host_update':state.failures>=3?'receipts':undefined;}
async function receipt($,operation,payload,state){
  try{await call($,operation,payload);state.failures=0;state.code=undefined;state.text=undefined;state.told=undefined;return true;}
  catch(error){
    state.failures++;state.code=typeof error?.code==='string'?error.code:undefined;
    const cause=receiptCause(state);
    if(cause){state.text=cause==='host_update'?HOST_UPDATE_TEXT:'消息回执连续失败，对方可能以为你没看到（Claude 会择机自动重新加载插件；仍失败请执行 /reload-plugins，或运行 nxbridge doctor 检查）';$.ui.status(state.text);}
    noteReceiptFailure(operation,error,state.failures);
    return false;
  }
}
async function resumePrompt($,context,state,turnId){
  if(!await receipt($,'prompt',{context},state))return;
                                                          
                                              
  const health=context.nativeHealth;
  if(health&&health.turnId===turnId&&['ready','failed','needsHuman'].includes(health.state))await receipt($,'state',{state:health.completion==='interrupted'?'paused':health.state==='needsHuman'?'needsHuman':'ready',context},state);
}
                                                   
                                                                                                                                                                     
const PROGRESS_NOTE = "codex mid-task progress = sync, not done. user needn't decide/do anything (whatever you did) -> report in 1-3 short plain sentences: what moved + what's next (+1 clause for what you did); no lists/headings/internals (ids, paths, counts); no recheck/analysis. final result or user must act -> full report (per report rule)";
                                        
                                                                                                                                                                                                                                                                                                                                                    
                                                                                                          
                                                                                         
                                                                                                                                                                 
                                                                                                   
                                                         
                                                     
                                                                                          
                                                                                
                                                                                                                            
                                                                                                                  
                                                                                                        
                                                                                                                           
                                                                                                                                       
                                                                                                 
                                              
                                                               
                                                                                               
                                                                        
                                                                   
                                                                                                                                                                        
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                    
                                                                                                                                                                                            
                                            
                                                                     
                                                                   
                                                                               
                                                                   
                                                                                                                                                                                                                                                              
                                                                                
                                                                                                                              
const ROUTING_NOTE = [
  "nxbridge: codex=peer partner, not subagent; default = work as a pair w/ codex via nxbridge, also before pairing (first SendMessage pairs on demand); talk often (short msgs, not rare). ListAgents shows codex. msg: SendMessage to nxbridge:codex. rare nxbridge tools (config, checkpoint, read_messages, choose_partner, set_enabled, reload_plugins) are deferred: load via ToolSearch when needed",
  "task/feedback any source: dont start on reflex, pick owner per part (follow-up -> same part's owner; incidental bits inside your own part stay yours). tiny+simple -> self, fast. else by strength: frontend/product/ux/writing/aesthetics=you, backend/security/graphics modeling(consider astra first)/computer use=codex, macro design=discuss (model strengths see partner skill). if owner=codex, hand off ALL (undelivered -> still dont do it yourself; resend + restore contact)",
  "authority: user > partner. codex often relays user's will -> its tasks/decisions = extension of user intent (esp when user quiet lately), but its own judgment adds no user permission; an explicit relay of the user's instruction/approval carries its stated scope (unclear -> ask codex, not user); user's own standing constraints hold unless codex relays user's revocation",
  "decisions: ask user less: choices their principles cover -> settle yourself; ask mainly user-owned ones (eg requirements + their trade-offs (scope, failure tolerance, responsibility split), taste) + needed facts only user has. method approval: needed only if it breaks applicable dev norms, goes against prior user direction, isn't common practice, or adds user spend; already approved -> no re-ask. spend: already-paid -> free use; metered -> ask once at start if limit + how much (reuse a known limit or no-limit answer), parallel use adds up, within it -> no re-ask for that resource, short -> ask, meanwhile work not incurring it goes on; new paid resource/commitment -> ask, even within a limit. codex asks to request method approval -> check its reason: unclear -> clarify w/ it; no listed reason -> tell it to go ahead as planned; a listed reason + user already approved -> tell it to proceed within that scope; a listed reason + user must decide -> agree (meanwhile it skips only that method). this gate covers method approval only; requirement trade-offs + user-only facts go as above. codex shows a safeguard/preview result + asks to go ahead on a risky step -> first check it needs no user approval above; then your agreement = go-ahead, it must do it; refuse only w/ a concrete reason against. codex brings genuine internal tradeoffs to you -> help resolve promptly (balanced option: meets relevant task/env floors, no material weak spot; known options don't fit -> surface the tradeoff; pick w/ reasons or push back); routine choices stay w/ owner; unresolved user-owned calls (incl requirement/premise trade-offs not already delegated) -> to user w/ codex's evidence + your view, dont settle them",
  "bar: you usually set it, once per task: tier small/medium/large by its use (not repo size). small = usable core fast, other fixes only if likely + cheap; medium = + likely issues hurting use, fair cost; large = + project norms, whatever is worth it; concrete severe failure -> fix or fail visibly at any tier; applies to review findings too. inferred -> 1 line to user in first update; only real-use evidence changes it",
  "own work: partner doesnt change your subagent rules: still use own subagents for parallel/search/ctx isolation. keep session model (switch = cache loss); work fitting other claude model -> subagent w/ model + effort (default high/xhigh)",
  "schedule (defaults; user intent overrides: msgs, CLAUDE.md/AGENTS.md/task requirements, user wishes relayed by codex): small task -> skip upfront split talk + multi-round review; parts still by strength. other nontrivial task -> before starting, agree split + parallel parts w/ codex when reachable (not agreed yet -> start parts surely yours, no idle wait), then each side delegates to own subagents where useful. owner keeps critical path moving, waits only on real dependencies, integrates/releases. git repo -> worktrees allow parallel feature edits. missing user/reporter-only info needed for the task + not findable -> ask early; continue independent work. peer review before irreversible/outward steps (outward = real external effect, eg push, publish, live servers, sending for user; not routine progress msgs; review pending -> prep + verify meanwhile, only that step waits); overlap independent implementation/docs/tests; reuse checks unless changes/new evidence invalidate them; codex says a key check can't be done -> agree only if you also find no workable way. pair: one heavy test/build group at a time. codex hands over files it can't delete w/o force -> find cause; force only if cause + scope confirmed safe; still unclear -> leave files, continue other work; ask user only per decisions",
  "delegate: to strong model (codex or subagent above Sonnet/Haiku class): goal + why + bar + hard constraints + known facts, not the method (even a borrowed one); no pre-listed report items (required deliverables ok); ask it to review deeply + plan fully itself within the bar (incl needed unstated work). to codex: also push it to own that outcome fully (gpt initiative weaker). small model: concrete steps ok. codex side (host + its subagents) GPT models only. default gpt-6.2-sol model xhigh effort unless user instruction",
  "send: long existing text -> nxref, dont retype (output tokens costly): nxref:msg:<message_id> (any pair msg, sent/received) / nxref:agent:<agentId> (own finished subagent final answer); nxbridge inlines it in Agent prompt or partner msg. msg needing partner reply (task/question) -> start it w/ [reply] (stripped, marks reply owed); report/FYI/ack -> no mark. incoming header w/ reply_expected = partner awaits your reply",
  "changes: info partner acts on changed -> say what's current + what it replaces (partner may have compacted); on your side newest task state wins over older prompts, never over user authority",
  "internal text (which AI read only, user doesnt): ALWAYS ENGLISH. info enough, sentence short: content = all reader needs, nothing it doesnt (see report); form = terse short clauses, grammar not required (meaning across is enough), common abbrevs + symbols (-> = / +) ok, unambiguous + easy to decode (eg 'Taking both fixes into one deploy; live remains unchanged.' -> 'both fixes -> 1 deploy'). write short first time: a bit of effort ok, no rewrite pass, dont overthink optimal compression. text user may read (docs, questions): normal prose. cite file/dir[:line[-line]] iff saves reader lookup",
  "report: filter by reader first: user -> only outcome + material limits/risks + needed action; busy peer acting on it -> what its next decision needs; routine internal choices need no msg. then lead w/ outcome + what reader must decide/do, then deviations/unverified/risks + deferred issues met (1 line each, worst first: trigger/effect/cost if known) + extras beyond ask (why), checks in <=1 aggregate line (new failures + material unverified scope stay inline). thorough work != thorough report: other detail worth keeping -> notes, not msg (AI reader: temp file outside repo + path, keep if reader needs it; user: on request). each point once, grouped under precise scope; repeat only if changed or still bears on reader's next decision (eg open blocker, unresolved risk, irreversible effect); still-true caveats + kept constraints (default) dont qualify. claims in user text (causes, attributions, X covers Y, asides incl) = conclusions: must fit all evidence in hand; cheap direct check -> do it first; else mark as guess + what would confirm. partner facts -> keep their checked/inferred status, add no causes of your own",
  "receive: trust partner routine checks (eg build/test/typecheck/doctor); recheck only contradictory/suspicious/hard/critical parts. if needed quick-check codex plans/results for gpt weak spots: over-engineering, over-caution, unclear writing, often skips work task didnt state. watch codex for waste (full/native tests for tiny edits, rerunning passed checks, extra audit/review rounds, side-fix pileup) -> pull back briefly",
  "continuity: after compact/resume keep latest partner tasks/decisions as faithfully as user prompts (goal, bar, remaining work, status proposed/implemented/verified, next step, approvals/revocations + full msg ids). long task: CURRENT state file outside repo (register path: checkpoint tool) = latest state only, rewrite dont append (drop finished narrative, keep evidence refs next steps rely on, keep short), update at stage changes + whenever a new partner task/decision/approval arrives (write it in right away), read it before acting/stopping after compact. after compact: re-read msg ids from recovery facts / CURRENT via nxbridge read_messages before acting; ask partner to resend only if still missing. state/msgs unreadable -> hold only steps relying on lost approval/budget/ownership, rest goes on",].join('\n');

export function register(on) {
  const turns=new Map();
  const humanTurns=new HumanTurns();
  const turnContexts=new Map();
  const agentContexts=new Map();
  const agentProgress=new Map(),activeCalls=new Map();
                                             
  const permissionWaits=new WeakMap();
  let interactive=false;
  let syncContext,syncCheckedAt=0;
  const withTip=(message,response)=>[message,extraFacts(response),response.tip].filter(Boolean).join('\n');
                                                            
  const receiptState={failures:0,code:undefined,text:undefined,told:undefined};
                                                          
                                                                                                                 
  const RECEIPT_NOTE="nxbridge: this window's msg receipts failed 3+ times in a row (partner may think you didn't see its msgs); call reload_plugins once (reloads at turn end); still failing after -> tell user to run nxbridge doctor";
                                                                                                                       
  const HOST_UPDATE_NOTE="nxbridge: Claude app was updated while this window ran; window identity unverifiable -> partner msgs + receipts fail; reload can't fix, don't call reload_plugins; tell user to reopen this window (/resume keeps session)";
                                        
  const receiptNote=e=>{const cause=receiptCause(receiptState);if(e.agentId||!cause||receiptState.told===cause)return;receiptState.told=cause;return cause==='host_update'?HOST_UPDATE_NOTE:RECEIPT_NOTE;};
                                                                     
                                                     
  let replyLinks={context:undefined,observed:[],linked:0};
  const linksFor=context=>{if(replyLinks.context!==context)replyLinks={context,observed:[],linked:0};return replyLinks;};
  on('classic.SessionStart',permissionObserved);
  on('classic.UserPromptSubmit',permissionObserved);
  on('classic.PreToolUse',permissionObserved);
                                                                                 
  on('classic.Stop',async($,e,next)=>{
    await observePermission($,e);
    try{const context=await observeStop($,e),health=context?.nativeHealth;if(health&&humanTurns.current(context,health.turnId)&&['ready','failed'].includes(health.state))await receipt($,'state',{state:health.completion==='interrupted'?'paused':'ready',context},receiptState);}catch{}
    return next(e);
  });
                                                                 
  on('classic.PermissionRequest',async($,e,next)=>{
    const value=await healthFor($,{agentId:e.agent_id},turns,agentProgress);
    if(value&&e.session_id===value.context.sessionId){
      progress(value.context,value.turnId,'human',undefined,false);
      if(value.context.nativeHealth?.state==='needsHuman'&&value.context.nativeHealth.turnId===value.turnId){permissionWaits.set(value.context,(permissionWaits.get(value.context)??0)+1);try{await receipt($,'state',{state:'needsHuman',context:value.context},receiptState);}catch{}}
    }
    return next(e);
  });
                                              
  on('telemetry.log',{to:'collector',event:'tool_decision'},async($,e,next)=>{
    const value=activeCalls.get(e.attributes?.tool_use_id);
    if(currentProgress(value,turns)&&value.context===await captureContext($)&&['accept','reject'].includes(e.attributes?.decision)){
      progress(value.context,value.turnId,'progress');
                                                                  
      const waits=permissionWaits.get(value.context)??0;
      if(waits>0&&e.attributes?.source!=='config'){permissionWaits.set(value.context,waits-1);if(waits===1&&value.context.nativeHealth?.state==='running')try{await receipt($,'state',{state:'busy',context:value.context},receiptState);}catch{}}
    }
                                              
    try{const denied=await observeAutoDecision($,e.attributes);if(denied)await receipt($,'state',{state:'busy',context:denied},receiptState);}catch{}
    return next(e);
  });
  on('prompt.submit', async ($, e, next) => {
                                 
                                                              
    const human=await humanPrompt($,e),context=human?await captureContext($):undefined;
    if (human) {
      const note=receiptNote(e);if(note)e={...e,context:[...(e.context??[]),note]};
    }
                                                      
                                                         
                                                                             
    let heldContext,entries=[];
    const attachHeld=async changed=>{
      if(changed.agentId||!hasHeld())return changed;
      try{heldContext=await captureContext($);entries=await takeHeld($,heldContext);}catch{return changed;}
      return entries.length?{...changed,context:[...(changed.context??[]),...entries.map(entry=>entry.text)]}:changed;
    };
    const wake=!!noticePickup(e);
    if(!wake)e=await attachHeld(e);
    const before=human?humanTurns.turn(context):undefined;
    let result;
    try{result=await noticePrompt($,e,async changed=>questionSubmit($,wake?await attachHeld(changed):changed,next));}
    catch(error){if(entries.length)await settleHeld($,entries,heldContext,'unknown',String(error?.message??error));throw error;}
    if(entries.length){
                                        
      const entered=!result?.drop&&entries.every(entry=>result?.context?.includes(entry.text));
      await settleHeld($,entries,heldContext,result?.drop?'requeue':entered?'submitted':'unknown',result?.drop||entered?undefined:'通知正文未出现在宿主上下文回执中');
    }
    const accepted=human&&humanTurns.submit(context,e,result,before);
    if(accepted)await resumePrompt($,context,receiptState,accepted.turnId);
    return result;
  }).catch(noticeFailure);
  on('tool.call', {tool:'AskUserQuestion'}, nativeFormCall).catch(nativeFormFailure);
  on('tool.call',async($,e,next)=>{
    const health=await healthFor($,e,turns,agentProgress),context=health?.context,turnId=health?.turnId,work=!/receive_messages$/.test(e.tool??'');
    const value=health&&(e.agentId?health:{context,turnId,toolId:e.tool_use_id});
    if(value&&e.tool_use_id)activeCalls.set(e.tool_use_id,{...value,delegation:['Agent','Task'].includes(e.tool)});
    if(context)progress(context,turnId,e.agentId?'progress':'tool_start',e.agentId?undefined:e.tool_use_id,work);
    if(context&&e.tool==='AskUserQuestion')progress(context,turnId,'human',undefined,false);
    if(context&&syncContext!==context){syncContext=context;syncCheckedAt=Date.now();}
    let result;
    try{result=await questionCall($,e,next);}finally{if(e.tool_use_id)activeCalls.delete(e.tool_use_id);if(context&&(!e.agentId||currentProgress(health,turns)))progress(context,turnId,e.agentId?'progress':'tool_end',e.agentId?undefined:e.tool_use_id,work);}
    if(!result?.deny){const note=receiptNote(e);if(note)result={...result,context:[...(result?.context??[]),note]};}
                                               
    if(!e.agentId&&!result?.deny&&hasHeld()){
      const heldContext=await captureContext($),entries=await takeHeld($,heldContext);
      if(entries.length){result={...result,context:[...(result?.context??[]),...entries.map(entry=>entry.text)]};await settleHeld($,entries,heldContext,'submitted');}
    }
    if(e.agentId||!context||syncContext!==context||result?.deny)return result;
                                         
    const now=Date.now();if(now-syncCheckedAt<60000)return result;syncCheckedAt=now;
                                                                      
    let usage;try{const tokens=(await $.session.usage())?.context?.tokens;if(Number.isFinite(tokens)&&tokens>0)usage={tokens,observedAt:Date.now()};}catch{}
    const compaction=compactions.get(context);
    try{const response=await call($,'tip-sync',{context,...(usage?{usage}:{}),...(compaction?{compaction}:{})});if(response.tip)return{...result,context:[...(result?.context??[]),response.tip]};}catch{}
    return result;
  });
  on('tool.call', {tool:'mcp__nxbridge__select_partner'}, async ($, e, next) => pairingCall($, e, next));
  on('tool.call', {tool:'mcp__nxbridge__choose_partner'}, openPartnerCall);
  on('tool.call', {tool:'mcp__nxbridge__partner_profile'}, partnerProfileCall);
  on('tool.call', {tool:'mcp__nxbridge__config'}, async ($, e, next) => configurationCall($, e, next));
  on('tool.call', {tool:'mcp__nxbridge__checkpoint'}, recoveryCall);
  on('tool.call', {tool:'mcp__nxbridge__read_messages'}, recoveryCall);
  on('tool.call', {tool:'mcp__nxbridge__set_enabled'}, switchCall);
  on('tool.call', {tool:'mcp__nxbridge__reload_plugins'}, async ($, e, next) => reloadCall($, e, next, () => receiptCause(receiptState)));
  on('session.compact', recoveryCompact);
  on('session.start', async ($, e, next) => {
    interactive=e.isInteractive===true;setPairingInteractive(interactive);
                                                                                      
    try{await observeInteractive($,e.isInteractive===true?true:undefined);}catch{}
    turns.clear();
    turnContexts.clear();
    agentContexts.clear();
    agentProgress.clear();
    activeCalls.clear();
                                            
    try { setModVersion(JSON.parse(await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json')).version,MOD_REVISION); } catch { setModVersion(undefined,MOD_REVISION); }
    try {
      profiles.clear();
      await questionStart($);
      await configurationStart($);
      await pairingStart($);
      await recoveryStart($);
      await reloadStart($);
      await switchStart($);
      await call($, 'context-start');markContextStarted(await captureContext($));
      try { await observeInbound($);await observeProfile($); await observeDecision($); await publishFacts($,await captureContext($)); } catch {}
      await $.command.register({ name: 'nxbridge', description: '查看搭档状态或修改配置', argumentHint: '[pair|on|off [codex]|config list|get|set|unset|confirm]' });
    } catch (error) { $.ui.status(String(error)); }
                                                                                                                   
      let strikes = 0;
      let monitoring = false;
      let checkingStatus = false;
      let inboundTicks = 0;
      let noticeFailureText;
      const provided=new Map(),outageClaims=new Map();
                                                        
                                               
      const awaitingMode=new Map();
                                                                       
                                                                
      const retries=new Map();let failedNotice;
      const showFailure=(id,text)=>{noticeFailureText=text;failedNotice=id;$.ui.status(text);};
      const reportNotice=(id,state,error)=>{
                                          
        if(state==='cancelled'){provided.delete(id);retries.delete(id);return;}
        if(state==='retry'){
          const attempts=(retries.get(id)?.attempts??0)+1,wait=attempts<4?0:Math.min(60_000*2**(attempts-4),600_000);
          retries.delete(id);retries.set(id,{attempts,nextAt:Date.now()+wait});if(retries.size>32)retries.delete(retries.keys().next().value);
          provided.delete(id);
                                                       
          if(attempts===4)showFailure(id,`运行时通知暂未送达：${error}（会自动重试）`);
          return;
        }
        if(state==='submitted'){retries.delete(id);if(failedNotice===id){failedNotice=undefined;noticeFailureText=undefined;}}
        provided.set(id,{state,error});if(provided.size>32)provided.delete(provided.keys().next().value);
        if(state==='submitted')return;
                                                                   
        noticeFailureText=`运行时通知${state==='denied'?'被宿主策略拒绝':'未确认'}${error?'：'+error:''}`;
        failedNotice=state!=='denied'?id:undefined;
        $.ui.status(noticeFailureText);
      };
      $.clock.every(15_000, async () => {
        if(monitoring)return;monitoring=true;
        try{
                                             
          const health=await read($,'monitor');
          const noticeContext=await captureContext($);
                                               
          const pendingIds=new Set((health.notices??[]).map(notice=>notice.id));
          if(failedNotice&&!pendingIds.has(failedNotice)){failedNotice=undefined;noticeFailureText=undefined;}
          for(const id of retries.keys())if(!pendingIds.has(id))retries.delete(id);
          for(const notice of health.notices??[]){
                                                       
            if(notice.id?.startsWith('broker-outage:')&&notice.claimedBy?.at!==undefined&&outageClaims.get(notice.id)!==notice.claimedBy.at){outageClaims.set(notice.id,notice.claimedBy.at);if(outageClaims.size>32)outageClaims.delete(outageClaims.keys().next().value);provided.delete(notice.id);}
                                                                      
            if(typeof notice.tier==='number'&&notice.tier<3)continue;
                                                                   
            if(provided.has(notice.id)&&!(notice.wake===true&&upgradeHeld(notice.id)))continue;
            if((retries.get(notice.id)?.nextAt??0)>Date.now())continue;
            if(awaitingMode.has(notice.id)){const seen=awaitingMode.get(notice.id),observed=noticeContext.nativePermission;if(!observed||observed.observedAt<=seen||!KNOWN_MODES.has(observed.mode))continue;awaitingMode.delete(notice.id);}
                                              
            provided.set(notice.id,{state:'queued'});if(provided.size>32)provided.delete(provided.keys().next().value);
            try{
              const result=await deliverNotice($,notice,noticeContext,(state,error)=>reportNotice(notice.id,state,error));
                                                                              
              if(result?.drop==='condition resolved before delivery'||result?.deferred===true)provided.delete(notice.id);
              if(result?.drop&&result.drop!=='condition resolved before delivery')reportNotice(notice.id,'denied',String(result.drop));
            }catch(cause){
                                                                     
              if(cause?.code==='permission_unknown'){provided.delete(notice.id);awaitingMode.set(notice.id,noticeContext.nativePermission?.observedAt??0);continue;}
              if(retryable(cause)){reportNotice(notice.id,'retry',preSubmitBusy(cause)?'数据库繁忙':String(cause?.message??cause));continue;}
              reportNotice(notice.id,'unknown',String(cause));
            }
          }
        }catch{}finally{monitoring=false;}
      });
      $.clock.every(15_000, async () => {
        if(checkingStatus)return;checkingStatus=true;
        try{
                                              
        if(++inboundTicks>=8){inboundTicks=0;try{await observeInbound($);await observeProfile($);await observeDecision($);await publishFacts($,await captureContext($));}catch{}}
        let status;
        try { status = await read($, 'status'); } catch {}
        const state = status?.paired ? status.partner?.state : undefined;
        strikes = !status || state === 'offline' ? strikes + 1 : 0;
                                                    
        if(status?.disabled===true){$.ui.status('本窗口的 nxbridge 已关闭（输入 /nxbridge on 打开）');return;}
                                                           
        if(status?.integrationAction)await autoReload($,status.integrationAction,async action=>call($,'reload-attempt',{attempt_id:action.attemptId,target_revision:action.targetRevision,context:await captureContext($)}));
        $.ui.status(noticeFailureText??receiptState.text??(!status ? (strikes >= 2 ? '获取不到 nxbridge 状态，后台服务可能停了：持续 2 分钟会自动请一个 AI 处理（也可自己运行 nxbridge bootstrap）' : undefined)
          : !status.paired && status.pair_lost ? lostStatusText(status.pair_lost)
          : status.partner?.enabled === false ? 'Codex 的 nxbridge 已关闭，不会向它投递或拉起它（输入 /nxbridge on codex 打开）'
          : status.paused ? '配对已暂停（运行 nxbridge resume' + (status.self?.id ? ' --member ' + status.self.id : '') + ' 恢复）'
          : status.self?.state === 'paused' ? '本窗口已暂停（中断后，发消息即恢复）'
                                                  
          : autoModeText(status.self?.claude_auto_mode) ? autoModeText(status.self.claude_auto_mode)
                                                         
          : profileHeldText(status.partner?.partner_profile) ? profileHeldText(status.partner.partner_profile)
          : hostingText(status.partner?.hosting) ? hostingText(status.partner.hosting)
                                              
          : recoveryText(status.partner?.recovery, 'Codex') ? recoveryText(status.partner.recovery, 'Codex')
          : selfRecoveryText(status.self?.recovery) ? selfRecoveryText(status.self.recovery)
                                                          
          : (status.integrationIssues ?? []).some(issue => (issue?.code ?? issue) === 'launch_failed') ? launchFailedText((status.integrationIssues ?? []).find(issue => issue?.code === 'launch_failed'))
          : state === 'paused' ? pausedText(status.partner)
          : firstPromptText(status.partner?.delivery_wait) ? firstPromptText(status.partner.delivery_wait)
          : status.waiting_context ? 'Codex 新对话还没开始，消息在等待（在该 Codex 窗口发一条消息后送达）'
                                                                     
          : state === 'needsHuman' ? ((status.partner?.delivery_wait?.state === 'needs_human' && humanWaitText(status.partner.delivery_wait)) || 'Codex 等待人工处理（到 Codex 窗口查看）')
                                                      
          : incidentText(status) ? incidentText(status)
                                                                   
          : providerText(status.partner?.health) ? providerText(status.partner.health)
                                             
          : admissionText(status.delivery_admission, status.permission_guidance ?? status.partner?.permission_guidance) ? admissionText(status.delivery_admission, status.permission_guidance ?? status.partner?.permission_guidance)
          : permissionText(status.permission_guidance ?? status.partner?.permission_guidance) ? permissionText(status.permission_guidance ?? status.partner.permission_guidance)
          : waitText(status.partner?.delivery_wait) ? waitText(status.partner.delivery_wait)
          : integrationText(status) ? integrationText(status)
          : status.partner?.health?.state === 'networkRetrying' ? `Codex 网络重连中${status.partner.health.retry?.attempt !== undefined ? '，第 ' + status.partner.health.retry.attempt + '/' + status.partner.health.retry.max + ' 次' : ''}（运行 nxbridge status 查看）`
                                                               
          : status.partner?.health?.state === 'silent' ? (status.partner.health.progressEvidence === false ? 'Codex 的进度暂时无法观测，不代表卡住（运行 nxbridge status 查看）' : 'Codex 长时间没有进展，原因未知（运行 nxbridge status 查看）')
          : status.partner?.health?.state === 'failed' ? failedText(status.partner.health)
          : strikes >= 8 ? 'Codex 离线超过 2 分钟（运行 nxbridge status 查看）' : undefined));
        }finally{checkingStatus=false;}
      });
    return next(e);
  });

  on('prompt.compose', async ($, e, next) => {
                                
    if(isOff())return next(e);
    const result = await next(e);
    return { sections: [...result.sections, { id: 'nxbridge:task-routing', text: ROUTING_NOTE, scope: 'session' }, { id: 'nxbridge:questions', text: QUESTION_NOTE, scope: 'session' }, { id: 'nxbridge:partner-progress', text: PROGRESS_NOTE, scope: 'session' }] };
  });

  on('command.run', { command: 'nxbridge' }, async ($,e) => {
    try { if(SWITCH_COMMAND.test(e.args?.trim()??''))return await switchCommand($,e);
      return /^pair(?:\s|$)/.test(e.args?.trim()??'')?await pairingCommand($,e):await configurationCommand($,e); }
    catch (error) { return { text: String(error) }; }
  });

  on('command.run',{command:'effort'},async($,e,next)=>{
    await beginEffortCommand($,e.args??'');
    const result=await next(e);
    scheduleProfileRead($);
    return result;
  });
  on('command.run',{command:'model'},async($,e,next)=>{const result=await next(e);scheduleProfileRead($);return result;});

  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const result = await next(e);
    if(isOff())return result;
    try {
      const status = await call($, 'status', { model_view: true });
                                                                                                  
      const line = status.paired
        ? `codex peer: ${ADDRESS}, state ${status.partner.state}${status.partner.context_state?', '+status.partner.context_state:''}${status.partner.health ? ', native=' + status.partner.health.state : ''}${profileText(status.partner) ? ', ' + profileText(status.partner) : ''}${status.partner.delivery_mode==='daemon-direct' ? ', delivery daemon-direct (wakes while that Codex window is open; receipt still required)' : ''}${status.partner.delivery_mode==='daemon-pull' ? ', delivery daemon-pull (no wake; idle needs user input in that Codex window'+(status.partner.delivery_wait?.pending ? ', '+status.partner.delivery_wait.pending+' waiting' : '')+')' : ''}${status.paused ? ', pair paused' : ''}${status.partner.delivery_wait?.open_command ? ', needs ' + humanAskModel(status.partner.delivery_wait) + ': user runs "' + status.partner.delivery_wait.open_command + '" in project terminal' : ''}${status.partner.delivery_wait?.reason === 'awaiting_first_prompt' ? ', codex window has no conversation yet: user types once there' : ''}${(status.permission_guidance ?? status.partner.permission_guidance) ? ', permission ' + (status.permission_guidance ?? status.partner.permission_guidance).state : ''}${status.partner.native_issue ? ', last native issue ' + status.partner.native_issue.kind + ' (tool fact, not task outcome)' : ''}${status.partner.recovery?.state ? `, managed recovery ${status.partner.recovery.state}${status.partner.recovery.attempts_used !== undefined ? ' ' + status.partner.recovery.attempts_used + '/' + status.partner.recovery.attempts_max + (status.partner.recovery.extra_used ? '+1' : '') : ''}${status.partner.recovery.precondition ? ' (' + status.partner.recovery.precondition + ')' : ''}${status.partner.recovery.user_step ? ', user step `' + status.partner.recovery.user_step + '`' : ''} incident ${status.partner.recovery.incident_id}` : ''}. send via SendMessage; member ${status.self?.member_id}, conversation ${status.self?.session_id}, pair ${status.pair_id}`
        : status.pair_lost ? lostModelLine(status.pair_lost)
        : `codex peer: none for this window (pairs of other windows not shown); first SendMessage to ${ADDRESS} pairs on demand`;
      if (result && result.result && typeof result.result.listing === 'string') {
                                                
        return { result: { ...result.result, listing: result.result.listing + '\n' + line + (status.paired && hostingModel(status.partner?.hosting) ? '; ' + hostingModel(status.partner.hosting) : '') + noteLines(status).map(note => '\n' + note).join('') }, ...(result.context ? { context: result.context } : {}) };
      }
      return result;
    } catch { return result; }
  });

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if(isMonitorRecipient(e.to))return{result:{success:false,message:'runtime monitor is not a recipient; act on facts or tell user',display:'运行时监测不是收件人'}};
                                                                                  
                                                     
    const to=typeof e.to==='string'?e.to.trim():e.to;
    if(typeof to==='string'&&to.toLowerCase()===ADDRESS)e={...e,to:ADDRESS};
    else if(typeof to==='string'&&/^nxbridge\s*:/i.test(to))return{result:{success:false,message:`not sent: no recipient '${to}'; partner address is ${ADDRESS}, resend to it`,display:`地址有误，未发送（搭档地址是 ${ADDRESS}）`}};
    if (e.to !== ADDRESS) return next(e);
                                                             
    if(isOff())return{result:{success:false,message:'not sent: user turned nxbridge off in this window; if needed ask user to type /nxbridge on',display:'本窗口的 nxbridge 已关闭，未发送'}};
                                                                                                                                
    const replyExpected=typeof e.message==='string'&&REPLY_MARK.test(e.message);
    if(replyExpected)e={...e,message:e.message.replace(REPLY_MARK,'')};
    if (!e.message) return { result: { success: false, message: 'nxbridge: msg body required (idle notify unsupported); partner state -> ListAgents', display: '未发送' } };
    try {
      const context=await captureContext($),turnId=turns.get(e.agentId??'root')?.turnId;
      const agents = e.agentId ? await $.agent.list() : undefined;
      const links=e.agentId?undefined:linksFor(context),observed=links?.observed.length;
      const evidence=links?(observed>links.linked?links.observed[observed-1]:turnSource(undefined,context)):undefined;
                                        
      const original = await call($, 'send', { context, message: e.message, via: e.agentId, agents, callId: e.tool_use_id,turnId,...(evidence?{auto_reply_to:evidence.id,auto_reply_text:evidence.text}:{}),...(replyExpected?{reply_expected:true}:{}) });
      if(links&&original?.message_id)links.linked=Math.max(links.linked,observed);
                                                 
      if((await captureContext($))!==context)return{result:{success:!!original?.message_id,message:`send result belongs to the previous conversation; check it there before retrying${original?.message_id?'; message_id='+original.message_id:''}`,display:original?.message_id?'原对话的消息已保存':'对话已切换，请回原对话查看发送结果'}};
      const selected = await choosePartner($,original,interactive&&!e.agentId);
                                                                         
      const pairWarning = selected.status==='paired' ? pairPermission(selected.permission_guidance) : undefined;
      if(pairWarning)try{$.ui.toast(pairWarning.user);}catch{}
      const response = selected.status==='paired'?{...selected,status:'queued'}:selected;
                                                                      
      if(response.status==='pick_in_chat')return{result:{success:false,message:'not sent yet (held until pairing); '+pickInChat(response)+'; original message sends after commit, do not resend',display:'等你告诉 Claude 要配哪个 Codex 窗口'}};
      if(response.status==='no_pair_options')return{result:{success:false,message:'not sent: '+pairingModelResult(response)+(response.pairing_code?'; original message sends after pairing by code, do not resend':''),display:noPairOptionsText(response)}};
                                                                       
                                                                                                            
      if(response.status==='selection_required'&&response.reason==='hosting')return{result:{success:true,message:withTip(`saved, NOT delivered: partner Codex window closed (pair kept); ask user: continue original session in bg / wait for window / new partner / unpair; commit user's answer via select_partner selection_id=${response.selection_id} action=adopt|wait|create|unpair; never choose yourself; do not resend; message_id=${response.message_id}${hostingModel(response.hosting)?'; '+hostingModel(response.hosting):''}`,response),display:'消息已保存：搭档的 Codex 窗口已关闭，等你选择怎么处理'}};
                                                         
      if((response.hosting?.verifying===true||response.hosting?.phase&&['window_closed','awaiting_window','adopting','verifying','releasing','blocked'].includes(response.hosting.phase))&&!['selection_required','selection_declined','bootstrap_required'].includes(response.status))return{result:{success:true,message:withTip(`saved, NOT delivered: ${hostingModel(response.hosting)}; delivers after hosting resolves; do not resend; message_id=${response.message_id??original.message_id}`,response),display:'消息已保存：'+(hostingText(response.hosting)??'等 Codex 会话接上后送达')}};
      if(['selection_required','selection_declined','bootstrap_required'].includes(response.status))return{result:{success:false,message:response.status==='selection_required'?JSON.stringify(response):response.message,display:response.status==='selection_required'?(response.reason==='pair_lost'?'原配对已断开，等待选择恢复或新建':'等待选择搭档'):response.status==='selection_declined'?'未配对，消息未发送':'请先在普通 PowerShell 运行 nxbridge bootstrap'}};      if(response.status==='starting')return{result:{success:true,message:withTip(`${response.message}; message_id=${response.message_id}`,response),display:'消息已保存，正在启动搭档'}};
                                                                                  
                                                      
                                                                                                     
      if(response.status==='queued'&&response.delivery_wait?.state==='context_changing'&&response.delivery_wait.reason==='native_context_changed'){
        const wait=response.delivery_wait;
        return{result:{success:true,message:withTip(`saved, NOT delivered: same-project Codex likely switched to a newer conversation; old session ${wait.name?'"'+wait.name+'" ':''}(${wait.session_id??'unknown'}) not woken; tell user: type nxbridge pair in the conversation they want, or type once in the old session; never auto-forwarded; do not resend; message_id=${response.message_id}`,response),display:`消息已保存但未送达：这个项目开了新的 Codex 对话，原会话${waitName(wait)}暂不唤醒`}};
      }
                                                        
                                                                               
      if(response.delivery_wait?.reason==='awaiting_first_prompt'){
        const wait=response.delivery_wait;
        return{result:{success:true,message:withTip(`saved, NOT delivered: Codex window ${wait.name?'"'+wait.name+'" ':''}has no conversation yet (official API needs a thread); tell user to type once in that Codex window, then it delivers automatically; not a permission issue; do not resend; message_id=${response.message_id}`,response),display:`消息已保存：Codex 窗口${waitName(wait)}还没开始对话，先在那个窗口输入一句后送达`}};
      }
      if(['waiting_native_input','waiting_native_interaction'].includes(response.status)){
        const wait=response.delivery_wait??{},idle=response.status==='waiting_native_input';
        return{result:{success:true,message:withTip(`${response.message??'saved'}; NOT delivered/observed: shared-daemon Codex ${wait.name?'"'+wait.name+'" ':''}(session ${wait.session_id??'unknown'}) cannot be woken; ${idle?'picks up only after user types in that Codex window':'picks up at its next native interaction'}; tell user: type "nxbridge pickup" in that Codex window to collect (marked as pickup only, not an answer or approval)${wait.resume_command?'; if that window is closed, user first runs "'+wait.resume_command+'" in a terminal in the project dir to reopen the same session':''}; do not resend; message_id=${response.message_id}`,response),display:idle?`消息已保存但未送达：到 Codex 窗口${waitName(wait)}输入 nxbridge pickup 即可取件${resumeHint(wait)}`:`消息已保存，等 Codex 窗口${waitName(wait)}下一次交互时取件`}};
      }
      if(response.status&&response.status!=='queued'&&response.status!=='observed'&&response.status!=='starting'){
                                             
                                                                                              
        if(response.delivery_wait?.state==='needs_human'&&response.delivery_wait.open_command){
          const wait=response.delivery_wait;
          return{result:{success:false,message:withTip(`${response.message}; Codex waits for ${humanAskModel(wait)}; tell user: run "${wait.open_command}" in a terminal in this project dir to answer it in the original session; never auto-approved; persisted=true, do not resend; message_id=${response.message_id}`,response),display:`消息已保存：Codex${waitName(wait)}在等你${humanAsk(wait) ?? "处理"}，在项目目录终端运行 ${wait.open_command} 处理`}};
        }
        const displays={blocked:'消息已保存，投递受阻；恢复后自动通知',unverified:'消息已保存，运行时可达性未确认',unknown:'消息已保存，提交结果不明；不会自动重发',paused:'消息已保存，正在暂停或等待人工处理',held:'消息已保存，宿主暂扣',refused:'消息已保存，宿主拒收',expired:'消息已过期'};
        return{result:{success:false,message:withTip(`${response.message}; persisted=true, delivery_state=${response.delivery_state}; do not resend; message_id=${response.message_id}`,response),display:displays[response.status]??'消息已保存，未确认已读'}};
      }
                                       
      return { result: { success: true, message: withTip(`${response.message??'saved; queued for delivery; read not confirmed'}; message_id=${response.message_id}${pairWarning?'; '+pairWarning.model:''}`,response), display: (response.status==='observed'?'已确认原生上下文或回信':'消息已保存并排队，未确认已读')+(pairWarning?'。'+pairWarning.user:'') } };
    } catch (error) {
      return { result: { success: false, message: modelMessage(error), display: error?.uncertain === true ? '发送结果未确认' : '未发送' } };
    }
  });

  on('session.receive', async ($, e, next) => {
    const match = typeof e.text === 'string' && /\[nxbridge message_id=([0-9a-f-]+)/.exec(e.text);
    if (match && ['peer', 'peer-send-message'].includes(e.origin?.kind)) {
                                                 
      const fromMode = /from-mode="([^"]*)"/.exec(e.text)?.[1];
      const hold = predictedHold(await captureContext($), fromMode);
      await receipt($, 'observe', { message_id: match[1], state: 'observed', ...(hold ? { admission: 'approval_required' } : {}) },receiptState);
    }
                                         
    return next(e);
  });

  on('session.append', async ($, e, next) => {
    const context=await captureContext($);
    const result = await next(e);
    observeEffortAppend($,e,result,context);
    const evidence=await questionAppend($, e, result,context);
    if (evidence) {
      linksFor(context).observed.push(evidence);
      await receipt($, 'observe', { message_id: evidence.id, state: 'contextObserved',context },receiptState);
    }
    return result;
  });

  on('agent.spawn', async ($, e, next) => {
    const context=await captureContext($);
    const expanded=e.prompt.includes('nxref:')?await call($,'ref-expand',{text:e.prompt,context}):undefined;
    const result=await next(expanded?{...e,prompt:expanded.text}:e);
                                              
    if(result?.agentId){
      agentContexts.delete(result.agentId);agentContexts.set(result.agentId,context);
      if(agentContexts.size>256)agentContexts.delete(agentContexts.keys().next().value);
      const value=activeCalls.get(e.tool_use_id);
      if(value?.delegation&&currentProgress(value,turns))agentProgress.set(result.agentId,value);else agentProgress.delete(result.agentId);
    }
    return result;
  }).catch(($, e, next) => next.called ? next(e) : { deny: referenceDeny(modelMessage(next.error)) });

  on('tool.call', {tool:'Agent'}, async ($,e,next)=>{
    let tip;
    if(typeof e.prompt==='string')try{
                                                   
      const response=await call($,'tip-agent',{text:e.prompt,callId:e.tool_use_id,turnId:turns.get(e.agentId??'root')?.turnId,via:e.agentId,agents:e.agentId?await $.agent.list():undefined});tip=response.tip;
    }catch{}
    const result=await next(e);
    return tip&&!result?.deny?{...result,context:[...(result.context??[]),tip]}:result;
  });

  on('turn.step', async function* ($, e, next) {
    const health=await healthFor($,e,turns,agentProgress),context=health?.context,turnId=health?.turnId;
    if(context&&!context.nativeHealth)startProgress(context,turnId);
    if (!e.agentId) {
      const session = await $.session.id(), profile = { model: e.model, effort: e.effort ?? null };
      if(ownedProfileContext(context)&&e.effort!==undefined&&(context.nativeProfile?.effortUnverified||context.nativeProfile?.runtimeEffort!==null)){context.nativeProfile={...context.nativeProfile,model:e.model,runtimeEffort:e.effort,effortUnverified:false,observedAt:Date.now()};}
      if (JSON.stringify(profiles.get(session)) !== JSON.stringify(profile)) {
        if (await receipt($, 'state', { state: 'busy', ...profile },receiptState)) profiles.set(session, profile);
      }
    }
    try{for await(const chunk of next(e)){if(context&&(!e.agentId||currentProgress(health,turns)))streamProgress(context,turnId,chunk);yield chunk;}}
    catch(error){if(context&&!e.agentId){progress(context,turnId,'failed');if(context.nativeHealth?.turnId===turnId)context.nativeHealth.error=String(error).slice(0,1200);}throw error;}
  });

  on('turn.start', async ($, e, next) => {
    const context=await captureContext($);
    if(e.turnId){turns.set(e.agentId??'root',{turnId:e.turnId,context});turnContexts.set(e.turnId,context);}
    questionTurn(e);
    if (!e.agentId){
      const human=humanTurns.start(context,e);
      permissionWaits.delete(context);startProgress(context,e.turnId);
      if(human)await receipt($,'prompt',{context},receiptState);
      await receipt($, 'state', { state: 'busy',context },receiptState);
    }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const context=e.turnId?turnContexts.get(e.turnId)??(e.agentId?agentContexts.get(e.agentId):undefined):await captureContext($);
    const result = await next(e);
    if(!context)return result;
    await questionComplete($, e,context);
    if (e.agentId && !e.isAborted) try {
      const rows = await $.session.messages({ agentId: e.agentId });
      const final = Array.isArray(rows) && rows.findLast(m => m.role === 'assistant');
      const text = e.answer ?? final?.text;
      if (text?.trim() && (e.answer !== undefined || !final.toolUses?.length)) await call($, 'ref-capture', { agent_id: e.agentId, text, agents: await $.agent.list(),context });
    } catch {}
    if (!e.agentId&&humanTurns.current(context,e.turnId)){progress(context,e.turnId,e.isAborted?'paused':'ready');await receipt($, 'state', { state: e.isAborted ? 'paused' : 'ready',context },receiptState);}
    if(turns.get(e.agentId??'root')?.turnId===e.turnId)turns.delete(e.agentId??'root');
    if(e.turnId)turnContexts.delete(e.turnId);
                                                                 
    if(e.agentId&&!turns.has(e.agentId))agentProgress.delete(e.agentId);
    if(!e.agentId)for(const [id,value] of agentProgress)if(value.context===context&&value.turnId===e.turnId)agentProgress.delete(id);
                                       
    await reloadComplete($, e, () => receiptCause(receiptState));
    return result;
  });
  on('session.end', async ($, e, next) => {
    const context=await captureContext($);
    const ending=(!e.sessionId||e.sessionId===context.sessionId)&&markContextEnd(context,e.reason);
    if(ending){humanTurns.clear(context);questionReset();try { await call($, 'context-end',{context,reason:ending}); } catch {}}
    const result=await next(e);
    if(ending&&await $.session.id()!==context.sessionId)try{await call($,'context-start');const fresh=await captureContext($);markContextStarted(fresh);await observeInbound($);await observeProfile($);await observeDecision($);await publishFacts($,fresh);}catch{}
    return result;
  });
}
