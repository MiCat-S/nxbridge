import { z } from 'zod';
import { processAncestry, processIdentity } from '../process/process.js';
import {BridgeError} from '../shared/errors.js';

export const terminalOriginSchema=z.object({pid:z.number().int().positive(),procStart:z.string().min(1),tty:z.literal(true)}).strict();
export type TerminalOrigin=z.infer<typeof terminalOriginSchema>;
export const HOSTING_TERMINAL_MESSAGE='请在独立的系统终端（Terminal.app、Windows Terminal 等）里运行 nxbridge adopt/release codex。非交互 shell 和 Claude / Codex 里的终端都不能执行这个操作；也可以让 Claude 发信，在出现的选择里选“后台继续原会话”。';
interface TerminalCapture {interactive:boolean;identity:typeof processIdentity}
export async function externalTerminalOrigin(context:TerminalCapture={interactive:process.stdin.isTTY===true,identity:processIdentity}):Promise<TerminalOrigin|undefined>{
                                       
  if(!context.interactive)return;
  const identity=await context.identity(process.pid);return{pid:identity.pid,procStart:identity.startedAt,tty:true};
}
export async function isExternalTerminal(value?:TerminalOrigin,read=processAncestry):Promise<boolean>{
  if(!value)return false;
  let evidence:Awaited<ReturnType<typeof processAncestry>>;
  try{evidence=await read(value.pid,32);}catch{return false;}
  const root=evidence.ancestors[0];
                                           
                                          
  return evidence.complete&&root?.pid===value.pid&&root.startedAt===value.procStart&&!['Z','X'].includes(root.state??'')&&!evidence.ancestors.some(row=>/^(?:claude|codex)(?:\.exe)?$/i.test(row.name));
}
export async function requireExternalTerminal(value?:TerminalOrigin,read=processAncestry):Promise<void>{
  if(!await isExternalTerminal(value,read))throw new BridgeError('user_terminal_required','此操作需要用户在 Claude/Codex 之外的独立交互终端亲自执行；终端身份和父链必须能够核验。');
}
