import type {Peer} from '../../types.js';

export type CodexTurnCause='partner'|'children'|'notice'|'queue';
export interface CodexTurnOrigin {turnTrigger:string;clientUserMessageId:string}
export type CodexTurnOriginProvider=(peer:Peer,cause:CodexTurnCause)=>Promise<CodexTurnOrigin|undefined>;
