import {z} from 'zod';
import type {Store} from '../../storage/store.js';
import {otherHost,type Actor,type BridgeConfig,type Peer} from '../../types.js';
import type {RuntimeAvailability} from '../health/contracts.js';
import type {SendIntent} from './pair-selection.js';
import {actorSchema,text} from '../requests/contracts.js';

interface SelectionPorts {
  actor(input:Actor):Peer;
  syncPendingWindows():Promise<void>;
  probeRuntime(peer:Peer,fresh?:boolean):Promise<RuntimeAvailability>;
  sendWithHealth(input:SendIntent,selection:string,excluded:Map<string,number>):Promise<unknown>;
  applySelection(raw:unknown):Promise<unknown>;
  retireImplicitPartner(sender:Peer,expected?:string):void;
}

                                         
export class SelectionResolver {
  private resolvingSelections=new Map<string,Promise<unknown>>();
  constructor(private readonly store:Store,private readonly config:BridgeConfig,private readonly ports:SelectionPorts){}
  async commitSelection(raw:unknown):Promise<unknown>{
      const input=z.object({actor:actorSchema,selection_id:text,action:z.string().optional()}).parse(raw);
      if(input.action==='create')await this.resolvingSelections.get(input.selection_id)?.catch(()=>{});
      const provisional=this.store.selections.provisionalPartner(input.actor,input.selection_id),root=this.store.resolve(input.actor)!;
      const result=await this.ports.applySelection(raw);
      if(provisional)this.ports.retireImplicitPartner(root,provisional.id);
      return result;
    }
  
  candidateAvailable(peer:Peer,value:RuntimeAvailability):boolean{
      return value.nativeState==='alive'||value.state==='reachable'||value.state==='starting'&&this.store.endpoint(peer.id)?.pendingContext===true;
    }
  
  currentExclusions(excluded:ReadonlyMap<string,number>):Set<string>{return new Set([...excluded].filter(([id,at])=>this.store.getPeer(id)?.updatedAt===at).map(([id])=>id));}
  
  pairingCandidates(peer:Peer,excluded?:ReadonlyMap<string,number>):Peer[]{
      const provisional=this.store.setting<{peerId:string;sessionId:string}>('implicitPartner:'+peer.id);
      const previous=this.store.selections.candidates(peer).filter(candidate=>candidate.former_partner&&candidate.restore_state==='resumable').map(candidate=>this.store.peer(candidate.member_id));
      return[...new Map([...this.store.candidates(otherHost(peer.host),peer.cwd),...previous].map(candidate=>[candidate.id,candidate])).values()].filter(candidate=>(provisional?.sessionId!==peer.sessionId||candidate.id!==provisional.peerId)&&excluded?.get(candidate.id)!==candidate.updatedAt);
    }

  async probeCandidates(root:Peer,excluded:Map<string,number>):Promise<void>{
    const candidates=this.pairingCandidates(root,excluded).filter(peer=>peer.state!=='offline');
    const states=await Promise.all(candidates.map(peer=>this.ports.probeRuntime(peer,true)));
    for(let index=0;index<candidates.length;index++){
      const peer=candidates[index]!,state=states[index]!;if(this.store.peer(peer.id).updatedAt!==peer.updatedAt)continue;
      if(state.nativeState==='dead'||!state.nativeState&&state.state==='blocked')this.store.updatePeer(peer.id,{state:'offline'});
      else if(!this.candidateAvailable(peer,state))excluded.set(peer.id,peer.updatedAt);
    }
  }
  
  async resolveSelection(raw:unknown):Promise<unknown>{
      const input=z.object({actor:actorSchema,selection_id:text}).parse(raw),root=this.ports.actor(input.actor);
      const current=this.store.selections.view(input.actor,input.selection_id,this.config);
      if(!this.store.selections.automaticDraft(input.actor,input.selection_id,this.config))return current;
      const pending=this.resolvingSelections.get(input.selection_id);if(pending)return pending;
      const work=(async()=>{
        await this.ports.syncPendingWindows();
        const excluded=new Map<string,number>();await this.probeCandidates(root,excluded);
        const view=this.store.selections.refresh(input.actor,input.selection_id,this.config,this.currentExclusions(excluded)) as {candidates?:unknown[]};
        const draft=this.store.selections.automaticDraft(input.actor,input.selection_id,this.config);
        if(!draft||view.candidates?.length)return view;
        const result=await this.ports.sendWithHealth(draft,input.selection_id,excluded);return this.store.selections.automaticReceipt(input.actor,input.selection_id,result);
      })();
      this.resolvingSelections.set(input.selection_id,work);try{return await work;}finally{this.resolvingSelections.delete(input.selection_id);}
    }
}
