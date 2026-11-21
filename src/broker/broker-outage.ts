import {embeddedSource} from "../shared/embedded-source.js";
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { probeProcesses } from '../process/process.js';
import type { Host } from '../types.js';
import type {RuntimeNotice} from './health/contracts.js';

export const BROKER_OUTAGE_DELAY_MS=120000;
export const BROKER_OUTAGE_STABLE_MS=120000;
export const BROKER_OUTAGE_GAP_MS=60000;
export const BROKER_OUTAGE_COOLDOWN_MS=3600000;
export const BROKER_OUTAGE_RESERVATION_MS=60000;
export const BROKER_OUTAGE_ENQUEUED_MS=120000;
const clockSkewMs=5000;
export interface OutageClaimant {host:Host;peerId:string;sessionId:string;pid:number;procStart:string}
interface Claim extends OutageClaimant {state:'reserved'|'enqueued'|'admitted';at:number}
interface Outage {epoch:string;since:number;lastAt:number;closedAt?:number;healthySince?:number;healthyAt?:number;lastWakeAt?:number;claim?:Claim;excluded?:Record<string,number|boolean>;passive?:Record<string,boolean>;recoveryAdmitted?:boolean;recovery?:Record<string,boolean>}
const file=(home:string)=>path.join(home,'run','broker-outage.db');
const same=(a:OutageClaimant|undefined,b:OutageClaimant)=>!!a&&a.host===b.host&&a.peerId===b.peerId&&a.sessionId===b.sessionId&&a.pid===b.pid&&a.procStart===b.procStart;
const scope=(value:OutageClaimant)=>JSON.stringify([value.host,value.peerId,value.sessionId,value.pid,value.procStart]);
const failures=new Map<string,string>();
export function brokerOutageDiagnostic(home:string):string|undefined{return failures.get(home);}

                                         
function transaction<T>(home:string,work:(value:Outage|undefined)=>{value?:Outage;result:T}):T|undefined{
  if(!existsSync(path.join(home,'run')))return;
  let db:DatabaseSync|undefined;
  try{
    const {DatabaseSync:Database}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db=new Database(file(home),{timeout:0});
    db.exec(                          embeddedSource("sql", `CREATE TABLE IF NOT EXISTS outage(slot INTEGER PRIMARY KEY CHECK(slot=1),data TEXT NOT NULL); BEGIN IMMEDIATE`));
    const row=db.prepare(                          embeddedSource("sql", `SELECT data FROM outage WHERE slot=1`)).get();
    const original=row?JSON.parse(String(row.data)) as Outage:undefined;
    if(original?.claim?.state==='admitted'&&original.lastWakeAt===undefined)original.lastWakeAt=original.claim.at;
    const before=row?String(row.data):undefined,{value,result}=work(original);
    const after=value?JSON.stringify(value):undefined;
    if(after&&after!==before){db.prepare(                          embeddedSource("sql", `INSERT OR REPLACE INTO outage VALUES(1,?)`)).run(after);db.exec(                          embeddedSource("sql", `COMMIT`));}
    else db.exec(                          embeddedSource("sql", `ROLLBACK`));
    failures.delete(home);return result;
  }catch(error){
    const code=(error as {errcode?:number;code?:string}).errcode;
    if(code!==undefined&&[5,6].includes(code&255))return;
    const detail='broker outage ledger unavailable; automatic recovery claim unknown: '+String((error as {code?:string}).code??(error as Error).message);
    if(failures.get(home)!==detail){failures.set(home,detail);try{process.stderr.write(detail+'\n');}catch{                 }}
    return;
  }finally{
    try{if(db?.isTransaction)db.exec(                          embeddedSource("sql", `ROLLBACK`));}catch{             }
    try{db?.close();}catch{             }
  }
}
export function brokerOutageState(home:string):Outage|undefined{
  if(!existsSync(file(home)))return;
  return transaction(home,value=>({result:value}));
}
function normalizeClock(value:Outage,now:number):void{
  if(value.lastAt>now+clockSkewMs||value.since>now+clockSkewMs){value.since=now;value.lastAt=now;}
  if(value.lastWakeAt!==undefined&&value.lastWakeAt>now+clockSkewMs)value.lastWakeAt=now;
  if(value.closedAt!==undefined&&value.closedAt>now+clockSkewMs)value.closedAt=now;
  if(value.healthySince!==undefined&&value.healthySince>now+clockSkewMs){delete value.healthySince;delete value.healthyAt;}
  if(value.claim&&value.claim.at>now+60000)value.claim.at=value.claim.state==='admitted'?now:now-(value.claim.state==='reserved'?BROKER_OUTAGE_RESERVATION_MS:BROKER_OUTAGE_ENQUEUED_MS)-1;
  for(const [key,until] of Object.entries(value.excluded??{}))if(typeof until==='number'&&until>now+60000)value.excluded![key]=now+60000;
}
function reachable(value:Outage,now:number,healthy=true):void{
  normalizeClock(value,now);
  if(value.closedAt!==undefined)return;
  if(!healthy){delete value.healthySince;delete value.healthyAt;return;}
  if(value.healthyAt===undefined||now+clockSkewMs<value.healthyAt||now-value.healthyAt>BROKER_OUTAGE_GAP_MS)value.healthySince=now;
  value.healthyAt=now;
  if(now-(value.healthySince??now)>=BROKER_OUTAGE_STABLE_MS)value.closedAt??=now;
}
                                    
export function observeBrokerReachable(home:string,now=Date.now(),healthy=true):void{
  if(!existsSync(file(home)))return;
  transaction(home,value=>{if(value)reachable(value,now,healthy);return{value,result:undefined};});
}
function release(value:Outage,exclude=true):void{if(value.claim){if(exclude)(value.excluded??={})[scope(value.claim)]=value.lastAt+60000;delete value.claim;}}
export function releaseBrokerOutageClaim(home:string,actor:OutageClaimant,id:string,expected?:'reserved'|'enqueued'):void{
  transaction(home,value=>{
    if(!value||id!=='broker-outage:'+value.epoch||!same(value.claim,actor)||value.claim?.state==='admitted'||expected&&value.claim?.state!==expected)return{result:undefined};
    release(value);return{value,result:undefined};
  });
}
export async function brokerOutageNotice(home:string,actor:OutageClaimant,options:{reachable?:boolean;healthy?:boolean;suppressed?:boolean;eligible?:boolean;admit?:boolean;noticeId?:string;now?:number}={},probe=probeProcesses):Promise<RuntimeNotice|undefined>{
  if(options.reachable)return brokerRecoveryNotice(home,actor,options);
  const observed=brokerOutageState(home);
  let dead=false;
  if(!options.suppressed&&observed?.claim&&observed.claim.state!=='admitted'&&!same(observed.claim,actor)){
    try{dead=(await probe([observed.claim]))[0]==='dead';}catch{                }
  }
  return transaction(home,current=>{
                                            
    const now=options.now??Date.now();
    if(current)normalizeClock(current,now);
    const value:Outage=!current||current.closedAt!==undefined?{epoch:randomUUID(),since:now,lastAt:now,...(current?.lastWakeAt===undefined?{}:{lastWakeAt:current.lastWakeAt})}:current;
    if(now+clockSkewMs<value.lastAt||actor.host!=='codex'&&now-value.lastAt>BROKER_OUTAGE_GAP_MS)value.since=now;
    value.lastAt=now;delete value.healthySince;delete value.healthyAt;
    if(options.suppressed){if(!value.claim)value.since=now;return{value,result:undefined};}
    if(now-value.since<BROKER_OUTAGE_DELAY_MS)return{value,result:undefined};
    const id='broker-outage:'+value.epoch;
    if(options.noticeId&&options.noticeId!==id)return{value,result:undefined};
    if(dead&&value.claim?.state!=='admitted'&&JSON.stringify(value.claim)===JSON.stringify(observed?.claim))release(value);
    if(value.claim?.state==='reserved'&&now-value.claim.at>BROKER_OUTAGE_RESERVATION_MS)release(value,false);
    if(value.claim?.state==='enqueued'&&now-value.claim.at>BROKER_OUTAGE_ENQUEUED_MS)release(value,false);
    const cooldown=value.lastWakeAt!==undefined&&now-value.lastWakeAt<BROKER_OUTAGE_COOLDOWN_MS;
    const excluded=value.excluded?.[scope(actor)];if(excluded===true)value.excluded![scope(actor)]=now+60000;
    if(!value.claim&&!cooldown&&options.eligible!==false&&!(excluded===true||typeof excluded==='number'&&excluded>now))value.claim={...actor,state:'reserved',at:now};
    const claimant=same(value.claim,actor),wake=claimant&&value.claim!.state!=='admitted'&&(options.admit!==false||value.claim!.state==='reserved');
    if(claimant&&!wake||!claimant&&value.passive?.[scope(actor)])return{value,result:undefined};
    const message=wake?'nxbridge coordinator unreachable since '+new Date(value.since).toISOString()+'. You own this outage recovery task. Run nxbridge doctor once (diagnosis only); if it confirms the coordinator is offline, run nxbridge bootstrap once (proof-first recovery). Still down or crashing: read the broker log tail, report the cause and exact next step to the user. Do not edit the database, kill processes, replay messages, or retry in a loop.':
      'nxbridge coordinator unreachable since '+new Date(value.since).toISOString()+'. Outage recovery '+(value.claim?'assigned to '+value.claim.host+' session '+value.claim.sessionId:cooldown?'automatic wake cooling down':'awaits an eligible root window')+'. This window has no additional recovery task.';
    const notice:RuntimeNotice={id,epoch:value.epoch,since:value.since,...(value.claim?{claimedBy:value.claim}:{}),incidentId:value.epoch,message,state:'pending',source:'broker_outage',kind:'broker_outage',wake};
    if(options.admit!==false){if(wake){value.claim!.state='admitted';value.lastWakeAt=now;}else (value.passive??={})[scope(actor)]=true;}
    return{value,result:notice};
  });
}
                                        
export function brokerRecoveryNotice(home:string,actor:OutageClaimant,options:{admit?:boolean;noticeId?:string;now?:number;healthy?:boolean}={}):RuntimeNotice|undefined{
  if(!existsSync(file(home)))return;
  const now=options.now??Date.now();
  return transaction(home,current=>{
    if(!current)return{result:undefined};reachable(current,now,options.healthy);
    const id='broker-recovered:'+current.epoch;
    if(current.closedAt===undefined||!current.claim&&!Object.values(current.passive??{}).some(Boolean)||current.recoveryAdmitted||current.recovery?.[scope(actor)]||now-current.closedAt>300000||options.noticeId&&options.noticeId!==id)return{value:current,result:undefined};
    const notice:RuntimeNotice={id,epoch:current.epoch,since:current.since,message:'nxbridge coordinator is stably reachable again; outage '+current.epoch+' closed.',state:'pending',source:'broker_outage',kind:'broker_outage',phase:'recovery',wake:false};
    if(options.admit!==false)(current.recovery??={})[scope(actor)]=true;
    return{value:current,result:notice};
  });
}
                                              
export function claimBrokerOutageEnqueue(home:string,actor:OutageClaimant,id:string,now=Date.now()):boolean{
  return transaction(home,value=>{
    if(!value||value.closedAt!==undefined||id!=='broker-outage:'+value.epoch||!same(value.claim,actor)||value.claim?.state!=='reserved')return{result:false};
    value.claim.state='enqueued';value.claim.at=now;return{value,result:true};
  })===true;
}
export function isBrokerOutageNotice(id:string):boolean{return id.startsWith('broker-outage:');}
