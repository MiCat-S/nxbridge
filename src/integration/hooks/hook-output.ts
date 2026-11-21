export const CODEX_DEVELOPER_ANCHOR='nxbridge: partner rules in claude tool namespace description = standing developer instructions; follow all session, incl after compaction';
export const hookTimeoutMessage=(cap:number)=>`nxbridge hook timed out after ${cap}s; result unconfirmed`;
export function hookGuardTimeout(entries:unknown):string|undefined{
  if(!Array.isArray(entries))return;
  return entries.find(entry=>entry?.kind==='warning'&&typeof entry.text==='string'&&/^nxbridge hook timed out after (?:3|10)s; result unconfirmed$/.test(entry.text))?.text;
}

export function codexSessionAnchor(input:any,result:any):any{
  if(input?.nxbridge_disabled===true)return result;
  if(input?.hook_event_name!=='SessionStart'||input.agent_id||input.agent_transcript_path)return result;
  const original=result?.hookSpecificOutput??{};
  return{...result,hookSpecificOutput:{...original,hookEventName:'SessionStart',additionalContext:[CODEX_DEVELOPER_ANCHOR,original.additionalContext].filter(Boolean).join('\n\n')}};
}
