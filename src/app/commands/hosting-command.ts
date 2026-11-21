import path from 'node:path';
import {BridgeError} from '../../shared/errors.js';
import { brokerCall } from '../../ipc/ipc.js';
import type { TargetSelector } from '../../broker/pairing/admin-target.js';
import { externalTerminalOrigin } from '../../hosts/user-origin.js';

export function hostingArguments(args:string[]):TargetSelector&{home?:string;cwd?:string}{
  if(args[0]!=='codex')throw new BridgeError('invalid_arguments','用法：nxbridge adopt|release codex [--session ID] [--pair ID | --member ID] [--home CODEX_HOME] [--cwd 目录]。');
  const fields={'--session':'session_id','--pair':'pair_id','--member':'peer_id','--home':'home','--cwd':'cwd'} as const,result:TargetSelector&{home?:string;cwd?:string}={};
  for(let i=1;i<args.length;i+=2){const key=fields[args[i] as keyof typeof fields],value=args[i+1];if(!key||!value||value.startsWith('-')||result[key]!==undefined)throw new BridgeError('invalid_arguments','托管切换参数无效或重复。');result[key]=key==='home'||key==='cwd'?path.resolve(value):value;}
  if(result.pair_id&&result.peer_id)throw new BridgeError('invalid_arguments','--pair 与 --member 只能选一项。');return result;
}
export async function hostingCommand(command:'adopt'|'release',args:string[]):Promise<unknown>{
  const target=hostingArguments(args);
  return brokerCall('hosting.'+command,{...target,terminal_origin:await externalTerminalOrigin()},{mutation:true,timeout:60000});
}
