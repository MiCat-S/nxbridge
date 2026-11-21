import { randomUUID } from 'node:crypto';
import type { Store } from '../../storage/store.js';
import type { Peer } from '../../types.js';
import type { RpcMessage } from '../../ipc/rpc.js';
import type {RuntimeNotice} from '../health/contracts.js';

interface Outage {id:string;sessionId:string;scope:string;retryTurn?:string;failed:string[];notified?:boolean}
                                               
export class ProviderRecovery {
  constructor(private store:Store){}
  observe(peer:Peer,scope:string,message:RpcMessage):RuntimeNotice|undefined{
    const key='providerRecovery:'+peer.id,p=message.params??{},turn=p.turnId??p.turn?.id;if(typeof turn!=='string')return;
    let value=this.store.setting<Outage>(key);
    if(message.method==='error'&&p.willRetry===true){
      if(!value||value.notified||value.sessionId!==peer.sessionId||value.scope!==scope)value={id:randomUUID(),sessionId:peer.sessionId!,scope,failed:[]};
      value.retryTurn=turn;this.store.setSetting(key,value);return;
    }
    if(!value||value.sessionId!==peer.sessionId||value.scope!==scope||value.notified)return;
    if(message.method==='turn/completed'&&p.turn?.status==='failed'&&value.retryTurn===turn){value.failed=[...new Set([...value.failed,turn])].slice(-32);delete value.retryTurn;this.store.setSetting(key,value);return;}
    if(message.method!=='item/completed'||p.item?.type!=='agentMessage'||typeof p.item.text!=='string'||!p.item.text.trim()||!value.failed.length||value.failed.includes(turn))return;
    value.notified=true;this.store.setSetting(key,value);this.store.event('provider.output_resumed',{peerId:peer.id,incidentId:value.id,failedTurns:value.failed});
    return{id:'provider-recovered:'+value.id,source:'turn_health',kind:'provider_recovered',factKey:value.id,state:'pending',wake:false,message:`nxbridge runtime notice (not partner task or user approval): ${peer.name} has produced new model output in the same native session/provider scope after native retries. Earlier failed turns: ${value.failed.join(', ')}. Nothing replayed. This proves this operation succeeded, not that the entire provider is healthy.`};
  }
}
