import type { CodexAdapter, CodexContextReceipt } from './adapter.js';
import type { Store } from '../../storage/store.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import {type Endpoint,type Message,type Peer} from '../../types.js';
import type { HistoryCursor } from './codex-history.js';
import { memberEnabled } from '../../broker/member-control.js';
import { hostingGate } from '../../broker/recovery/session-hosting.js';
import { codexThreadIdle } from './codex-thread-state.js';

interface Attempt {id:string;callId:string;waitingTurn?:string;notice?:boolean;at?:number;checks?:number;historyCursor?:HistoryCursor}
interface Continuation {anchor:string;notice?:boolean;baseline?:string;attempts:number;at:number;uncertain?:boolean;error?:string}
interface Reservation {scope:string;attempts:Attempt[];continuation?:Continuation;parked?:string[];checkedAt?:number;wait?:{native_status:string;active_flags:string[];turn_id?:string;since:number;message:string}}
const RECEIPT_GRACE_MS=3000,RECHECK_MS=10000,RETRY_MS=30000;
const key=(peerId:string)=>'codexDirect:'+peerId;
const scope=(peer:Peer,endpoint:Endpoint)=>JSON.stringify([peer.sessionId,endpoint.epoch]);

                                          
export class CodexDirectDelivery {
  private active=new Set<string>();
  constructor(private store:Store,private adapter:Pick<CodexAdapter,'injectionState'|'inject'|'continueInjected'>){}
  pending(peerId:string):boolean{const value=this.store.setting<Reservation>(key(peerId));return !!value&&(value.attempts.length>0||!!value.continuation&&(value.continuation.attempts<3||!!value.continuation.uncertain));}
  status(peerId:string):Reservation|undefined{return this.store.setting(key(peerId));}
  continued(peerId:string,turnId:string):void{const value=this.status(peerId);if(value?.continuation&&turnId!==value.continuation.baseline){delete value.continuation;this.store.setSetting(key(peerId),value);}}
  async deliver(peer:Peer,endpoint:Endpoint,messages:(Message&{notice?:boolean})[],output:(message:Message&{notice?:boolean})=>Promise<string|undefined>,guard:()=>boolean,observed:(receipt:CodexContextReceipt)=>void,noticeCanContinue:(id:string)=>boolean=()=>true):Promise<void>{
    if(hostingGate(this.store,peer))return;
    const enabled=()=>memberEnabled(this.store,this.store.peer(peer.id));if(!enabled())return;
    if(this.active.has(peer.id))return;this.active.add(peer.id);
    try{
      const identity=JSON.stringify([this.store.pairFor(peer.id)?.id,scope(peer,endpoint)]),previous=this.status(peer.id);
      if(previous&&previous.scope!==identity){this.store.setSetting(key(peer.id),null);return;}
      const reservation:Reservation=previous??{scope:identity,attempts:[]},save=()=>this.store.setSetting(key(peer.id),reservation);
                                                 
      if(reservation.continuation&&reservation.continuation.notice!==false){
        const continuation=reservation.continuation,id=continuation.anchor.slice('nxbridge-'.length);let message=false;
        if(continuation.notice===undefined)try{message=this.store.message(id).to===peer.id;}catch(error){if(!(error instanceof BridgeError)||error.code!=='message_missing')throw error;}
        if(!message&&!noticeCanContinue(id)){delete reservation.continuation;save();}
      }
      if(!messages.length&&Date.now()-(reservation.checkedAt??0)<RECHECK_MS)return;
      reservation.checkedAt=Date.now();
      const historyOptions=()=>{
                                                      
        if(reservation.attempts.some(value=>!value.historyCursor))return{since:Math.min(...reservation.attempts.map(value=>value.at??0))};
        const cursors=reservation.attempts.flatMap(value=>value.historyCursor?[value.historyCursor]:[]).sort((a,b)=>a.offset-b.offset);return cursors.length?{cursor:cursors[0]}:{tail:true};
      };
      let state=await this.adapter.injectionState(peer,endpoint,historyOptions());
      if(!enabled())return;
      const latest=()=>state.thread.turns?.at(-1),idle=()=>codexThreadIdle(state.thread);
      const recordWait=()=>{
        if(idle()){if(reservation.wait){delete reservation.wait;save();this.store.event('codex.delivery.resumed',{peerId:peer.id});}return;}
        const turn=state.thread.turns?.find(turn=>turn.status==='inProgress'),facts={native_status:state.thread.status?.type??'unknown',active_flags:state.thread.status?.activeFlags??[],...(turn?{turn_id:turn.id}:{})};
        if(reservation.wait&&reservation.wait.native_status===facts.native_status&&JSON.stringify(reservation.wait.active_flags)===JSON.stringify(facts.active_flags)&&reservation.wait.turn_id===facts.turn_id)return;
        reservation.wait={...facts,since:Date.now(),message:'原生 Codex 尚未空闲（'+facts.native_status+(facts.active_flags.length?'；'+facts.active_flags.join(', '):'')+(turn?'；轮次 '+turn.id+' 仍在运行':'')+'）；消息保留，等待原生任务或输入处理完成后继续投递。'};save();this.store.event('codex.delivery.wait',{peerId:peer.id,...reservation.wait});
      };
      recordWait();
      const reconcile=()=>{
        for(const attempt of [...reservation.attempts]){
          const receipt=state.history.receipts.find(value=>value.callId===attempt.callId&&value.messageId===attempt.id);
          if(receipt){
            reservation.attempts=reservation.attempts.filter(value=>value!==attempt);
            if((!attempt.notice||noticeCanContinue(attempt.id))&&(!reservation.continuation||reservation.continuation.attempts>=3&&!reservation.continuation.uncertain))reservation.continuation={anchor:attempt.callId,notice:attempt.notice===true,baseline:latest()?.id,attempts:0,at:0};save();observed(receipt);
          }else if(!attempt.notice&&attempt.historyCursor&&Date.now()-(attempt.at??Date.now())>=RECEIPT_GRACE_MS&&state.history.status==='supported'&&state.history.complete===true&&!state.history.calls.includes(attempt.callId)&&attempt.waitingTurn&&idle()&&state.thread.turns?.some(turn=>turn.id===attempt.waitingTurn&&['interrupted','completed','failed'].includes(turn.status))){
                                                 
            this.store.transition(attempt.id,'accepted','原生轮次已结束且成对调用未进入持久历史，继续原编号投递');reservation.attempts=reservation.attempts.filter(value=>value!==attempt);save();
          }else{
            if(!attempt.notice&&Date.now()-(attempt.at??Date.now())>=RECEIPT_GRACE_MS&&this.store.message(attempt.id).state==='sending')this.store.transition(attempt.id,'unknown','注入已请求，尚无完整原生持久历史证明');
            const waiting=state.thread.turns?.find(turn=>turn.id===attempt.waitingTurn);
            if(attempt.waitingTurn&&(!idle()||waiting&&!['interrupted','completed','failed'].includes(waiting.status)))continue;
            if(Date.now()-(attempt.at??Date.now())<RETRY_MS)continue;
            attempt.checks=(attempt.checks??0)+1;
            if(attempt.checks>=3){reservation.parked=[...(reservation.parked??[]),attempt.id];reservation.attempts=reservation.attempts.filter(value=>value!==attempt);this.store.event('codex.injection.unknown',{peerId:peer.id,id:attempt.id});}
            save();
          }
        }
      };
      reconcile();
      const continuation=reservation.continuation;
      if(continuation&&continuation.attempts>0&&latest()?.id!==continuation.baseline){delete reservation.continuation;save();}
      else if(continuation?.uncertain&&idle()&&Date.now()-continuation.at>=30000){continuation.uncertain=false;save();}
      if(!idle()||!guard())return;
      let submitted=false;
      for(const message of messages){
        if(reservation.attempts.some(value=>value.id===message.id)||!message.notice&&this.store.message(message.id).state!=='accepted')continue;
        const body=await output(message);if(body===undefined||!guard())continue;
                                        
        const attempt:Attempt={id:message.id,callId:'nxbridge-'+message.id,at:Date.now(),...(state.history.cursor?{historyCursor:state.history.cursor}:{}),...(message.notice?{notice:true}:{})};
        const claimed=this.store.transaction(()=>{if(!message.notice&&!this.store.claim(message.id))return false;reservation.attempts.push(attempt);save();return true;});if(!claimed)continue;
        submitted=true;try{await this.adapter.inject(peer,endpoint,attempt.callId,body);}
        catch(error){
          if(!enabled())return;
          if((error as {uncertain?:boolean}).uncertain===false){reservation.attempts=reservation.attempts.filter(value=>value!==attempt);save();if(!message.notice)this.store.transition(message.id,'accepted',undefined,describeError(error));throw error;}
          if(!message.notice)this.store.transition(message.id,'unknown',undefined,describeError(error));
        }
      }
      if(submitted){
        if(!enabled())return;state=await this.adapter.injectionState(peer,endpoint,historyOptions());if(!enabled())return;recordWait();
        if(!idle())for(const attempt of reservation.attempts)attempt.waitingTurn=latest()?.status==='inProgress'?latest()?.id:undefined;
        save();reconcile();if(!idle()||!guard())return;
      }
      const start=reservation.continuation;if(!start||!guard()||start.uncertain||start.attempts>=3||Date.now()-start.at<30000&&start.attempts>0)return;
      start.attempts++;start.at=Date.now();start.baseline=latest()?.id;start.uncertain=true;save();
      try{await this.adapter.continueInjected(peer,endpoint);if(!enabled())return;delete reservation.continuation;save();}
      catch(error){if(!enabled())return;start.error=describeError(error).slice(0,1200);start.uncertain=(error as {uncertain?:boolean}).uncertain!==false;save();this.store.event('codex.continuation.failed',{peerId:peer.id,error:start.error,uncertain:start.uncertain});}
    }finally{this.active.delete(peer.id);}
  }
}
