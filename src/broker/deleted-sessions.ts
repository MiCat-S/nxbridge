import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/store.js';
import { memberEnabled } from './member-control.js';
import { pairLoss, pairLossKey, type PairLoss } from './pairing/pair-loss.js';
import { pairChangeKey } from './pairing/pair-changes.js';
import { References } from './delivery/references.js';
import { sessionHistoryState, recordSessionHistory, verifySessionHistory, sessionHistoryNeedsVerification } from './recovery/session-history.js';
import { hostingRecord } from './recovery/session-hosting.js';
import {BridgeError,DeliveryError,describeError} from '../shared/errors.js';
import {otherHost,type BridgeConfig,type Endpoint,type Pair,type Peer} from '../types.js';
import { recoveryPrecondition } from './recovery/managed-recovery.js';
import { probeProcesses } from '../process/process.js';
import {bridgeHome} from '../shared/local-paths.js';
import {sameDirectory} from '../shared/files.js';
import { claudeChild } from '../hosts/claude/claude-child.js';
import { nativeOwnership } from '../process/owned-native.js';
import { pairLossView } from './pairing/pair-restore.js';

export type SessionPresence='present'|'absent'|'unknown';
interface Replacement {lossId:string;sessionId:string|null;memberId:string;state:'staged'|'ready'|'failed'|'uncertain';nextAt:number;attempts?:number;error?:string;creationPending?:boolean;loss?:PairLoss;bootstrap?:string}
interface DeletedProof {sessionId:string|null;endpoint:string;pairId:string;at:number}
interface Dependencies {
  holder:(peer:Peer)=>Promise<'alive'|'dead'|'unknown'>;
  busy:(peer:Peer)=>boolean;
  change:<T>(pair:Pair,work:()=>Promise<T>)=>Promise<T>;
  cancel:(peerId:string)=>void;
  prepare:(peer:Peer,source:Peer,guard:()=>void,beforeCreate:()=>void)=>Promise<void>;
  beforeCreate:()=>void;
  retire:(peerId:string)=>void;
  notifyFailure?:(peer:Peer,loss:PairLoss)=>void;
  presence?:(peer:Peer)=>Promise<SessionPresence>;
}
const replacementKey=(id:string)=>'deletedReplacement:'+id;
const proofKey=(id:string)=>'sessionDeleted:'+id;
const endpointFor=(store:Store,id:string)=>store.endpoint(id)??store.endpoints(id).sort((a,b)=>b.seenAt-a.seenAt)[0];
const endpointScope=(ep:Endpoint)=>[ep.epoch,ep.active,ep.address,ep.pid,ep.procStart,ep.native,ep.configHome,ep.daemon,ep.processKind,ep.nativeSession];

                                    
export async function sessionPresence(store:Store,peer:Peer,probe=probeProcesses,home=bridgeHome()):Promise<SessionPresence>{
  const endpoints=store.endpoints(peer.id),active=endpoints.filter(ep=>ep.active),current=active.length?active:endpoints.sort((a,b)=>b.seenAt-a.seenAt).slice(0,1);
  if(!current.length)return'unknown';
  const results=await Promise.all(current.map(async ep=>{
    const native=ep.native??ep;
    if(!native.pid||!native.procStart)return'unknown' as const;
    const state=(await probe([{pid:native.pid,procStart:native.procStart}]))[0];
    if(state!=='alive')return'unknown' as const;
    if(ep.nativeSession?.interactive===true||peer.host==='codex'&&ep.processKind==='foreground')return'present' as const;
    if(store.setting('takeover:'+peer.id))return'present' as const;
    if(peer.owner==='nxbridge'&&ep.active&&!ep.daemon){
      if(peer.host==='codex'&&ep.mode==='app-server')return store.bindings.current(peer.id)?'present' as const:'absent' as const;
      if(peer.host==='claude'&&ep.mode==='claude-inbox')try{
        const child=claudeChild(home,peer.id);
        if(child)return child.phase==='active'&&!child.foreground&&child.sessionId===peer.sessionId&&child.native?.pid===native.pid&&child.native.startedAt===native.procStart?'absent' as const:'unknown' as const;
        const proof=nativeOwnership(home,peer.id);
        if(proof?.phase==='bound'&&!proof.releasedToUser&&proof.sessionId===peer.sessionId&&proof.native?.pid===native.pid&&proof.native.startedAt===native.procStart&&(!ep.configHome||sameDirectory(proof.configHome,ep.configHome)))return'absent' as const;
      }catch{return'unknown' as const;}
    }
    return'unknown' as const;
  }));
  return results.includes('present')?'present':results.every(value=>value==='absent')?'absent':'unknown';
}

                                  
export class DeletedSessions {
  private nextCheck=0;
  private checking?:Promise<void>;
  constructor(private store:Store,private config:BridgeConfig,private deps:Dependencies){}
  observe(peer:Peer,endpoint:Endpoint,file=endpoint.nativeSession?.transcriptPath):void{
    if(!['root','fork'].includes(peer.kind)||!memberEnabled(this.store,peer))return;
    recordSessionHistory(this.store,peer,endpoint,file);
    if(this.store.setting(proofKey(peer.id))&&sessionHistoryState(this.store,peer,endpoint)==='present')this.store.setSetting(proofKey(peer.id),null);
  }
  deleted(peer:Peer,endpoint:Endpoint):void{
    const pair=this.store.pairFor(peer.id);if(!memberEnabled(this.store,peer)||!peer.sessionId||!pair)return;
    this.store.setSetting(proofKey(peer.id),{sessionId:peer.sessionId,endpoint:endpoint.epoch,pairId:pair.id,at:Date.now()} satisfies DeletedProof);
    this.nextCheck=0;
  }
  ownsReservation(peerId:string,targetId:string):boolean{
    const source=this.store.getPeer(peerId),claim=this.store.setting<Replacement>(replacementKey(peerId)),loss=source?pairLoss(this.store,source):undefined;
    return !!source&&!!claim&&!(claim.state==='failed'&&claim.nextAt===Number.MAX_SAFE_INTEGER)&&claim.memberId===targetId&&claim.sessionId===source.sessionId&&claim.lossId===loss?.id&&!loss.replacement_suppressed&&!this.store.pairFor(targetId);
  }
  pendingCreation(targetId:string):boolean{
    if(this.store.getPeer(targetId)?.sessionId)return false;
    return this.store.peers().some(peer=>{const claim=this.store.setting<Replacement>(replacementKey(peer.id));return claim?.memberId===targetId&&claim.creationPending===true;});
  }
                                               
  bootstrapSelected(peer:Peer):void{
    const claim=this.store.setting<Replacement>(replacementKey(peer.id)),pair=this.store.pairFor(peer.id);
    if(!claim?.loss||claim.state==='ready'||claim.sessionId!==peer.sessionId||pair?.[otherHost(peer.host)]!==claim.memberId||pair.paused||!memberEnabled(this.store,peer)||!memberEnabled(this.store,this.store.peer(claim.memberId)))return;
    this.queueBootstrap(peer,claim.loss,claim,pair);
  }
  markSelectedCreation(targetId:string):void{
    const pair=this.store.pairFor(targetId);if(!pair)return;
    const target=this.store.peer(targetId),source=this.store.peer(pair[otherHost(target.host)]),claim=this.store.setting<Replacement>(replacementKey(source.id));
    if(!claim?.loss||claim.memberId!==targetId||claim.sessionId!==source.sessionId)return;
    if(pair.paused||!memberEnabled(this.store,source)||!memberEnabled(this.store,target)||claim.creationPending)throw new BridgeError('session_changed','删除恢复预约已改变或仍在等待创建确认。');
    this.store.setSetting(replacementKey(source.id),{...claim,creationPending:true});
  }
  sweep(fresh=false):Promise<void>{
    if(this.checking)return this.checking;
    if(!fresh&&Date.now()<this.nextCheck)return Promise.resolve();
    this.nextCheck=Date.now()+5000;
    const work=this.check().finally(()=>{if(this.checking===work)this.checking=undefined;});this.checking=work;return work;
  }
  private allowed(peer:Peer):boolean{
    return memberEnabled(this.store,peer)&&['root','fork'].includes(peer.kind)&&!['paused','needsHuman','starting'].includes(peer.state)&&!this.deps.busy(peer);
  }
  private scope(pair:Pair):string{
    return JSON.stringify([this.store.pairById(pair.id),...[pair.claude,pair.codex].map(id=>{
      const p=this.store.peer(id),binding=this.store.bindings.current(id);return[p.id,p.sessionId,p.owner,p.enabled,p.state,this.store.endpoints(id).map(endpointScope),binding?.key,binding?.epoch,binding?.transitioning];
    })]);
  }
  private async check():Promise<void>{
    for(const source of this.store.peers())try{
      const key=replacementKey(source.id),claim=this.store.setting<Replacement>(key);if(!claim||claim.state==='ready'||this.ownsReservation(source.id,claim.memberId))continue;
      const selected=this.store.pairFor(source.id);
      if(selected?.[otherHost(source.host)]===claim.memberId&&claim.loss){
        if(source.sessionId===claim.sessionId){
          this.bootstrapSelected(source);
          if(this.store.getPeer(claim.memberId)?.sessionId)this.complete(source,claim.loss,claim,selected);
          continue;
        }
      }
      this.store.setSetting(key,null);
      const intent=this.store.setting<{peerId:string}>('implicitPartner:'+source.id);if(intent?.peerId===claim.memberId)this.store.setSetting('implicitPartner:'+source.id,null);
      if(this.store.getPeer(claim.memberId)&&!this.store.pairFor(claim.memberId))this.deps.retire(claim.memberId);
    }catch(error){this.store.event('session.replacement.reconcile_failed',{memberId:source.id,error:describeError(error)});}
    for(const pair of this.store.pairs())try{
      if(pair.paused)continue;
      const members=[this.store.peer(pair.claude),this.store.peer(pair.codex)];
      if(members.some(peer=>!memberEnabled(this.store,peer)||!['root','fork'].includes(peer.kind)))continue;
      for(const peer of members){
        const survivor=members.find(member=>member.id!==peer.id)!;
        if(!this.allowed(survivor))continue;
        const ep=endpointFor(this.store,peer.id);if(!ep||!peer.sessionId)continue;
        const scope=this.scope(pair),proof=this.store.setting<DeletedProof>(proofKey(peer.id)),explicit=proof?.sessionId===peer.sessionId&&proof.endpoint===ep.epoch&&proof.pairId===pair.id;
        if(!explicit&&!sessionHistoryNeedsVerification(this.store,peer,ep))continue;
                                                           
        if(!explicit&&await this.deps.holder(peer)!=='dead')continue;
        if(!explicit&&await verifySessionHistory(this.store,peer,ep)!=='missing')continue;
        if(this.scope(pair)!==scope)continue;
        await this.deps.change(pair,async()=>{
          if(this.scope(pair)!==scope||!this.allowed(this.store.peer(survivor.id))||!memberEnabled(this.store,this.store.peer(peer.id)))return;
          if(!explicit&&await this.deps.holder(peer)!=='dead')return;
          if(this.scope(pair)!==scope)return;
          if(!explicit&&sessionHistoryState(this.store,peer,ep)!=='missing')return;
          this.store.transaction(()=>{
            for(const message of this.store.messagesFor(pair.id)){
              if(['accepted','held'].includes(message.state)&&message.attempts===0)this.store.transition(message.id,message.from===peer.id?'held':'expired',message.from===peer.id?'session_deleted: 原搭档留下的未读消息，保留供原接收方读取。':'session_deleted: 原会话历史已删除；未转发给新搭档。');
              else if(message.state==='sending')this.store.transition(message.id,'unknown','session_deleted: 原会话可能已收到；不得自动重发。');
            }
            this.store.unpair(pair.id,{reason:'session_deleted',actor:'verified native session history loss'});
            const loss=pairLoss(this.store,this.store.peer(survivor.id));
            if(loss)this.store.setSetting(pairLossKey(survivor.id),{...loss,deleted_member_id:peer.id,held_message_ids:this.store.messagesFor(pair.id).filter(message=>message.from===peer.id&&message.to===survivor.id&&message.state==='held'&&message.attempts===0).map(message=>message.id)});
            this.store.setSetting(pairLossKey(peer.id),null);
            for(const id of [pair.claude,pair.codex])this.deps.cancel(id);
            this.store.deactivate(peer.id);const binding=this.store.bindings.current(peer.id);if(binding)this.store.bindings.save({...binding,active:false});
            this.store.updatePeer(peer.id,{state:'offline'});
            this.store.setSetting(proofKey(peer.id),null);
            this.store.event('session.deleted',{pairId:pair.id,peerId:peer.id,sessionId:peer.sessionId,proof:explicit?'native_event':'recorded_history_missing'});
          });
          this.deps.retire(peer.id);
        });
        break;
      }
    }catch(error){this.store.event('session.deletion.check_failed',{pairId:pair.id,error:describeError(error)});}
    for(const peer of this.store.peers())try{
      const loss=pairLoss(this.store,peer);
      if(loss?.reason==='session_deleted'&&loss.deleted_member_id!==peer.id)await this.replace(peer,loss);
    }catch(error){this.store.event('session.replacement.check_failed',{memberId:peer.id,error:describeError(error)});}
  }
  private eligible(peer:Peer,loss:PairLoss):boolean{
    const dead=this.store.getPeer(loss.deleted_member_id??'');
    return this.config.implicit!=='never'&&this.allowed(peer)&&!!dead&&memberEnabled(this.store,dead)&&!loss.replacement_suppressed&&!(loss.replacement?.state==='failed'&&loss.replacement.terminal)&&!this.store.pairFor(peer.id)&&pairLoss(this.store,peer)?.id===loss.id&&peer.sessionId===loss.session_id&&!hostingRecord(this.store,peer)?.released&&pairLossView(this.store,peer)?.restore_state!=='resumable';
  }
  private async replace(peer:Peer,loss:PairLoss):Promise<void>{
    if(!this.eligible(peer,loss)||!peer.sessionId)return;
    const presence=this.deps.presence??(p=>sessionPresence(this.store,p));
    const sourceScope=()=>{const binding=this.store.bindings.current(peer.id);return JSON.stringify([this.store.peer(peer.id).sessionId,this.store.endpoints(peer.id).map(endpointScope),binding?.key,binding?.epoch,binding?.transitioning]);},scope=sourceScope();
    if(await presence(peer)!=='absent'||sourceScope()!==scope)return;
    const key=replacementKey(peer.id);let claim=this.store.setting<Replacement>(key);
    if(claim?.lossId===loss.id&&claim.nextAt>Date.now()&&!(claim.state==='uncertain'&&this.store.getPeer(claim.memberId)?.sessionId))return;
    const deleted=this.store.getPeer(loss.deleted_member_id??''),endpoint=deleted?endpointFor(this.store,deleted.id):undefined;
    if(deleted&&endpoint)await verifySessionHistory(this.store,deleted,endpoint,{fresh:true});
    if(sourceScope()!==scope||!this.eligible(this.store.peer(peer.id),loss))return;
    if(!claim||claim.lossId!==loss.id){
      claim=this.store.transaction(()=>{
        const target=this.store.placeholder(otherHost(peer.host),peer.cwd),reservation:Replacement={lossId:loss.id,sessionId:peer.sessionId,memberId:target.id,state:'staged',nextAt:0,attempts:0,loss};
        this.store.setSetting(key,reservation);return reservation;
      });
    }
    const target=this.store.getPeer(claim.memberId);if(!target||this.store.pairFor(target.id))return;
    if(claim.creationPending&&!target.sessionId){this.uncertain(peer,loss,claim,'新会话创建曾提交但身份尚未核实，未重复创建；请检查原生启动记录。');return;}
    this.store.setSetting('implicitPartner:'+peer.id,{peerId:target.id,sessionId:peer.sessionId});
    const guard=(allowHandoff=false)=>{
      const current=this.store.peer(peer.id),fresh=pairLoss(this.store,current),saved=this.store.setting<Replacement>(key),pair=this.store.pairFor(peer.id);
      const selected=allowHandoff&&pair?.[otherHost(peer.host)]===target.id&&!pair.paused&&this.allowed(current)&&memberEnabled(this.store,this.store.peer(target.id));
      if(!selected&&(!fresh||!this.eligible(current,fresh)||fresh.id!==loss.id)||saved?.memberId!==target.id||saved.lossId!==loss.id||sourceScope()!==scope)throw new BridgeError('session_changed','删除恢复期间窗口或选择已改变，未创建另一个搭档。');
    };
    try{
      claim={...claim,attempts:(claim.attempts??0)+1};this.store.setSetting(key,claim);
      guard();this.deps.beforeCreate();await this.deps.prepare(target,peer,guard,()=>{guard(true);const saved=this.store.setting<Replacement>(key);claim={...claim!,bootstrap:saved?.bootstrap,creationPending:true};this.store.setSetting(key,claim);});guard();
      if(await presence(this.store.peer(peer.id))!=='absent')throw new BridgeError('session_changed','原生窗口已可交互，请由用户选择新搭档。');
      guard();
      this.store.transaction(()=>{
        guard();this.complete(peer,loss,claim!);
      });
    }catch(error){
      const selected=this.store.pairFor(peer.id),handoff=selected?.[otherHost(peer.host)]===target.id;
      if(handoff&&this.store.peer(target.id).sessionId){this.complete(peer,loss,claim,selected);return;}
      const fresh=pairLoss(this.store,this.store.peer(peer.id))??(handoff?loss:undefined);
      if(fresh?.id===loss.id){
        const pending=claim.creationPending&&!this.store.peer(target.id).sessionId;
        const uncertain=error instanceof DeliveryError?error.uncertain:!recoveryPrecondition(error)||error instanceof BridgeError&&error.code==='owned_launch_cleanup_failed';
        if(pending&&uncertain){this.uncertain(peer,fresh,claim,describeError(error));return;}
        const terminal=(claim.attempts??0)>=3,nextAt=terminal?Number.MAX_SAFE_INTEGER:Date.now()+30000*2**Math.max(0,(claim.attempts??1)-1),errorText=describeError(error);
        const saved=this.store.setting<Replacement>(key);
        this.store.setSetting(key,{...claim,bootstrap:saved?.bootstrap,creationPending:false,state:'failed',nextAt,error:errorText});
        const updated:PairLoss={...fresh,...(terminal?{state:'pending',admitted:false}:{}),replacement:{state:'failed',member_id:target.id,next_at:nextAt,error:errorText,...(terminal?{terminal:true}:{})}};
        if(!handoff)this.store.setSetting(pairLossKey(peer.id),updated);
        if(terminal&&!handoff){this.deps.retire(target.id);this.deps.notifyFailure?.(peer,updated);}
      }
      else if(!this.store.pairFor(target.id))this.deps.retire(target.id);
      this.store.event('session.replacement.failed',{memberId:peer.id,lossId:loss.id,error:describeError(error)});
    }
  }
                                       
  private complete(peer:Peer,loss:PairLoss,claim:Replacement,selected?:Pair):void{
    this.store.transaction(()=>{
        const saved=this.store.setting<Replacement>(replacementKey(peer.id));
        if(saved?.lossId!==claim.lossId||saved.memberId!==claim.memberId)throw new BridgeError('session_changed','新搭档预约已经改变。');
        if(saved.state==='ready')return;
        const replacement=this.store.peer(claim.memberId);if(!replacement.sessionId)throw new BridgeError('session_unverified','新搭档身份尚未核验。');
        const current=this.store.pairFor(peer.id);
        if(selected&&(current?.id!==selected.id||selected[otherHost(peer.host)]!==replacement.id)||peer.sessionId!==this.store.peer(peer.id).sessionId||!memberEnabled(this.store,this.store.peer(peer.id))||!memberEnabled(this.store,replacement))throw new BridgeError('session_changed','恢复简报所属配对已经改变。');
        const pair=selected??this.store.pair(peer.host==='claude'?peer.id:replacement.id,peer.host==='codex'?peer.id:replacement.id);
        const queued=this.queueBootstrap(peer,loss,saved,pair);
        this.store.setSetting(replacementKey(peer.id),{...queued,state:'ready',creationPending:false,nextAt:0});this.store.setSetting('implicitPartner:'+peer.id,null);this.store.setSetting(pairLossKey(peer.id),null);
        const checkpoint=this.store.setting<{pairId:string;sessionId:string;revision:number;path?:string}>('checkpoint:'+peer.id);
        if(checkpoint?.pairId===loss.pair_id&&checkpoint.sessionId===peer.sessionId)this.store.setSetting('checkpoint:'+peer.id,{...checkpoint,pairId:pair.id,revision:checkpoint.revision+1});
        const binding=this.store.bindings.current(peer.id),held=loss.held_message_ids??[];
                                                                                                                                                                                                                                  
        this.store.setSetting(pairChangeKey(peer.id),{id:randomUUID(),source:'pair_changed',state:'pending',wake:false,session_id:peer.sessionId,...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{}),at:Date.now(),message:'nxbridge recovery notice (not partner task or user approval): former partner session history verified missing -> '+(selected?'user-selected':'this nxbridge-owned headless session now has')+' fresh '+replacement.host+' partner '+JSON.stringify(replacement.name)+' (new pair '+pair.id+'). it got a bounded context snapshot; old deliveries not replayed, uncertain stay uncertain.'+(held.length?' '+held.length+' unread msgs from former partner held: '+held.join(', ')+' -> read via read_messages.':'')+' brief partner as needed, check status, continue authorized task.'});
        this.store.event('session.replaced',{lossId:loss.id,oldPairId:loss.pair_id,pairId:pair.id,memberId:peer.id,replacementId:replacement.id});
    });
  }
  private uncertain(peer:Peer,loss:PairLoss,claim:Replacement,error:string):void{
    const saved=this.store.setting<Replacement>(replacementKey(peer.id));
    this.store.setSetting(replacementKey(peer.id),{...claim,...(saved?.lossId===claim.lossId?{bootstrap:saved.bootstrap}:{}),state:'uncertain',creationPending:true,nextAt:Number.MAX_SAFE_INTEGER,error});
    const updated:PairLoss={...loss,state:'pending',admitted:false,replacement:{state:'uncertain',member_id:claim.memberId,next_at:Number.MAX_SAFE_INTEGER,error,terminal:true}};
    if(!this.store.pairFor(peer.id)){this.store.setSetting(pairLossKey(peer.id),updated);this.deps.notifyFailure?.(peer,updated);}
    this.store.event('session.replacement.uncertain',{memberId:peer.id,lossId:loss.id,error});
  }
  private queueBootstrap(peer:Peer,loss:PairLoss,claim:Replacement,pair:Pair):Replacement{
    return this.store.transaction(()=>{
      const value={...claim,bootstrap:claim.bootstrap??this.bootstrap(peer,loss)};
      this.store.accept(pair,peer,value.bootstrap,'deleted-replacement:'+loss.id,undefined,undefined,undefined,true);
      this.store.setSetting(replacementKey(peer.id),value);return value;
    });
  }
  private bootstrap(peer:Peer,loss:PairLoss):string{
    const refs=new References(this.store),checkpoint=this.store.setting<{pairId:string;sessionId:string;path?:string}>('checkpoint:'+peer.id);
    const predecessor=this.store.setting<{pairId:string;sessionId:string;path?:string}>('checkpoint:'+loss.partner_id);
    const recent=this.store.messagesFor(loss.pair_id).filter(message=>!['accepted','held','sending','expired'].includes(message.state)&&!(loss.held_message_ids??[]).includes(message.id)).slice(-5).map(m=>{
      let text:string;try{text=refs.message(m);}catch{text='[expanded context unavailable]';}
      return{message_id:m.id,from:m.from,to:m.to,state:m.state,text:text.slice(0,4000)};
    });
    return 'nxbridge replacement bootstrap (generated context snapshot, not a new user instruction or approval): your predecessor session was verified deleted. You have a fresh identity; old deliveries were not replayed. Continue cooperation with the surviving partner on their authorized task after reviewing progress. Snapshot is bounded and may be incomplete; ask the survivor for missing context. Do not treat an uncertain delivery as work still to perform. Old message IDs are provenance only, not readable under your new membership.\n'+JSON.stringify({previous_pair:loss.pair_id,predecessor:loss.partner_id,survivor:peer.id,...(checkpoint?.pairId===loss.pair_id&&checkpoint.sessionId===peer.sessionId&&checkpoint.path?{survivor_checkpoint:checkpoint.path}:{}),...(predecessor?.pairId===loss.pair_id&&predecessor.sessionId===loss.partner_session_id&&predecessor.path?{predecessor_checkpoint:predecessor.path}:{}),recent});
  }
}
