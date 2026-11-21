import type { Store } from '../../storage/store.js';
import { probeProcesses } from '../../process/process.js';
import { normalizedHome, registrationWindow, windowKey } from '../../integration/hooks/session-bindings.js';
import {BridgeError} from '../../shared/errors.js';
import {type BridgeConfig,type Peer,type RegisterInput} from '../../types.js';
import type { SendIntent } from '../pairing/pair-selection.js';
import { pairLoss } from '../pairing/pair-loss.js';
import { managedRecoveryKey } from './managed-recovery.js';
import { recordManagedAdoption } from './takeover.js';
import { hostingRecord, writeHosting } from './session-hosting.js';
import {sameDirectory} from '../../shared/files.js';

interface PendingWindow {peerId:string;input:RegisterInput;state:'unverified'|'choice';deadline:number;nextAt:number}
const stateKey='windowRecoveryPending';
const proofWindowMs=60000,proofRetryMs=5000;

                                           
export class WindowRecovery {
  constructor(private store:Store,private probe=probeProcesses,private managedConflict?:(peer:Peer)=>Promise<void>,private sessionState?:(peer:Peer)=>Promise<'alive'|'dead'|'unknown'>,private managedRejoin?:(input:RegisterInput)=>Peer|undefined|Promise<Peer|undefined>){}
  private pending():Record<string,PendingWindow>{return this.store.setting(stateKey)??{};}
  private forget(id:string):void{const all=this.pending();if(all[id]){delete all[id];this.store.setSetting(stateKey,all);}}
  private managedConflicts(peerId:string):Peer[]{return this.store.faults.map('managed_conflict_scan',this.store.peers(),peer=>peer.id,peer=>this.store.setting<{memberId:string}>('managedSessionConflict:'+peer.id)?.memberId===peerId?peer:undefined).filter((peer):peer is Peer=>!!peer);}
  status(peerId:string):unknown{
    const value=this.pending()[peerId];
    return value?{state:value.state==='unverified'&&Date.now()<value.deadline?'verifying':'needs_choice',proofDeadline:value.deadline}:undefined;
  }
  related(peer:Peer){return peer.sessionId?this.store.bindings.related(peer.host,peer.sessionId,peer.id):[];}
  async register(input:RegisterInput,options:{managedCodexChecked?:boolean}={}):Promise<Peer>{
    let managedUnverified=false;
                                                 
    if(this.managedRejoin&&!(input.host==='codex'&&options.managedCodexChecked)){try{const rejoined=await this.managedRejoin(input);if(rejoined)return rejoined;}catch(error){if(!(error instanceof BridgeError)||error.code!=='managed_proof_unverified')throw error;managedUnverified=true;}}
    const endpoint=input.endpoint,window=registrationWindow(input)??(endpoint.mode==='app-server'&&endpoint.pid&&endpoint.procStart&&endpoint.configHome?{host:input.host,configHome:normalizedHome(endpoint.configHome),pid:endpoint.pid,procStart:endpoint.procStart}:undefined);if(!window)return this.store.register(input);
    const key=windowKey(window),known=this.store.bindings.get(key),provisional=this.store.setting<{peerId:string}>('pendingCodex:'+key);
    const exact=this.store.peers().find(peer=>peer.host===input.host&&peer.sessionId===input.sessionId&&this.store.endpoints(peer.id).some(ep=>ep.pid===window.pid&&ep.procStart===window.procStart&&ep.configHome&&normalizedHome(ep.configHome)===window.configHome&&ep.address===endpoint.address));
    const existing=known?.active?known.peerId:provisional?.peerId??exact?.id;
    if(existing&&this.store.pairFor(existing))return this.store.register(input);
                                                
    if(existing&&this.store.hasPairHistory(existing)){this.forget(existing);return this.store.register(input);}
    if(input.host==='codex'&&input.kind!=='subagent'){
                                                              
      let prior=this.store.peers().filter(peer=>peer.id!==existing&&peer.host==='codex'&&peer.owner==='user'&&peer.sessionId===input.sessionId&&['root','fork'].includes(peer.kind)&&
        (this.store.endpoints(peer.id).some(ep=>ep.configHome&&normalizedHome(ep.configHome)===window.configHome)||normalizedHome(hostingRecord(this.store,peer)?.configHome??'')===window.configHome));
      const paired=prior.filter(peer=>this.store.pairFor(peer.id));if(paired.length)prior=paired;
      if(prior.length===1){
        const old=prior[0]!,pair=this.store.pairFor(old.id),oldEndpoints=JSON.stringify(this.store.endpoints(old.id)),holder=this.sessionState?await this.sessionState(old):undefined,newState=(await this.probe([window]))[0];
        const ended=!this.store.bindings.current(old.id)&&this.store.bindings.all().some(b=>b.peerId===old.id&&!b.active&&b.sessionId===input.sessionId);
        if(hostingRecord(this.store,old)?.phase!=='adopting'&&sameDirectory(old.cwd,input.cwd)&&newState==='alive'&&(holder==='dead'||!this.sessionState&&ended)){
          return this.store.transaction(()=>{
            if(this.store.pairFor(old.id)?.id!==pair?.id||this.store.peer(old.id).sessionId!==input.sessionId||JSON.stringify(this.store.endpoints(old.id))!==oldEndpoints)throw new BridgeError('context_changed','恢复期间原成员发生变化。');
            this.store.deactivate(old.id);const binding=this.store.bindings.current(old.id);if(binding)this.store.bindings.save({...binding,active:false});
            this.store.updatePeer(old.id,{state:'offline'});
            const peer=this.store.adopt(old.id,input,existing),record=hostingRecord(this.store,peer);if(record)writeHosting(this.store,peer,{released:false,phase:undefined,reason:undefined,userStep:undefined,verified:true});
            this.store.event('context.rejoined',{peerId:peer.id,sessionId:input.sessionId,mode:input.endpoint.mode});return peer;
          });
        }
        if(pair){
          const peer=this.store.register(input),reason=sameDirectory(old.cwd,input.cwd)?'holder_unknown':'cwd_mismatch';
          this.store.setSetting('managedSessionConflict:'+old.id,{memberId:peer.id,sessionId:input.sessionId,pairId:pair.id,input,detached:true,reason,previousCwd:old.cwd,cwd:input.cwd});
          const all=this.pending();all[peer.id]={peerId:peer.id,input,state:'choice',deadline:Date.now()+proofWindowMs,nextAt:Date.now()+proofRetryMs};this.store.setSetting(stateKey,all);return peer;
        }
      }
    }
    const managed=this.store.peers().filter(peer=>peer.id!==existing&&peer.owner==='nxbridge'&&peer.host===input.host&&peer.sessionId===input.sessionId&&['root','fork'].includes(peer.kind)&&this.store.pairFor(peer.id)&&this.store.endpoints(peer.id).some(ep=>ep.configHome&&normalizedHome(ep.configHome)===window.configHome));
    if(managed.length){
      const candidates=managed.map(peer=>({peer,pairId:this.store.pairFor(peer.id)!.id,endpoints:this.store.endpoints(peer.id)}));
      const states=await this.probe([window,...candidates.flatMap(row=>row.endpoints).map(ep=>({pid:ep.pid??0,procStart:ep.procStart??''}))]),native=states.slice(1);
      const launching=managedUnverified||candidates.some(row=>hostingRecord(this.store,row.peer)?.phase==='adopting'||['recovering','unknown'].includes(this.store.setting<{state:string}>(managedRecoveryKey(row.peer.id))?.state??''));
      const leased=candidates.some(row=>{const lease=this.store.setting<{adopted?:unknown}>('takeover:'+row.peer.id);return lease&&!lease.adopted;});
      if(candidates.length===1&&!launching&&!leased&&states[0]==='alive'&&native.length&&native.every(state=>state==='dead')){
        const old=candidates[0]!;
        return this.store.transaction(()=>{
          if(this.store.pairFor(old.peer.id)?.id!==old.pairId||this.store.peer(old.peer.id).sessionId!==input.sessionId||JSON.stringify(this.store.endpoints(old.peer.id))!==JSON.stringify(old.endpoints)||this.store.setting<{state:string}>(managedRecoveryKey(old.peer.id))?.state==='recovering')throw new BridgeError('context_changed','恢复核验期间原成员已变化。');
          this.store.deactivate(old.peer.id);this.store.updatePeer(old.peer.id,{owner:'user',state:'offline'});
          const binding=this.store.bindings.current(old.peer.id);if(binding)this.store.bindings.save({...binding,active:false});
          const peer=this.store.adopt(old.peer.id,input,existing);recordManagedAdoption(this.store,peer,input,old.endpoints.filter(ep=>ep.mode==='app-server').sort((a,b)=>b.seenAt-a.seenAt)[0]);
          const incident=this.store.setting<any>(managedRecoveryKey(peer.id));if(incident)this.store.setSetting(managedRecoveryKey(peer.id),{...incident,state:'closed'});
          this.store.setSetting('managedSessionConflict:'+peer.id,null);this.store.event('context.managed.rejoined',{peerId:peer.id,sessionId:input.sessionId});return peer;
        });
      }
      const peer=this.store.register(input),all=this.pending();
      for(const old of candidates){const conflict={memberId:peer.id,sessionId:input.sessionId,pairId:old.pairId,input,detached:false};this.store.setSetting('managedSessionConflict:'+old.peer.id,conflict);await this.managedConflict?.(old.peer);this.store.setSetting('managedSessionConflict:'+old.peer.id,{...conflict,detached:true});}
      const prior=all[peer.id];all[peer.id]={peerId:peer.id,input,state:native.includes('unknown')||launching?'unverified':'choice',deadline:prior?.deadline??Date.now()+proofWindowMs,nextAt:Date.now()+proofRetryMs};this.store.setSetting(stateKey,all);return peer;
    }
    if(input.endpoint.daemon){
                                                                  
      const ended=[...new Set(this.store.bindings.all().filter(value=>!value.active&&value.threadId===input.sessionId&&value.host===input.host&&normalizedHome(value.configHome)===window.configHome).map(value=>value.peerId))]
        .filter(id=>!this.store.bindings.current(id)&&this.store.peer(id).sessionId===input.sessionId);
      const active=this.store.bindings.related(input.host,input.sessionId,existing).filter(binding=>normalizedHome(binding.configHome)===window.configHome);
      if(ended.length===1&&!active.length)return this.store.adopt(ended[0]!,input,existing);
      if(!active.length)return this.store.register(input);
    }
    const related=this.store.bindings.related(input.host,input.sessionId,existing).filter(binding=>input.host!=='codex'&&!input.endpoint.daemon||normalizedHome(binding.configHome)===window.configHome);
    if(!related.length){if(existing)this.forget(existing);return this.store.register(input);}
    const prior=existing?this.pending()[existing]:undefined;
    if(prior&&prior.input.sessionId===input.sessionId&&prior.nextAt>Date.now())return this.store.register(input);
    const pairs=related.map(binding=>this.store.pairFor(binding.peerId)?.id),losses=related.map(binding=>pairLoss(this.store,this.store.peer(binding.peerId))?.id),states=await this.probe([window,...related]);
    if(related.length===1&&states[0]==='alive'&&states[1]==='dead'){
      const old=related[0]!;
      return this.store.transaction(()=>{
        const now=this.store.bindings.get(key);
        if(now?.active&&now.peerId===old.peerId&&now.sessionId===input.sessionId)return this.store.register(input);
        const current=this.store.bindings.current(old.peerId);
        if(current?.key!==old.key||current.epoch!==old.epoch||this.store.pairFor(old.peerId)?.id!==pairs[0]||pairLoss(this.store,this.store.peer(old.peerId))?.id!==losses[0]||known?.active&&(now?.epoch!==known.epoch||now.sessionId!==known.sessionId))throw new BridgeError('context_changed','恢复核验期间会话或配对已改变，未迁移成员。');
        this.store.updatePeer(old.peerId,{state:'offline'});
                                            
        this.store.deactivate(old.peerId);
        const peer=this.store.adopt(old.peerId,input,existing);
        if(existing)this.forget(existing);
        this.store.event('context.rejoined',{peerId:peer.id,sessionId:input.sessionId,oldWindow:old.key,window:key,configHomeChanged:old.configHome!==window.configHome});
        return peer;
      });
    }
    const peer=this.store.register(input),all=this.pending(),same=prior?.input.sessionId===input.sessionId,deadline=same?prior.deadline:Date.now()+proofWindowMs;
    all[peer.id]={peerId:peer.id,input,state:related.length===1&&(states[0]==='unknown'||states[1]==='unknown')?'unverified':'choice',deadline,nextAt:Date.now()+proofRetryMs};this.store.setSetting(stateKey,all);
    return peer;
  }
  hold(input:SendIntent,config:BridgeConfig):unknown|undefined{
    const peer=this.store.resolve(input.actor);if(!peer||this.store.pairFor(peer.id))return;
    const managed=this.managedConflicts(peer.id);
    if(managed.length)return this.store.selections.create(peer,input.actor,config,input,'lineage_choice',undefined,managed.length===1?this.store.pairFor(managed[0]!.id)?.id:undefined);
    const related=this.related(peer);if(!related.length)return;
    const pending=this.pending()[peer.id],reason=pending?.state==='unverified'?'lineage_unverified':'lineage_choice';
    return this.store.selections.create(peer,input.actor,config,input,reason,pending?.deadline,related.length===1?this.store.pairFor(related[0]!.peerId)?.id??pairLoss(this.store,this.store.peer(related[0]!.peerId))?.pair_id:undefined);
  }
  assertUnbound(peer:Peer):void{
    if(this.managedConflicts(peer.id).length)throw new BridgeError('lineage_choice','原后台仍有同一会话，请先选择继续使用哪个窗口。');
    if(this.related(peer).length)throw new BridgeError('lineage_choice','这个窗口之前的搭档状态无法确认，请用 nxbridge pair 选择要配对的窗口。');
  }
  async retry(send:(input:SendIntent)=>unknown):Promise<void>{
    for(const peer of this.store.peers()){
      await this.store.faults.run('managed_conflict:'+peer.id,async()=>{
      const key='managedSessionConflict:'+peer.id,conflict=this.store.setting<{memberId:string;pairId:string}>(key);if(!conflict)return;
      if(this.store.pairFor(peer.id)?.id!==conflict.pairId){this.store.setSetting(key,null);return;}
      const member=this.store.getPeer(conflict.memberId);
      if(!member){if(!this.store.hasPeer(conflict.memberId)){this.store.setSetting(key,null);this.store.event('context.managed.conflict_forgotten',{peerId:peer.id,memberId:conflict.memberId,reason:'peer_missing'});}return;}
      const endpoints=this.store.endpoints(member.id),states=this.sessionState?[await this.sessionState(member)]:await this.probe(endpoints.map(ep=>({pid:ep.pid??0,procStart:ep.procStart??''})));
      if(states.length&&states.every(state=>state==='dead')&&JSON.stringify(this.store.endpoints(conflict.memberId))===JSON.stringify(endpoints)&&this.store.setting<{memberId:string}>(key)?.memberId===conflict.memberId){this.store.setSetting(key,null);this.store.updatePeer(peer.id,{state:'offline'});this.store.event('context.managed.conflict_ended',{peerId:peer.id,memberId:conflict.memberId});}
      });
    }
    for(const [id,value] of Object.entries(this.pending())){
      await this.store.faults.run('window_recovery:'+id,async()=>{
      const current=this.store.getPeer(value.peerId);
      if(!current){if(!this.store.hasPeer(value.peerId))this.forget(value.peerId);return;}
      if(current.enabled===false)return;
      if(this.store.pairFor(value.peerId)){this.forget(value.peerId);return;}
      if(value.state!=='unverified'||value.nextAt>Date.now()||Date.now()>=value.deadline)return;
      const window=registrationWindow(value.input),binding=window&&this.store.bindings.get(windowKey(window));
      if(window&&(!binding?.active||binding.peerId!==value.peerId||binding.sessionId!==value.input.sessionId)){this.forget(value.peerId);return;}
        const peer=await this.register({...value.input,...(binding?{expectedBinding:{key:binding.key,epoch:binding.epoch}}:{})});
        if(peer.id!==value.peerId)this.store.selections.resumeHeld(peer.id,send);
      });
    }
  }
}
