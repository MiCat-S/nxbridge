import {embeddedSource} from "../../shared/embedded-source.js";
import path from 'node:path';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {DatabaseSync} from 'node:sqlite';
import {BridgeError} from '../../shared/errors.js';
import {type Actor,type Endpoint,type Host,type Pair,type Peer} from '../../types.js';
import {assertClaudeSession} from '../../hosts/claude/claude-session.js';
import {pairLossKey,type PairLoss} from '../pairing/pair-loss.js';
import {pairChangeKey,type PairChange} from '../pairing/pair-changes.js';
import {storageError} from '../../storage/storage-errors.js';
import {expectedReplyRows,deliveryIssueRows} from '../delivery/delivery-facts.js';
import {type DeliveryCounts,emptyDeliveryCounts,type HealthStorage,noticeScope} from './contracts.js';
import {DeliveryHealth} from './delivery.js';
export interface HealthSnapshot {pair:Pair;sender:Peer;partner:Peer;senderEndpoint?:Endpoint;endpoint?:Endpoint;scope:string;binding?:Actor['binding'];loss?:PairLoss;change?:PairChange}
interface HealthDeliverySnapshot extends HealthSnapshot {counts:DeliveryCounts;dependencySince?:number}
function assertSnapshotSession(value:HealthSnapshot):void{
  if(value.sender.host!=='claude')return;
  const endpoint=value.senderEndpoint,native=endpoint?.native??endpoint;
  if(!native?.pid||!native.procStart)throw new BridgeError('session_changed','Claude 原生窗口身份无法核验，未消费通知。');
  assertClaudeSession(endpoint!.configHome,value.sender.sessionId!,{pid:native.pid,procStart:native.procStart});
}
function snapshot(db:DatabaseSync,host:Host,sessionId:string,contextKey?:string,native?:{pid:number;procStart:string}):HealthSnapshot|undefined{
  const rows=db.prepare(                          embeddedSource("sql", `SELECT data FROM peers WHERE host=? AND session_id=?`)).all(host,sessionId).filter(row=>{
    if(!native)return true;
    const peer=JSON.parse(row.data as string) as Peer;
    return db.prepare(                          embeddedSource("sql", `SELECT data FROM endpoints WHERE peer_id=?`)).all(peer.id).some(r=>{const e=JSON.parse(r.data as string) as Endpoint,p=e.native??e;return p.pid===native.pid&&p.procStart===native.procStart;});
  });
  if(rows.length!==1)return;
  const sender=JSON.parse(rows[0]!.data as string) as Peer;
  let pairRow=db.prepare(                          embeddedSource("sql", `SELECT * FROM pairs WHERE archived=0 AND (claude=? OR codex=?)`)).get(sender.id,sender.id),loss:PairLoss|undefined;
  const changeRow=db.prepare(                          embeddedSource("sql", `SELECT value FROM settings WHERE key=?`)).get(pairChangeKey(sender.id)),change=changeRow?JSON.parse(changeRow.value as string) as PairChange|null:undefined;
  if(!pairRow){
    const record=db.prepare(                          embeddedSource("sql", `SELECT value FROM settings WHERE key=?`)).get(pairLossKey(sender.id));loss=record?JSON.parse(record.value as string)??undefined:undefined;
    const previous=loss?.session_id===sender.sessionId?loss:change?.session_id===sender.sessionId?change:undefined;if(!previous)return;
    pairRow=db.prepare(                          embeddedSource("sql", `SELECT * FROM pairs WHERE id=? AND archived=1 AND (claude=? OR codex=?)`)).get(previous.pair_id,sender.id,sender.id);
  }
  if(!pairRow||pairRow.paused&&!pairRow.archived||!['root','fork'].includes(sender.kind))return;
  if(contextKey){const key=db.prepare(                          embeddedSource("sql", `SELECT value FROM settings WHERE key=?`)).get('hookContext:'+contextKey);if(!key||JSON.parse(key.value as string)!==sessionId)return;}
  const partnerRow=db.prepare(                          embeddedSource("sql", `SELECT data FROM peers WHERE id=?`)).get(pairRow[host==='codex'?'claude':'codex'] as string);if(!partnerRow)return;
  const partner=JSON.parse(partnerRow.data as string) as Peer;
  const route=(id:string)=>{
    const endpoints=db.prepare(                          embeddedSource("sql", `SELECT data FROM endpoints WHERE peer_id=? ORDER BY rowid`)).all(id).map(r=>JSON.parse(r.data as string) as Endpoint);
    const active=endpoints.filter(e=>e.active);
    const foreground=!!db.prepare(                          embeddedSource("sql", `SELECT 1 FROM window_bindings WHERE peer_id=? AND active=1`)).get(id);
    const direct=active.filter(e=>foreground?e.mode!=='app-server':e.mode!=='embedded'),selected=direct.length?direct:foreground?[]:active;
    if(selected.length>1)return undefined;
    return selected[0]??endpoints.at(-1);
  };
  const pair={id:pairRow.id as string,claude:pairRow.claude as string,codex:pairRow.codex as string,paused:false,archived:!!pairRow.archived,createdAt:Number(pairRow.created_at)},bindingFor=(id:string)=>{const row=db.prepare(                          embeddedSource("sql", `SELECT data FROM window_bindings WHERE peer_id=? AND active=1`)).get(id);return row?JSON.parse(row.data as string):undefined;},binding=bindingFor(sender.id);
  if(loss&&(loss.binding?.key!==binding?.key||loss.binding?.epoch!==binding?.epoch||partner.id!==loss.partner_id))return;
  const validChange=change?.session_id===sender.sessionId&&change.binding?.key===binding?.key&&change.binding?.epoch===binding?.epoch?change:undefined;
  return{pair,sender,partner,senderEndpoint:route(sender.id),endpoint:route(partner.id),scope:noticeScope(pair,sender,partner,binding?.epoch,bindingFor(partner.id)?.epoch),...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{}),...(loss?{loss}:{}),...(validChange?{change:validChange}:{})};
}
                                  
function deliverySnapshot(db:DatabaseSync,value:HealthSnapshot):HealthDeliverySnapshot{
  const counts=emptyDeliveryCounts();
  for(const r of db.prepare(                          embeddedSource("sql", `SELECT state,count(*) AS count FROM messages WHERE pair_id=? AND sender=? GROUP BY state`)).all(value.pair.id,value.sender.id))if(Object.hasOwn(counts,r.state as string))counts[r.state as keyof DeliveryCounts]=Number(r.count);
  const dependencyTimes=[...deliveryIssueRows(db,value.pair.id,value.partner.id).filter(row=>['accepted','sending','runtimeQueued','held','unknown'].includes(row.state as string)).map(row=>Number(row.created_at)),...expectedReplyRows(db,value.pair.id,value.partner.id).map(row=>Number(row.updated_at))];
  return{...value,counts,...(dependencyTimes.length?{dependencySince:Math.min(...dependencyTimes)}:{})};
}
function openHealthDatabase(home:string,readOnly:boolean,busyTimeoutMs=3000):DatabaseSync|undefined{
  const filename=path.join(home,'nxbridge.db');if(!existsSync(filename))return;
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db=new DatabaseSync(filename,{readOnly});
  try{db.exec('PRAGMA busy_timeout='+Math.max(0,Math.floor(readOnly?Math.min(300,busyTimeoutMs):busyTimeoutMs)));return db;}
  catch(error){db.close();throw storageError(error,'health.open');}
}
export function readHealthSnapshot(home:string,host:Host,sessionId:string,contextKey?:string,native?:{pid:number;procStart:string},busyTimeoutMs=300):HealthSnapshot|undefined{
  const db=openHealthDatabase(home,true,busyTimeoutMs);if(!db)return;
  try{db.exec(                          embeddedSource("sql", `BEGIN`));const value=snapshot(db,host,sessionId,contextKey,native);db.exec(                          embeddedSource("sql", `COMMIT`));return value;}catch(error){throw storageError(error,'health.read');}finally{if(db.isTransaction)db.exec(                          embeddedSource("sql", `ROLLBACK`));db.close();}
}
                                                      
export function updateHealthSnapshot<T>(home:string,host:Host,sessionId:string,contextKey:string|undefined,work:(health:DeliveryHealth,value:HealthDeliverySnapshot,storage:HealthStorage)=>T,native?:{pid:number;procStart:string},busyTimeoutMs=3000):T|undefined{
  const db=openHealthDatabase(home,false,busyTimeoutMs);if(!db)return;
  try{
    db.exec(                          embeddedSource("sql", `BEGIN IMMEDIATE`));const current=snapshot(db,host,sessionId,contextKey,native);if(!current)return;assertSnapshotSession(current);const value=deliverySnapshot(db,current);
    const storage:HealthStorage={transaction:fn=>fn(),deliveryDependencySince:(pairId,recipient)=>pairId===value.pair.id&&recipient===value.partner.id?value.dependencySince:undefined,setting:<V>(key:string)=>{const r=db.prepare(                          embeddedSource("sql", `SELECT value FROM settings WHERE key=?`)).get(key);return r?JSON.parse(r.value as string) as V:undefined;},setSetting:(key,value)=>{db.prepare(                          embeddedSource("sql", `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)).run(key,JSON.stringify(value),Date.now());},event:(type,data)=>{db.prepare(                          embeddedSource("sql", `INSERT INTO events(created_at,type,data) VALUES(?,?,?)`)).run(Date.now(),type,JSON.stringify(data));}};
    const result=work(new DeliveryHealth(storage),value,storage);db.exec(                          embeddedSource("sql", `COMMIT`));return result;
  }catch(error){throw storageError(error,'health.update');}finally{if(db.isTransaction)db.exec(                          embeddedSource("sql", `ROLLBACK`));db.close();}
}

export function acknowledgeContextSnapshot(home:string,host:Host,sessionId:string,native:{pid:number;procStart:string},id:string,contextKey?:string,busyTimeoutMs=3000):void{
  const db=openHealthDatabase(home,false,busyTimeoutMs);if(!db)return;
  try{
    db.exec(                          embeddedSource("sql", `BEGIN IMMEDIATE`));const value=snapshot(db,host,sessionId,contextKey,native);
    const recorded=value?.senderEndpoint?.native??value?.senderEndpoint;
    if(value&&recorded?.pid===native.pid&&recorded.procStart===native.procStart){assertSnapshotSession(value);db.prepare(                          embeddedSource("sql", `UPDATE context_notices SET acknowledged=1 WHERE id=? AND recipient=? AND pair_id=?`)).run(id,value.sender.id,value.pair.id);}
    db.exec(                          embeddedSource("sql", `COMMIT`));
  }catch(error){throw storageError(error,'health.ack');}finally{if(db.isTransaction)db.exec(                          embeddedSource("sql", `ROLLBACK`));db.close();}
}
