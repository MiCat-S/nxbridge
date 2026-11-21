import { processAncestors } from '../../process/process.js';
import {BridgeError} from '../../shared/errors.js';
import {type Actor,type Host} from '../../types.js';

export interface TargetSelector {
  actor?:Actor;pair_id?:string;peer_id?:string;session_id?:string;
  native?:{host:Host;pid:number;procStart:string};
}

                                   
export async function administrativeTarget(args:string[]):Promise<TargetSelector>{
  const fields={'--pair':'pair_id','--member':'peer_id','--session':'session_id'} as const;
  const result:TargetSelector={};
  for(let i=0;i<args.length;i++){
    const key=fields[args[i] as keyof typeof fields],value=args[++i];
    if(!key||!value||value.startsWith('-')||Object.keys(result).length)throw new BridgeError('invalid_arguments','目标只能指定一项：--pair <配对ID>、--member <成员ID> 或 --session <会话ID>。');
    result[key]=value;
  }
  if(Object.keys(result).length)return result;
  const native=(await processAncestors(process.pid,32)).find(value=>/^(?:codex|claude)(?:\.exe)?$/i.test(value.name));
  return native?{native:{host:/^codex/i.test(native.name)?'codex':'claude',pid:native.pid,procStart:native.startedAt}}:{};
}
