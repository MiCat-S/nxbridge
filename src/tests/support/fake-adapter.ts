import { EventEmitter } from 'node:events';
import type { DeliveryResult, Endpoint, Message, Peer, PermissionClass, RegisterInput } from '../../types.js';
import type { CodexContextReceipt } from '../../hosts/codex/adapter.js';
import type {RuntimeAvailability} from '../../broker/health/contracts.js';
import { registration } from './registration.js';

export class FakeAdapter extends EventEmitter{
  delivered:Message[]=[];
  fail?:Error;
  created:Peer[]=[];
  released:Peer[]=[];
  runtimeReleased=false;
  attached:{peer:Peer;endpoint:Endpoint}[]=[];
  attachFailure?:Error;
  ensured=0;
  woken:Peer[]=[];
  connected:string[]=[];
  private injectionReceipts:(CodexContextReceipt&{callId:string})[]=[];
  private injectionTurn=0;
  injectedNotices:{id:string;body:string}[]=[];
  injected:{callId:string;output:string}[]=[];
  async injectionState(peer:Peer,_endpoint:Endpoint){return{thread:{id:peer.sessionId!,cwd:peer.cwd,status:{type:peer.state==='busy'?'active':'idle'},turns:this.injectionTurn?[{id:'injection-turn-'+this.injectionTurn,status:'completed'}]:[]},history:{status:'supported' as const,receipts:this.injectionReceipts,calls:this.injectionReceipts.map(receipt=>receipt.callId),cursor:{dev:1,ino:1,offset:0},complete:true}};}
  async inject(peer:Peer,_endpoint:Endpoint,callId:string,output:string){
    if(this.fail)throw this.fail;
    this.injected.push({callId,output});
    const value=JSON.parse(output);
    for(const message of value.messages??[]){this.injectionReceipts.push({messageId:message.message_id,callId,turnId:'persisted-history',itemId:callId});this.delivered.push({id:message.message_id,body:message.message,to:peer.id} as Message);}
    for(const notice of value.notices??[]){this.injectionReceipts.push({messageId:notice.notice_id,callId,turnId:'persisted-history',itemId:callId});this.injectedNotices.push({id:notice.notice_id,body:notice.message});}
  }
  async continueInjected(peer:Peer,_endpoint:Endpoint){if(this.fail)throw this.fail;this.woken.push(peer);return'injection-turn-'+(++this.injectionTurn);}
  async probe(_peer:Peer):Promise<RuntimeAvailability>{return{state:'reachable',reasons:[],checked_at:Date.now()};}
  async connect(address:string){this.connected.push(address);return{request:async()=>({})};}
  async attach(peer:Peer,endpoint:Endpoint){
    this.attached.push({peer,endpoint});if(this.attachFailure)throw this.attachFailure;
    this.emit('register',registration(peer.host,peer.sessionId!,{state:'ready',endpoint}),peer.id);return{request:async()=>({})};
  }
  async observe(peer:Peer,endpoint:Endpoint){await this.attach(peer,endpoint);}
  async observeActive(peer:Peer,endpoint:Endpoint){await this.attach(peer,endpoint);}
  hasSubscription(_peer:Peer,_endpoint:Endpoint):boolean{return false;}
  userSubscriptions():{peer:Peer;endpoint:Endpoint}[]{return[];}
  async releaseIdle(_peer:Peer,_endpoint:Endpoint,_guard:()=>boolean,_closing=false):Promise<'retained'|'released'|'unloaded'|'idle'>{return'retained';}
  async ensureEndpoint(_cwd?:string,_peerId?:string,_requesterSession?:string,_sessionId?:string,_configHome?:string,beforeLaunch?:()=>void|Promise<void>){await beforeLaunch?.();this.ensured++;return'new-endpoint';}
  async wake(peer:Peer,_endpoint?:Endpoint,_signal?:AbortSignal,beforeSubmit?:()=>Promise<boolean|void>){if(this.fail)throw this.fail;if(beforeSubmit&&await beforeSubmit()===false)return;this.woken.push(peer);}
  async discover(sessionId:string):Promise<RegisterInput|undefined>{const input=registration('claude',sessionId,{state:'ready'});return{...input,endpoint:{...input.endpoint,nativePermission:{mode:'bypassPermissions',permission:'bypass',observedAt:Date.now()},nativeInbound:{policy:'accept',source:'flag',observedAt:Date.now()}}};}
  async deliver(_p:Peer,_e:unknown,m:Message & {beforeSubmit?:()=>Promise<boolean>}):Promise<DeliveryResult>{if(this.fail)throw this.fail;if(m.beforeSubmit&&!await m.beforeSubmit())return{state:'expired',evidence:'通知条件已失效'};this.delivered.push(m);return{state:'runtimeQueued',evidence:'模拟宿主接受'};}
  async create(peer:Peer,requesterOrGuard?:string|(()=>void|Promise<void>),guardOrPermission?:PermissionClass|(()=>void|Promise<void>),permissionOrCreate?:PermissionClass|(()=>void|Promise<void>),beforeCreate?:()=>void|Promise<void>):Promise<any>{
    const guard=typeof requesterOrGuard==='function'?requesterOrGuard:typeof guardOrPermission==='function'?guardOrPermission:undefined;
    await guard?.();await(typeof permissionOrCreate==='function'?permissionOrCreate:beforeCreate)?.();
    this.created.push(peer);return peer.host==='claude'?'implicit-'+peer.id:registration(peer.host,'implicit-'+peer.id);
  }
  async reconcile(_peer:Peer,_endpoint:Endpoint):Promise<CodexContextReceipt[]>{return[];}
  async release(peer:Peer){this.released.push(peer);}
  async releaseRuntime(){this.runtimeReleased=true;}
  close(){}
}
