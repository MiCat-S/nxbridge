import { statement } from '../../storage/sql-statements.js';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {BridgeError} from '../../shared/errors.js';
import {type Actor,type RegisterInput,type SessionBinding,type WindowIdentity} from '../../types.js';

                                         
export function normalizedHome(value: string): string {
  let result = path.resolve(value);
  try { result = realpathSync.native(result); } catch {}
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

export function windowKey(identity: WindowIdentity): string {
  return JSON.stringify([identity.host, normalizedHome(identity.configHome), identity.pid, identity.procStart,...(identity.threadId?[identity.threadId]:[])]);
}

                                          
export function hookContextMatches(key:string,sessionId:string,native:{pid:number;procStart:string}):boolean{
  const prefix=native.pid+':'+native.procStart+':';if(!key.startsWith(prefix))return false;
  const transcript=key.slice(prefix.length),name=path.posix.basename(transcript.replaceAll('\\','/'));
  return transcript===sessionId||name===sessionId+'.jsonl'||name.startsWith('rollout-')&&name.endsWith('-'+sessionId+'.jsonl');
}

                                             
export function registrationWindow(input: RegisterInput): WindowIdentity | undefined {
  const e = input.endpoint;
  if(e.daemon&&input.kind!=='subagent'&&input.kind!=='unknown'&&e.pid&&e.procStart&&e.configHome)return{host:input.host,configHome:normalizedHome(e.configHome),pid:e.pid,procStart:e.procStart,threadId:e.daemon.rootSessionId??input.sessionId};
  if (input.kind === 'subagent' || input.kind === 'unknown' || e.mode === 'app-server' || e.processKind==='app-server' || !e.pid || !e.procStart || !e.configHome) return undefined;
  return { host: input.host, configHome: normalizedHome(e.configHome), pid: e.pid, procStart: e.procStart };
}

export class SessionBindings {
  constructor(private db: DatabaseSync) {}

  get(key: string): SessionBinding | undefined {
    const r = statement(this.db,'SELECT data FROM window_bindings WHERE key=?').get(key);
    return r ? JSON.parse(r.data as string) : undefined;
  }
  current(peerId: string): SessionBinding | undefined {
    const r = statement(this.db,'SELECT data FROM window_bindings WHERE peer_id=? AND active=1').get(peerId);
    return r ? JSON.parse(r.data as string) : undefined;
  }
  all(): SessionBinding[] { return statement(this.db,'SELECT key,data FROM window_bindings').all().flatMap(row=>{
    try{return[JSON.parse(String(row.data)) as SessionBinding];}
    catch{return[];}
  }); }
  save(binding: SessionBinding): void {
    statement(this.db,'INSERT INTO window_bindings(key,peer_id,active,data) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET peer_id=excluded.peer_id,active=excluded.active,data=excluded.data').run(binding.key, binding.peerId, Number(binding.active), JSON.stringify(binding));
  }
  activate(identity: WindowIdentity, peerId: string, sessionId: string, reason: string): SessionBinding {
    const now=Date.now(),binding: SessionBinding = { ...identity, key: windowKey(identity), peerId, sessionId, epoch: randomUUID(), active: true, transitioning: false, observedAt:now,activatedAt:now };
    const previous = this.current(peerId);
    if (previous && previous.key !== binding.key) this.save({ ...previous, active: false });
    this.save(binding);
    statement(this.db,'INSERT INTO session_lineage(peer_id,host,config_home,session_id,epoch,reason,observed_at) VALUES(?,?,?,?,?,?,?)').run(peerId, identity.host, normalizedHome(identity.configHome), sessionId, binding.epoch, reason, binding.observedAt);
    return binding;
  }
  known(peerId: string, sessionId: string): boolean { return !!statement(this.db,'SELECT 1 FROM session_lineage WHERE peer_id=? AND session_id=? LIMIT 1').get(peerId, sessionId); }
  acceptsBoundary(binding:SessionBinding,sessionId:string,startedAt:number):boolean{
    if(binding.activatedAt===undefined||startedAt>=binding.activatedAt)return true;
                                         
    return binding.sessionId===sessionId&&!statement(this.db,'SELECT 1 FROM session_lineage WHERE peer_id=? AND session_id=? AND epoch<>? LIMIT 1').get(binding.peerId,sessionId,binding.epoch);
  }
  lineage(peerId: string): {sessionId:string;epoch:string;reason:string;observedAt:number}[] {
    return statement(this.db,'SELECT session_id,epoch,reason,observed_at FROM session_lineage WHERE peer_id=? ORDER BY observed_at,rowid').all(peerId).map(r => ({sessionId:r.session_id as string,epoch:r.epoch as string,reason:r.reason as string,observedAt:Number(r.observed_at)}));
  }
  reopen(identity: WindowIdentity, sessionId: string): SessionBinding | undefined {
    const rows=this.related(identity.host,sessionId);
    return rows.length===1?rows[0]:undefined;
  }
  related(host: WindowIdentity['host'], sessionId: string, except?:string):SessionBinding[]{
                                                 
    const rows = statement(this.db,`SELECT DISTINCT b.data FROM session_lineage l JOIN window_bindings b ON b.peer_id=l.peer_id AND b.active=1
      JOIN pairs p ON (p.archived=0 OR EXISTS(SELECT 1 FROM settings s WHERE s.key='pairLoss:'||l.peer_id AND s.value<>'null')) AND (p.claude=l.peer_id OR p.codex=l.peer_id)
      WHERE l.host=? AND l.session_id=?`).all(host, sessionId);
    return rows.map(row=>JSON.parse(row.data as string) as SessionBinding).filter(binding=>binding.peerId!==except);
  }
  validate(actor: Actor): SessionBinding | undefined {
    if (!actor.binding) return undefined;
    const b = this.get(actor.binding.key);
    if (!b?.active || b.host !== actor.host || b.epoch !== actor.binding.epoch || b.sessionId !== actor.sessionId || b.transitioning) throw new BridgeError('stale_context', '原生窗口上下文已改变，请在当前对话重新发起操作。');
    return b;
  }
}
