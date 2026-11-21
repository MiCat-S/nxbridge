import path from 'node:path';
import {readJson} from '../../shared/files.js';
import type { SessionRecord } from './claude-inbox.js';
import {BridgeError} from '../../shared/errors.js';

                                                        
export function assertClaudeSession(configHome:string|undefined,sessionId:string,native:{pid:number;procStart:string}):void{
  if(!configHome)throw new BridgeError('session_changed','Claude 原生窗口未登记配置目录，未消费通知。');
  let record:SessionRecord;
  try{record=readJson<SessionRecord>(path.join(configHome,'sessions',native.pid+'.json'));}catch{throw new BridgeError('session_changed','Claude 原生会话已结束或无法读取，未消费通知。');}
  if(record.sessionId!==sessionId||(record.procStartFt??record.procStart)!==native.procStart)throw new BridgeError('session_changed','Claude 原生会话已切换，未消费旧上下文的通知。');
}
