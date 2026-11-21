import {embeddedSource} from "../../shared/embedded-source.js";
import type { DatabaseSync } from 'node:sqlite';

const recoveryPrefixes=['hosting:','managedRuntimeConflict:','managedSessionConflict:','managedRecovery:','managedAdopted:','managedLaunchProof:','legacyTakeoverNeedsUser:','takeover:','codexIdentity:','pairLoss:','sessionHistory:','sessionDeleted:','deletedReplacement:'];

                                             
export function forgetPeerRecovery(db:DatabaseSync,peerId:string,replacement?:string):void{
  const memberPath='$.'+JSON.stringify(peerId);
  db.prepare(                          embeddedSource("sql", `UPDATE settings SET value=json_remove(value,?) WHERE key='windowRecoveryPending' AND json_valid(value) AND json_type(value,?) IS NOT NULL`)).run(memberPath,memberPath);
  db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key=? OR (key LIKE 'managedSessionConflict:%' AND json_valid(value) AND json_extract(value,'$.memberId')=?)`)).run('managedSessionConflict:'+peerId,peerId);
  for(const prefix of recoveryPrefixes)db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key=?`)).run(prefix+peerId);
  db.prepare(                          embeddedSource("sql", `UPDATE settings SET value=json_remove(value,?) WHERE key='processRetirements' AND json_valid(value)`)).run(memberPath);
  const pending=db.prepare(                          embeddedSource("sql", `SELECT key FROM settings WHERE key LIKE 'pendingCodex:%' AND json_valid(value) AND json_extract(value,'$.peerId')=?`)).all(peerId);
  for(const row of pending)if(replacement)db.prepare(                          embeddedSource("sql", `UPDATE settings SET value=json_set(value,'$.peerId',?) WHERE key=?`)).run(replacement,row.key as string);
  else db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key=?`)).run(row.key as string);
                                               
  db.prepare(                          embeddedSource("sql", `UPDATE settings SET value=json_set(value,'$.partner_missing',json('true')) WHERE key LIKE 'pairLoss:%' AND json_valid(value) AND json_extract(value,'$.partner_id')=?`)).run(peerId);
}

                                        
export function repairPeerRecovery(db:DatabaseSync):void{
  const peers=new Set(db.prepare(                          embeddedSource("sql", `SELECT id FROM peers`)).all().map(row=>String(row.id)));
  db.prepare(                          embeddedSource("sql", `DELETE FROM endpoints WHERE NOT EXISTS(SELECT 1 FROM peers WHERE peers.id=endpoints.peer_id)`)).run();
                                        
  const prefixes=[...recoveryPrefixes,'pendingCodex:'];
  const rows=db.prepare("SELECT key,value FROM settings WHERE key IN ('windowRecoveryPending','processRetirements') OR "+prefixes.map(()=> 'key GLOB ?').join(' OR ')).all(...prefixes.map(prefix=>prefix+'*'));
  const remove=(key:string)=>db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key=?`)).run(key);
  for(const row of rows){
    const key=String(row.key),raw=String(row.value),prefix=recoveryPrefixes.find(prefix=>key.startsWith(prefix));
    let value:any;try{value=JSON.parse(raw);}catch{continue;}
    if(value==null)continue;
    if(prefix){
      if(!peers.has(key.slice(prefix.length))||prefix==='managedSessionConflict:'&&!peers.has(value.memberId)){remove(key);continue;}
      if(prefix==='pairLoss:'&&!peers.has(value.partner_id)&&value.partner_missing!==true)db.prepare(                          embeddedSource("sql", `UPDATE settings SET value=json_set(value,'$.partner_missing',json('true')) WHERE key=?`)).run(key);
    }else if(key.startsWith('pendingCodex:')){if(!peers.has(value.peerId))remove(key);}
    else{
      let changed=false;
      for(const id of Object.keys(value))if(!peers.has(id)){delete value[id];changed=true;}
      if(changed)db.prepare(                          embeddedSource("sql", `UPDATE settings SET value=? WHERE key=?`)).run(JSON.stringify(value),key);
    }
  }
}
