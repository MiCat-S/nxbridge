import type { Store } from '../../storage/store.js';
import {DEFAULT_CONFIG} from '../../config/defaults.js';
import {type BridgeConfig,type Message,type Peer} from '../../types.js';
import { cooperationTipText } from './cooperation-tip-text.js';

export interface SyncReminder {firedAt:number;dueAt:number}
export interface ContextUsage {tokens:number;at:number;id?:string}
interface Clock {
  scope:string;checkedAt:number;running:boolean;work:number;contact:number;tip?:number;
  count:number;firstTip?:number;firstTipWork?:number;sentAt?:number;
  usage?:ContextUsage;seenBands:number[];pendingBand?:number;compaction?:string;compactedAt?:number;
  baselinePending?:boolean;
}
interface Options {
  config?:()=>BridgeConfig;blocked?:(peer:Peer)=>boolean;
  idle?:(peer:Peer)=>{id:string;messageIds:string[]}|undefined;
  consumeIdle?:(peer:Peer,id:string)=>void;
}
const key=(peer:Peer)=>'cooperation:'+peer.id;
const root=(peer:Peer)=>!!peer.sessionId&&['root','fork'].includes(peer.kind)&&peer.enabled!==false;
                                         
const elapsedWork=(at:number,now:number)=>now>=at&&now-at<=120000?now-at:0;

                                  
export function cooperationInterval(minutes:number,effort:Peer['effort']):number{
  return minutes*60000*({medium:2/3,high:5/6,xhigh:1,max:1}[String(effort).toLowerCase()]??.5);
}

                                       
export class CooperationTips {
  constructor(private store:Store,private options:Options={}){}
  private config():BridgeConfig{return this.options.config?.()??DEFAULT_CONFIG;}
  private scope(peer:Peer):string|undefined{
    const binding=this.store.bindings.current(peer.id),pair=this.store.pairFor(peer.id);
    if(!root(peer)||binding&&(binding.transitioning||binding.sessionId!==peer.sessionId))return;
    return JSON.stringify([peer.sessionId,binding?.epoch??null,pair?.id??null]);
  }
  private eligible(peer:Peer):boolean{
    if(!this.config().syncTipMinutes||!this.scope(peer)||peer.state!=='busy'||this.options.blocked?.(peer)||this.store.endpoint(peer.id)?.pendingContext)return false;
    const pair=this.store.pairFor(peer.id);
    if(!pair)return this.config().implicit!=='never'&&!this.store.setting('cooperationUnpaired:'+peer.id)&&!this.store.hasPairHistory(peer.id)&&!this.store.setting('pairLoss:'+peer.id)&&!this.store.setting('hosting:'+peer.id);
    const other=this.store.peer(pair[peer.host==='codex'?'claude':'codex']);
    if(pair.paused||!root(other)||other.state!=='ready'||!this.scope(other)||this.options.blocked?.(other)||this.store.endpoint(other.id)?.pendingContext)return false;
    if(this.store.questions(true).some(q=>q.pairId===pair.id))return false;
    return ![peer.id,other.id].some(id=>this.store.deliveryIssueFacts(pair.id,id).length);
  }
  private clock(peer:Peer,now=Date.now()):Clock|undefined{
    const scope=this.scope(peer);if(!scope){const previous=this.store.setting<Clock>(key(peer));if(previous?.running){if(this.config().syncTipMinutes)previous.work+=elapsedWork(previous.checkedAt,now);previous.checkedAt=now;previous.running=false;this.store.setSetting(key(peer),previous);}return;}
    let state=this.store.setting<Clock>(key(peer));
    if(state?.scope!==scope){
                                         
      const sameConversation=state&&JSON.parse(state.scope)[0]===peer.sessionId;
      state={scope,checkedAt:now,running:this.eligible(peer),work:0,contact:0,count:0,
        seenBands:sameConversation?state!.seenBands:[],...(sameConversation?{pendingBand:state!.pendingBand,compaction:state!.compaction,compactedAt:state!.compactedAt,baselinePending:state!.baselinePending}:{})};
    }
    const running=this.eligible(peer);if(!state.running&&!running)return state;
    if(state.running&&this.config().syncTipMinutes)state.work+=elapsedWork(state.checkedAt,now);
    state.checkedAt=now;state.running=running;
    return state;
  }
  observe(peer:Peer):void{
    const now=Date.now(),state=this.clock(this.store.peer(peer.id),now);if(state&&(state.running||state.checkedAt===now))this.store.setSetting(key(peer),state);
  }
  restarted():void{
    for(const peer of this.store.peers()){
      const state=this.store.setting<Clock>(key(peer));if(!state)continue;
      state.checkedAt=Date.now();state.running=false;this.store.setSetting(key(peer),state);
    }
  }
  changed(peer:Peer):void{
                                           
    this.observe(peer);const pair=this.store.pairFor(peer.id);
    if(pair)this.observe(this.store.peer(pair[peer.host==='codex'?'claude':'codex']));
  }
  contact(peer:Peer,message:Message,incoming:boolean):void{
    this.store.transaction(()=>{
      const current=this.store.peer(peer.id),state=this.clock(current),pair=this.store.pairFor(peer.id);
      if(!state||!pair||message.pairId!==pair.id)return;
      const receiptKey='syncTip:message:'+message.id,receipt=this.store.setting<string|{incoming?:string;outgoing?:string}>(receiptKey);
      const previous=typeof receipt==='string'?{incoming:receipt}:receipt??{},direction=incoming?'incoming':'outgoing';
      if(previous[direction]===state.scope)return;
                                
      if(!incoming&&message.createdAt<(state.sentAt??0))return;
      state.contact=state.work;
      if(!incoming){state.count=0;delete state.firstTip;delete state.firstTipWork;state.sentAt=message.createdAt;delete state.pendingBand;}
      this.store.setSetting(receiptKey,{...previous,[direction]:state.scope});this.store.setSetting(key(peer),state);
    });
  }
  usage(peer:Peer,usage:ContextUsage):void{
    if(!Number.isSafeInteger(usage.tokens)||usage.tokens<0||!Number.isFinite(usage.at))return;
    const current=this.store.peer(peer.id),state=this.clock(current);
    if(!state)return;
    if(usage.at<(this.store.bindings.current(peer.id)?.activatedAt??0)||usage.at<(state.compactedAt??0)||state.usage&&state.usage.at>usage.at){this.store.setSetting(key(peer),state);return;}
    state.usage=usage;
    const bands=this.config().contextTipTokens??DEFAULT_CONFIG.contextTipTokens;
    for(const band of bands)if(usage.tokens>=band&&!state.seenBands.includes(band)){state.seenBands.push(band);if(!state.baselinePending)state.pendingBand=Math.max(state.pendingBand??0,band);}
    delete state.baselinePending;
    this.store.setSetting(key(peer),state);
  }
                                       
  contextKey(peer:Peer):string{return JSON.stringify([peer.sessionId??null,this.store.setting<Clock>(key(peer))?.compaction??null]);}
  compacted(peer:Peer,id:string,at=Date.now()):void{
    const state=this.clock(this.store.peer(peer.id));if(!state||state.compaction===id||at<(this.store.bindings.current(peer.id)?.activatedAt??0)||at<(state.compactedAt??0))return;
    const fresh=state.usage&&state.usage.at>at?state.usage:undefined;
    state.compactedAt=at;
    state.compaction=id;
    delete state.usage;delete state.pendingBand;
    state.baselinePending=true;state.seenBands=[];this.store.setSetting(key(peer),state);
    if(fresh)this.usage(peer,fresh);
    this.store.event('communication.contextReset',{peerId:peer.id,at});
  }
  tip(peer:Peer,minutes:number):string|undefined{
    return this.store.transaction(()=>{
      const current=this.store.peer(peer.id),state=this.clock(current);if(!state)return;
      const save=()=>this.store.setSetting(key(peer),state);
      const interval=cooperationInterval(minutes,current.effort),elapsed=state.work-state.contact,cooldown=minutes*30000;
      if(!minutes||!state.running){save();return;}
      const sinceTip=state.tip===undefined?Infinity:state.work-state.tip;
      const silence=elapsed>=interval&&sinceTip>=interval&&state.count<3;
      const band=state.pendingBand,context=band!==undefined&&state.usage&&state.usage.tokens>=band&&(this.config().contextTipTokens??DEFAULT_CONFIG.contextTipTokens).includes(band)?{tokens:state.usage.tokens,threshold:band}:undefined;
      if((!silence&&!context)||elapsed<cooldown||sinceTip<cooldown){save();return;}
      const pair=this.store.pairFor(peer.id),other=pair?this.store.peer(pair[peer.host==='codex'?'claude':'codex']):undefined;
      const owed=pair?this.store.seenSinceLastSendFacts(pair.id,peer.id,this.store.bindings.current(peer.id)?.activatedAt??pair.createdAt).map(m=>m.id):[];
      const idle=this.options.idle?.(current);
      if(silence){state.count++;if(state.firstTip===undefined){state.firstTip=Date.now();state.firstTipWork=state.work;}}
      state.tip=state.work;if(context)delete state.pendingBand;save();
      if(idle)this.options.consumeIdle?.(current,idle.id);
      this.store.event('communication.syncTip',{peerId:peer.id,minutes:interval/60000,effort:current.effort??'unknown',ordinal:silence?state.count:undefined,contextBand:context?.threshold,unpaired:!pair,coalescedIdle:idle?.id});
      return cooperationTipText({unpaired:!pair,elapsedMinutes:Math.floor(elapsed/60000),intervalMinutes:interval/60000,effort:current.effort,
        ...(other?{partnerIdleMinutes:Math.floor((Date.now()-(other.stateSince??Date.now()))/60000)}:{}),
        ...(silence?{silence:{ordinal:state.count as 1|2|3}}:{}),...(context?{context}:{}),...(owed.length?{owedMessageIds:owed}:{}),...(idle?{idleMessageIds:idle.messageIds}:{})});
    });
  }
  reminder(peer:Peer,minutes:number):SyncReminder|undefined{
    const now=Date.now(),current=this.store.peer(peer.id),state=this.clock(current,now);if(!state)return;
    if(state.running||state.checkedAt===now)this.store.setSetting(key(peer),state);
    if(!minutes||!state.running||state.firstTip===undefined||state.firstTipWork===undefined)return;
    const remaining=Math.max(state.firstTipWork,state.contact)+cooperationInterval(minutes,current.effort)-state.work;
    return{firedAt:state.firstTip,dueAt:Date.now()+Math.max(0,remaining)};
  }
}
