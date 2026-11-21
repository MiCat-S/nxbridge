import {embeddedSource} from "../shared/embedded-source.js";
import type { DatabaseSync } from 'node:sqlite';
import type { Endpoint, Peer, RetentionConfig } from '../types.js';
import { liveProcess } from '../process/process.js';
import { statement } from './sql-statements.js';
import { forgetPeerRecovery } from '../broker/recovery/peer-recovery-state.js';

                                                
const terminal="('runtimeQueued','contextObserved','responded','refused','expired')";

export function pruneHistory(db:DatabaseSync,policy:RetentionConfig,now:number,peers:Peer[],endpoints:Endpoint[]):void{
  const cutoff=now-policy.historyMaxAgeMs;
  db.prepare(                          embeddedSource("sql", `DELETE FROM questions WHERE status NOT IN ('pending','awaiting_user') AND
    (expires_at<? OR id NOT IN (SELECT id FROM questions WHERE status NOT IN ('pending','awaiting_user') ORDER BY expires_at DESC,rowid DESC LIMIT ?))`)).run(cutoff,policy.maxQuestions);

                                     
  db.exec(                          embeddedSource("sql", `CREATE TEMP TABLE IF NOT EXISTS protected_messages(id TEXT PRIMARY KEY); DELETE FROM protected_messages;
    CREATE TEMP TABLE IF NOT EXISTS retained_messages(id TEXT PRIMARY KEY); DELETE FROM retained_messages`));
  db.prepare(                          embeddedSource("sql", `WITH RECURSIVE protected(id) AS (
    SELECT id FROM messages WHERE state NOT IN ${terminal}
    UNION SELECT id FROM messages WHERE sender IN (SELECT id FROM peers WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.enabled')=0 END) OR recipient IN (SELECT id FROM peers WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.enabled')=0 END)
    UNION SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.messageId') END FROM questions
    UNION SELECT m.in_reply_to FROM messages m JOIN protected p ON m.id=p.id WHERE m.in_reply_to IS NOT NULL
  ) INSERT INTO protected_messages SELECT id FROM protected WHERE id IS NOT NULL`)).run();
  db.prepare(                          embeddedSource("sql", `INSERT INTO retained_messages SELECT id FROM protected_messages
    UNION SELECT id FROM (SELECT id,updated_at FROM messages WHERE state IN ${terminal} ORDER BY updated_at DESC,rowid DESC LIMIT ?) WHERE updated_at>=?`)).run(policy.maxMessages,cutoff);
                                         
  db.exec(                          embeddedSource("sql", `UPDATE messages SET original_reply_to=COALESCE(original_reply_to,in_reply_to),in_reply_to=NULL
    WHERE id IN (SELECT id FROM retained_messages) AND in_reply_to IS NOT NULL AND in_reply_to NOT IN (SELECT id FROM retained_messages);
    DELETE FROM messages WHERE id NOT IN (SELECT id FROM retained_messages)`));

  const protectedRefs=new Set(db.prepare(                          embeddedSource("sql", `SELECT 'ref:message:'||id AS key FROM protected_messages
    UNION SELECT s.key FROM settings s,json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '{}' END,'$.messages') j JOIN messages m ON m.id=json_extract(j.value,'$.message_id')
      WHERE s.key LIKE 'receive:%' AND m.id IN (SELECT id FROM protected_messages)`)).all().map(r=>r.key as string));
  const refs=db.prepare(                          embeddedSource("sql", `SELECT key,updated_at,length(CAST(value AS BLOB)) AS bytes FROM settings WHERE key LIKE 'ref:%' OR key LIKE 'receive:%' ORDER BY updated_at DESC,rowid DESC`)).all();
  let count=0,bytes=0;
  for(const r of refs)if(protectedRefs.has(r.key as string)){count++;bytes+=Number(r.bytes);}
  const remove=db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key=?`));
  for(const r of refs){
    const key=r.key as string;if(protectedRefs.has(key))continue;
    const orphan=key.startsWith('ref:message:')&&!statement(db,'SELECT 1 FROM messages WHERE id=?').get(key.slice('ref:message:'.length));
    if(orphan||Number(r.updated_at)<now-policy.referenceMaxAgeMs||count>=policy.maxReferences||bytes+Number(r.bytes)>policy.maxReferenceBytes)remove.run(key);
    else{count++;bytes+=Number(r.bytes);}
  }
  db.prepare(                          embeddedSource("sql", `DELETE FROM pairs WHERE archived=1 AND NOT EXISTS (SELECT 1 FROM messages WHERE pair_id=pairs.id)
    AND NOT EXISTS (SELECT 1 FROM questions WHERE pair_id=pairs.id)
    AND (COALESCE(archived_at,created_at)<? OR id NOT IN (SELECT id FROM pairs WHERE archived=1 ORDER BY COALESCE(archived_at,created_at) DESC,rowid DESC LIMIT ?))`)).run(cutoff,policy.maxArchivedPairs);

  const idleCutoff=now-policy.peerMaxIdleMs;
  const referenced=new Set(db.prepare(                          embeddedSource("sql", `SELECT claude AS id FROM pairs UNION SELECT codex FROM pairs
    UNION SELECT sender FROM messages UNION SELECT recipient FROM messages
    UNION SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.from') END FROM questions UNION SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.to') END FROM questions`)).all().map(r=>r.id as string));
  const retirements=db.prepare(                          embeddedSource("sql", `SELECT value FROM settings WHERE key='processRetirements'`)).get();
  if(retirements)for(const id of Object.keys(JSON.parse(String(retirements.value))))referenced.add(id);
  const dead=new Set(peers.filter(p=>p.enabled!==false&&p.updatedAt<idleCutoff&&!referenced.has(p.id)&&
    !endpoints.some(e=>e.peerId===p.id&&e.active&&(e.pid?liveProcess(e.pid):p.state!=='offline'))).map(p=>p.id));
                
  for(const peer of peers)if(!dead.has(peer.id)){
    let parent=peer.parentId;const seen=new Set<string>();
    while(parent&&!seen.has(parent)){seen.add(parent);const root=peers.find(p=>p.id===parent||p.sessionId===parent);if(!root)break;dead.delete(root.id);parent=root.parentId;}
  }
  for(const peer of peers)if(dead.has(peer.id)){
    forgetPeerRecovery(db,peer.id);
    statement(db,'DELETE FROM endpoints WHERE peer_id=?').run(peer.id);
    statement(db,'DELETE FROM peers WHERE id=?').run(peer.id);
    statement(db,"DELETE FROM settings WHERE key LIKE ? OR key LIKE ?").run('ref:agent:'+peer.id+':%','receive:'+peer.id+':%');
    statement(db,'DELETE FROM settings WHERE key IN (?,?,?,?,?,?,?)').run('communicationTips:'+peer.id,'communicationTurn:'+peer.id,'syncTip:'+peer.id,'idleNotice:'+peer.id,'integration:'+peer.id,'pairIssues:'+peer.id,'replyContract:'+peer.id);
    statement(db,'DELETE FROM settings WHERE key=?').run('cooperation:'+peer.id);
    statement(db,'DELETE FROM settings WHERE key IN (?,?,?)').run('cooperationUnpaired:'+peer.id,'codexTranscript:'+peer.id,'codexRecoveryFence:'+peer.id);
    statement(db,'DELETE FROM settings WHERE key IN (?,?)').run('checkpoint:'+peer.id,'recoveryRevision:'+peer.id);
    statement(db,'DELETE FROM settings WHERE key=?').run('codexWake:'+peer.id);
  }
  for(const ep of endpoints){
    if(dead.has(ep.peerId)||ep.seenAt>=idleCutoff)continue;
    const last=endpoints.filter(e=>e.peerId===ep.peerId).at(-1);
    if(ep!==last&&(!ep.active||(ep.pid&&!liveProcess(ep.pid))))statement(db,'DELETE FROM endpoints WHERE peer_id=? AND epoch=?').run(ep.peerId,ep.epoch);
  }
  db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key LIKE 'hookContext:%' AND updated_at<?
    AND NOT EXISTS (SELECT 1 FROM peers WHERE session_id=json_extract(settings.value,'$'))`)).run(idleCutoff);
  const foregroundEnds=new Set(endpoints.filter(ep=>ep.active&&!dead.has(ep.peerId)).flatMap(ep=>{const peer=peers.find(p=>p.id===ep.peerId);return peer?.sessionId?['codexForegroundEnd:'+ep.address+'|'+peer.sessionId]:[];}));
  for(const row of db.prepare(                          embeddedSource("sql", `SELECT key,value FROM settings WHERE key LIKE 'codexForegroundEnd:%'`)).all())if(row.value==='null'||!foregroundEnds.has(String(row.key)))statement(db,'DELETE FROM settings WHERE key=?').run(String(row.key));
  db.prepare(                          embeddedSource("sql", `DELETE FROM events WHERE created_at<? OR seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)`)).run(now-policy.eventMaxAgeMs,policy.maxEvents);
                                               
  db.exec(                          embeddedSource("sql", `UPDATE events SET data=json_remove(data,'$.health.fingerprint') WHERE seq IN
    (SELECT seq FROM events WHERE type='health.alert' AND json_type(data,'$.health.fingerprint') IS NOT NULL ORDER BY seq LIMIT 8)`));
  db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key LIKE 'turnHealthDelivery:%' AND updated_at<? AND NOT EXISTS (SELECT 1 FROM pairs WHERE archived=0 AND settings.key LIKE 'turnHealthDelivery:'||pairs.id||':%')`)).run(cutoff);
  db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key LIKE 'communicationTip:message:%' AND NOT EXISTS (SELECT 1 FROM messages WHERE settings.key='communicationTip:message:'||messages.id)`)).run();
  db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key LIKE 'syncTip:message:%' AND NOT EXISTS (SELECT 1 FROM messages WHERE settings.key='syncTip:message:'||messages.id)`)).run();
  db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key LIKE 'claudeApproval:%' AND (value='null' OR NOT EXISTS (SELECT 1 FROM messages WHERE settings.key='claudeApproval:'||messages.id))`)).run();
  db.prepare(                          embeddedSource("sql", `DELETE FROM context_notices WHERE json_extract(data,'$.at')<? OR id NOT IN (SELECT id FROM context_notices ORDER BY rowid DESC LIMIT ?)`)).run(cutoff,policy.maxEvents);
  db.prepare(                          embeddedSource("sql", `DELETE FROM session_lineage WHERE peer_id NOT IN (SELECT claude FROM pairs WHERE archived=0 UNION SELECT codex FROM pairs WHERE archived=0)
    AND epoch NOT IN (SELECT json_extract(data,'$.epoch') FROM window_bindings WHERE active=1)
    AND (observed_at<? OR rowid NOT IN (SELECT rowid FROM session_lineage ORDER BY observed_at DESC,rowid DESC LIMIT ?))`)).run(cutoff,policy.maxReferences);
  db.prepare(                          embeddedSource("sql", `DELETE FROM window_bindings WHERE active=0 AND json_extract(data,'$.observedAt')<?`)).run(idleCutoff);
  db.prepare(                          embeddedSource("sql", `DELETE FROM settings WHERE key LIKE 'codexRecovery:%' AND updated_at<?`)).run(cutoff);
}
