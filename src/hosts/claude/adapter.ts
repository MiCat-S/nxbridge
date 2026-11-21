import net from 'node:net';
import {unlinkSync,chmodSync} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {BridgeError} from '../../shared/errors.js';
import {type BridgeConfig,type DeliveryResult,type Endpoint,type Peer,type RegisterInput} from '../../types.js';
import {bridgeHome} from '../../shared/local-paths.js';
import {delay} from '../../shared/time.js';
import {readJson} from '../../shared/files.js';
import {runCli} from '../../process/host-command.js';
import { prepareOwnedLaunch, recordHostLaunch, selectHostLaunch } from '../host-launch.js';
import { selectSessionLaunch } from '../session-launch.js';
import {liveProcess,processIdentity,matchesProcess} from '../../process/process.js';
import type { DeliveryMessage } from '../../broker/delivery/file-references.js';
import { deliverClaudeInbox, type SessionRecord } from './claude-inbox.js';
export { canonicalPipe, peerKeyFile, peerAddress, encodePeerMessage, type SessionRecord } from './claude-inbox.js';
import { claudeBackground, claudeBackgroundMode, requireClaudeBackground } from './claude-capability.js';
import { claudeChild, childCall, ensureClaudeChild, findClaudeChild, stopClaudeChild } from './claude-child.js';
import {probePeerRuntime} from '../../broker/health/probe.js';
import {type RuntimeAvailability} from '../../broker/health/contracts.js';
import { beginNativeLaunch, bindNativeLaunch, captureNativeProcess, failNativeLaunch, forgetNativeOwnership, nativeLaunchHandle, nativeOwnership, nativeOwnershipForSession, nativeSupervisorAvailable, saveNativeOwnership } from '../../process/owned-native.js';
import { ownedProcesses, releaseOwnedProcess } from '../../process/owned-processes.js';
import { ownedProcessState } from '../../process/process-stop.js';
import type { NativeOwnership } from '../../process/owned-native.js';
import { restoreState } from '../../broker/pairing/pair-restore.js';
import { ownedClaudeArgs } from '../owned-launch-policy.js';
import { requireClaudeBypassConsent } from './claude-autonomy.js';
import type { HostLaunch } from '../host-launch.js';
import { claudeProfileArgs } from '../../broker/profiles/profile-arguments.js';
import { profileChangeFailure } from '../../broker/profiles/partner-profile.js';
import type { PermissionClass } from '../../types.js';
import {claudeRegistration} from './identity.js';

export class ClaudeAdapter extends EventEmitter {
  modelProfile:(peer:Peer)=>import('../../types.js').ModelProfile=()=>({});
  private disabledMembers=new Set<string>();
  setEnabled(peer:Peer,_endpoint:Endpoint|undefined,enabled:boolean):void{if(enabled)this.disabledMembers.delete(peer.id);else this.disabledMembers.add(peer.id);}
  private requireMember(peer:Peer):void{if(this.disabledMembers.has(peer.id))throw new BridgeError('member_disabled','此成员的 nxbridge 已关闭，未访问原生宿主。');}
  private replyListeners=new Map<string,{server:net.Server;address:string}>();
  private registrationProbes=new Map<string,{until:number;work:Promise<NativeOwnership|undefined>}>();
  private nativeRestartWaits=new Map<string,{launchId:string;at:number}>();
  constructor(private config:BridgeConfig,private home=bridgeHome()){super();}
  probe(peer:Peer,endpoint?:Endpoint):Promise<RuntimeAvailability>{return probePeerRuntime(peer,endpoint,this.home);}
  private childMode():boolean{return claudeBackgroundMode(claudeBackground(this.home,this.config))==='child';}
                                                 
  private async submitLaunch(peer:Peer,intent:NativeOwnership,launch:HostLaunch,args:string[],beforeLaunch?:()=>void|Promise<void>,beforeCreate?:()=>void|Promise<void>):Promise<NativeOwnership>{
    let submitted=false;
    try{
      launch.env.NXBRIDGE_OWNED_LAUNCH='claude:'+intent.id;launch.env.NXBRIDGE_MANAGED_PEER=peer.id;
      this.requireMember(peer);
      const output=await runCli('claude',args,{cwd:peer.cwd,home:this.home,config:this.config,launch,timeout:30000,beforeSpawn:async()=>{await beforeLaunch?.();await beforeCreate?.();},onSpawn:()=>{submitted=true;}});
      recordHostLaunch(this.home,'claude-background',launch);
      const result={...intent,handle:nativeLaunchHandle(output)};saveNativeOwnership(result);return result;
    }catch(error){failNativeLaunch(intent,error,!submitted);throw error;}
  }
  async deliver(peer:Peer,endpoint:Endpoint,message:DeliveryMessage,sender:Peer):Promise<DeliveryResult>{
    this.requireMember(peer);
    return deliverClaudeInbox(peer,endpoint,message,sender,()=>endpoint.configHome??selectHostLaunch('claude',this.config,{cwd:peer.cwd,sessionId:peer.sessionId??undefined}).configHome,()=>this.replySocket(path.dirname(endpoint.address)));
  }
  private async replySocket(directory:string):Promise<string>{
    const existing=this.replyListeners.get(directory);if(existing)return existing.address;
    const address=path.join(directory,`${process.pid}-${randomBytes(4).toString('hex')}.sock`);
    const server=net.createServer(socket=>{
      let buffer='';socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{
        buffer+=chunk;if(buffer.length>65536){socket.destroy();return;}
        let index:number;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const receipt=JSON.parse(line);if(receipt.type==='control'&&receipt.action==='peer_message_status')this.emit('receipt',receipt);}catch{}}
      });
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(address,()=>{server.off('error',reject);resolve();});});
    chmodSync(address,0o600);
    this.replyListeners.set(directory,{server,address});return address;
  }
  async create(peer:Peer,beforeLaunch?:()=>void|Promise<void>,sourcePermission:PermissionClass='unknown',beforeCreate?:()=>void|Promise<void>):Promise<string>{
    this.requireMember(peer);
    requireClaudeBackground(this.home,this.config);
    if(this.childMode())return(await ensureClaudeChild(this.home,this.config,peer,beforeLaunch,sourcePermission,beforeCreate,this.modelProfile(peer))).sessionId;
    const name=`nxbridge-${peer.id}`;
    let binding=nativeOwnership(this.home,peer.id);
    const launch=await prepareOwnedLaunch(selectHostLaunch('claude',this.config,{home:this.home,cwd:peer.cwd,configHome:binding?.configHome,executable:binding?.executable,profileId:binding?.profileId}));
    if(binding?.phase==='failed'){forgetNativeOwnership(binding);binding=undefined;}
    if(binding){
      if(binding.releasedToUser)throw new BridgeError('process_owned_by_user','该后台会话已经交给用户窗口，未自动恢复。');
      const before=await this.list(undefined,launch.configHome);
      this.requireMember(peer);
      const launched=before.filter(value=>value.id===binding!.handle&&value.kind==='background');
      if(launched.length===1){const bound=binding.phase==='intent'?await bindNativeLaunch(binding,launched[0]):await captureNativeProcess(binding,launched[0]);return bound.sessionId!;}
      if(binding.phase==='bound'&&binding.sessionId){await this.wake({...peer,sessionId:binding.sessionId},undefined,undefined,beforeLaunch);return binding.sessionId;}
      throw new BridgeError('claude_start_pending','上次后台启动结果尚未核验；保留启动记录，未重复创建。请运行 doctor。');
    }
    requireClaudeBypassConsent(launch.configHome,peer.cwd);
    for(const note of launch.notes)this.emit('diagnostic',note);
    await beforeLaunch?.();binding={...await beginNativeLaunch(this.home,peer,launch.configHome),executable:launch.executable.command,profileId:launch.profile?.id,hostVersion:launch.profile?.version};saveNativeOwnership(binding);
    const profile=this.modelProfile(peer);
    binding=await this.submitLaunch(peer,binding,launch,['--bg','--name',name,...ownedClaudeArgs(sourcePermission,profile),...claudeProfileArgs(profile)],beforeLaunch,beforeCreate);
    for(let i=0;i<15;i++){
      const agents=await this.list(undefined,launch.configHome);
      const matches=agents.filter(r=>r.id===binding!.handle);
      if(matches.length===1&&matches[0].sessionId){binding=await bindNativeLaunch(binding,matches[0]);return binding.sessionId!;}
      if(matches.length>1)throw new BridgeError('ambiguous_implicit','发现多个同名后台会话，需要人工选择。');
      await delay(300);
    }
    throw new BridgeError('claude_start_pending','后台 Claude 尚未发布可核验的会话身份；检查工作目录信任及插件状态。');
  }
  async list(sessionId?:string,configHome?:string,timeout?:number):Promise<any[]>{const launch=selectHostLaunch('claude',this.config,{home:this.home,sessionId,configHome});if(!await nativeSupervisorAvailable(launch.configHome))return[];return JSON.parse(await runCli('claude',['agents','--json','--all'],{config:this.config,home:this.home,sessionId,launch,timeout}));}
  async setProfile(peer:Peer,_endpoint:Endpoint,profile:import('../../types.js').ModelProfile,guard:()=>void):Promise<import('../../broker/profiles/partner-profile.js').EffectiveModelProfile>{
    let submitted=false;try{
    guard();this.requireMember(peer);
    const child=claudeChild(this.home,peer.id);
    if(peer.owner!=='nxbridge'||child?.phase!=='active'||child.sessionId!==peer.sessionId)throw new BridgeError('profile_change_unsupported','此 Claude 原生后台暂不能在保留会话 ID 的同时切换设置；请在新建搭档时指定。');
    submitted=true;const result=await childCall<import('../../broker/profiles/partner-profile.js').EffectiveModelProfile>(this.home,child,'profile',profile);guard();return result;
    }catch(error){throw profileChangeFailure(error,submitted);}
  }
  async readProfile(peer:Peer):Promise<import('../../broker/profiles/partner-profile.js').EffectiveModelProfile>{
    this.requireMember(peer);const child=claudeChild(this.home,peer.id);
    if(peer.owner!=='nxbridge')throw new BridgeError('process_owned_by_user','只能读取当前自有托管 Claude 的设置。');
    if(child?.phase!=='active'||child.sessionId!==peer.sessionId)throw new BridgeError('claude_child_offline','托管 Claude 尚未就绪，等待原生设置回读。');
    return childCall(this.home,child,'profile.get');
  }
  async corroborateRegistration(input:RegisterInput,proof:NativeOwnership):Promise<NativeOwnership|undefined>{
    if(!proof.handle||proof.releasedToUser||!input.endpoint.pid||!input.endpoint.procStart)return;
    const key=JSON.stringify([proof.id,proof.peerId,proof.handle,proof.configHome,proof.phase,proof.native,input.sessionId,input.endpoint.pid,input.endpoint.procStart]),cached=this.registrationProbes.get(key);if(cached&&cached.until>Date.now())return cached.work;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const probe=(async()=>{
      const matches=(await this.list(input.sessionId,proof.configHome,1000)).filter(agent=>agent.kind==='background'&&agent.id===proof.handle&&agent.sessionId===input.sessionId&&agent.pid===input.endpoint.pid);
      if(matches.length!==1)return;
      const captured=await(proof.phase==='intent'?bindNativeLaunch:captureNativeProcess)(proof,matches[0]);
      return captured.native?.startedAt===input.endpoint.procStart?captured:undefined;
    })();
                                        
    const work=Promise.race([probe,new Promise<undefined>((_resolve,reject)=>{timer=setTimeout(()=>reject(new BridgeError('managed_proof_unverified','后台归属核验超时，保留原启动记录。')),1500);})]).finally(()=>clearTimeout(timer));
                                                 
    const forget=()=>{if(this.registrationProbes.get(key)?.work===work)this.registrationProbes.delete(key);};
    void work.then(result=>{if(!result)forget();},forget);
    this.registrationProbes.set(key,{until:Date.now()+30000,work});if(this.registrationProbes.size>128)this.registrationProbes.delete(this.registrationProbes.keys().next().value!);return work;
  }
  async handle(sessionId:string):Promise<string>{
    const matches=(await this.list(sessionId)).filter(a=>a.sessionId===sessionId);
    if(matches.length!==1||!matches[0].id)throw new BridgeError('ambiguous_background','无法确认唯一的 Claude 原生后台 handle。');
    return matches[0].id;
  }
  async discover(sessionId:string):Promise<RegisterInput|undefined>{
    const child=findClaudeChild(this.home,sessionId);
    if(child){if(child.phase!=='active'||!child.native||!liveProcess(child.native.pid)||(await processIdentity(child.native.pid)).startedAt!==child.native.startedAt)return;return child.registration?{...child.registration,state:child.human?'needsHuman':undefined}:undefined;}
    const binding=nativeOwnershipForSession(this.home,sessionId),directory=selectHostLaunch('claude',this.config,{home:this.home,sessionId,configHome:binding?.configHome}).configHome;
    const live=(await this.list(sessionId,directory)).filter(a=>a.sessionId===sessionId&&a.pid&&liveProcess(a.pid));
    if(live.length>1)throw new BridgeError('ambiguous_endpoint','Claude 同一会话有多个存活实例。');
    if(!live.length)return undefined;
    const agent=live[0],captured:{record?:SessionRecord}={};
    if(binding?.phase==='bound'&&!binding.releasedToUser)await captureNativeProcess(binding,agent,record=>{captured.record=record;});
    else{const record=readJson<SessionRecord>(path.join(directory,'sessions',`${agent.pid}.json`));if(record.sessionId!==sessionId||!matchesProcess(record,await processIdentity(agent.pid)))return undefined;captured.record=record;}
    const record=captured.record;if(!record?.messagingSocketPath)return undefined;
    const registration=claudeRegistration({record,pid:agent.pid},record.messagingSocketPath);registration.endpoint.configHome=directory;
    return{...registration,state:agent.status==='waiting'?'needsHuman':agent.status==='busy'?'busy':'ready'};
  }
  async wake(peer:Peer,_endpoint?:Endpoint,_signal?:AbortSignal,beforeLaunch?:()=>void|Promise<void>,affinity?:{configHome?:string;executable?:string;profileId?:string}):Promise<void>{
    this.requireMember(peer);
    requireClaudeBackground(this.home,this.config);
    if(this.childMode()||peer.sessionId&&findClaudeChild(this.home,peer.sessionId)){await ensureClaudeChild(this.home,this.config,peer,beforeLaunch);return;}
    let binding=nativeOwnership(this.home,peer.id);
    if(binding?.sessionId&&binding.sessionId!==peer.sessionId)throw new BridgeError('session_changed','后台启动记录属于后继会话，未恢复旧会话或覆盖启动记录。');
    const agents=await this.list(peer.sessionId??undefined,affinity?.configHome??binding?.configHome);
    if(binding?.releasedToUser)throw new BridgeError('process_owned_by_user','该后台会话已经交给用户窗口，未自动恢复。');
    if(binding?.phase==='intent'){
      const launched=agents.filter(a=>a.kind==='background'&&a.id===binding!.handle&&a.sessionId===peer.sessionId);
      if(launched.length!==1)throw new BridgeError('claude_start_pending','上次后台启动结果尚未核验，未重复恢复。');
      binding=await bindNativeLaunch(binding,launched[0]);
    }
    const live=agents.filter(a=>a.sessionId===peer.sessionId&&a.pid&&liveProcess(a.pid));
    if(live.length>1)throw new BridgeError('ambiguous_endpoint','同一 Claude 会话存在多个在线实例，未恢复或停止。');
    const existing=live[0];
    if(existing){
      this.nativeRestartWaits.delete(peer.id);
      if(existing.kind!=='background')throw new BridgeError('process_owned_by_user','该会话已由前台窗口运行，未认领用户窗口。');
      if(binding?.phase==='bound'){await captureNativeProcess(binding,existing);return;}
      const actual=await processIdentity(existing.pid);
      if(ownedProcesses(this.home).records.some(value=>!value.releasedToUser&&value.role==='claude-native'&&value.peerId===peer.id&&value.identity.pid===actual.pid&&value.sessionId===peer.sessionId&&value.identity.startedAt===actual.startedAt))return;
      throw new BridgeError('claude_launch_unverified','同一会话的在线进程不是 nxbridge 启动的，未认领用户窗口。');
    }
    if(binding?.native&&await ownedProcessState(binding.native)!=='dead')throw new BridgeError('claude_start_pending','原后台进程尚未核验退出，未重复恢复。');
    if(binding){
                                                                    
      const managed=agents.some(agent=>agent.kind==='background'&&agent.id===binding!.handle&&agent.sessionId===peer.sessionId&&['working','blocked'].includes(agent.state));
      const controllers=ownedProcesses(this.home).records.filter(value=>value.role==='claude-native'&&!value.releasedToUser&&value.peerId===peer.id&&value.sessionId===peer.sessionId&&value.proof.launchId===binding!.id&&(value.identity.pid!==binding!.native?.pid||value.identity.startedAt!==binding!.native?.startedAt));
      const rebuilding=managed||(await Promise.all(controllers.map(value=>ownedProcessState(value.identity)))).some(state=>state!=='dead');
      const current=nativeOwnership(this.home,peer.id);
      if(current?.id!==binding.id||current.releasedToUser)throw new BridgeError('process_record_changed','核验退出期间后台归属已改变，未重复恢复。');
      if(rebuilding){
        let wait=this.nativeRestartWaits.get(peer.id);if(wait?.launchId!==binding.id){wait={launchId:binding.id,at:Date.now()};this.nativeRestartWaits.set(peer.id,wait);}
        if(Date.now()-wait.at>=60000)throw new BridgeError('claude_native_recovery_waiting','后台 Claude 的原会话超过一分钟没有恢复，配对和消息都已保留；需要先在 Claude 的后台列表里停止这个原会话（claude stop），nxbridge 随后会自动接着运行。');
        throw new BridgeError('claude_start_pending','原后台管理器或 PTY 正在恢复同一会话，等待它重新发布 Claude 身份，未重复启动。');
      }
    }
    this.nativeRestartWaits.delete(peer.id);
    const launch=await prepareOwnedLaunch(await selectSessionLaunch('claude',this.config,{home:this.home,cwd:peer.cwd,sessionId:peer.sessionId??undefined,configHome:affinity?.configHome??binding?.configHome,executable:binding?.executable??affinity?.executable,profileId:binding?.profileId??affinity?.profileId}));
    if(restoreState(peer,launch.configHome)==='gone')throw new BridgeError('session_not_found','原配置目录中没有该 Claude 会话，请先在原生窗口恢复原会话。');
    let intent:NativeOwnership={...await beginNativeLaunch(this.home,peer,launch.configHome),executable:launch.executable.command,profileId:launch.profile?.id,hostVersion:launch.profile?.version};saveNativeOwnership(intent);
    intent=await this.submitLaunch(peer,intent,launch,['--resume',peer.sessionId!,'--bg'],beforeLaunch);
    for(let i=0;i<20;i++){
      const matches=(await this.list(peer.sessionId??undefined,launch.configHome)).filter(a=>a.sessionId===peer.sessionId&&a.id===intent.handle);
      if(matches.length===1&&matches[0].pid&&liveProcess(matches[0].pid)){await bindNativeLaunch(intent,matches[0]);return;}
      await delay(250);
    }
    throw new BridgeError('resume_identity_mismatch','恢复后没有发现同一 ID 的存活 Claude；保持原配对，请核对是否创建了副本。');
  }
  async createManualCopy(peer:Peer,source:NativeOwnership,beforeLaunch:()=>void|Promise<void>):Promise<string>{
    this.requireMember(peer);
    if(peer.owner!=='nxbridge'||peer.sessionId!==source.sessionId||source.releasedToUser)throw new BridgeError('claude_launch_unverified','自动权限恢复缺少原后台启动证明。');
    if(nativeOwnership(this.home,peer.id))throw new BridgeError('claude_start_pending','后台已有未结算启动，未重复创建权限恢复副本。');
    const launch=await prepareOwnedLaunch(await selectSessionLaunch('claude',this.config,{home:this.home,cwd:peer.cwd,sessionId:peer.sessionId!,configHome:source.configHome,executable:source.executable,profileId:source.profileId}));
    await beforeLaunch();
    let intent:NativeOwnership={...await beginNativeLaunch(this.home,{...peer,sessionId:null},launch.configHome),executable:launch.executable.command,profileId:launch.profile?.id,hostVersion:launch.profile?.version};saveNativeOwnership(intent);
                                                         
    intent=await this.submitLaunch(peer,intent,launch,['--resume',peer.sessionId!,'--bg','--permission-mode','default'],beforeLaunch);
    const registration=await this.manualCopyRegistration(peer);
    if(!registration)throw new BridgeError('claude_start_pending','手动审批后台尚未发布可核验身份；保留启动记录，不重复创建。');
    return registration.sessionId;
  }
  async manualCopyRegistration(peer:Peer):Promise<RegisterInput|undefined>{
    let proof=nativeOwnership(this.home,peer.id);if(!proof?.handle||proof.releasedToUser)return;
    const matches=(await this.list(undefined,proof.configHome,5000)).filter(agent=>agent.id===proof!.handle&&agent.kind==='background');
    if(matches.length!==1||!matches[0].sessionId)return;
    const captured:{record?:SessionRecord}={};
    proof=await(proof.phase==='intent'?bindNativeLaunch:captureNativeProcess)(proof,matches[0],record=>{captured.record=record;});
    const agent=matches[0],record=captured.record;if(!agent.pid||!proof.native||!record?.messagingSocketPath)return;
    const registration=claudeRegistration({record,pid:agent.pid},record.messagingSocketPath);
    return{...registration,endpoint:{...registration.endpoint,configHome:proof.configHome},state:agent.status==='waiting'?'needsHuman':agent.status==='busy'?'busy':'ready'};
  }
  async release(peer:Peer,beforeStop?:(agent:any)=>void|Promise<void>):Promise<void>{
    if(peer.owner!=='nxbridge')throw new BridgeError('process_owned_by_user','用户窗口不由 nxbridge 停止。');
    const child=claudeChild(this.home,peer.id)??(peer.sessionId?findClaudeChild(this.home,peer.sessionId):undefined);if(child){await stopClaudeChild(this.home,child);return;}
    let binding=nativeOwnership(this.home,peer.id);
    if(binding?.phase==='failed'){forgetNativeOwnership(binding);return;}
    const sessionId=peer.sessionId??binding?.sessionId,records=ownedProcesses(this.home).records.filter(value=>value.role==='claude-native'&&value.peerId===peer.id&&(!sessionId||value.sessionId===sessionId));
    if(binding?.releasedToUser)throw new BridgeError('process_owned_by_user','该后台会话已经交给用户窗口，未停止。');
    if(!binding&&!records.length){if(!peer.sessionId)return;throw new BridgeError('claude_launch_unverified','缺少后台会话启动归属，保留进程。请运行 doctor 核对。');}
    if(binding?.sessionId&&peer.sessionId&&binding.sessionId!==peer.sessionId)throw new BridgeError('session_changed','后台归属与要释放的会话不符，未停止。');
    const directory=binding?.configHome??records[0]?.configHome??selectHostLaunch('claude',this.config,{sessionId:sessionId??undefined}).configHome;
                                  
    const available=await nativeSupervisorAvailable(directory);
    const agents=available?await this.list(sessionId??undefined,directory):[],matches=agents.filter(value=>sessionId?value.sessionId===sessionId:value.id===binding?.handle);
    if(matches.length>1)throw new BridgeError('ambiguous_background','同一会话存在多个后台实例，未停止。');
    const agent=matches[0];
    if(agent){
      if(agent.kind!=='background')throw new BridgeError('process_owned_by_user','当前会话由前台窗口运行，未停止用户窗口。');
      if(binding?.phase==='intent')binding=await bindNativeLaunch(binding,agent);
      const native=agent.pid?await processIdentity(agent.pid):undefined;
      const proven=!!binding?.handle&&binding.handle===agent.id||records.some(value=>value.identity.pid===native?.pid&&value.identity.startedAt===native.startedAt);
      if(!proven)throw new BridgeError('claude_launch_unverified','当前后台 handle 不属于已记录的启动，未停止。');
      if(binding)binding=await captureNativeProcess(binding,agent);
      await beforeStop?.(agent);
      await runCli('claude',['stop',agent.id],{config:this.config,home:this.home,sessionId:sessionId??undefined,launch:selectHostLaunch('claude',this.config,{home:this.home,sessionId:sessionId??undefined,configHome:directory})});
    }
    for(const record of ownedProcesses(this.home).records.filter(value=>value.role==='claude-native'&&value.peerId===peer.id))await releaseOwnedProcess(record);
    if(binding?.phase==='intent')throw new BridgeError(binding.handle?'claude_release_pending':'claude_release_unresolved',binding.handle?'原生后台启动结果尚未确认，保留归属记录，稍后重试。':'仅剩未结算启动记录，缺少可解析 handle 和可核验进程；停止自动回收重试，保留证据，请运行 nxbridge doctor 后显式 retire。');
    if(binding)forgetNativeOwnership(nativeOwnership(this.home,peer.id)??binding);
  }
  close():void{for(const {server,address}of this.replyListeners.values()){server.close();try{unlinkSync(address);}catch{}}this.replyListeners.clear();}
}
