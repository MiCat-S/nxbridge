import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { brokerCall } from '../../ipc/ipc.js';
import {BridgeError} from '../../shared/errors.js';
import {type Host,type Peer} from '../../types.js';
import {sameDirectory} from '../../shared/files.js';
import { candidateLabel, hostLabel } from '../../broker/pairing/pair-presentation.js';
import type { PairCandidate } from '../../broker/pairing/pair-selection.js';
import { terminalText } from '../../integration/mcp/presentation.js';

interface Inventory {pairs:{id:string;claude:Peer;codex:Peer;paused:boolean}[];members:PairCandidate[];previous_partners?:PairCandidate[]}
export function formatPairInventory(value:Inventory):string{
  const paired=value.pairs.map((pair,index)=>`  ${index+1}. ${pair.claude.cwd}   Claude「${pair.claude.name}」 ↔ Codex「${pair.codex.name}」${pair.paused?' · 已暂停':''}`);
  const unpaired=value.members.map((member,index)=>`  ${index+1}. ${hostLabel(member.host)}「${member.label??candidateLabel(member)}」  ${member.cwd} · ${member.description??'状态未知'}`);
  const previous=(value.previous_partners??[]).map(member=>`  ${hostLabel(member.host)}「${member.label??candidateLabel(member)}」  ${member.cwd} · ${member.description??'可恢复'} · 成员 ${member.member_id} · 会话 ${member.session_id}`);
  return terminalText(['已配对：',...paired,paired.length?'':'  暂无','还没配对的窗口：',...unpaired,unpaired.length?'':'  暂无',...(previous.length?['之前的后台搭档（没有编号，用成员 ID 或会话 ID 配对）：',...previous]:[])].filter(Boolean).join('\n'))+'\n';
}
export function resolvePairMember(inventory:Inventory,host:Host,selector:string):string{
  const numbered=/^\d+$/.test(selector)?inventory.members[Number(selector)-1]:undefined;
  const values=[...inventory.members,...inventory.previous_partners??[]].map(member=>({id:member.member_id,host:member.host,sessionId:member.session_id})).concat(inventory.pairs.flatMap(pair=>[pair.claude,pair.codex]));
  const matches=numbered?[{id:numbered.member_id,host:numbered.host}]:values.filter(member=>member.id===selector||member.host===host&&member.sessionId===selector);
  const unique=[...new Map(matches.filter(member=>member.host===host).map(member=>[member.id,member])).values()];
  if(unique.length!==1)throw new BridgeError('ambiguous_context','找不到唯一匹配的窗口或成员。用 nxbridge pair 查看列表，按窗口编号、成员 ID 或会话 ID 指定；同一会话有多名成员时请用成员 ID。');return unique[0]!.id;
}
interface PairResult {status?:string;launch_precondition?:{code:string;message:string};message?:string}
                                           
export function startupPending(result:PairResult):string|undefined{
  if(result.status!=='launch_precondition')return;
  const reason=(result.launch_precondition?.message??result.message??'原因未知').trim().replace(/[。.]+$/,'');
  return `，但原会话暂时没能在后台启动：${reason}。配对已保留，不用重新配对；可以用 nxbridge status 查看进度。\n`;
}
export async function pairCommand(args:string[]):Promise<void>{
  if(args[0]==='--restore'){
    if(args.length!==2||!args[1]||args[1].startsWith('-'))throw new BridgeError('invalid_arguments','用法：nxbridge pair --restore <原配对ID>。');
    const restored=await brokerCall<PairResult&{pair_id:string}>('pair.restore',{pair_id:args[1]},{mutation:true,timeout:90000});stdout.write('已恢复原配对 '+restored.pair_id+(startupPending(restored)??'，继续使用原成员和会话。\n'));return;
  }
  const inventory=await brokerCall<Inventory>('pair.inventory'),pick=(flag:string)=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];};
  const resolve=(host:Host,selector:string)=>resolvePairMember(inventory,host,selector);
  const claude=pick('--claude'),codex=pick('--codex');
  if(claude||codex){
    if(!claude||!codex)throw new BridgeError('invalid_arguments','用法：nxbridge pair --claude <窗口编号、成员ID或会话ID> --codex <窗口编号、成员ID或会话ID> [--replace]。');
    const c=resolve('claude',claude),x=resolve('codex',codex),result=await brokerCall<PairResult&{restored_members?:{host:Host;name:string}[]}>('pair',{claude:c,codex:x,replace:args.includes('--replace')},{mutation:true,timeout:90000});
    const pending=startupPending(result);if(pending){stdout.write('配对已完成'+pending);return;}
    stdout.write(result.restored_members?.length?'配对已完成，'+result.restored_members.map(member=>`之前的后台 ${hostLabel(member.host)}「${member.name}」会在后台接着原来的会话运行`).join('；')+'。\n':'配对已完成。\n');return;
  }
  if(args.length)throw new BridgeError('invalid_arguments','在原生 Codex 窗口输入 nxbridge pair 和四位配对码；终端配对用 --claude 和 --codex。');
  stdout.write(formatPairInventory(inventory));
  if(!stdin.isTTY){stdout.write('用法：nxbridge pair --claude <窗口编号、成员ID或会话ID> --codex <窗口编号、成员ID或会话ID> [--replace]。\n');return;}
  if(inventory.members.length<2){stdout.write(inventory.previous_partners?.length?'可按编号配对的窗口不够。要接回之前的后台搭档，用 nxbridge pair --claude <编号或ID> --codex <ID>，ID 见上面的列表。\n':'没有可配对的窗口。在项目目录里打开 Claude 或 Codex 后再试。\n');return;}
  const input=createInterface({input:stdin,output:stdout});
  try{
    const line=(await input.question('输入要配对的两个编号（例如 1 2），直接回车取消：')).trim();if(!line)return;
    const match=/^(\d+)\s+(\d+)$/.exec(line),a=match&&inventory.members[Number(match[1])-1],b=match&&inventory.members[Number(match[2])-1];
    if(!a||!b||a.host===b.host)throw new BridgeError('invalid_pair','请选一个 Claude 窗口和一个 Codex 窗口。');
    if(!sameDirectory(a.cwd,b.cwd)&&!/^y$/i.test((await input.question('这两个窗口不在同一个项目目录，仍然配对吗？(y/N)')).trim()))return;
    await brokerCall('pair',{claude:a.host==='claude'?a.member_id:b.member_id,codex:a.host==='codex'?a.member_id:b.member_id},{mutation:true});stdout.write('配对已完成。\n');
  }finally{input.close();}
}
