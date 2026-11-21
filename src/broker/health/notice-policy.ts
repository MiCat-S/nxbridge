import type {HealthStorage,RuntimeNotice} from './contracts.js';

export const HEALTH_NOTICE_INTERVAL_MS=60000;
export const HEALTH_NOTICE_REPEAT_MS=600000;
export const HEALTH_UNVERIFIED_MS=60000;
export function noticeTier(notice:RuntimeNotice):0|1|2|3|4{
  if(notice.tier!==undefined)return notice.tier;
  if(notice.kind==='explicit_recovery')return 4;
  if(notice.phase==='recovery'||notice.kind==='bridge_restart'||notice.kind==='provider_recovered')return 2;
  if(notice.source==='managed_recovery')return notice.recovery?.wake?4:1;
  if(notice.source==='idle_unanswered')return 3;
  if(notice.source==='pair_anomaly'&&/:(?:hooks_timeout|hooks_missing|contract_inactive|native_denied)$/.test(notice.kind??''))return 1;
  if(notice.source==='claude_auto_mode'||notice.source==='broker_outage')return notice.wake?4:3;
  return 3;
}
interface Admission {lastAt:number;kinds:Record<string,{at:number;severity:number;factKey?:string}>}

                                           
export function noticeCanWake(notice:RuntimeNotice,_recipient:string):boolean{
  if(notice.tier!==undefined)return notice.tier===4;
  if(notice.source==='claude_auto_mode')return notice.wake===true&&notice.kind?.startsWith('claude_auto_mode:')===true&&!!notice.factKey;
  if(notice.source==='broker_outage')return notice.kind==='broker_outage'&&notice.phase!=='recovery'&&notice.wake===true&&!!notice.epoch;
  if(notice.kind==='explicit_recovery')return true;
  return notice.source==='managed_recovery'&&notice.phase!=='recovery'&&notice.recovery?.wake===true;
}

export const noticeSignal=(notice:RuntimeNotice)=>({id:notice.id,source:notice.source,tier:noticeTier(notice),wake:noticeTier(notice)===4,...(notice.source==='broker_outage'?{kind:notice.kind,epoch:notice.epoch,since:notice.since,claimedBy:notice.claimedBy}:{})});

                                     
export class HealthNoticePolicy {
  constructor(private storage:HealthStorage){}
  private key(recipient:string):string{return 'healthNoticeAdmission:'+recipient;}
  private state(recipient:string):Admission|undefined{return this.storage.setting<Admission>(this.key(recipient));}
  canWake(recipient:string,notice:RuntimeNotice):boolean{return noticeCanWake(notice,recipient);}
  sameFact(recipient:string,notice:RuntimeNotice):boolean{return notice.factKey!==undefined&&this.state(recipient)?.kinds[notice.kind??notice.source??'runtime']?.factKey===notice.factKey;}
  eligible(recipient:string,notice:RuntimeNotice,now=Date.now()):boolean{
    if(noticeTier(notice)<3)return false;
    const state=this.state(recipient);
    const last=state?.kinds[notice.kind??notice.source??'runtime'];
    if(notice.factKey!==undefined&&last?.factKey===notice.factKey)return false;
                                          
    if(notice.kind==='explicit_recovery')return true;
    if(state&&now-state.lastAt<HEALTH_NOTICE_INTERVAL_MS)return false;
    if(notice.source==='managed_recovery'&&notice.recovery?.wake===true)return true;
    if(notice.phase==='recovery')return true;
    return !last||now-last.at>=HEALTH_NOTICE_REPEAT_MS||(notice.severity??1)>last.severity;
  }
  admit(recipient:string,notices:RuntimeNotice[],now=Date.now()):void{
    const state=this.state(recipient)??{lastAt:now,kinds:{}};state.lastAt=now;
    for(const notice of notices)if(notice.phase!=='recovery')state.kinds[notice.kind??notice.source??'runtime']={at:now,severity:notice.severity??1,...(notice.factKey!==undefined?{factKey:notice.factKey}:{})};
    this.storage.setSetting(this.key(recipient),state);
  }
}
