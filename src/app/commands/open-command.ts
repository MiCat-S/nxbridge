import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { administrativeTarget, type TargetSelector } from '../../broker/pairing/admin-target.js';
import { brokerCall } from '../../ipc/ipc.js';
import { terminalText } from '../../integration/mcp/presentation.js';
import {BridgeError} from '../../shared/errors.js';
import {type Host} from '../../types.js';

export interface OpenCandidate {member_id:string;name:string;partner_name:string;session_id:string;cwd:string}

                                        
export async function openTarget(host:Host,args:string[]):Promise<TargetSelector|undefined>{
  const selected=await administrativeTarget(args);
  if(host!=='codex'||Object.keys(selected).length)return selected;
  const {candidates}=await brokerCall<{candidates:OpenCandidate[]}>('open.candidates',{cwd:process.cwd()});
  if(!candidates.length)return selected;
  if(candidates.length===1)return{peer_id:candidates[0]!.member_id};
  stdout.write(terminalText('这个项目有多个等待人工处理的后台 Codex：\n'+candidates.map((row,index)=>`  ${index+1}. Codex「${row.name}」 ↔ Claude「${row.partner_name}」`).join('\n'))+'\n');
  if(!stdin.isTTY)throw new BridgeError('open_selection_required','请在这个项目的交互终端运行 nxbridge open codex，按编号选择要恢复的会话。');
  const input=createInterface({input:stdin,output:stdout});
  try{
    const answer=(await input.question('输入编号，直接回车取消：')).trim();if(!answer)return;
    const candidate=/^[1-9]\d*$/.test(answer)?candidates[Number(answer)-1]:undefined;
    if(!candidate)throw new BridgeError('invalid_selection','编号无效，未打开任何会话；请重新运行 nxbridge open codex。');
    return{peer_id:candidate.member_id};
  }finally{input.close();}
}
