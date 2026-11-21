                                                
const CLASS_TEXT = { bypass: '全部放行类（含计划模式）', prompting: '需确认类' };
                                                   
const SOURCE_FIX = {
  policy: '这是组织的托管策略，只有管理员能改',
  project: '这是项目设置（.claude/settings.json）里设的，删掉其中的 crossSessionInbound 即可',
  local: '这是本机项目设置（.claude/settings.local.json）里设的，删掉其中的 crossSessionInbound 即可',
  invalid: '设置里的 crossSessionInbound 值无法识别，改成有效值即可',
};
const sourceFix = (guide, fallback) => SOURCE_FIX[guide?.policy_source] ?? fallback;
export const permissionText = guide => !guide ? undefined
  : guide.state === 'held' ? 'Codex 发来的消息被本窗口拦下等你审核：在审核框里放行（默认约 5 分钟不处理会作废；确认作废后会告诉 Codex，不会自动重发）'
  : guide.state === 'refused' ? `本窗口设置为拒收其他会话的消息，Codex 的消息收不到（${sourceFix(guide, '在 /config 里修改接收设置')}）`
  : guide.state === 'sender_unknown' ? `还没确认 Codex 的权限模式，本窗口是${CLASS_TEXT[guide.receiver_class] ?? '未知类'}，Codex 的消息可能会被拦下等你审核`
  : guide.state === 'class_mismatch' && guide.receiver_class === 'bypass' ? `本窗口是${CLASS_TEXT.bypass}、Codex 是${CLASS_TEXT.prompting}，Codex 的消息会被拦下等你审核：在审核框放行，或按 Shift+Tab 把本窗口切到普通模式`
  : guide.state === 'class_mismatch' ? `Codex 是全部放行模式、本窗口不是，Codex 的消息会被拦下等你审核：在审核框放行，或让 Codex 不用全部放行模式运行`
  : undefined;
                                                               
                                            
                                                                                      
const PAIR_STATES = new Set(['class_mismatch', 'held', 'refused']);
export function pairPermission(guide) {
  if (!PAIR_STATES.has(guide?.state)) return undefined;
  const fix = guide.state === 'refused' ? 'change the inbound setting in /config'
    : guide.state === 'held' ? 'approve in the dialog, or allow msgs from other sessions in /config'
    : guide.receiver_class === 'bypass' ? 'approve in the dialog, or Shift+Tab this window to normal mode'
    : 'approve in the dialog, or run Codex without full-access mode';
  return {
    user: '注意：' + permissionText(guide),
    model: `tell user now: Codex replies to this window ${guide.state === 'refused' ? 'are refused' : 'are held for user approval (approval dialog; unhandled ~5 min -> expire, never delivered)'}; fix: ${fix}`,
  };
}
                                                                     
                                                              
const RECENT_MS = 30 * 60_000;
const count = value => Number.isInteger(value) && value > 0 ? value : 0;
const recent = (side, now) => typeof side?.latest_at === 'number' && now - side.latest_at <= RECENT_MS;
const fixText = guide => guide?.state === 'refused' ? sourceFix(guide, '在 /config 里修改接收设置')
  : guide?.state === 'held' ? sourceFix(guide, '在 /config 允许接收其他会话的消息')
  : guide?.state === 'class_mismatch' && guide.receiver_class === 'bypass' ? '按 Shift+Tab 把本窗口切到普通模式'
  : guide?.state === 'class_mismatch' ? '让 Codex 不用全部放行模式运行' : undefined;
export function admissionText(admission, guide, now = Date.now()) {
  const inbound = admission?.inbound, outbound = admission?.outbound, parts = [];
  if (count(inbound?.held)) parts.push(`Codex 发来的 ${count(inbound.held)} 条消息在等你审核：在审核框里放行，约 5 分钟不处理会作废`);
  const lost = recent(inbound, now) ? count(inbound.expired) + count(inbound.refused) : 0;
  if (lost) parts.push(`Codex 发来的 ${lost} 条消息没被放行，已作废、没有送达（已告诉 Codex）`);
  const sentLost = recent(outbound, now) ? count(outbound.expired) + count(outbound.refused) : 0;
  if (sentLost) parts.push(`你发给 Codex 的 ${sentLost} 条消息被拒收或过期，没有送达`);
  if (!parts.length) return undefined;
  const fix = (count(inbound?.held) || lost) && fixText(guide);
  return parts.join('；') + (fix ? `。以后不想被拦下：${fix}` : '');
}
