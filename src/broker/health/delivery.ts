import {randomUUID} from 'node:crypto';
import {type Pair,type Peer} from '../../types.js';
import {HealthNoticePolicy,noticeCanWake,noticeTier} from './notice-policy.js';
import {type RuntimeAvailability,type DeliveryCounts,unsettledCount,type RuntimeNotice,type HealthStorage,deliveryHealthKey} from './contracts.js';
interface DeliveryIncident {id:string;active:boolean;reasons:string[];notices:RuntimeNotice[];checkedAt:number;scope?:string;revision?:number;alertAdmitted?:boolean;restartSignature?:string;since?:number;dependencySince?:number;unverified?:{since:number;lastAt:number;count:number}}
const countsText=(c:DeliveryCounts)=>((Object.entries({unsent:c.accepted,sending:c.sending,'queued-unread':c.runtimeQueued,held:c.held,unknown:c.unknown}).filter(([,count])=>count).map(([label,count])=>`${label}=${count}`).join(', '))||'none');
const waitingIdle=(notice:RuntimeNotice)=>notice.source==='idle_unanswered'&&!notice.admitted&&notice.state==='denied'&&notice.error==='condition resolved before delivery';

                                                             
export class DeliveryHealth {
  private policy:HealthNoticePolicy;
  constructor(private storage:HealthStorage){this.policy=new HealthNoticePolicy(storage);}
  enqueue(pairId:string,recipientId:string,notice:RuntimeNotice):void{
    this.storage.transaction(()=>{
      if(this.policy.sameFact(recipientId,notice))return;
      const key=deliveryHealthKey(pairId,recipientId),value=this.storage.setting<DeliveryIncident>(key)??{id:randomUUID(),active:false,reasons:[],notices:[],checkedAt:Date.now()};
      const existing=value.notices.find(n=>n.id===notice.id);
      if(existing){if(notice.source==='managed_recovery'&&!existing.admitted&&(existing.state==='pending'||existing.state==='sending')){Object.assign(existing,notice);this.storage.setSetting(key,value);}return;}
      value.notices=value.notices.filter(n=>n.state==='pending'||n.state==='sending'||waitingIdle(n)&&n.kind!==notice.kind);value.notices.push(notice);this.storage.setSetting(key,value);
    });
  }
  cancel(pairId:string,recipientId:string,id:string):void{
    this.storage.transaction(()=>{const key=deliveryHealthKey(pairId,recipientId),value=this.storage.setting<DeliveryIncident>(key),notice=value?.notices.find(n=>n.id===id&&!n.admitted&&(n.state==='pending'||n.state==='sending'));if(notice){notice.state='denied';notice.error='condition resolved before delivery';this.storage.setSetting(key,value);}});
  }
  updatePending(pairId:string,recipientId:string,id:string,message:string,scope?:string,factKey?:string,fields?:Partial<RuntimeNotice>):void{
    this.storage.transaction(()=>{
      const key=deliveryHealthKey(pairId,recipientId),value=this.storage.setting<DeliveryIncident>(key),notice=value?.notices.find(n=>n.id===id&&!n.admitted&&(n.state==='pending'||n.state==='sending'||waitingIdle(n)));
      if(notice){
                                                
        if(notice.state==='denied'){notice.state='pending';delete notice.error;delete notice.claimedAt;}
        notice.message=message;notice.scope=scope;if(factKey!==undefined)notice.factKey=factKey;if(fields)Object.assign(notice,fields);notice.revision=(notice.revision??0)+1;this.storage.setSetting(key,value);
      }
    });
  }
  succeeded(pairId:string,senderId:string,now=Date.now()):void{
    this.storage.transaction(()=>{
      const key=deliveryHealthKey(pairId,senderId),value=this.storage.setting<DeliveryIncident>(key);if(!value)return;
      for(const notice of value.notices)if(notice.kind==='runtime'&&!notice.admitted){notice.state='denied';notice.error='condition resolved before delivery';}
      if(value.active)this.storage.event('health.delivery.recovered',{pairId,senderId,incidentId:value.id,functionalSuccessAt:now});
      value.active=false;value.checkedAt=now;delete value.dependencySince;this.storage.setSetting(key,value);
    });
  }
  observe(pair:Pair,sender:Peer,partner:Peer,counts:DeliveryCounts,availability:RuntimeAvailability,monitor=false,scope?:string,awaitingReply=false):void{
    this.storage.transaction(()=>{
      const key=deliveryHealthKey(pair.id,sender.id),previous=this.storage.setting<DeliveryIncident>(key),now=availability.checked_at;
      if(previous&&(!scope||previous.scope===scope)&&now<previous.checkedAt)return;
      const managed=this.storage.setting<{pairId:string;state:string}>('managedRecovery:'+partner.id);
      if(managed?.pairId===pair.id&&managed.state!=='closed'){
        if(previous){previous.active=false;previous.checkedAt=now;for(const notice of previous.notices)if(notice.kind==='runtime'&&!notice.admitted)notice.state='denied';this.storage.setSetting(key,previous);}return;
      }
      let incident:DeliveryIncident=previous??{id:availability.incident?.id??randomUUID(),active:false,reasons:[],notices:[],checkedAt:now};
      if(previous?.scope&&scope&&previous.scope!==scope){
        const before=JSON.parse(previous.scope),after=JSON.parse(scope),sameConversation=[0,1,2,4,5].every(index=>before[index]===after[index]);
        if(!sameConversation){for(const notice of previous.notices)if(!notice.admitted)notice.state='denied';incident={id:availability.incident?.id??randomUUID(),active:false,reasons:[],notices:previous.notices,checkedAt:now};}
      }
      if(availability.state==='starting')return;
      const dependencySince=this.storage.deliveryDependencySince?.(pair.id,partner.id),unsettled=unsettledCount(counts)>0,dependent=unsettled||awaitingReply||dependencySince!==undefined;
                                           
      if(dependent)incident.dependencySince=dependencySince??(this.storage.deliveryDependencySince?now:incident.dependencySince??now);
      else delete incident.dependencySince;
      let bad=availability.state!=='reachable';
      const functional=availability.functionalSuccessAt;
      if(!bad&&incident.active&&unsettled&&(!functional||functional<(incident.since??0)||now-functional<30000))bad=true;
      if(availability.incident?.state==='recovering'){
        for(const notice of incident.notices)if(notice.kind==='runtime'&&!notice.admitted)notice.state='denied';
        incident.checkedAt=now;this.storage.setSetting(key,incident);return;
      }
      if(!bad){
        for(const notice of incident.notices)if(notice.kind==='runtime'&&!notice.admitted)notice.state='denied';
        if(incident.active)this.storage.event('health.delivery.recovered',{pairId:pair.id,senderId:sender.id,incidentId:incident.id,functionalSuccessAt:functional});
        incident.active=false;incident.checkedAt=now;incident.scope=scope??incident.scope;this.storage.setSetting(key,incident);return;
      }
      if(!dependent&&!incident.active&&!monitor)return;
      if(!incident.active){incident.id=availability.incident?.id??randomUUID();incident.since=availability.incident?.since??now;incident.alertAdmitted=false;}
      incident.active=true;incident.scope=scope??incident.scope;incident.checkedAt=now;incident.since??=now;incident.reasons=availability.reasons;
                                             
      if(!dependent){
        for(const notice of incident.notices)if(notice.kind==='runtime'&&!notice.admitted){notice.state='denied';notice.error='condition resolved before delivery';}
        this.storage.setSetting(key,incident);return;
      }
      const cause=availability.incident,hard=cause!==undefined&&!['transient','unknown'].includes(cause.causeClass),age=Math.max(0,Math.min(now-incident.since,now-(incident.dependencySince??now))),tier=dependent&&(hard||age>=300000)?3:1;
      const reason=cause?.code??(availability.state==='reachable'?'awaiting context receipt':availability.reasons[0]??'runtime availability unverified');
      const message=`Partner delivery remains unconfirmed for ${Math.floor(age/60000)}min (${reason}); pending: ${unsettled?countsText(counts):'awaiting partner reply'}. Continue independent work; inspect the held dependency if it still blocks you.`;
      const alert=incident.notices.findLast(notice=>notice.incidentId===incident.id&&notice.kind==='runtime');
      if(alert&&!alert.admitted){Object.assign(alert,{message,tier,scope,since:incident.since,layer:cause?.layer??'delivery',causeClass:cause?.causeClass??'unknown',action:cause?.action});if(alert.state==='denied'&&alert.error==='condition resolved before delivery'){alert.state='pending';delete alert.error;}}
      else if(!alert){
        incident.notices.push({id:randomUUID(),message,state:'pending',incidentId:incident.id,phase:'alert',kind:'runtime',tier,wake:false,since:incident.since,factKey:incident.id,layer:cause?.layer??'delivery',causeClass:cause?.causeClass??'unknown',action:cause?.action,...(scope?{scope}:{})});
        this.storage.event('health.delivery.alert',{pairId:pair.id,senderId:sender.id,incidentId:incident.id,code:cause?.code,counts});
      }
      this.storage.setSetting(key,incident);
    });
  }
  restarted(pair:Pair,sender:Peer,counts:DeliveryCounts,messages:{id:string;state:string}[],recoveredSending:number):void{
    if(!unsettledCount(counts))return;
    this.storage.transaction(()=>{
      const key=deliveryHealthKey(pair.id,sender.id),value=this.storage.setting<DeliveryIncident>(key)??{id:randomUUID(),active:false,reasons:[],notices:[],checkedAt:Date.now()};
                                                
      const signature=JSON.stringify(messages.map(({id,state})=>[id,state]).sort((a,b)=>a[0]!.localeCompare(b[0]!)));
      if(value.restartSignature===signature)return;
      value.restartSignature=signature;const id=randomUUID();
      value.notices=value.notices.filter(n=>n.kind!=='bridge_restart'&&(n.state==='pending'||n.state==='sending'||waitingIdle(n)));
      value.notices.push({id,state:'pending',kind:'bridge_restart',message:`nxbridge runtime monitor (not partner reply or user msg): bridge restarted; undelivered msgs rechecked. pending: ${countsText(counts)}${recoveredSending?'; '+recoveredSending+' interrupted sends now unknown':''}. only safely unsent msgs retry; unknown msgs never auto-replayed; nothing resent`});
      this.storage.setSetting(key,value);this.storage.event('health.delivery.restart',{pairId:pair.id,senderId:sender.id,noticeId:id,counts,recoveredSending});
    });
  }
  private pending(value:DeliveryIncident|undefined,senderId:string,onlyRuntime:boolean):RuntimeNotice[]{
    return value?.notices.filter(n=>!n.admitted&&(!onlyRuntime||!n.source)&&(n.state==='pending'||n.state==='sending'&&Date.now()-(n.claimedAt??0)>=60000)&&this.policy.eligible(senderId,n))??[];
  }
  private groups(notices:RuntimeNotice[],recipient:string):RuntimeNotice[]{
                                         
    return[notices.filter(n=>!n.readyOnly),notices.filter(n=>n.readyOnly)].filter(group=>group.length).map(group=>this.combined(group,recipient));
  }
                                          
  peek(pairId:string,senderId:string,onlyRuntime=false):RuntimeNotice[]{
    const pending=this.pending(this.storage.setting<DeliveryIncident>(deliveryHealthKey(pairId,senderId)),senderId,onlyRuntime);
    return this.groups(pending,senderId);
  }
  take(pairId:string,senderId:string,onlyRuntime=false):RuntimeNotice[]{
    return this.storage.transaction(()=>{
      const key=deliveryHealthKey(pairId,senderId),value=this.storage.setting<DeliveryIncident>(key);if(!value)return[];
      const pending=this.pending(value,senderId,onlyRuntime);
      for(const notice of value.notices)if(pending.some(n=>n.id===notice.id)){notice.state='sending';notice.claimedAt=Date.now();}
      if(pending.length)this.storage.setSetting(key,value);return this.groups(pending,senderId);
    });
  }
  get(pairId:string,senderId:string,id:string):RuntimeNotice|undefined{const notice=this.storage.setting<DeliveryIncident>(deliveryHealthKey(pairId,senderId))?.notices.find(n=>n.id===id&&(n.state==='pending'||n.state==='sending')&&!n.admitted);return notice?{...notice,tier:noticeTier(notice),wake:this.policy.canWake(senderId,notice)}:undefined;}
  recordedCanWake(pairId:string,recipient:string,id:string):boolean{return this.storage.setting<DeliveryIncident>(deliveryHealthKey(pairId,recipient))?.notices.some(n=>(n.id===id||n.batchId===id)&&(n.admitted?noticeCanWake(n,recipient):this.policy.canWake(recipient,n)))===true;}
  eligible(pairId:string,recipient:string,id:string):boolean{const notice=this.get(pairId,recipient,id);return !!notice&&this.policy.eligible(recipient,notice);}
  private combined(notices:RuntimeNotice[],recipient:string):RuntimeNotice{return{...notices[0]!,tier:Math.max(...notices.map(noticeTier)) as 3|4,wake:notices.some(n=>this.policy.canWake(recipient,n)),...(notices.some(n=>n.readyOnly)?{readyOnly:true}:{}),message:notices.map(n=>n.message).join('\n'),componentIds:notices.map(n=>n.id)};}
  due(pairId:string,senderId:string):boolean{return this.pending(this.storage.setting<DeliveryIncident>(deliveryHealthKey(pairId,senderId)),senderId,false).length>0;}
  prepare(pairId:string,senderId:string,id:string,scope?:string,onlyRuntime=false,requireWake=false,readyBoundary=false):RuntimeNotice|undefined{
    return this.storage.transaction(()=>{
      const key=deliveryHealthKey(pairId,senderId),value=this.storage.setting<DeliveryIncident>(key),notice=value?.notices.find(n=>n.id===id&&!n.admitted&&(n.state==='pending'||n.state==='sending'));
      if(!value||!notice||notice.readyOnly&&!readyBoundary)return;
      const valid=(n:RuntimeNotice)=>!(n.scope&&scope!==n.scope||n.source!=='managed_recovery'&&n.incidentId&&(n.incidentId!==value.id||n.phase==='alert'&&!value.active||n.phase==='recovery'&&value.active));
      for(const n of value.notices)if(!n.admitted&&(n.state==='pending'||n.state==='sending')&&!valid(n))n.state='denied';
      if(!valid(notice)||!this.policy.eligible(senderId,notice)||onlyRuntime&&notice.source){this.storage.setSetting(key,value);return;}
      const pending=value.notices.filter(n=>!n.admitted&&(n.state==='pending'||n.state==='sending')&&(!onlyRuntime||!n.source)&&(!n.readyOnly||readyBoundary)&&valid(n)&&this.policy.eligible(senderId,n));
      if(requireWake&&!pending.some(n=>this.policy.canWake(senderId,n))){this.storage.setSetting(key,value);return;}
      const combined=this.combined([notice,...pending.filter(n=>n.id!==id)],senderId);
                                               
      for(const n of pending){n.admitted=true;n.state='unknown';n.batchId=id;if(!n.source&&n.phase==='alert')value.alertAdmitted=true;
        if(n.source==='managed_recovery'&&n.recovery){const incident=this.storage.setting<import('../recovery/managed-recovery.js').ManagedIncident>('managedRecovery:'+n.kind?.slice('managed_recovery:'.length));if(incident&&incident.id===n.incidentId){incident.noticeAdmitted=true;if(n.recovery.wake)incident.wakeAdmitted=true;this.storage.setSetting('managedRecovery:'+incident.peerId,incident);}}
      }
      this.policy.admit(senderId,pending);
      this.storage.setSetting(key,value);return combined;
    });
  }
  outcome(pairId:string,senderId:string,id:string,state:RuntimeNotice['state'],error?:string):void{
    this.storage.transaction(()=>{
      const key=deliveryHealthKey(pairId,senderId),value=this.storage.setting<DeliveryIncident>(key),notice=value?.notices.find(n=>n.id===id);if(!notice)return;
      if(notice.state==='denied'&&!notice.admitted)return;
      const batch=notice.batchId?value!.notices.filter(n=>n.batchId===notice.batchId):[notice];
      for(const n of batch){
        if(state==='pending'||state==='denied'){n.admitted=false;if(!n.source&&n.phase==='alert')value!.alertAdmitted=false;delete n.batchId;}
        if(state==='submitted'){n.admitted=true;if(!n.source&&n.phase==='alert')value!.alertAdmitted=true;}
        n.state=state;if(error)n.error=error;
      }
      this.storage.setSetting(key,value);
      this.storage.event('health.notice',{noticeId:id,peerId:senderId,state,...(error?{error}:{})});
    });
  }
  active(pairId:string,senderId:string):boolean{return this.storage.setting<DeliveryIncident>(deliveryHealthKey(pairId,senderId))?.active===true;}
  notes(pairId:string,recipient:string):{text:string}[]{return(this.storage.setting<DeliveryIncident>(deliveryHealthKey(pairId,recipient))?.notices??[]).filter(notice=>noticeTier(notice)===2&&notice.state!=='denied').slice(-3).map(notice=>({text:notice.message}));}
  hasPending(pairId:string,senderId:string):boolean{return this.storage.setting<DeliveryIncident>(deliveryHealthKey(pairId,senderId))?.notices.some(n=>n.state==='pending'||n.state==='sending')===true;}
}
