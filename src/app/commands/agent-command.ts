import path from 'node:path';
import {bridgeHome} from '../../shared/local-paths.js';

                                               
export function agentCommand(args:string[],home=bridgeHome()):string{
  const quote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  return[process.execPath,path.join(home,'bin','nxbridge.cjs'),...args].map(value=>quote(process.platform==='win32'?value.replaceAll('\\','/'):value)).join(' ');
}

                                                                                                                                
export function partnerRestartAdvice(home?:string):string{
  return`paired Claude may choose a safe idle moment (no active task, in-flight submission, question or approval; old unknown msgs don't count: restart verifies them, never resends) and run once in its own native Bash, unwrapped (no timeout wrapper: breaks caller check): ${agentCommand(['restart','codex','--partner'],home)}; --partner verifies only its current managed Codex, resumes same session id/history/profile; never-attempted accepted msgs stay queued through restart; failed-turn systemError without active work counts as idle; busy/unconfirmed/transitioning -> finish pending work then retry once; user-owned/shared/unverified -> stop, tell user; no polling/restart loop; verified success clears notice`;
}

export function diagnosisAdvice(home?:string):string{
  return`AI can diagnose its current pair once in its own native Bash: ${agentCommand(['doctor','--current'],home)}; act only on a verified nxbridge-owned cause at a safe moment; trust approval, user config and other windows -> tell user exact step; unknown delivery -> never resend automatically; no polling`;
}
