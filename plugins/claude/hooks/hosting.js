                                                                    
const named=h=>h?.name?`「${h.name}」`:'';
const held=h=>h?.held_unsent?`，${h.held_unsent} 条消息在等`:'';
const uncertain=h=>h?.uncertain?`；${h.uncertain} 条消息结果不明，不会自动重发`:'';
const step=h=>h?.user_step?`（${h.user_step}）`:'';
const POLICY_PART={filesystem:'文件',network:'网络',approval:'审批方式',reviewer:'审批人'};
const BLOCK_REASON={
  policy_unrepresentable:'原来的权限没法安全套用',policy_verification_failed:'恢复后的权限核对没通过',
  holder_unknown:'无法确认这个会话没被别处打开',holder_active:'这个会话还开在别处',cwd_mismatch:'项目目录和配对记录不一致',
  pending_approval:'还有操作在等你批准',native_work_pending:'还有没收尾的任务',
  session_conflict:'同一会话正开在别处，需要先选用哪一个',session_not_found:'原配置目录里找不到这个会话',profile_version_unsupported:'这个版本的 Codex 读不了原会话的格式',
  bootstrap_policy_unsupported:'这个 Codex 版本不支持 nxbridge 启动时用的严格权限，为免权限变宽先不启动',
  policy_unknown_unstartable:'读不到原来的权限，而最严格的权限下 Codex 起不来',
};
                                      
export function policyText(policy){
  if(!policy)return undefined;
  const unknown=policy.unknown??[],narrowed=policy.narrowed??[];
  if(policy.source!=='conservative'&&!unknown.length&&!narrowed.length)return undefined;
  const tail='；要放宽请按 Codex 正常方式设置';
  if(unknown.includes('filesystem'))return '读不到这个会话原来的权限，后台先不给文件和网络权限'+tail;
  const parts=[unknown.length?`读不到原来的${unknown.map(k=>POLICY_PART[k]??k).join('、')}设置，这部分按最严格处理`:'',narrowed.length?`${narrowed.length} 条权限规则没法原样恢复，已改成更严格的`:''].filter(Boolean);
  return parts.length?'后台 Codex 的权限比原会话更严：'+parts.join('；')+tail:undefined;
}
                                      
export function hostingText(h){
  if(!h?.phase&&h?.verifying!==true)return undefined;
  const n=named(h);
  if(h.phase==='adopting')return `正在把 Codex 会话${n}转到后台（同一会话、同一配对）${held(h)}${uncertain(h)}`;
                                                             
  if(h.phase==='verifying'||h.verifying===true&&h.phase!=='adopting')return `后台 Codex 会话${n}刚重新拉起，正在核对权限，核对完再投递${held(h)}${uncertain(h)}`;
  if(h.phase==='releasing')return `正在停止后台的 Codex 会话${n}，停稳后告诉你怎么在自己的窗口打开${held(h)}`;
  if(h.phase==='awaiting_window')return `后台已停，等你在自己的窗口打开 Codex 会话${n}${held(h)}${step(h)}${h.wake_capable===false?'；打开后要在窗口里有操作才会取消息':''}${uncertain(h)}`;
  if(h.phase==='window_closed')return `Codex 会话${n}的窗口已关闭${held(h)}：重新打开这个会话后送达，或下次发信时选择在后台继续${step(h)}${uncertain(h)}`;
  if(h.phase==='blocked'){
    const holder=h.holder?.pid?`（占着它的是 ${h.holder.mode??'进程'} ${h.holder.pid}）`:'';
    return `Codex 会话${n}暂时转不过去：${BLOCK_REASON[h.reason]??'条件不满足'}${holder}${step(h)}；消息已保留${uncertain(h)}`;
  }
  if(h.phase==='background')return policyText(h.policy);
                              
  if(h.phase==='foreground'&&h.preference==='bg'&&h.reason==='holder_active')return `已记下：关掉 Codex 窗口后，会话${named(h)}在后台接着跑`;
  return undefined;
}
                              
export function hostingModel(h){
  if(!h?.phase)return '';
  const p=h.policy;
  return [`hosting pref=${h.preference??'unknown'} phase=${h.phase}${h.verifying===true?' (verifying policy, delivery held)':''}`,h.session_id?`session ${h.session_id}`:'',h.cwd?`cwd ${h.cwd}`:'',
    h.wake_capable===false?'no wake (picks up only on user input in that window)':'',h.held_unsent?`${h.held_unsent} held`:'',h.uncertain?`${h.uncertain} uncertain (never resend)`:'',
    p?`policy ${p.source}${p.unknown?.length?' unknown='+p.unknown.join('/'):''}${p.narrowed?.length?' narrowed='+p.narrowed.length:''}`:'',
    h.reason?`reason ${h.reason}`:'',h.holder?.pid?`holder ${h.holder.mode??'?'} pid ${h.holder.pid}`:'',h.user_step?`user step \`${h.user_step}\``:'',
    h.phase==='window_closed'?'next send asks user: continue in bg / wait for window / new / unpair (never adopt yourself)':''].filter(Boolean).join(', ');
}
