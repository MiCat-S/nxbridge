import {embeddedSource} from "../shared/embedded-source.js";
import { statement } from './sql-statements.js';
import {messageFactColumns as factColumns,expectedReplyRows,deliveryIssueRows} from '../broker/delivery/delivery-facts.js';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pairLossKey, recordPairLoss, type PairLossCause } from '../broker/pairing/pair-loss.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_RETENTION} from '../config/defaults.js';
import {type Actor,type ContextChangeReason,type ContextRotation,type RetentionConfig,type DeliveryState,type Endpoint,type Host,type Message,type Pair,type Peer,type RegisterInput} from '../types.js';
import { pruneHistory } from './retention.js';
import {sameDirectory} from '../shared/files.js';
import { liveProcess } from '../process/process.js';
import type { PartnerQuestion } from '../integration/mcp/questions.js';
import { runtimeProfile } from '../broker/profiles/runtime-profile.js';
import {emptyDeliveryCounts,type DeliveryCounts} from '../broker/health/contracts.js';
import { initializeSchema } from './schema.js';
import { hookContextMatches, registrationWindow, SessionBindings, windowKey } from '../integration/hooks/session-bindings.js';
import { PairSelections } from '../broker/pairing/pair-selection.js';
import { memberEnabled } from '../broker/member-control.js';
import type { NativeApproval } from '../hosts/claude/claude-inbound.js';
import { codexEvidenceContext, observeCodexPermission } from '../hosts/codex/codex-permission.js';
import { forgetPeerRecovery, repairPeerRecovery } from '../broker/recovery/peer-recovery-state.js';
import { FaultBoundary } from '../broker/fault-boundary.js';

type Row = Record<string, unknown>;
export type MessageFacts=Pick<Message,'id'|'pairId'|'from'|'to'|'state'|'createdAt'|'updatedAt'|'inReplyTo'|'replyExpected'>;
export type PendingMessageFacts=Pick<Message,'id'|'pairId'|'to'|'attempts'>;
const factsFrom=(row:Row):MessageFacts=>({id:row.id as string,pairId:row.pair_id as string,from:row.sender as string,to:row.recipient as string,state:row.state as Message['state'],createdAt:row.created_at as number,updatedAt:row.updated_at as number,inReplyTo:(row.original_reply_to??row.in_reply_to) as string|null,replyExpected:row.reply_expected===1});
const pairFrom = (row: Row): Pair => ({ id: row.id as string, claude: row.claude as string, codex: row.codex as string, paused: !!row.paused, archived: !!row.archived, createdAt: row.created_at as number });
const messageColumns=['id','pair_id','sender','recipient','in_reply_to','original_reply_to','reply_source','reply_expected','via','call_id','state','created_at','updated_at','evidence','error','attempts'];
const bodyProjection=(prefix:string)=>messageColumns.map(column=>prefix+column).concat('CAST('+prefix+'body AS BLOB) AS body').join(',');
const messageFields=bodyProjection(''),joinedMessageFields=bodyProjection('m.');
                                                                 
const sqliteText=(value:unknown):string=>{const bytes=value as Uint8Array;return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('utf8');};
const messageFrom = (r: Row): Message => ({ id:r.id as string,pairId:r.pair_id as string,from:r.sender as string,to:r.recipient as string,body:sqliteText(r.body),inReplyTo:(r.original_reply_to??r.in_reply_to) as string|null,...(r.reply_source?{replySource:r.reply_source as Message['replySource']}:{}),replyExpected:r.reply_expected===1,via:r.via as string|null,callId:r.call_id as string,state:r.state as DeliveryState,createdAt:r.created_at as number,updatedAt:r.updated_at as number,evidence:r.evidence as string|null,error:r.error as string|null,attempts:r.attempts as number });

export class Store {
  readonly faults=new FaultBoundary((type,data)=>this.event(type,data));
  private db: DatabaseSync;
  private transactionSequence=0;
  private hookContextWarnings=new Map<string,Set<string>>();
  readonly bindings: SessionBindings;
  readonly selections: PairSelections;
  onRotation?: (rotation: ContextRotation) => void;
  onContextEnd?: (peerId:string) => void;
  onCooperationChange?: (peerIds:string[]) => void;
  onDeliveryObserved?: (message:Message) => void;
  constructor(filename: string) {
    const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(filename);
    try { initializeSchema(this.db); } catch(error) { this.db.close(); throw error; }
    this.bindings = new SessionBindings(this.db);
    this.selections = new PairSelections(this.db,this);
    this.transaction(()=>repairPeerRecovery(this.db));
  }

  close(): void { this.db.close(); }
  private decode<T>(kind:string,id:string,raw:string):T|undefined{
    const stage='record:'+kind+':'+id;
    try{const value=JSON.parse(raw) as T;this.faults.recovered(stage);return value;}
                                            
    catch(error){this.faults.failedOnce(stage,error);return;}
  }
  private readPeer(row:Row):Peer|undefined{
    const peer=this.decode<Peer>('peer',String(row.id),String(row.data));
    return peer?{enabled:true,...peer}:undefined;
  }
  private readQuestions(rows:Row[]):PartnerQuestion[]{return rows.flatMap(row=>{const q=this.decode<PartnerQuestion>('question',String(row.id),String(row.data));return q?[q]:[];});}
  transaction<T>(fn: () => T): T {
    const nested=this.db.isTransaction,savepoint='nxbridge_'+(++this.transactionSequence);
    this.db.exec(nested?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');
    try { const value=fn(); this.db.exec(nested?'RELEASE '+savepoint:'COMMIT'); return value; }
    catch(error) { this.db.exec(nested?'ROLLBACK TO '+savepoint:'ROLLBACK');if(nested)this.db.exec('RELEASE '+savepoint);throw error; }
  }
  questions(active=false):PartnerQuestion[]{return this.readQuestions(statement(this.db,active?"SELECT id,data FROM questions WHERE status IN ('pending','awaiting_user') ORDER BY rowid":"SELECT id,data FROM questions ORDER BY rowid DESC LIMIT 100").all());}
  expiredQuestionRoutes():PartnerQuestion[]{return this.readQuestions(statement(this.db,"SELECT id,data FROM questions WHERE status='needs_user' AND expires_at<=? ORDER BY rowid").all(Date.now()));}
  question(id:string):PartnerQuestion{const row=statement(this.db,'SELECT data FROM questions WHERE id=?').get(id);if(!row)throw new BridgeError('question_missing','问题不存在。');return JSON.parse(row.data as string);}
  questionByCall(key:string):PartnerQuestion|undefined{const row=statement(this.db,'SELECT data FROM questions WHERE actor_key=?').get(key);return row?JSON.parse(row.data as string):undefined;}
  saveQuestion(q:PartnerQuestion):void{statement(this.db,'INSERT INTO questions(id,pair_id,actor_key,status,expires_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(q.id,q.pairId,q.actorKey,q.status,q.expiresAt,JSON.stringify(q));this.event('question.state',{request_id:q.id,status:q.status},[q.from,q.to]);}
  event(type: string, data: unknown,cooperationIds?:readonly string[]): void {
    statement(this.db,'INSERT INTO events(created_at,type,data) VALUES(?,?,?)').run(Date.now(),type,JSON.stringify(data));
                                    
    if(cooperationIds?.length)this.onCooperationChange?.([...new Set(cooperationIds)]);
  }
  restartResult(requestId:string):{response?:unknown;error?:{code:string;message:string;uncertain?:boolean}}|undefined{
    const row=statement(this.db,"SELECT data FROM events WHERE type='codex.restart.result' AND json_extract(data,'$.requestId')=? ORDER BY seq DESC LIMIT 1").get(requestId);
    return row?JSON.parse(row.data as string):undefined;
  }
  events(after = 0, limit = 100): Row[] { return statement(this.db,'SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit).flatMap(row=>{const data=this.decode('event',String(row.seq),String(row.data));return data===undefined?[]:[{...row,data}];}); }
                                                
  codexNativeReceipt(messageId:string,sessionId:string,itemId:string):boolean{
    const matches=(evidence:unknown)=>typeof evidence==='string'&&evidence.startsWith('Codex ')&&evidence.includes(`，thread=${sessionId}，turn=`)&&evidence.endsWith(`，item=${itemId}`);
    if(matches(this.message(messageId).evidence))return true;
    return statement(this.db,"SELECT json_extract(data,'$.evidence') AS evidence FROM events WHERE type='message.state' AND json_extract(data,'$.messageId')=? AND json_extract(data,'$.state')='contextObserved'").all(messageId).some(row=>matches(row.evidence));
  }
  setting<T>(key: string): T | undefined { const r=statement(this.db,'SELECT value FROM settings WHERE key=?').get(key);if(!r)return;try{return JSON.parse(r.value as string) as T;}catch{throw new BridgeError('record_invalid','状态记录无法解析：'+key);} }
  setSetting(key: string, value: unknown): void { statement(this.db,'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,JSON.stringify(value),Date.now()); }
  warnHookContext(contextKey:string|undefined,sessionId:string,event:string,reason:string,peerId?:string):void{
    const key=contextKey??'session:'+sessionId,signature=JSON.stringify([sessionId,reason,peerId]),seen=this.hookContextWarnings.get(key)??new Set<string>();if(seen.has(signature))return;
    this.event('hook.context.unverified',{sessionId,event,reason,...(contextKey?{context_key:contextKey}:{}),...(peerId?{peerId}:{})});seen.add(signature);this.hookContextWarnings.set(key,seen);
    if(this.hookContextWarnings.size>256)this.hookContextWarnings.delete(this.hookContextWarnings.keys().next().value!);
  }
  requireSnapshot(id:string):void{statement(this.db,'UPDATE messages SET snapshot_required=1 WHERE id=?').run(id);}
  snapshotRequired(id:string):boolean{return statement(this.db,'SELECT snapshot_required FROM messages WHERE id=?').get(id)?.snapshot_required===1;}
  maintain(policy:Partial<RetentionConfig>={},now=Date.now()):void{
    this.transaction(()=>{this.selections.maintain();pruneHistory(this.db,{...DEFAULT_RETENTION,...policy},now,this.peers(),this.endpoints());});
  }
  checkpoint():void{this.db.exec(                          embeddedSource("sql", `PRAGMA wal_checkpoint(PASSIVE)`));}
  peers(): Peer[] { return statement(this.db,'SELECT * FROM peers ORDER BY rowid').all().flatMap(row=>{const peer=this.readPeer(row);return peer?[peer]:[];}); }
  getPeer(id:string):Peer|undefined{const row=statement(this.db,'SELECT * FROM peers WHERE id=?').get(id);return row?this.readPeer(row):undefined;}
  hasPeer(id:string):boolean{return !!statement(this.db,'SELECT 1 FROM peers WHERE id=?').get(id);}
  peer(id: string): Peer { const peer=this.getPeer(id);if(!peer)throw new BridgeError('peer_missing','会话不存在。');return peer; }
  peersForSession(host:Host,sessionId:string):Peer[]{return statement(this.db,'SELECT * FROM peers WHERE host=? AND session_id=?').all(host,sessionId).flatMap(row=>{const peer=this.readPeer(row);return peer?[peer]:[];});}
  find(host: Host, sessionId: string, address?:string): Peer | undefined {
    const rows=this.peersForSession(host,sessionId).filter(peer=>!address||this.endpoints(peer.id).some(e=>e.address===address));
    if(rows.length>1)throw new BridgeError('ambiguous_context','同一会话在多个原生窗口中打开，请重新加载插件以核验当前窗口。');
    return rows[0];
  }
  resolve(actor: Actor): Peer | undefined {
    const child=actor.via?this.peers().filter(p=>p.host===actor.host&&p.sessionId===actor.sessionId&&p.kind==='subagent').find(p=>!actor.binding||p.rootBinding?.key===actor.binding.key):undefined;
    if(child?.rootBinding){
      const root=this.bindings.get(child.rootBinding.key);
      if(!root||root.epoch!==child.rootBinding.epoch||actor.binding&&actor.binding.epoch!==root.epoch)throw new BridgeError('stale_context','子代理所属的根对话已改变，旧回调不能发信。');
      this.bindings.validate({...actor,sessionId:root.sessionId,binding:child.rootBinding});return child;
    }
    const binding=this.bindings.validate(actor);
    if(binding){if(actor.memberId&&actor.memberId!==binding.peerId)throw new BridgeError('stale_context','成员与窗口绑定不符。');return this.peer(binding.peerId);}
    const peer=actor.memberId?this.peer(actor.memberId):this.find(actor.host,actor.sessionId),current=peer&&this.bindings.current(peer.id);
    if(peer&&(peer.host!==actor.host||peer.sessionId!==actor.sessionId))throw new BridgeError('stale_context','成员当前对话已改变，原操作失效。');
    if(current?.transitioning)throw new BridgeError('stale_context','窗口正在切换对话，请在新对话开始后重试。');
    if(peer?.rootBinding){const root=this.bindings.get(peer.rootBinding.key);if(!root?.active||root.epoch!==peer.rootBinding.epoch)throw new BridgeError('stale_context','子代理所属的根上下文已经改变。');}
    return peer;
  }
  savePeer(peer: Peer): Peer {
    const previous=this.getPeer(peer.id);
    if(peer.state!=='paused'||previous&&previous.sessionId!==peer.sessionId)delete peer.pauseReason;
                                               
    peer.stateSince=previous?.state===peer.state&&previous.sessionId===peer.sessionId?previous.stateSince??Date.now():Date.now();
    statement(this.db,'INSERT INTO peers(id,host,session_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET host=excluded.host,session_id=excluded.session_id,data=excluded.data').run(peer.id,peer.host,peer.sessionId,JSON.stringify(peer));
    if(previous&&(previous.state!==peer.state||previous.sessionId!==peer.sessionId||previous.enabled!==peer.enabled))this.onCooperationChange?.([peer.id]);return peer;
  }
  updatePeer(id: string, patch: Partial<Peer>): Peer { const previous=this.peer(id),peer=this.savePeer({...previous,...patch,id,updatedAt:Date.now()});if(peer.state!==previous.state)this.event('peer.state',{peerId:id,state:peer.state});return peer; }

  register(input: RegisterInput, reopen?: {peerId:string;previousKey:string}): Peer {
    return this.transaction(()=>this.registerContext(input,reopen));
  }
  private registerContext(input:RegisterInput,reopen?:{peerId:string;previousKey:string},adoptId?:string):Peer {
    const window=registrationWindow(input),binding=window?this.bindings.get(windowKey(window)):undefined;
    if(input.expectedBinding){
      const expected=this.bindings.get(input.expectedBinding.key),native=window??registrationWindow({...input,kind:'root'});
      const parent=input.kind==='subagent'?this.peers().find(p=>p.sessionId===input.parentId&&p.host===input.host&&(p.id===expected?.peerId||p.rootBinding?.key===expected?.key&&p.rootBinding?.epoch===expected?.epoch)):undefined;
      if(!expected?.active||expected.host!==input.host||expected.epoch!==input.expectedBinding.epoch||!native||expected.key!==windowKey(native)||(input.kind==='subagent'?!parent:expected.sessionId!==input.sessionId))throw new BridgeError('stale_context','原操作所属上下文已经改变。');
    }
    if(binding?.active&&input.boundaryStartedAt!==undefined&&!this.bindings.acceptsBoundary(binding,input.sessionId,input.boundaryStartedAt))throw new BridgeError('stale_context','原生回调开始后对话已经切换，未更新新上下文。');
    let previous=adoptId?this.peer(adoptId):binding?.active?this.peer(binding.peerId):undefined;
    const pending=window?this.setting<{peerId:string;proposedSessionId?:string}>('pendingCodex:'+windowKey(window)):undefined;
    if(pending&&input.host==='codex'){
      const candidate=this.peer(pending.peerId);
      if(this.endpoints(candidate.id).some(e=>e.active&&e.pendingContext&&e.pid===window!.pid&&e.procStart===window!.procStart)){
        if(pending.proposedSessionId&&pending.proposedSessionId!==input.sessionId){
          const pair=this.pairFor(candidate.id);if(pair){for(const m of this.pending(candidate.id))this.transition(m.id,'held','启动参数中的对话与原生实际对话不同，原配对已解除，消息保留待人工选择。');this.unpair(pair.id,{reason:'identity_mismatch',actor:'native registration'});}
        }
        previous=candidate;this.setSetting('pendingCodex:'+windowKey(window!),{...pending,confirmed:true});
      }
    }
    if(!previous&&reopen){
      const old=this.bindings.current(reopen.peerId);
      if(!window||old?.key!==reopen.previousKey||this.bindings.reopen(window,input.sessionId)?.peerId!==reopen.peerId)throw new BridgeError('context_changed','恢复期间窗口身份改变，请重试。');
      previous=this.peer(reopen.peerId);
    }
    if(!previous){
      const matches=this.peers().filter(p=>p.host===input.host&&p.sessionId===input.sessionId&&(input.endpoint.processKind!=='app-server'||!this.bindings.current(p.id)&&this.endpoints(p.id).some(e=>{const native=e.native??e;return native.pid===input.endpoint.pid&&native.procStart===input.endpoint.procStart;}))&&(input.endpoint.mode!=='app-server'||this.endpoints(p.id).some(e=>e.mode==='app-server'&&e.address===input.endpoint.address)));
                                               
      if(!window){if(matches.length>1)throw new BridgeError('ambiguous_context','会话对应多个窗口，需要重新加载插件。');previous=matches[0];}
      else if(matches.length===1&&!this.bindings.current(matches[0]!.id)&&this.endpoints(matches[0]!.id).some(e=>e.mode!=='app-server'&&e.pid===window.pid&&e.procStart===window.procStart))previous=matches[0];
    }
    if(binding?.active&&binding.sessionId!==input.sessionId&&this.bindings.known(binding.peerId,input.sessionId)&&!input.contextStart)throw new BridgeError('stale_context','旧对话调用已经失效，请从当前原生对话重试。');
    const firstEndpoint=previous?.owner==='nxbridge'&&!this.endpoints(previous.id).length;
    const peer:Peer={...previous,id:previous?.id ?? randomUUID(),host:input.host,sessionId:input.sessionId,cwd:input.cwd,name:input.name ?? previous?.name ?? input.host,kind:input.kind ?? previous?.kind ?? 'root',parentId:input.parentId ?? previous?.parentId ?? null,owner:previous?.owner ?? 'user',state:reopen?'ready':previous?.state==='paused'?'paused':input.state ?? (previous?.state==='offline'||firstEndpoint?'ready':previous?.state) ?? 'ready',permission:input.permission&&input.permission!=='unknown'?input.permission:previous?.permission??'unknown',...runtimeProfile(previous??{},input),updatedAt:Date.now()};
    if(peer.kind==='subagent'&&peer.parentId){
      const native=registrationWindow({...input,kind:'root'}),root=native?this.bindings.get(windowKey(native)):undefined;
      const parents=this.peers().filter(p=>p.host===input.host&&p.sessionId===peer.parentId&&(root?p.id===root.peerId||p.rootBinding?.key===root.key:this.endpoints(p.id).some(e=>e.address===input.endpoint.address)));
      if(parents.length===1){const parent=parents[0]!,origin=parent.rootBinding??this.bindings.current(parent.id);peer.rootPeerId=parent.rootPeerId??parent.id;if(origin)peer.rootBinding={key:origin.key,epoch:origin.epoch};}
    }
    delete peer.launchFailure;
    this.savePeer(peer);
    let current=binding;
    if(window){
      if(!binding?.active||binding.sessionId!==input.sessionId){
                                                         
        const reason=input.contextReason&&input.contextReason!=='unknown'?input.contextReason:binding?.active?binding.transitionReason??'unknown':'unknown';
        current=this.bindings.activate(window,peer.id,input.sessionId,reason);
        if(binding?.active&&binding.sessionId!==input.sessionId){
          this.rotateContext(peer.id,binding,reason);
        }
        for(const ep of this.endpoints(peer.id))if(ep.active&&ep.mode!=='app-server')this.deactivate(peer.id,ep.epoch);
                                          
      }else this.bindings.save({...binding,observedAt:Date.now(),transitioning:false,transitionReason:input.contextStart?undefined:binding.transitionReason});
    }
    for(const old of this.endpoints(peer.id))if(old.active&&old.pid&&(!liveProcess(old.pid)||(old.pid===input.endpoint.pid&&old.mode===input.endpoint.mode&&old.epoch!==input.endpoint.epoch)))this.deactivate(peer.id,old.epoch);
    const oldEndpoint=this.endpoints(peer.id).find(e=>e.epoch===input.endpoint.epoch);
    const questionSupport=oldEndpoint?.questionSupport===true?true:input.endpoint.questionSupport??oldEndpoint?.questionSupport;
                                                          
    const sameNative=!!input.endpoint.pid&&!!input.endpoint.procStart&&oldEndpoint?.pid===input.endpoint.pid&&oldEndpoint.procStart===input.endpoint.procStart;
    const nativePermission=input.endpoint.nativePermission??(sameNative?oldEndpoint?.nativePermission:undefined);
    const inbound=input.endpoint.nativeInbound??(sameNative?oldEndpoint?.nativeInbound:undefined);
    const inboundPermission=nativePermission?.permission??inbound?.permission??(sameNative?oldEndpoint?.nativeInbound?.permission:undefined);
    const sameModContext=sameNative&&previous?.sessionId===input.sessionId&&oldEndpoint?.bindingEpoch===current?.epoch;
    const nativeSession=sameModContext?{...oldEndpoint?.nativeSession,...input.endpoint.nativeSession}:input.endpoint.nativeSession;
    const nativeDecision=input.endpoint.nativeDecision??(sameNative&&previous?.sessionId===input.sessionId?oldEndpoint?.nativeDecision:undefined);
    const nativeAutoMode=input.endpoint.nativeAutoMode??(sameModContext?oldEndpoint?.nativeAutoMode:undefined);
    const nativeProfile=input.endpoint.nativeProfile??(sameModContext?oldEndpoint?.nativeProfile:undefined);
    const modVersion=input.endpoint.modVersion??(sameModContext?oldEndpoint?.modVersion:undefined),modRevision=input.endpoint.modRevision??(sameModContext&&(input.endpoint.modVersion===undefined||input.endpoint.modVersion===oldEndpoint?.modVersion)?oldEndpoint?.modRevision:undefined);
    const endpoint: Endpoint={...input.endpoint,...(current?{bindingEpoch:current.epoch}:{}),...(oldEndpoint?.native?{native:oldEndpoint.native}:{}),...(oldEndpoint?.bridge?{bridge:oldEndpoint.bridge}:{}),...(input.endpoint.native?{native:input.endpoint.native}:{}),...(input.endpoint.bridge?{bridge:input.endpoint.bridge}:{}),...(modVersion?{modVersion}:{}),...(modRevision?{modRevision}:{}),...(questionSupport!==undefined?{questionSupport}:{}),...(nativePermission?{nativePermission}:{}),...(inbound?{nativeInbound:{...inbound,...(inboundPermission?{permission:inboundPermission}:{})}}:{}),peerId:peer.id,seenAt:Date.now(),active:true};
    if(nativeSession&&Object.keys(nativeSession).length)endpoint.nativeSession=nativeSession;
                                           
                                                     
    if(endpoint.daemon&&sameNative&&oldEndpoint?.bindingEpoch===current?.epoch)endpoint.daemon={...oldEndpoint.daemon,...endpoint.daemon};
    if(input.host==='codex'){
      const sameContext=sameNative&&previous?.sessionId===input.sessionId&&oldEndpoint?.bindingEpoch===current?.epoch;
      const legacy=sameContext&&(oldEndpoint.codexPermission??oldEndpoint.daemon),prior=sameContext?(oldEndpoint.codexPermissionObservation??(legacy?{value:legacy,source:'prior-native-registration',context:codexEvidenceContext(input.sessionId,endpoint),observedAt:oldEndpoint.seenAt}:undefined)):undefined;
      const evidence=input.endpoint.codexPermission??(input.endpoint.daemon?{sandbox:input.endpoint.daemon.sandbox,approval:input.endpoint.daemon.approval,autoReview:input.endpoint.daemon.autoReview}:{});
      Object.assign(endpoint,observeCodexPermission(endpoint,input.sessionId,evidence,'native-registration',prior));
      if(!endpoint.codexPermissionObservation){delete endpoint.codexPermission;delete endpoint.codexPermissionObservation;}
    }
    const sameHealthContext=oldEndpoint?.bindingEpoch===current?.epoch||previous?.sessionId===input.sessionId&&oldEndpoint?.nativeHealth?.turnId===endpoint.nativeHealth?.turnId;
    const previousHealth=sameNative&&sameHealthContext?oldEndpoint?.nativeHealth:undefined;
    if(!endpoint.nativeHealth||previousHealth&&previousHealth.lastEventAt>endpoint.nativeHealth.lastEventAt)endpoint.nativeHealth=previousHealth;
    if(nativeAutoMode)endpoint.nativeAutoMode=nativeAutoMode;
    if(nativeProfile)endpoint.nativeProfile=nativeProfile;
    if(nativeDecision)endpoint.nativeDecision=nativeDecision;
    const nativeBackground=input.endpoint.nativeBackground??(sameModContext?oldEndpoint?.nativeBackground:undefined);
    if(nativeBackground)endpoint.nativeBackground=nativeBackground;
    if(peer.host==='codex'&&peer.kind==='subagent'&&input.state==='offline')endpoint.active=false;
    this.saveEndpoint(endpoint);
    if(input.hookContextKey){
      const key='hookContext:'+input.hookContextKey,prior=this.setting<string>(key);
      if(input.host!=='codex'||!['root','fork'].includes(peer.kind)||!current?.active||current.transitioning||current.sessionId!==input.sessionId||!hookContextMatches(input.hookContextKey,input.sessionId,current)||prior!==undefined&&prior!==input.sessionId)this.warnHookContext(input.hookContextKey,input.sessionId,'registration',prior!==undefined&&prior!==input.sessionId?'mismatch':'invalid_key',peer.id);
      else if(prior===undefined)this.setSetting(key,input.sessionId);
    }
    if(!previous)this.event('peer.registered',{peerId:peer.id,host:peer.host,name:peer.name});
    if(input.replyContract===1)this.adoptReplyContract(peer.id,'mcp');
    return peer;
  }
  rotateContext(peerId:string,before:{sessionId:string;epoch:string},reason:ContextChangeReason):void{
    const peer=this.peer(peerId),current=this.bindings.current(peerId);if(!current)throw new BridgeError('context_changed','上下文接续缺少当前租约。');
    const pair=this.pairFor(peerId),messages=pair?this.messagesFor(pair.id).filter(m=>m.to===peerId):[];
    const rotation:ContextRotation={id:randomUUID(),peerId,...(pair?{pairId:pair.id}:{}),oldSessionId:before.sessionId,sessionId:current.sessionId,oldEpoch:before.epoch,epoch:current.epoch,reason,at:Date.now(),unanswered:messages.filter(m=>['runtimeQueued','contextObserved','held'].includes(m.state)).map(m=>m.id),uncertain:messages.filter(m=>['sending','unknown'].includes(m.state)).map(m=>m.id)};
    for(const message of messages)if(message.state==='sending')this.transition(message.id,'unknown','目标对话切换，传输结果待核对');
    this.selections.invalidate(peerId);this.onRotation?.(rotation);this.event('context.rotated',rotation);
    if(pair)statement(this.db,'INSERT INTO context_notices(id,pair_id,recipient,data) VALUES(?,?,?,?)').run(rotation.id,pair.id,pair[peer.host==='claude'?'codex':'claude'],JSON.stringify(rotation));
  }
  saveEndpoint(endpoint: Endpoint): void { statement(this.db,'INSERT INTO endpoints(peer_id,epoch,data) VALUES(?,?,?) ON CONFLICT(peer_id,epoch) DO UPDATE SET data=excluded.data').run(endpoint.peerId,endpoint.epoch,JSON.stringify(endpoint)); }
  endpoints(peerId?: string): Endpoint[] { return (peerId?statement(this.db,'SELECT * FROM endpoints WHERE peer_id=?').all(peerId):statement(this.db,'SELECT * FROM endpoints').all()).flatMap(row=>{const endpoint=this.decode<Endpoint>('endpoint',row.peer_id+':'+row.epoch,String(row.data));return endpoint?[endpoint]:[];}); }
  endpoint(peerId: string): Endpoint | undefined {
    const active=this.endpoints(peerId).filter(e=>e.active);
    if(this.bindings.current(peerId)&&this.peer(peerId).owner==='user'){
      const foreground=active.filter(e=>e.mode!=='app-server');
      if(foreground.length>1)throw new BridgeError('ambiguous_endpoint','同一窗口有多个存活端点，请重新加载插件。');
      if(foreground.length)return foreground[0];
      return undefined;
    }
    const direct=active.filter(e=>e.mode!=='embedded');
    const candidates=direct.length?direct:active;
    if(candidates.length>1)throw new BridgeError('ambiguous_endpoint','同一会话有多个存活端点，请先明确选择。');
    return candidates[0];
  }
  deactivate(peerId: string, epoch?: string): void { for(const ep of this.endpoints(peerId))if(!epoch||ep.epoch===epoch)this.saveEndpoint({...ep,active:false}); }
  placeholder(host: Host, cwd: string): Peer { return this.savePeer({id:randomUUID(),host,sessionId:null,cwd,name:`nxbridge · ${host} 搭档`,kind:'root',parentId:null,owner:'nxbridge',state:'starting',permission:'unknown',updatedAt:Date.now()}); }
  adopt(id: string, input: RegisterInput, provisionalId?:string): Peer {
    return this.transaction(()=>{
      const target=this.peer(id);
      if(target.host!==input.host)throw new BridgeError('invalid_adoption','接续成员的宿主不一致。');
      const window=registrationWindow(input),binding=window&&this.bindings.get(windowKey(window));
      const existing=provisionalId?this.peer(provisionalId):binding?.active?this.peer(binding.peerId):this.peers().find(p=>p.id!==id&&p.host===input.host&&p.sessionId===input.sessionId&&!this.bindings.current(p.id)&&this.endpoints(p.id).some(e=>e.epoch===input.endpoint.epoch&&e.address===input.endpoint.address));
      if(existing && existing.id!==id){
        const sameNative=window?this.endpoints(existing.id).some(e=>e.pid===window.pid&&e.procStart===window.procStart&&e.configHome&&windowKey({...window,configHome:e.configHome})===windowKey(window)):input.endpoint.mode==='app-server'&&input.endpoint.pid&&input.endpoint.procStart&&input.endpoint.configHome&&!this.bindings.current(existing.id)&&existing.sessionId===input.sessionId&&this.endpoints(existing.id).some(e=>e.mode==='app-server'&&e.address===input.endpoint.address&&e.epoch===input.endpoint.epoch&&e.pid===input.endpoint.pid&&e.procStart===input.endpoint.procStart&&e.configHome&&sameDirectory(e.configHome,input.endpoint.configHome!));
        if(provisionalId&&(existing.host!==input.host||!sameNative))throw new BridgeError('context_changed','临时成员不属于本次核验的原生窗口。');
        const inPair=statement(this.db,'SELECT id FROM pairs WHERE claude=? OR codex=?').get(existing.id,existing.id);
        if(inPair)throw new BridgeError('peer_already_paired','恢复发现的会话已参与其他配对，不能收养。');
                                                           
        for(const old of this.bindings.all())if(old.peerId===id&&old.active&&old.key!==binding?.key)this.bindings.save({...old,active:false});
        this.selections.rebind(existing.id,id);
        for(const endpoint of this.endpoints(existing.id))this.saveEndpoint({...endpoint,peerId:id});
        for(const current of this.bindings.all())if(current.peerId===existing.id)this.bindings.save({...current,peerId:id});
        statement(this.db,'UPDATE session_lineage SET peer_id=? WHERE peer_id=?').run(id,existing.id);
        for(const child of this.peers())if(child.rootPeerId===existing.id)this.updatePeer(child.id,{rootPeerId:id});
        forgetPeerRecovery(this.db,existing.id,id);
        statement(this.db,'DELETE FROM endpoints WHERE peer_id=?').run(existing.id);
        statement(this.db,'DELETE FROM peers WHERE id=?').run(existing.id);
        if(window){const key='pendingCodex:'+windowKey(window),pending=this.setting<Record<string,unknown>>(key);if(pending)this.setSetting(key,{...pending,peerId:id,confirmed:true});}
      }
                                                                
      if(target.state==='starting'||target.state==='offline')this.updatePeer(id,{state:'ready'});
      return this.registerContext(input,undefined,id);
    });
  }
  pairs():Pair[]{return statement(this.db,'SELECT * FROM pairs WHERE archived=0 ORDER BY created_at,rowid').all().map(pairFrom);}
  pairHistory(peerId:string):Pair[]{return statement(this.db,'SELECT * FROM pairs WHERE claude=? OR codex=? ORDER BY created_at DESC,rowid DESC').all(peerId,peerId).map(pairFrom);}
  pairById(id:string):Pair|undefined{const r=statement(this.db,'SELECT * FROM pairs WHERE id=?').get(id);return r?pairFrom(r):undefined;}
  pairFor(peerId:string):Pair|undefined{const r=statement(this.db,'SELECT * FROM pairs WHERE archived=0 AND (claude=? OR codex=?)').get(peerId,peerId);return r?pairFrom(r):undefined;}
  hasPairHistory(peerId:string):boolean{return!!statement(this.db,'SELECT 1 FROM pairs WHERE claude=? OR codex=? LIMIT 1').get(peerId,peerId);}
  currentPair(selector?:string): Pair | undefined {
    if(selector)return this.pairFor(selector)??this.pairs().find(p=>p.id===selector);
    const pairs=this.pairs();if(pairs.length>1)throw new BridgeError('pair_selector_required','有多组配对，请明确指定配对或窗口。');return pairs[0];
  }
  pair(claude: string,codex: string,replace=false): Pair {
    return this.transaction(()=>{
      const c=this.peer(claude),x=this.peer(codex);
      if(c.host!=='claude'||x.host!=='codex'||!['root','fork'].includes(c.kind)||!['root','fork'].includes(x.kind))throw new BridgeError('invalid_pair','只能配对 Claude 与 Codex 的独立主会话。');
      const old=[...new Map([this.pairFor(claude),this.pairFor(codex)].filter((p):p is Pair=>!!p).map(p=>[p.id,p])).values()];
      if(old.length===1&&old[0]!.claude===claude&&old[0]!.codex===codex)return old[0]!;
      if(old.length&&!replace)throw new BridgeError('pair_exists','所选窗口已有搭档；替换必须由人显式指定 --replace。');
      for(const p of old)statement(this.db,'UPDATE pairs SET archived=1,archived_at=? WHERE id=?').run(Date.now(),p.id);
      const pair:Pair={id:randomUUID(),claude,codex,paused:false,archived:false,createdAt:Date.now()};
      statement(this.db,'INSERT INTO pairs(id,claude,codex,created_at) VALUES(?,?,?,?)').run(pair.id,claude,codex,pair.createdAt);
      for(const id of [claude,codex])this.setSetting(pairLossKey(id),null);
      this.selections.invalidate(claude);this.selections.invalidate(codex);
      this.event('pair.created',pair,[pair.claude,pair.codex]);return pair;
    });
  }
  setPaused(paused: boolean,selector?:string): void { const pair=this.currentPair(selector);if(!pair)throw new BridgeError('unpaired','当前没有配对。');statement(this.db,'UPDATE pairs SET paused=? WHERE id=?').run(Number(paused),pair.id);this.event(paused?'pair.paused':'pair.resumed',{pairId:pair.id},[pair.claude,pair.codex]); }
  unpair(selector?:string,cause?:PairLossCause): Pair | undefined { return this.transaction(()=>{const pair=this.currentPair(selector);if(pair&&cause&&[pair.claude,pair.codex].some(id=>this.peer(id).enabled===false))return pair;if(pair){statement(this.db,'UPDATE pairs SET archived=1,archived_at=? WHERE id=?').run(Date.now(),pair.id);if(cause)recordPairLoss(this,pair,cause);else for(const id of [pair.claude,pair.codex]){this.setSetting(pairLossKey(id),null);this.setSetting('cooperationUnpaired:'+id,true);}this.event('pair.archived',{pairId:pair.id,...(cause?{cause}:{})},[pair.claude,pair.codex]);}return pair;}); }
  restorePair(id:string):Pair{
    return this.transaction(()=>{
      const pair=this.pairById(id);if(!pair)throw new BridgeError('pair_restore_unavailable','原配对不存在。');
      if(!pair.archived)return pair;
      if(this.pairFor(pair.claude)||this.pairFor(pair.codex))throw new BridgeError('pair_exists','原成员已有其他搭档，不能恢复旧配对。');
      statement(this.db,'UPDATE pairs SET archived=0,archived_at=NULL WHERE id=?').run(id);
      for(const member of [pair.claude,pair.codex]){this.setSetting(pairLossKey(member),null);this.selections.invalidate(member);}
      this.event('pair.restored',{pairId:id},[pair.claude,pair.codex]);return{...pair,archived:false};
    });
  }
  candidates(host: Host,cwd: string): Peer[] {return this.peers().filter(p=>p.enabled!==false&&p.host===host&&(p.sessionId||this.endpoint(p.id)?.pendingContext)&&!this.pairFor(p.id)&&['root','fork'].includes(p.kind)&&['ready','busy','needsHuman','paused'].includes(p.state)&&!this.bindings.current(p.id)?.transitioning&&sameDirectory(p.cwd,cwd));}
  endContext(actor:Actor,reason:ContextChangeReason='unknown'):boolean{
    const peer=this.resolve(actor),binding=peer&&this.bindings.current(peer.id);
    if(!peer||peer.sessionId!==actor.sessionId)return false;
    if(binding)this.bindings.save({...binding,transitioning:true,transitionReason:reason!=='unknown'?reason:binding.transitionReason??reason,observedAt:Date.now()});
    this.selections.invalidate(peer.id);this.onContextEnd?.(peer.id);
    return true;
  }
  contextNotices(peerId:string):ContextRotation[]{const pair=this.pairFor(peerId);return pair?statement(this.db,'SELECT data FROM context_notices WHERE recipient=? AND pair_id=? AND acknowledged=0 ORDER BY rowid').all(peerId,pair.id).map(r=>JSON.parse(r.data as string)):[];}
  acknowledgeContextNotice(peerId:string,id:string):void{statement(this.db,'UPDATE context_notices SET acknowledged=1 WHERE id=? AND recipient=?').run(id,peerId);}
  admitContextNotice(peerId:string,id:string):boolean{
                                            
    const changed=statement(this.db,'UPDATE context_notices SET acknowledged=2 WHERE id=? AND recipient=? AND acknowledged=0').run(id,peerId).changes>0;
    if(changed)this.event('context.notice.admitted',{noticeId:id,peerId,state:'unknown'});return changed;
  }

  accept(pair: Pair, sender: Peer, body: string, callId: string, inReplyTo?: string, via?: string,replySource:'explicit'|'auto'='explicit',replyExpected=false): Message {
    return this.transaction(()=>{
      const previous=statement(this.db,'SELECT '+messageFields+' FROM messages WHERE sender=? AND call_id=?').get(sender.id,callId);
      if(previous){const m=messageFrom(previous);if(m.pairId!==pair.id||m.body!==body||m.inReplyTo!==(inReplyTo??null)||!!m.replyExpected!==replyExpected)throw new BridgeError('idempotency_conflict','同一次工具调用不能改变配对、消息正文或回复约定。');return m;}
      if(!body.trim()||Buffer.byteLength(body)>256*1024)throw new BridgeError('invalid_message','消息不能为空，且不能超过 256 KiB；长内容请使用摘要和文件引用。');
      const to=pair.claude===sender.id?pair.codex:pair.codex===sender.id?pair.claude:null;
      if(!to)throw new BridgeError('unpaired','当前会话不是已配对成员。');
      if(this.pairFor(sender.id)?.id!==pair.id)throw new BridgeError('unpaired','原配对已解除，不能向旧搭档发送。');
      if(inReplyTo){const original=this.message(inReplyTo);if(original.pairId!==pair.id||original.from!==to||original.to!==sender.id)throw new BridgeError('invalid_reply','回复关联必须指向当前搭档发来的消息。');}
      const id=randomUUID(),now=Date.now();
      statement(this.db,'INSERT INTO messages(id,pair_id,sender,recipient,body,in_reply_to,via,call_id,state,created_at,updated_at,reply_expected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,pair.id,sender.id,to,body,inReplyTo??null,via??null,callId,'accepted',now,now,replyExpected?1:0);
      if(inReplyTo)statement(this.db,'UPDATE messages SET reply_source=? WHERE id=?').run(replySource,id);
      if(inReplyTo)this.transition(inReplyTo,'responded','搭档明确关联回复');
      this.event('message.accepted',{messageId:id,pairId:pair.id,from:sender.id,to},[sender.id,to]);return this.message(id);
    });
  }
  message(id: string): Message {const r=statement(this.db,'SELECT '+messageFields+' FROM messages WHERE id=?').get(id);if(!r)throw new BridgeError('message_missing','消息不存在。');return messageFrom(r);}
  messageByCall(sender:string,callId:string):Message|undefined{const r=statement(this.db,'SELECT '+messageFields+' FROM messages WHERE sender=? AND call_id=?').get(sender,callId);return r?messageFrom(r):undefined;}
  messages(limit=100): Message[] {return statement(this.db,'SELECT '+messageFields+' FROM messages ORDER BY rowid DESC LIMIT ?').all(limit).map(messageFrom).reverse();}
  messagesFor(pairId:string):Message[]{return statement(this.db,'SELECT '+messageFields+' FROM messages WHERE pair_id=? ORDER BY rowid').all(pairId).map(messageFrom);}
  recoveryMessageIds(pairId:string,peerId:string,since=0):string[]{
                                            
    return this.sinceLastSendRows(pairId,peerId,since,'id').map(row=>row.id as string);
  }
  seenSinceLastSendFacts(pairId:string,peerId:string,since=0):MessageFacts[]{
    const contract=this.setting<{at:number;boundary:string[]}>('replyContract:'+peerId);if(!contract)return[];
    return this.sinceLastSendRows(pairId,peerId,Math.max(since,contract.at),factColumns,contract).map(factsFrom);
  }
  private sinceLastSendRows(pairId:string,peerId:string,since:number,columns:string,contract?:{at:number;boundary:string[]}):Row[]{
    const boundary=contract?' AND NOT(updated_at=? AND id IN (SELECT value FROM json_each(?)))':'';
    return statement(this.db,'SELECT '+columns+" FROM messages WHERE pair_id=? AND recipient=? AND state='contextObserved' AND updated_at>=? AND rowid>COALESCE((SELECT rowid FROM messages WHERE pair_id=? AND sender=? ORDER BY rowid DESC LIMIT 1),0)"+boundary+' ORDER BY rowid DESC LIMIT 3').all(pairId,peerId,since,pairId,peerId,...(contract?[contract.at,JSON.stringify(contract.boundary)]:[]));
  }
  expectedReplyFacts(pairId:string,peerId:string,since=0):MessageFacts[]{
    const contract=this.setting<{at:number;boundary:string[]}>('replyContract:'+peerId);if(!contract)return[];
    return expectedReplyRows(this.db,pairId,peerId,since,contract).map(factsFrom);
  }
  deliveryIssueFacts(pairId:string,recipient:string):MessageFacts[]{
    return deliveryIssueRows(this.db,pairId,recipient).map(factsFrom);
  }
  lastMessageFacts(pairId:string,sender:string):MessageFacts|undefined{const row=statement(this.db,'SELECT '+factColumns+' FROM messages WHERE pair_id=? AND sender=? ORDER BY rowid DESC LIMIT 1').get(pairId,sender);return row?factsFrom(row):undefined;}
  hasQueuedMessages(pairId:string,recipient:string):boolean{return!!statement(this.db,"SELECT 1 FROM messages WHERE pair_id=? AND recipient=? AND state IN ('accepted','sending','runtimeQueued') LIMIT 1").get(pairId,recipient);}
  adoptReplyContract(peerId:string,source:'mcp'|'mod'):void{
    this.transaction(()=>{
      const key='replyContract:'+peerId;if(this.setting(key))return;
      this.peer(peerId);const at=Date.now();
                                              
      const boundary=statement(this.db,"SELECT id FROM messages WHERE recipient=? AND state='contextObserved' AND updated_at=?").all(peerId,at).map(row=>row.id as string);
      this.setSetting(key,{at,boundary,source});this.event('reply.contract.loaded',{peerId,at,source});
    });
  }
  seenUnanswered(pairId:string,peerId:string,since=0):Message[]{
    return this.unansweredRows(pairId,peerId,since,true).map(messageFrom);
  }
  seenUnansweredFacts(pairId:string,peerId:string,since=0):MessageFacts[]{return this.unansweredRows(pairId,peerId,since,false).map(factsFrom);}
  private unansweredRows(pairId:string,peerId:string,since:number,body:boolean):Row[]{
    const contract=this.setting<{at:number;boundary:string[]}>('replyContract:'+peerId);if(!contract)return[];
    const boundary=new Set(contract.boundary);
    return statement(this.db,'SELECT '+(body?messageFields:factColumns)+" FROM messages WHERE pair_id=? AND recipient=? AND state='contextObserved' AND updated_at>=? ORDER BY rowid").all(pairId,peerId,Math.max(since,contract.at)).filter(row=>row.updated_at!==contract.at||!boundary.has(row.id as string));
  }
  referenceCandidates(peerId:string,pairId?:string):{kind:'msg'|'agent';id:string;text:string}[]{
    const messages=pairId?statement(this.db,"SELECT id,CAST(COALESCE((SELECT json_extract(value,'$') FROM settings WHERE key='ref:message:'||m.id),body) AS BLOB) AS text FROM messages m WHERE pair_id=? AND (snapshot_required=0 OR EXISTS (SELECT 1 FROM settings WHERE key='ref:message:'||m.id)) ORDER BY rowid DESC LIMIT 128").all(pairId):[];
    const prefix='ref:agent:'+peerId+':',agents=statement(this.db,'SELECT key,value FROM settings WHERE substr(key,1,?)=? ORDER BY updated_at DESC,rowid DESC LIMIT 128').all(prefix.length,prefix);
    return[...messages.map(r=>({kind:'msg' as const,id:r.id as string,text:sqliteText(r.text)})),...agents.map(r=>({kind:'agent' as const,id:(r.key as string).slice(prefix.length),text:JSON.parse(r.value as string) as string}))];
  }
  deliveryCounts(pairId:string,senderId:string):DeliveryCounts{
    const counts=emptyDeliveryCounts();
    for(const r of statement(this.db,'SELECT state,count(*) AS count FROM messages WHERE pair_id=? AND sender=? GROUP BY state').all(pairId,senderId))if(Object.hasOwn(counts,r.state as string))counts[r.state as keyof DeliveryCounts]=Number(r.count);
    return counts;
  }
  deliveryAdmissionCounts(pairId:string,senderId:string):{held:number;expired:number;refused:number;unknown:number;latest_at?:number}{
    const counts={held:0,expired:0,refused:0,unknown:0},rows=statement(this.db,"SELECT state,count(*) AS count,max(updated_at) AS latest FROM messages WHERE pair_id=? AND sender=? AND state IN ('held','expired','refused','unknown') GROUP BY state").all(pairId,senderId);let latest:number|undefined;
    for(const row of rows){const state=row.state as keyof typeof counts;counts[state]=Number(row.count);if(state==='expired'||state==='refused')latest=Math.max(latest??0,Number(row.latest));}
    return{...counts,...(latest===undefined?{}:{latest_at:latest})};
  }
  deliveryDependencySince(pairId:string,recipientId:string):number|undefined{
                                                  
    const times=[...this.deliveryIssueFacts(pairId,recipientId).filter(message=>['accepted','sending','runtimeQueued','held','unknown'].includes(message.state)).map(message=>message.createdAt),...this.expectedReplyFacts(pairId,recipientId).map(message=>message.updatedAt)];
    return times.length?Math.min(...times):undefined;
  }
  uncertain(): Message[] {return statement(this.db,'SELECT '+messageFields+" FROM messages WHERE state='unknown' ORDER BY rowid").all().map(messageFrom);}
  reconcilable(peerId?:string):{id:string;to:string}[]{return statement(this.db,"SELECT id,recipient FROM messages WHERE state IN ('unknown','runtimeQueued')"+(peerId?' AND recipient=?':'')+' ORDER BY rowid').all(...(peerId?[peerId]:[])).map(r=>({id:r.id as string,to:r.recipient as string}));}
  recoverEmbeddedReceipts():void{
    this.transaction(()=>{for(const row of statement(this.db,"SELECT id,sender,recipient FROM messages WHERE state='runtimeQueued' AND evidence=? AND recipient IN (SELECT id FROM peers WHERE host='codex')").all('宿主 PostToolUse 确认取件工具完成'))if(memberEnabled(this,this.peer(row.sender as string))&&memberEnabled(this,this.peer(row.recipient as string)))this.transition(row.id as string,'contextObserved','历史宿主 PostToolUse 回执确认取件输出进入上下文；修正旧版 queued 状态');});
  }
  restartUnsettled(peerId:string,absent?:ReadonlySet<string>,options:{verifiedUnknown?:ReadonlyMap<string,{attempts:number;updatedAt:number}>;checkUnknown?:boolean}={}):{id:string;state:string}|undefined{
    const sql="SELECT id,state FROM messages WHERE recipient=? AND state IN ('sending','runtimeQueued','held','unknown')";
    if(!absent?.size&&!options.verifiedUnknown?.size&&options.checkUnknown!==false)return statement(this.db,sql+' LIMIT 1').get(peerId) as {id:string;state:string}|undefined;
    const rows=statement(this.db,sql.replace('SELECT id,state','SELECT id,state,attempts,updated_at')).all(peerId);
    const unsettled=rows.find(row=>{
      if(absent?.has(String(row.id))&&['unknown','runtimeQueued'].includes(String(row.state)))return false;
      if(row.state!=='unknown')return true;
      if(options.checkUnknown===false)return false;
      const proof=options.verifiedUnknown?.get(String(row.id));
      return !proof||proof.attempts!==row.attempts||proof.updatedAt!==row.updated_at;
    });
    return unsettled?{id:String(unsettled.id),state:String(unsettled.state)}:undefined;
  }
  subagentRestartUnsettled(peerId:string):{id:string;state:string}|undefined{
    return statement(this.db,"SELECT id,state FROM messages WHERE recipient=? AND state IN ('accepted','sending','runtimeQueued','held','unknown') LIMIT 1").get(peerId) as {id:string;state:string}|undefined;
  }
  partnerRestartUnsettled(pairId:string,recipientId:string,verifiedUnknown?:ReadonlyMap<string,{attempts:number;updatedAt:number}>,checkUnknown=true):{id:string;state:string}|undefined{
    const rows=statement(this.db,"SELECT id,state,attempts,updated_at FROM messages WHERE pair_id=? AND recipient=? AND (state IN ('sending','runtimeQueued','held','unknown') OR (state='accepted' AND attempts>0))").all(pairId,recipientId);
    const unsettled=rows.find(row=>{
      if(row.state!=='unknown')return true;
      if(!checkUnknown)return false;
      const proof=verifiedUnknown?.get(String(row.id));
      return !proof||proof.attempts!==row.attempts||proof.updatedAt!==row.updated_at;
    });
    return unsettled?{id:String(unsettled.id),state:String(unsettled.state)}:undefined;
  }
  pending(peerId?: string): Message[] {return statement(this.db,'SELECT '+joinedMessageFields+" FROM messages m JOIN pairs p ON p.id=m.pair_id AND p.archived=0 AND p.paused=0 WHERE m.state='accepted'"+(peerId?' AND m.recipient=?':'')+' ORDER BY m.rowid').all(...(peerId?[peerId]:[])).map(messageFrom);}
  pendingFacts(peerId?:string):PendingMessageFacts[]{return statement(this.db,"SELECT m.id,m.pair_id,m.recipient,m.attempts FROM messages m JOIN pairs p ON p.id=m.pair_id AND p.archived=0 AND p.paused=0 WHERE m.state='accepted'"+(peerId?' AND m.recipient=?':'')+' ORDER BY m.rowid').all(...(peerId?[peerId]:[])).map(row=>({id:row.id as string,pairId:row.pair_id as string,to:row.recipient as string,attempts:row.attempts as number}));}
  firstPendingId(peerId:string):string|undefined{return statement(this.db,"SELECT m.id FROM messages m JOIN pairs p ON p.id=m.pair_id AND p.archived=0 AND p.paused=0 WHERE m.state='accepted' AND m.recipient=? ORDER BY m.rowid LIMIT 1").get(peerId)?.id as string|undefined;}
                                        
  pendingMessage(facts:PendingMessageFacts):Message|undefined{const row=statement(this.db,'SELECT '+joinedMessageFields+" FROM messages m JOIN pairs p ON p.id=m.pair_id AND p.archived=0 AND p.paused=0 WHERE m.state='accepted' AND m.id=? AND m.pair_id=? AND m.recipient=? AND m.attempts=?").get(facts.id,facts.pairId,facts.to,facts.attempts);return row?messageFrom(row):undefined;}
  inboundApprovals():{message:Message;approval:NativeApproval}[]{return statement(this.db,'SELECT '+joinedMessageFields+",s.value AS approval FROM settings s JOIN messages m ON s.key='claudeApproval:'||m.id WHERE s.value<>'null'").all().flatMap(row=>{const approval=this.decode<NativeApproval>('inbound_approval',String(row.id),String(row.approval));return approval?[{message:messageFrom(row),approval}]:[];});}
  pendingCount(peerId?:string):number{return Number(statement(this.db,"SELECT count(*) AS n FROM messages m JOIN pairs p ON p.id=m.pair_id AND p.archived=0 AND p.paused=0 WHERE m.state='accepted'"+(peerId?' AND m.recipient=?':'')).get(...(peerId?[peerId]:[]))!.n);}
  unsettledDeliveryFacts(pairId:string,senderId:string):{id:string;state:string}[]{return statement(this.db,"SELECT id,state FROM messages WHERE pair_id=? AND sender=? AND state IN ('accepted','sending','runtimeQueued','held','unknown') ORDER BY id").all(pairId,senderId).map(row=>({id:row.id as string,state:row.state as string}));}
  claim(id: string): boolean {const row=statement(this.db,'SELECT recipient FROM messages WHERE id=?').get(id);if(!row)throw new BridgeError('message_missing','消息不存在。');const binding=this.bindings.current(row.recipient as string);if(binding?.transitioning)return false;return Number(statement(this.db,"UPDATE messages SET state='sending',delivery_epoch=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='accepted'").run(binding?.epoch??null,Date.now(),id).changes)===1;}
  retireQueuedDelivery(id:string,evidence:string):void{
                                        
    const row=statement(this.db,"UPDATE messages SET state='unknown',evidence=?,error=NULL,updated_at=? WHERE id=? AND state='runtimeQueued' RETURNING sender,recipient").get(evidence,Date.now(),id);
    if(row)this.event('message.state',{messageId:id,state:'unknown',evidence},[row.sender as string,row.recipient as string]);
  }
  transition(id: string,state: DeliveryState,evidence?: string,error?: string): void {
    const message=this.message(id),before=message.state;
                                             
    if(before==='responded'||(before==='contextObserved'&&state!=='responded')||(['refused','expired'].includes(before)&&!['contextObserved','responded'].includes(state))||(before==='runtimeQueued'&&['accepted','sending','unknown'].includes(state))||(before==='held'&&['accepted','sending','unknown'].includes(state)))return;
    if(before===state)return;
    statement(this.db,'UPDATE messages SET state=?,evidence=?,error=?,updated_at=? WHERE id=?').run(state,evidence??null,error??null,Date.now(),id);
    this.event('message.state',{messageId:id,state,evidence,error},[message.from,message.to]);
    if(state==='contextObserved'||state==='responded')this.onDeliveryObserved?.({...message,state,updatedAt:Date.now()});
  }
  recover(): void {for(const row of statement(this.db,"SELECT id,sender,recipient FROM messages WHERE state='sending'").all())this.faults.sync('message_recover:'+row.id,()=>this.transaction(()=>{if(memberEnabled(this,this.peer(row.sender as string))&&memberEnabled(this,this.peer(row.recipient as string)))this.transition(row.id as string,'unknown',undefined,'协调器在提交确认完成前退出，需要核对目标历史');}));}
}
