import type { CodexThread } from './adapter.js';
import type { PeerState } from '../../types.js';

type ThreadState=Pick<CodexThread,'status'|'turns'>;

                                               
export function codexThreadUnmaterialized(error:{code?:unknown;message?:string},threadId:string):boolean{
  return !!threadId&&String(error.code)==='-32600'&&typeof error.message==='string'&&error.message.includes('thread '+threadId+' is not materialized');
}

                                                     
export function codexThreadIdle(thread:ThreadState):boolean{
  return ['idle','systemError'].includes(thread.status?.type??'')&&!thread.status?.activeFlags?.length&&!thread.turns?.some(turn=>turn.status==='inProgress');
}

export function codexThreadState(thread:ThreadState):PeerState{
  if(thread.status?.activeFlags?.some(flag=>/approval|input/i.test(flag)))return'needsHuman';
  if(thread.status?.type==='active'||thread.turns?.some(turn=>turn.status==='inProgress'))return'busy';
  if(thread.status?.type==='notLoaded')return'offline';
  return codexThreadIdle(thread)?'ready':'unknown';
}
