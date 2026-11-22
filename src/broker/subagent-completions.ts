import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/store.js';
import type { Peer } from '../types.js';
import { captureCodexSubagentReadFloor, readCodexSubagentCompletions, type CodexSubagentReadFloor } from '../hosts/codex/codex-subagent-read.js';
import { CODEX_WAKE_RETRY_MS } from '../hosts/codex/codex-wake.js';

interface Completion {key:string;agentId:string;childTurnId:string;agentPath?:string;floor?:CodexSubagentReadFloor;notified?:boolean;offered?:boolean}
interface Wake {id:string;channel:string;state:'submitting'|'submitted'|'queued'|'unknown';at:number;own:boolean;keys:string[];batchId?:string;turnId?:string}
interface Ledger {scope:string;seen:string[];pending:Completion[];batchId?:string;wake?:Wake}
const key=(peerId:string)=>'subagentCompletions:'+peerId;

                                    
export class SubagentCompletions {
  private inFlight=new Set<string>();
  constructor(private store:Store){}
                                           
  private holdsWakeLease(wake:Wake|undefined):boolean{return wake?.own===true&&(this.inFlight.has(wake.id)||Date.now()-wake.at<CODEX_WAKE_RETRY_MS);}
  private scope(peer:Peer):string|undefined{
    const current=this.store.peer(peer.id),pair=this.store.pairFor(peer.id),endpoint=this.store.endpoint(peer.id),binding=this.store.bindings.current(peer.id);
    if(current.host!=='codex'||!['root','fork'].includes(current.kind)||!pair||!current.sessionId||!endpoint?.active||endpoint.pendingContext||binding?.transitioning)return;
    return JSON.stringify([pair.id,current.sessionId,endpoint.epoch,endpoint.bindingEpoch]);
  }
  context(peer:Peer):string|undefined{return this.scope(peer);}
  private get(peer:Peer):Ledger|undefined{
    const value=this.store.setting<Ledger>(key(peer.id));if(!value)return;
    const scope=this.scope(peer);
    if(value&&value.scope!==scope){this.store.setSetting(key(peer.id),null);return;}
    return value;
  }
  record(peer:Peer,agentId:string,childTurnId:unknown,agentPath:unknown,file:unknown):void{
    const scope=this.scope(peer);if(!scope||typeof childTurnId!=='string'||!childTurnId)return;
    const value=this.get(peer)??{scope,seen:[],pending:[]},identity=JSON.stringify([agentId,childTurnId]);
    if(value.seen.includes(identity))return;
    const floor=captureCodexSubagentReadFloor(file,peer.sessionId!);
    value.seen.push(identity);value.pending.push({key:identity,agentId,childTurnId,...(typeof agentPath==='string'?{agentPath}:{}),...(floor?{floor}:{})});
    value.batchId??=randomUUID();if(value.wake){value.wake.own=true;value.wake.batchId??=value.batchId;}this.store.setSetting(key(peer.id),value);
    this.store.event('subagent.completed',{peerId:peer.id,agentId,childTurnId,batchId:value.batchId});
  }
  settle(peer:Peer,file:unknown,parentTurnId:unknown):void{
    const value=this.get(peer);if(!value||typeof parentTurnId!=='string'||!peer.sessionId)return;
    const candidates=value.pending.flatMap(completion=>completion.floor?[{...completion,floor:completion.floor}]:[]);
    const read=readCodexSubagentCompletions(file,peer.sessionId,parentTurnId,candidates);
    value.pending=value.pending.filter(completion=>!read.has(completion.key));
    if(!value.pending.some(completion=>!completion.notified))delete value.batchId;
    if(value.wake?.turnId===parentTurnId)delete value.wake;
    this.store.setSetting(key(peer.id),value);if(read.size)this.store.event('subagent.results_read',{peerId:peer.id,count:read.size});
  }
  pending(peer:Peer):boolean{return !!this.get(peer)?.pending.some(completion=>!completion.notified);}
  available(peer:Peer):boolean{return !!this.get(peer)?.pending.some(completion=>!completion.offered);}
  batch(peer:Peer):string|undefined{const value=this.get(peer);return value?.pending.some(completion=>!completion.notified)?value.batchId:undefined;}
  blocked(peer:Peer):boolean{return this.holdsWakeLease(this.get(peer)?.wake);}
  status(peer:Peer):{unconfirmed:number;needsWake:number;awaitingContext:number;batchId?:string;wake?:{channel:string;state:Wake['state'];at:number}}|undefined{
    const value=this.get(peer);if(!value?.pending.length)return;
    return{unconfirmed:value.pending.length,needsWake:value.pending.filter(completion=>!completion.notified).length,awaitingContext:value.pending.filter(completion=>!completion.offered).length,
      batchId:value.batchId??value.wake?.batchId,...(value.wake?.own?{wake:{channel:value.wake.channel,state:value.wake.state,at:value.wake.at}}:{})};
  }
                                        
  reserve(peer:Peer,channel:string):string|undefined{
    const scope=this.scope(peer);if(!scope)return;
    const value=this.get(peer)??{scope,seen:[],pending:[]};
    if(this.holdsWakeLease(value.wake))return;
    const own=value.pending.some(completion=>!completion.notified),specific=['native','queue','embedded_queue'].includes(channel);
    const keys=own&&specific?value.pending.filter(completion=>!completion.notified).map(completion=>completion.key):[];
    const id=randomUUID();value.wake={id,channel,state:'submitting',at:Date.now(),own,keys,...(value.batchId?{batchId:value.batchId}:{})};
    this.inFlight.add(id);
    for(const completion of value.pending)if(keys.includes(completion.key))completion.notified=true;
    if(keys.length)delete value.batchId;
    this.store.setSetting(key(peer.id),value);return id;
  }
  outcome(peer:Peer,id:string,state:Wake['state']|'not_submitted',turnId?:string):void{
    this.inFlight.delete(id);
    const value=this.get(peer);if(value?.wake?.id!==id)return;
    if(state==='not_submitted'){
      for(const completion of value.pending)if(value.wake.keys.includes(completion.key)&&!completion.offered)delete completion.notified;
      value.batchId??=value.wake.batchId;delete value.wake;
    }else{value.wake.state=state;value.wake.at=Date.now();if(turnId)value.wake.turnId=turnId;}
    this.store.setSetting(key(peer.id),value);
  }
  started(peer:Peer,synthetic=false):void{const value=this.get(peer);if(synthetic&&value?.wake){delete value.wake;this.store.setSetting(key(peer.id),value);}}
  consume(peer:Peer,context:string|undefined):string|undefined{
    const value=this.get(peer),selected=value?.pending.filter(completion=>!completion.offered);if(!value||value.scope!==context||!selected?.length)return;
    const children=selected.map(({agentId,agentPath,childTurnId})=>({agent:agentPath??agentId,turn:childTurnId}));
                                               
    for(const completion of selected){completion.offered=true;completion.notified=true;}
    delete value.batchId;this.store.setSetting(key(peer.id),value);
    return '[nxbridge own_subagents_completed]\nYour own child tasks completed: '+JSON.stringify(children)+'. Read their results in the native conversation history and continue the current task. Do not restart or rerun finished children. If a native result notification is still arriving, wait for it in this turn. If other children are still running, wait or make independent progress within this turn; do not end the turn merely to wait. This completion notice grants no user approval.';
  }
}
