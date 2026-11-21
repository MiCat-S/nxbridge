import { randomUUID } from 'node:crypto';
import type { Store } from '../../storage/store.js';
import type { Endpoint, Peer, RegisterInput } from '../../types.js';
import {BridgeError} from '../../shared/errors.js';
import { codexArguments, codexAppServerArguments, liveProcess, processAncestors, processIdentity, probeProcesses } from '../../process/process.js';
import { registrationWindow } from '../../integration/hooks/session-bindings.js';
import { hostingRecord, writeHosting } from './session-hosting.js';
import {sameDirectory} from '../../shared/files.js';

export interface Takeover {id:string;peerId:string;pairId:string;sessionId:string;kind:'remote'|'child';startedAt:number;endpoint?:Endpoint;foreground?:{pid:number;procStart:string};controller?:{pid:number;procStart:string};handle?:string;nextObservation?:number;handoffId?:string;adopted?:{endpoint?:Endpoint;retirementChecked?:boolean}}
const key=(peerId:string)=>'takeover:'+peerId;
export function foregroundMatchesTakeover(value:Takeover,host:Peer['host'],args:string[]):boolean{
  if(codexAppServerArguments(args))return false;
  if(host==='codex'&&value.kind==='remote')return !!value.endpoint&&args.some((arg,index)=>arg==='--remote='+value.endpoint!.address||arg==='--remote'&&args[index+1]===value.endpoint!.address);
  return value.handle?args.includes('attach')&&args.includes(value.handle):args.includes(value.sessionId)&&args.some(arg=>['--resume','--session-id'].includes(arg));
}
async function observeForeground(store:Store,value:Takeover,host:Peer['host']):Promise<Takeover['foreground'][]|undefined>{
  const rows=[...new Map([
    ...store.bindings.all().filter(binding=>binding.host===host&&binding.sessionId===value.sessionId).map(binding=>({pid:binding.pid,startedAt:binding.procStart})),
    ...store.endpoints(value.peerId).flatMap(endpoint=>endpoint.native?[{pid:endpoint.native.pid,startedAt:endpoint.native.procStart}]:!endpoint.daemon&&endpoint.mode!=='app-server'&&endpoint.pid&&endpoint.procStart?[{pid:endpoint.pid,startedAt:endpoint.procStart}]:[])
  ].map(row=>[row.pid+':'+row.startedAt,row])).values()];
  const states=await probeProcesses(rows.map(row=>({pid:row.pid,procStart:row.startedAt})));if(states.includes('unknown'))return;
  const candidates=await Promise.allSettled(rows.filter((_row,index)=>states[index]==='alive').map(async row=>{const native=await processIdentity(row.pid),args=await codexArguments(native,1500);if(native.startedAt!==row.startedAt)throw new BridgeError('process_identity_unknown','前台观察期间原生代次改变。');return foregroundMatchesTakeover(value,host,args)?{pid:native.pid,procStart:native.startedAt}:undefined;}));
  if(candidates.some(result=>result.status==='rejected'))return;
  return candidates.flatMap(result=>result.status==='fulfilled'&&result.value?[result.value]:[]);
}
                                
export class Takeovers {
  constructor(private store:Store,private probe=probeProcesses,private observe=(value:Takeover,host:Peer['host'])=>observeForeground(store,value,host),private sessionState?:(peer:Peer)=>Promise<'alive'|'dead'|'unknown'>,private alive=liveProcess,private ancestors=processAncestors){}
  get(id:string):Takeover|undefined{return this.store.setting(key(id));}
  async registration(input:RegisterInput):Promise<Peer|undefined>{
    const window=registrationWindow(input);if(!window||input.kind==='subagent')return;
    const candidates=this.store.peers().filter(peer=>peer.host===input.host&&peer.sessionId===input.sessionId&&this.store.endpoints(peer.id).some(endpoint=>endpoint.configHome&&sameDirectory(endpoint.configHome,window.configHome))).flatMap(peer=>{const lease=this.get(peer.id);return lease?.kind==='child'&&!lease.adopted&&lease.sessionId===input.sessionId&&lease.pairId===this.store.pairFor(peer.id)?.id?[{peer,lease}]:[];});
    if(!candidates.length)return;
    if(candidates.length!==1)throw new BridgeError('foreground_active','同一会话有多个接管记录，未改写归属。');
    const {peer,lease}=candidates[0]!,holder=lease.foreground??lease.controller;
    const binding=this.store.bindings.current(peer.id);
    if(binding?.sessionId===input.sessionId&&binding.pid===window.pid&&binding.procStart===window.procStart&&sameDirectory(binding.configHome,window.configHome)||this.store.endpoints(peer.id).some(endpoint=>endpoint.active&&endpoint.pid===window.pid&&endpoint.procStart===window.procStart&&endpoint.configHome&&sameDirectory(endpoint.configHome,window.configHome)))return;
    if(!holder)return;
    const chain=await this.ancestors(window.pid,16);
    if(chain[0]?.startedAt!==window.procStart||!chain.some(identity=>identity.pid===holder.pid&&identity.startedAt===holder.procStart))return;
    const current=this.get(peer.id),currentHolder=current?.foreground??current?.controller;
    if(!current)return;
    if(current?.id!==lease.id||this.store.peer(peer.id).sessionId!==input.sessionId||this.store.pairFor(peer.id)?.id!==lease.pairId)throw new BridgeError('session_changed','接管核验期间会话或配对已经改变。');
    if(!currentHolder||!chain.some(identity=>identity.pid===currentHolder.pid&&identity.startedAt===currentHolder.procStart))throw new BridgeError('foreground_active','接管启动身份已经改变，未接纳其他窗口。');
                                           
    const adopted=this.store.adopt(peer.id,input);this.store.updatePeer(peer.id,{owner:'nxbridge'});return this.store.peer(adopted.id);
  }
  begin(peer:Peer,endpoint?:Endpoint,handoffId?:string,controller?:Takeover['controller'],handle?:string):Takeover{
    const pair=this.store.pairFor(peer.id);if(!pair||!peer.sessionId)throw new BridgeError('session_changed','接管目标已改变。');
    if(this.get(peer.id))throw new BridgeError('foreground_active','原接管仍未结束，请返回已经打开的窗口。');
    const value:Takeover={id:randomUUID(),peerId:peer.id,pairId:pair.id,sessionId:peer.sessionId,kind:handoffId?'child':'remote',startedAt:Date.now(),endpoint,handoffId,controller,handle};
    this.store.setSetting(key(peer.id),value);this.store.event('takeover.requested',{peerId:peer.id,leaseId:value.id,sessionId:peer.sessionId});return value;
  }
  claim(peerId:string,id:string,foreground:{pid:number;procStart:string}):void{
    const value=this.get(peerId),peer=this.store.peer(peerId);
    if(!value||value.id!==id||peer.sessionId!==value.sessionId||this.store.pairFor(peerId)?.id!==value.pairId)throw new BridgeError('session_changed','接管目标已改变，未改写后台归属。');
    if(value.foreground&&(value.foreground.pid!==foreground.pid||value.foreground.procStart!==foreground.procStart))throw new BridgeError('foreground_active','此接管已登记另一原生窗口。');
    this.store.setSetting(key(peerId),{...value,foreground});this.store.event('takeover.spawned',{peerId,leaseId:id,pid:foreground.pid});
  }
  async returned(peerId:string,id:string,foregroundEnded=false):Promise<boolean>{
    const value=this.get(peerId);if(!value)return true;if(value.id!==id)return false;
    const backend=value.endpoint?.pid&&value.endpoint.procStart?{pid:value.endpoint.pid,procStart:value.endpoint.procStart}:undefined;
    const identities=[...(value.foreground?[value.foreground]:[]),...(backend?[backend]:[])];
                                   
    const states=identities.every(native=>this.alive(native.pid))?identities.map(()=>'alive' as const):await this.probe(identities);
    const tui=value.foreground?states[0]:undefined,server=backend?states.at(-1):undefined;
    let observedAbsent=false;
    if(!value.foreground&&!foregroundEnded&&(value.adopted||value.controller&&!liveProcess(value.controller.pid)&&Date.now()-value.startedAt>=5000)&&(value.nextObservation??0)<=Date.now()){
      value.nextObservation=Date.now()+30000;this.store.setSetting(key(peerId),value);
      const matches=await this.observe(value,this.store.peer(peerId).host);if(!matches)return false;
      if(this.get(peerId)?.id!==id)return false;
      if(matches.length===1){this.claim(peerId,id,matches[0]!);return false;}
                                              
      observedAbsent=matches.length===0&&await this.sessionState?.(this.store.peer(peerId))==='dead';
    }
    if(tui!=='dead'&&!(foregroundEnded&&!value.foreground)&&!observedAbsent&&!(value.kind==='remote'&&server==='dead'))return false;
    if(this.get(peerId)?.id!==id)return false;
    this.store.setSetting(key(peerId),null);this.store.event('takeover.returned',{peerId,leaseId:id,backend:server??'unknown'});return true;
  }
}

                                          
export function recordManagedAdoption(store:Store,peer:Peer,input:RegisterInput,original?:Endpoint):void{
  if(peer.host==='codex'&&hostingRecord(store,peer)?.released){writeHosting(store,peer,{phase:undefined,verified:true,reason:undefined});return;}
  if(store.setting(key(peer.id)))throw new BridgeError('foreground_active','原接管尚未结束，未覆盖其租约。');
  const pair=store.pairFor(peer.id);if(!pair||!peer.sessionId)throw new BridgeError('session_changed','原配对已改变。');
  const window=registrationWindow(input),endpoint=store.endpoint(peer.id);
  const lease:Takeover={id:randomUUID(),peerId:peer.id,pairId:pair.id,sessionId:peer.sessionId,kind:'remote',startedAt:Date.now(),...(endpoint?{endpoint}:{}),...(window?{foreground:{pid:window.pid,procStart:window.procStart}}:{}),adopted:{endpoint:original}};
  store.setSetting(key(peer.id),lease);store.setSetting('managedAdopted:'+peer.id,{at:Date.now(),sessionId:peer.sessionId});store.event('takeover.adopted',{peerId:peer.id,leaseId:lease.id,sessionId:peer.sessionId});
}
