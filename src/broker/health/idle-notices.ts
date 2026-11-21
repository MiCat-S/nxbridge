import { randomUUID } from 'node:crypto';
import type { Store, MessageFacts } from '../../storage/store.js';
import {noticeScope} from './contracts.js';
import {type DeliveryHealth} from './delivery.js';
import type { Pair, Peer } from '../../types.js';

export interface IdleSnapshot {
  pair:Pair;partner:Peer;delegator:Peer;since:number;now:number;minutes:number;
  transitioning:boolean;queued:boolean;questionTowardDelegator:boolean;
  messages:MessageFacts[];lastMessage?:MessageFacts;
}
interface Episode {scope:string;work?:string;noticeId?:string;recipient:string;pairId:string}
const age=(now:number,at:number)=>Math.max(0,Math.floor((now-at)/60000))+'m';

                                       
export function idleUnanswered(value:IdleSnapshot):string|undefined{
  const {pair,partner,now,since,minutes,lastMessage}=value,messages=value.messages.filter(message=>message.replyExpected===true);
  if(!minutes||pair.paused||pair.archived||partner.state!=='ready'||!partner.sessionId||value.transitioning||value.queued||value.questionTowardDelegator||!messages.length)return;
  if(now-Math.max(since,...messages.map(m=>m.updatedAt))<minutes*60000)return;
  const seen=messages.slice(0,3).map(m=>`${m.id} (${age(now,m.createdAt)} ago)`).join(', ');
  const last=lastMessage?`${lastMessage.id} (${age(now,lastMessage.createdAt)} ago, ${lastMessage.inReplyTo?'reply to '+lastMessage.inReplyTo:'not a reply'})`:'none';
  return`Expected reply still pending after ${minutes} min idle: ${seen}. Last partner msg: ${last}. Continue independent work; check the outstanding task if it still blocks you.`;
}

export class IdleNotices {
  constructor(private store:Store,private notices:DeliveryHealth){}
  observe(pair:Pair,partner:Peer,minutes:number):void{
    if(minutes)minutes=Math.max(5,minutes);
    this.store.transaction(()=>{
      const delegator=this.store.peer(pair[partner.host==='codex'?'claude':'codex']),binding=this.store.bindings.current(partner.id),recipientBinding=this.store.bindings.current(delegator.id),key='idleNotice:'+partner.id;
      const scope=JSON.stringify([pair.id,binding?.epoch??partner.sessionId,recipientBinding?.epoch??delegator.sessionId]),previous=this.store.setting<Episode>(key);
                                               
      const oldScope=previous?JSON.parse(previous.scope):undefined;
      const sameContext=previous?.scope===scope||Array.isArray(oldScope)&&typeof oldScope[2]==='number'&&oldScope[0]===pair.id&&oldScope[1]===(binding?.epoch??partner.sessionId);
      let episode:Episode=sameContext?{...previous!,scope}:{scope,recipient:delegator.id,pairId:pair.id};
      const save=()=>{if(!previous||previous.scope!==episode.scope||previous.work!==episode.work||previous.noticeId!==episode.noticeId)this.store.setSetting(key,episode);};
      const lastMessage=this.store.lastMessageFacts(pair.id,partner.id);
                                              
      const work=JSON.stringify([partner.activityAt??null,lastMessage?.id??null,this.store.lastMessageFacts(pair.id,delegator.id)?.id??null]);
      if(!sameContext||episode.work!==undefined&&episode.work!==work){
        if(previous?.noticeId)this.notices.cancel(previous.pairId,previous.recipient,previous.noticeId);
        episode={scope,work,recipient:delegator.id,pairId:pair.id};
      }else episode.work=work;
      if(!minutes||pair.paused||pair.archived||partner.state!=='ready'||!partner.sessionId||binding?.transitioning||Date.now()-(partner.stateSince??Date.now())<minutes*60000){
        if(previous?.noticeId)this.notices.cancel(previous.pairId,previous.recipient,previous.noticeId);
        save();return;
      }
      const messages=this.store.expectedReplyFacts(pair.id,partner.id,binding?.activatedAt??pair.createdAt);
      const queued=this.store.hasQueuedMessages(pair.id,partner.id);
      const message=idleUnanswered({pair,partner,delegator,since:partner.stateSince??Date.now(),now:Date.now(),minutes,transitioning:binding?.transitioning??false,queued,questionTowardDelegator:this.store.questions(true).some(q=>q.from===partner.id&&q.to===delegator.id),messages,lastMessage});
      if(!message&&episode.noticeId)this.notices.cancel(episode.pairId,episode.recipient,episode.noticeId);
      if(message&&episode.noticeId)this.notices.updatePending(pair.id,delegator.id,episode.noticeId,message,noticeScope(pair,delegator,partner,recipientBinding?.epoch,binding?.epoch));
      if(message&&!episode.noticeId){
        const issueKey=JSON.stringify([pair.id,partner.sessionId,delegator.sessionId,lastMessage?.id??null,messages.map(value=>value.id).sort()]);
        episode.noticeId=randomUUID();this.notices.enqueue(pair.id,delegator.id,{id:episode.noticeId,message,state:'pending',source:'idle_unanswered',kind:'idle_unanswered:'+partner.id,wake:false,tier:3,affectedMessageIds:messages.slice(0,3).map(value=>value.id),issueKey,factKey:issueKey,scope:noticeScope(pair,delegator,partner,recipientBinding?.epoch,binding?.epoch)});
        this.store.event('health.idle.unanswered',{pairId:pair.id,peerId:partner.id,recipient:delegator.id,noticeId:episode.noticeId,unanswered:messages.map(m=>m.id),since:partner.stateSince});
      }
      save();
    });
  }
}
