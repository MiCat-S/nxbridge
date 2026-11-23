import {BrokerLifecycleCoordinator,codexRequester,isCodexIdentityError,type StoredLaunchProof} from './lifecycle/coordinator.js';
import {BrokerHealthCoordinator} from './health/coordinator.js';
import {SelectionResolver} from './pairing/selection-resolver.js';
import {text,host,actorSchema,targetSchema,restartSchema,profileSchema,processSchema,registerSchema,mcpRegisterSchema,hookClientSchema,mcpHookClientSchema,claudeHookClientSchema,modDiagnosticsSchema,questionDiagnosticsSchema} from './requests/contracts.js';
import { codexHookContext } from '../hosts/codex/codex-hook-context.js';
import { VERSION } from '../version.js';
import { z } from 'zod';
import { permissionGuidance, permissionFacts } from '../integration/mcp/permission-guidance.js';
import {codexHookApproval,observeCodexPermission} from '../hosts/codex/codex-permission.js';
import { authorizeDaemonWake, daemonContextChanged, daemonWakeAuthorized } from '../hosts/codex/daemon-wake.js';
import { changeNotices, settleChangedPair } from './pairing/pair-changes.js';
import { Store, type PendingMessageFacts } from '../storage/store.js';
import { managedRegistration, managedCodexRegistration, managedDescendant, clearManagedChildConflict } from '../hosts/managed-registration.js';
import { codexRuntimeChild, codexRuntimeEndpoint } from '../hosts/codex/codex-lineage.js';
import { addManagedConflict, clearManagedConflict } from './recovery/managed-conflicts.js';
import {observeBrokerReachable,brokerOutageDiagnostic} from './broker-outage.js';
import { CodexAdapter, codexContextReceipts, type CodexContextReceipt, type CodexThread } from '../hosts/codex/adapter.js';
import { readCodexHistory, type HistoryCheckpoint } from '../hosts/codex/codex-history.js';
import {ClaudeAdapter} from '../hosts/claude/adapter.js';
import {liveProcess} from '../process/process.js';
import {peerAddress} from '../hosts/claude/claude-inbox.js';
import {BridgeError,DeliveryError,describeError} from '../shared/errors.js';
import {DEFAULT_RETENTION} from '../config/defaults.js';
import {WAKE_NOTICE,HEALTH_WAKE_NOTICE,isEmbeddedWake,otherHost,type Actor,type BridgeConfig,type Endpoint,type Message,type Peer,type Pair,type PeerState,type RegisterInput,type Host} from '../types.js';
import {delay} from '../shared/time.js';
import {runCli} from '../process/host-command.js';
import {sameDirectory} from '../shared/files.js';
import {retirementViews,type RetirementRecord} from './recovery/retirement-state.js';
import {verifiedLaunchStatus} from '../hosts/session-launch.js';
import {type ServiceOrigin} from '../ipc/ipc.js';
import { Questions } from '../integration/mcp/questions.js';
import { fileHintFields } from './delivery/file-references.js';
import { References } from './delivery/references.js';
import { SubagentCompletions } from './subagent-completions.js';
import { CodexFinalForwards } from './codex-final-forwards.js';
import { runtimeProfile } from './profiles/runtime-profile.js';
import { type PartnerProfiles, modelProfileSchema, hasProfile } from './profiles/partner-profile.js';
import { PartnerProfileCoordination } from './profiles/coordination.js';
import { frozenProfileStatus, profileDefaults, syncFrozenProfiles } from './profiles/frozen-profile.js';
import { modelError, modelPeerName, modelStatus, referenceDeny } from '../integration/mcp/model-output.js';
import { manualCodexRestart, type RestartSelector } from '../hosts/codex/codex-restart.js';
import { captureUserLaunch, captureDaemonLaunch, profileMetadata, setPreferredProfiles } from '../hosts/launch-profiles.js';
import { launchStatus, selectHostLaunch, prepareOwnedLaunch, assertLaunchPreconditions } from '../hosts/host-launch.js';
import { loadBridgeConfig } from '../config/configuration.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {TurnHealthTracker,RECENT_PROGRESS_MS,type TurnHealth} from './health/turn-health.js';
import { ForegroundHealth, nativeHealthSchema } from './health/foreground-health.js';
import {providerBlocked,modelRequestText} from '../hosts/codex/codex-model-request.js';
import { InHostConfiguration, modelConfigurationSchema, type ConfigurationSession } from '../config/config-in-host.js';
import { claudeBackground } from '../hosts/claude/claude-capability.js';
import { claudeChild, childCall, childHandoff, findClaudeChild, recordClaudeForeground, stopClaudeChild } from '../hosts/claude/claude-child.js';
import { processIdentity, probeProcesses, codexIsAppServer, processProbeStatus, processAncestryStatus, codexProcessIdentity } from '../process/process.js';
import { ownedProcessState } from '../process/process-stop.js';
import { WindowsIdentitySession } from '../process/windows/windows-identity-session.js';
import { hook as executeHook,type HookExecution } from '../integration/hooks/hook-control.js';
import {claudeIdentity} from '../hosts/claude/identity.js';
import { hookGuardTimeout } from '../integration/hooks/hook-output.js';
import { remainingTime } from '../shared/time-budget.js';
import {DeliveryHealth} from './health/delivery.js';
import {runtimeNoticeText,type RuntimeAvailability,type RuntimeNotice} from './health/contracts.js';
import { readCodexThread } from '../hosts/codex/codex-evidence.js';
import { codexThreadIdle } from '../hosts/codex/codex-thread-state.js';
import { RuntimeIncidents } from './health/runtime-incidents.js';
import { SKIPPED } from './fault-boundary.js';
import { CommunicationTips } from './delivery/communication-tips.js';
import { IdleNotices } from './health/idle-notices.js';
import { PairAnomalies } from './pairing/pair-anomalies.js';
import { reloadAction, recordReloadAttempt } from '../integration/mod/mod-reload.js';
import { MOD_REVISION } from '../mod-revision.js';
import {ownedProcesses} from '../process/owned-processes.js';
import { nativeOwnership, nativeOwnershipRecords, saveNativeOwnership } from '../process/owned-native.js';
import { migrateLegacyOwnership } from '../process/legacy-owned.js';
import { processOwnershipSummary } from '../process/process-audit.js';
import { retireUnconfirmedContainers } from '../process/process-cleanup.js';
import { pruneDeadProcessRecords } from '../process/process-records.js';
import { hookContextMatches, registrationWindow, windowKey } from '../integration/hooks/session-bindings.js';
import { preSubmitError } from '../storage/storage-errors.js';
import { contextNotice } from './health/context-notices.js';
import type { TargetSelector } from './pairing/admin-target.js';
import {runtimeFor,localCodexEndpoint} from '../hosts/managed-runtimes.js';
import { Recovery } from './recovery/recovery.js';
import { installedCacheStatus } from '../install/installation.js';
import { registerPendingCodex } from './pending-windows.js';
import { WindowRecovery } from './recovery/window-recovery.js';
import {ResourceHealth} from './health/resource-health.js';
import { ModReadServer, type ModReadOperation } from '../integration/mod/mod-read-server.js';
import { mod, type ModExecution } from '../integration/mod/mod-control.js';
import { bindModReadReceipt, type ModReadReceipt } from '../integration/mod/mod-read-receipt.js';
import {lossNotices,pairLoss,pairLossKey,type PairLossCause} from './pairing/pair-loss.js';
import { pairLossView, restorableOwnedPartner, partnerConfigHome, refreshRestoreObservations } from './pairing/pair-restore.js';
import {verifySessionHistory} from './recovery/session-history.js';
import type { SendIntent } from './pairing/pair-selection.js';
import { EmbeddedWakeSignals } from '../ipc/embedded-wake.js';
import { CodexWakeSignals } from '../hosts/codex/codex-wake.js';
import { readMessages, readMessagesSchema } from './delivery/message-history.js';
import { nativeInboundSchema, nativeDecisionSchema, nativeProfileSchema } from '../integration/mod/mod-protocol.js';
import { DeletedSessions, sessionPresence } from './deleted-sessions.js';
import { nativeAutoModeSchema, nativeBackgroundSchema, observeClaudeAuto, claudeAutoKey, claudeAutoStatus, claudeAutoHolds, type ClaudeAutoFallback } from '../hosts/claude/claude-auto-mode.js';
import {ClaudeInbound,inboundAdmission,inboundWarning} from '../hosts/claude/claude-inbound.js';
import { CodexHookTrust, hookApprovalRequired, readCodexHookTrust } from '../hosts/codex/codex-hook-trust.js';
import { CodexDaemons, daemonPermission } from '../hosts/codex/codex-daemon.js';
import { CodexDirectDelivery } from '../hosts/codex/codex-direct.js';
import { noticeSignal } from './health/notice-policy.js';
import { disabledMember, memberEnabled, memberOffResultFor, requireMemberEnabled, writeMemberControls } from './member-control.js';
import { ManagedRecovery, recoverPartnerSchema, recoveryPrecondition } from './recovery/managed-recovery.js';
import { isExternalTerminal, requireExternalTerminal, terminalOriginSchema, HOSTING_TERMINAL_MESSAGE, type TerminalOrigin } from '../hosts/user-origin.js';
import { ConfigurationReload } from '../config/config-reload.js';
import { Takeovers } from './recovery/takeover.js';
import { ProviderRecovery } from './recovery/provider-recovery.js';
import { captureLegacyTakeovers } from './recovery/legacy-takeover.js';
import {hostingRecord,hostingGate,hostingStatus,writeHosting,closeHostedWindow,codexForegroundEnd,codexForegroundEndKey,type CodexForegroundEnd,SessionTransfers} from './recovery/session-hosting.js';
import { readSessionProfile, sessionFile } from '../hosts/codex/codex-session-profile.js';
import { stopCodexRuntime } from '../hosts/codex/codex-restart.js';
import { codexUserWindow } from '../hosts/codex/codex-lineage.js';
import { CodexForegroundWindows, type CodexForegroundWindow } from '../hosts/codex/codex-foreground.js';

const RECEIVE_BATCH_BYTES=1024*1024;

export interface Adapters {
  codex:CodexAdapter;
  claude:ClaudeAdapter;
}

export class Broker {
  private readonly memberLifecycle:BrokerLifecycleCoordinator;
  readonly profiles:PartnerProfiles;
  private readonly profileCoordination:PartnerProfileCoordination;
  readonly questions:Questions;
  readonly references:References;
  readonly subagentCompletions:SubagentCompletions;
  readonly finalForwards:CodexFinalForwards;
  readonly recovery:Recovery;
  readonly managedRecovery:ManagedRecovery;
  private takeovers:Takeovers;
  private transfers:SessionTransfers;
  readonly communicationTips:CommunicationTips;
  readonly configuration:InHostConfiguration;
  private readonly configurationReload:ConfigurationReload;
  private configurationWindows=new Map<string,{epoch:string;pid:number;procStart:string}>();
  private timer?:NodeJS.Timeout;
  private pumping?:Promise<void>;
  private stopped=false;
  private codexSubscriptionChecks=new Map<string,Promise<unknown>>();
  private codexObservationChecks=new Map<string,Promise<void>>();
  private codexForeground:CodexForegroundWindows;
  private readonly selectionResolver:SelectionResolver;
  private pairChanges=0;
  private lifecycle=new Map<string,Promise<unknown>>();
  private changingMembers=new Map<string,{scope:string;count:number}>();
  private windowRecovery:WindowRecovery;
  readonly deletedSessions:DeletedSessions;
  readonly daemons:CodexDaemons;
  private identityConflicts=new Map<string,{endpoint:string;pid:number;procStart:string;error:BridgeError;attempts:number}>();
  private wakeSignals:EmbeddedWakeSignals;
  private codexWake:CodexWakeSignals;
  private codexDirect:CodexDirectDelivery;
  private codexWakeWork=new Map<string,Promise<void|typeof SKIPPED>>();
  private lastReconcile=0;
  private lastMaintenance=0;
  private recordMaintenance?:Promise<void>;
  private reconciling=new Map<string,Promise<void>>();
  private reconcileOffline=new Map<string,{endpoint:Endpoint;sessionId:string|null;retryAt:number}>();
  readonly health=new TurnHealthTracker();
  readonly foregroundHealth:ForegroundHealth;
  readonly deliveryHealth:DeliveryHealth;
  readonly claudeInbound:ClaudeInbound;
  readonly idleNotices:IdleNotices;
  readonly pairAnomalies:PairAnomalies;
  private hookTrust:CodexHookTrust;
  private hookChecks=new Map<string,Promise<void>>();
  private hookIdentity?:WindowsIdentitySession;
  private hookReceipts=new Map<string,{ack:()=>Promise<void>;timer:NodeJS.Timeout}>();
  readonly incidents:RuntimeIncidents;
  private readonly modReads:ModReadServer;
  private readonly runtimeHealth:BrokerHealthCoordinator;
  private providerRetries=new Map<string,Record<string,unknown>>();
  private providerRecovery:ProviderRecovery;
  private captureLaunch=captureUserLaunch;
  private launchPreferenceKey?:string;
  constructor(readonly store:Store,readonly config:BridgeConfig,readonly adapters:Adapters,readonly home:string,readonly origin?:ServiceOrigin,readonly runtime?:{entry:string;generation:string;buildId?:string;windowsIndependent?:boolean},readonly resources?:ResourceHealth){
    this.selectionResolver=new SelectionResolver(store,config,{actor:(...args)=>this.actor(...args),syncPendingWindows:(...args)=>this.syncPendingWindows(...args),probeRuntime:(...args)=>this.runtimeHealth.probeRuntime(...args),sendWithHealth:(...args)=>this.sendWithHealth(...args),applySelection:(...args)=>this.applySelection(...args),retireImplicitPartner:(...args)=>this.retireImplicitPartner(...args)});
    this.profileCoordination=new PartnerProfileCoordination({store,config,adapters,home},{
      lifecycle:id=>({stopped:this.stopped,enabled:this.enabled(id),preparing:this.memberLifecycle.isPreparing(id),restarting:this.memberLifecycle.isRestarting(id),retiring:this.memberLifecycle.isRetiring(id),takingOver:!!this.takeovers.get(id)}),
      beginChange:id=>this.memberLifecycle.beginRestart(id),
      pump:()=>this.pump(),
    });
    this.profiles=this.profileCoordination.profiles;
    this.incidents=new RuntimeIncidents(store);
    this.codexForeground=new CodexForegroundWindows(store,window=>this.endCodexForeground(window));
    this.windowRecovery=new WindowRecovery(store,probeProcesses,async peer=>{const endpoint=this.store.endpoint(peer.id);if(peer.host==='codex'&&endpoint){await this.adapters.codex.release(peer,endpoint);this.store.deactivate(peer.id,endpoint.epoch);}},peer=>this.memberLifecycle.nativeSessionState(peer),async input=>await managedCodexRegistration(store,this.home,input,(runtime,id)=>this.adapters.codex.inspectThread(runtime,id))??await managedRegistration(store,this.home,input,undefined,(proof,input)=>this.adapters.claude.corroborateRegistration(input,proof)));
    this.daemons=new CodexDaemons(store,config,home,input=>this.register(input));
    this.wakeSignals=new EmbeddedWakeSignals(store);
    this.codexWake=new CodexWakeSignals(store);
    this.subagentCompletions=new SubagentCompletions(store);
    this.codexDirect=new CodexDirectDelivery(store,{
      injectionState:(peer,endpoint,options)=>(endpoint.daemon?this.daemons:adapters.codex).injectionState(peer,endpoint,options),
      inject:(peer,endpoint,callId,output)=>(endpoint.daemon?this.daemons:adapters.codex).inject(peer,endpoint,callId,output),
      continueInjected:async(peer,endpoint)=>{
        const id=this.subagentCompletions.reserve(peer,'native_existing');
        if(!id)throw new DeliveryError('wake_coalesced','父会话已有待消费的唤醒。');
        try{const turn=await(endpoint.daemon?this.daemons:adapters.codex).continueInjected(peer,endpoint);this.subagentCompletions.outcome(peer,id,'submitted',turn);return turn;}
                                               
        catch(error){this.subagentCompletions.outcome(peer,id,'not_submitted');throw error;}
      }
    });
    this.foregroundHealth=new ForegroundHealth(store);
    this.questions=new Questions(store,config);
    this.recovery=new Recovery(store);
    this.managedRecovery=new ManagedRecovery(store);
    this.providerRecovery=new ProviderRecovery(store);
    this.takeovers=new Takeovers(store,probeProcesses,undefined,peer=>this.memberLifecycle.nativeSessionState(peer));
    this.deletedSessions=new DeletedSessions(store,config,{
      presence:peer=>sessionPresence(store,peer,probeProcesses,home),
      holder:async peer=>{const state=await this.memberLifecycle.nativeSessionState(peer);if(state!=='dead')return state;try{await this.memberLifecycle.assertNoLiveSessionHolder(peer);return'dead';}catch{return'unknown';}},
      busy:peer=>this.stopped||this.memberLifecycle.isPreparing(peer.id)||this.memberLifecycle.isRestarting(peer.id)||this.memberLifecycle.isRetiring(peer.id)||!!this.takeovers.get(peer.id)||!!this.store.setting('managedSessionConflict:'+peer.id)||this.managedRecovery.get(peer.id)?.state==='recovering',
      change:(pair,work)=>this.changePair(work,pair.id,[pair.claude,pair.codex]),cancel:id=>this.questions.cancelPeer(id),
      prepare:(peer,source,authorize,beforeCreate)=>this.memberLifecycle.prepare(peer,undefined,{peerId:source.id,sessionId:source.sessionId!,authorize,beforeCreate}),
      beforeCreate:()=>{if(this.stopped)throw new BridgeError('stopping','协调器正在关闭。');this.requireIndependentBackground();},
      retire:id=>{const ids=this.memberLifecycle.queueRetirements([id]);this.background('deleted_replacement_retirement:'+id,()=>this.memberLifecycle.releaseOwned(ids));},
      notifyFailure:(peer,loss)=>this.background('deleted_replacement_notice:'+loss.id,()=>this.runtimeHealth.notifyDeletedReplacementFailure(peer,loss)),
    });
    this.transfers=new SessionTransfers(store,config,home,{holder:peer=>this.memberLifecycle.nativeSessionState(peer),loaded:(peer,endpoint)=>adapters.codex.sessionState(peer,endpoint),daemon:async(peer,runtime)=>{
      const configHome=hostingRecord(store,peer)?.configHome;if(!configHome)return'unknown';
      try{const connection=await this.daemons.scan(configHome,runtime,true);return connection?connection.threads.some(thread=>thread.id===peer.sessionId)?'alive':'dead':'unknown';}catch{return'unknown';}
    },inspect:(runtime,id)=>adapters.codex.inspectThread(runtime,id),cleanup:async(peer,address)=>{const note=await adapters.codex.releaseRuntime([],address,[{...peer,owner:'nxbridge'}]);if(note)throw new BridgeError('holder_unknown',note);},prepare:peer=>this.memberLifecycle.prepare(peer),enabled:peer=>this.requireEnabled(peer),stop:async(peer,endpoint,guard)=>{
      const rpc=await adapters.codex.connect(endpoint.address),deadline=Date.now()+15000;
      while(true){const result=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});if(result.thread?.id!==peer.sessionId)throw new BridgeError('session_changed','原生线程已改变。');const status=result.thread.status;
        if(status?.activeFlags?.some((flag:string)=>/approval|input/i.test(flag)))throw new BridgeError('pending_approval','请先 nxbridge open codex 打开原会话并处理审批，再释放后台。');
        if(['idle','notLoaded'].includes(status?.type))break;if(Date.now()>=deadline)throw new BridgeError('native_work_pending','原生任务仍在运行，未停止后台；请等待完成后重试。');await delay(100);
      }
      await this.reconcile(peer.id);guard();
      await stopCodexRuntime({peer,endpoint,home,connect:address=>adapters.codex.connect(address),guard,onStopped:()=>this.retireCodexRuntime(endpoint)});
    }});
    store.onRotation=rotation=>{this.questions.rotate(rotation);this.recovery.rotated(rotation.peerId);store.onCooperationChange?.([rotation.peerId]);};
    store.onContextEnd=peerId=>{this.questions.endContext(peerId);store.onCooperationChange?.([peerId]);};
    this.deliveryHealth=new DeliveryHealth(store);
    this.finalForwards=new CodexFinalForwards(store,this.deliveryHealth,{
      source:peer=>{
        const endpoint=store.endpoint(peer.id),known=store.setting<{sessionId:string;file:string}>('codexTranscript:'+peer.id);
        const file=endpoint?.nativeSession?.transcriptPath??(known?.sessionId===peer.sessionId?known.file:undefined)??(endpoint?.configHome&&peer.sessionId?sessionFile(endpoint.configHome,peer.sessionId):undefined);
        const runtime=endpoint?runtimeFor(home,{endpoint:endpoint.address})?.value:undefined;
        const proof=store.setting<StoredLaunchProof>('managedLaunchProof:'+peer.id);
        const sessionMatches=runtime?.sessionId===peer.sessionId||proof?.sessionId===peer.sessionId&&proof.runtimeId===runtime?.id&&!!proof.configHome&&!!runtime?.configHome&&sameDirectory(proof.configHome,runtime.configHome);
        const owned=peer.owner==='nxbridge'&&runtime?.kind==='owned'&&runtime.state==='ready'&&runtime.dedicated===true&&runtime.peerId===peer.id&&sessionMatches
          &&!!runtime.configHome&&!!endpoint?.configHome&&sameDirectory(runtime.configHome,endpoint.configHome)&&runtime.pid===endpoint.pid&&runtime.procStart===endpoint.procStart
          &&(endpoint.address.startsWith('unix://')||runtime.authenticatedLoopback===true&&/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint.address));
        return{file,owned};
      },
      children:peer=>this.subagentCompletions.forwardChildren(peer),
      gate:(codex,claude)=>this.finalForwardGate(codex,claude),
    });
    const turnOrigin:NonNullable<CodexAdapter['turnOrigin']>=async(peer,cause)=>{
      const pair=store.pairFor(peer.id),endpoint=store.endpoint(peer.id);if(!pair||!endpoint)return;
      const mark=await this.finalForwards.origin(peer,cause);
      if(!this.codexWakeAllowed(peer,endpoint,pair.id))throw new DeliveryError('wake_unavailable','原生轮次准备期间配对或运行状态已改变。');
      return mark;
    };
    adapters.codex.turnOrigin=turnOrigin;this.daemons.turnOrigin=turnOrigin;
    store.onDeliveryObserved=message=>{
      if(store.pairFor(message.to)?.id!==message.pairId||!this.enabled(message.to))return;
      store.faults.sync('functional_delivery:'+message.to,()=>this.runtimeHealth.deliverySucceeded(store.peer(message.to)));
    };
    this.claudeInbound=new ClaudeInbound(store,this.deliveryHealth);
    this.idleNotices=new IdleNotices(store,this.deliveryHealth);
    this.pairAnomalies=new PairAnomalies(store,this.deliveryHealth,VERSION,resources,home);
    this.hookTrust=new CodexHookTrust((configHome,cwd)=>readCodexHookTrust(this.config,this.home,configHome,cwd));
    this.references=new References(store);
    this.communicationTips=new CommunicationTips(store,{
      config:()=>this.config,blocked:peer=>hostingGate(store,peer)||providerBlocked(this.runtimeHealth.peerHealth(peer)),
      idle:peer=>{const pair=store.pairFor(peer.id);if(!pair)return;const other=store.peer(pair[otherHost(peer.host)]),episode=store.setting<{noticeId?:string}>('idleNotice:'+other.id);if(!episode?.noticeId)return;const notice=this.deliveryHealth.get(pair.id,peer.id,episode.noticeId);if(!notice||notice.admitted||notice.state!=='pending')return;return{id:notice.id,messageIds:store.seenSinceLastSendFacts(pair.id,other.id,store.bindings.current(other.id)?.activatedAt??pair.createdAt).map(m=>m.id)};},
      consumeIdle:(peer,id)=>{const pair=store.pairFor(peer.id);if(pair)this.deliveryHealth.outcome(pair.id,peer.id,id,'submitted');},
    });
    store.onCooperationChange=ids=>{for(const id of ids)store.faults.sync('cooperation_clock:'+id,()=>this.communicationTips.cooperation.changed(store.peer(id)));};
    this.configurationReload=new ConfigurationReload(home);this.configuration=new InHostConfiguration(home,Date.now,()=>this.applyConfiguration(),(name,data)=>this.store.event(name,data));
    this.runtimeHealth=new BrokerHealthCoordinator({store,config,adapters,home,resources},{incidents:this.incidents,deliveryHealth:this.deliveryHealth,communicationTips:this.communicationTips,pairAnomalies:this.pairAnomalies,idleNotices:this.idleNotices,profiles:this.profiles,foregroundHealth:this.foregroundHealth,managedRecovery:this.managedRecovery,health:this.health,codexDirect:this.codexDirect,daemons:this.daemons,questions:this.questions,finalForwards:this.finalForwards},{stopped:()=>this.stopped,actor:(...args)=>this.actor(...args),enabled:(...args)=>this.enabled(...args),requireEnabled:(...args)=>this.requireEnabled(...args),ownedClaudeLaunchReady:(...args)=>this.memberLifecycle.ownedClaudeLaunchReady(...args),ownedClaudeLaunchFailure:(...args)=>this.memberLifecycle.ownedClaudeLaunchFailure(...args),signalCodexWake:(...args)=>this.signalCodexWake(...args),signalEmbeddedWake:(...args)=>this.signalEmbeddedWake(...args),refreshHookTrust:(...args)=>this.refreshHookTrust(...args),pumpStage:(...args)=>this.pumpStage(...args)});
    this.memberLifecycle=new BrokerLifecycleCoordinator({store,config,adapters,home},{profileCoordination:this.profileCoordination,deletedSessions:this.deletedSessions,takeovers:this.takeovers,managedRecovery:this.managedRecovery,transfers:this.transfers,runtimeHealth:this.runtimeHealth,deliveryHealth:this.deliveryHealth,daemons:this.daemons,codexDirect:this.codexDirect},{
      stopped:()=>this.stopped,
      migrateCodexIdentity:(...args)=>this.migrateCodexIdentity(...args),
      pumpAfterCurrent:()=>{const pumping=this.pumping;return pumping?pumping.then(()=>this.pump()):this.pump();},
    });
    this.modReads=new ModReadServer(home,(actor,operation,receipt,endpointEpoch,health)=>this.modRead(actor,operation,receipt,endpointEpoch,health),(input,actor,receipt,endpointEpoch,admit)=>this.modWrite(input,actor,receipt,endpointEpoch,admit));
    const on=(adapter:{on:(event:string,listener:(...args:any[])=>void)=>unknown},event:string,listener:(...args:any[])=>unknown)=>adapter.on(event,(...args:any[])=>{
      const first=args[0],id=typeof first==='string'?first:first?.sessionId??first?.message?.params?.threadId??first?.address??'';
      this.background('event:'+event+':'+id,()=>listener(...args));
    });
    on(adapters.codex,'historyCompatibility',({sessionId,address,status,reason})=>{const peer=this.runtimePeer(sessionId,address);if(peer&&this.enabled(peer.id)){const key='codexHistoryCompatibility:'+peer.id,value={status,...(reason?{reason}:{})};if(JSON.stringify(this.store.setting(key))!==JSON.stringify(value))this.store.setSetting(key,value);}});
    on(adapters.codex,'native',({address,message})=>{
      if(message.method==='thread/deleted'){
        const peer=this.runtimePeer(message.params?.threadId,address),endpoint=peer?this.runtimeEndpoint(peer.id):undefined;
        if(peer&&endpoint&&endpoint.address===address)this.deletedSessions.deleted(peer,endpoint);
      }
                                                 
      const lifecycle=['turn/started','turn/completed','hook/completed','item/started','item/completed','thread/tokenUsage/updated','error'].includes(message.method);
      const owner=lifecycle?this.runtimePeer(message.params?.threadId??message.params?.thread?.id,address):undefined;if(owner&&!this.enabled(owner.id))return;
      this.health.observe(address,message);if(message.method==='error'||message.method==='turn/completed')this.runtimeHealth.resetTurnCheck();
      if(owner&&message.method==='thread/tokenUsage/updated'){
        const tokens=message.params?.tokenUsage?.last?.inputTokens;
        if(Number.isSafeInteger(tokens)&&tokens>=0)this.communicationTips.cooperation.usage(owner,{tokens,at:Date.now()});
      }
      if(owner&&message.method==='item/completed'&&message.params?.item?.type==='contextCompaction')this.communicationTips.cooperation.compacted(owner,String(message.params.item.id));
      if(owner&&this.store.pairFor(owner.id)){
        const endpoint=this.store.endpoint(owner.id),budget=this.providerRetries.get(address)??this.store.setting<Record<string,unknown>>('providerRetries:'+address),scope=endpoint?.configHome&&budget?JSON.stringify([endpoint.configHome,address,budget.provider,budget.scope]):undefined;
        if(scope){const notice=this.providerRecovery.observe(owner,scope,message),pair=this.store.pairFor(owner.id);if(notice&&pair){const recipient=this.store.peer(pair[otherHost(owner.host)]);this.deliveryHealth.enqueue(pair.id,recipient.id,{...notice,scope:this.runtimeHealth.noticeScope(pair,recipient)});}}
      }
      if(owner?.state==='needsHuman'&&['item/completed','turn/completed'].includes(message.method)){
        const health=this.health.get(address,owner.sessionId!);
        if(health&&health.turnId===(message.params?.turnId??message.params?.turn?.id)&&health.state!=='needsHuman')this.store.updatePeer(owner.id,{state:['ready','failed'].includes(health.state)?'ready':'busy'});
      }
      if(message.method==='turn/completed'){
        const peer=owner;if(peer&&this.store.reconcilable(peer.id).length)queueMicrotask(()=>this.background('reconcile:'+peer.id,()=>this.reconcile(peer.id)));
        if(peer)this.background('codex_final:'+peer.id,async()=>{await this.finalForwards.scan(this.store.peer(peer.id));const pair=this.store.pairFor(peer.id);if(pair)this.finalForwards.refresh(pair);});
                                                                  
        if(peer&&message.params?.turn?.status==='failed'&&typeof message.params.turn.id==='string')this.pairAnomalies.integration(peer,{turnFailed:true,turnId:message.params.turn.id});
      }
      const ordinaryInput=(message.method==='item/started'||message.method==='item/completed')&&message.params?.item?.type==='userMessage';
      const peer=(message.method==='turn/started'||message.method==='hook/completed'||ordinaryInput)?owner:undefined;
      if(peer&&message.method==='turn/started'&&typeof message.params?.turn?.id==='string')this.codexDirect.continued(peer.id,message.params.turn.id);
                                                                 
      if(peer&&ordinaryInput&&!message.params.item.content?.some((entry:any)=>isEmbeddedWake(entry.text)))this.store.updatePeer(peer.id,{activityAt:Date.now()});
      if(peer&&message.method==='turn/started')this.pairAnomalies.integration(peer,{turn:true,turnId:message.params?.turn?.id??message.params?.turnId});
      const run=message.params?.run;
      if(peer&&message.method==='hook/completed'&&run?.source==='plugin'&&String(run.sourcePath??'').includes('nxbridge')){
        const guarded=run.status==='completed'?hookGuardTimeout(run.entries):undefined;
        const nativeHook=typeof run.eventName==='string'&&run.eventName.length<=64&&typeof run.durationMs==='number'&&Number.isFinite(run.durationMs)&&run.durationMs>=0?{event:run.eventName,durationMs:run.durationMs}:undefined;
        if(run.status==='failed'||guarded){
                                               
          this.store.event('hook.native.failed',{peerId:peer.id,sessionId:peer.sessionId,turnId:message.params?.turnId,event:run.eventName,startedAt:run.startedAt,completedAt:run.completedAt,durationMs:run.durationMs});
          this.pairAnomalies.integration(peer,{nativeHook,hookError:guarded||(run.entries??[]).filter((entry:any)=>entry.kind==='error').map((entry:any)=>entry.text).join('; ')||'no detail'});
          this.refreshHookTrust(peer);
        }
        else if(run.status==='completed'){
          const failure=this.store.setting<{error:string}>('hookCallFailure:'+peer.id);
          this.pairAnomalies.integration(peer,{nativeHook,...(failure?{hookError:failure.error}:{hook:true as const}),turnId:message.params?.turnId});
          const pair=this.store.pairFor(peer.id);if(pair)this.runtimeHealth.refreshNoticeConditions(pair,'codex_hook_completed');
        }
      }
    });
    on(adapters.codex,'providerRetries',({address,budget})=>{this.providerRetries.set(address,budget);this.store.setSetting('providerRetries:'+address,budget);});
    on(adapters.codex,'register',async(r:RegisterInput,memberId?:string)=>{
      if(memberId&&!this.enabled(memberId)||this.disabledRegistration(r))return;
      if(memberId){const peer=this.store.peer(memberId);if(peer.host!=='codex'||peer.sessionId!==r.sessionId||this.store.bindings.current(peer.id))return;this.store.adopt(peer.id,r);const ep=this.runtimeEndpoint(peer.id);if(ep)this.deletedSessions.observe(this.store.peer(peer.id),ep);this.background('codex_observe:'+peer.id,()=>this.observeActiveCodex(this.store.peer(peer.id)));return;}
      const runtime=runtimeFor(this.home,{endpoint:r.endpoint.address})?.value;
      if(runtime?.peerId){
        const peer=this.store.peer(runtime.peerId);if(!peer.sessionId)return;
        if(r.kind==='subagent'||managedDescendant(this.store,peer,r)){r.kind='subagent';this.store.register(r);clearManagedChildConflict(this.store,peer,runtime.id,r);return;}
        if(peer.sessionId===r.sessionId){if(!this.store.setting('managedSessionConflict:'+peer.id)){this.store.adopt(peer.id,r);const ep=this.runtimeEndpoint(peer.id);if(ep)this.deletedSessions.observe(this.store.peer(peer.id),ep);}return;}
        addManagedConflict(this.store,peer.id,runtime.id,r.sessionId);return;
      }
      const matches=this.store.peers().filter(p=>p.host==='codex'&&p.sessionId===r.sessionId&&this.store.endpoints(p.id).some(e=>e.mode==='app-server'&&e.address===r.endpoint.address)&&!this.store.bindings.current(p.id));
      if(matches.length>1)return;
      const peer=await this.windowRecovery.register(r),ep=this.runtimeEndpoint(peer.id);if(ep)this.deletedSessions.observe(peer,ep);this.background('codex_observe:'+peer.id,()=>this.observeActiveCodex(peer));
    });
    on(adapters.codex,'sessionPolicy',({memberId,sessionId,policy,runtimeId})=>{const peer=this.store.getPeer(memberId);if(peer&&peer.sessionId===sessionId&&this.store.pairFor(peer.id)&&(!hostingRecord(this.store,peer)?.verificationRuntimeId||hostingRecord(this.store,peer)?.verificationRuntimeId===runtimeId))writeHosting(this.store,peer,{policy,verifying:false,verified:true,verificationError:undefined});});
    on(adapters.codex,'sessionVerifying',({memberId,sessionId,runtimeId,endpoint})=>{const peer=this.store.getPeer(memberId);if(peer&&peer.owner==='nxbridge'&&peer.sessionId===sessionId&&this.store.pairFor(peer.id))writeHosting(this.store,peer,{verifying:true,verified:false,verificationRuntimeId:runtimeId,verificationEndpoint:endpoint,verificationError:undefined});});
    on(adapters.codex,'sessionVerificationFailed',({memberId,sessionId,runtimeId,error})=>{const peer=this.store.getPeer(memberId);if(peer&&peer.owner==='nxbridge'&&peer.sessionId===sessionId&&this.store.pairFor(peer.id)&&hostingRecord(this.store,peer)?.verificationRuntimeId===runtimeId)writeHosting(this.store,peer,{verificationError:error});});
    on(adapters.codex,'state',(id:string,state:PeerState,address?:string)=>{
      if(state==='offline'&&address){const runtime=runtimeFor(this.home,{endpoint:address})?.value;if(runtime?.peerId)clearManagedConflict(this.store,runtime.peerId,runtime.id,id);}
      const p=this.runtimePeer(id,address);if(p&&this.enabled(p.id)&&(p.state!=='paused'||p.kind==='subagent'))this.store.updatePeer(p.id,{state});
      if(p?.kind==='subagent'&&state==='offline')for(const endpoint of this.store.endpoints(p.id))if(endpoint.mode==='app-server'&&endpoint.address===address)this.store.deactivate(p.id,endpoint.epoch);
      if(p&&['busy','needsHuman'].includes(state))return this.observeActiveCodex(this.store.peer(p.id));
    });
    on(adapters.codex,'permission',(id:string,permission:Peer['permission'],address?:string)=>{const p=this.runtimePeer(id,address);if(p&&this.enabled(p.id))this.store.updatePeer(p.id,{permission});});
    on(adapters.codex,'profile',(id:string,input:RegisterInput,address?:string)=>{const p=this.runtimePeer(id,address);if(p&&this.enabled(p.id)){const profile=runtimeProfile(p,input);this.profiles.observed(this.store.updatePeer(p.id,{model:profile.model,effort:profile.effort}),input);}});
    on(adapters.codex,'interrupted',(id:string,address?:string,turnId?:string)=>{const p=this.runtimePeer(id,address);if(p&&this.enabled(p.id)&&!this.recoveredCodexInterrupt(p,turnId)){this.questions.cancelPeer(p.id);this.store.updatePeer(p.id,{state:'paused'});}});
    on(adapters.codex,'turnStarted',(id:string,address?:string)=>{const p=this.runtimePeer(id,address);if(p&&this.enabled(p.id)&&(p.state!=='paused'||p.kind==='subagent'))this.store.updatePeer(p.id,{state:'busy'});});
    on(adapters.codex,'runtimeStopped',(runtime:Endpoint)=>this.retireCodexRuntime(runtime));
    on(adapters.codex,'disconnected',(address:string)=>this.disconnected(address));
    on(adapters.codex,'diagnostic',(message:string)=>this.store.event('diagnostic',{message}));
    on(adapters.codex,'contextObserved',(receipt:CodexContextReceipt&{sessionId:string;address:string})=>{
      if(this.stopped)return;
      const peer=this.runtimePeer(receipt.sessionId,receipt.address);
      if(peer&&this.enabled(peer.id)&&this.store.endpoints(peer.id).some(e=>e.active&&e.mode==='app-server'&&e.address===receipt.address))this.observeCodexContext(peer,receipt,'item/completed');
    });
    on(adapters.claude,'receipt',(receipt:any)=>{
      try{const m=this.store.message(receipt.orig_msg_id);const target=this.store.peer(m.to);const ep=this.store.endpoint(target.id);
        if(!this.enabled(target.id)||target.host!=='claude'||!ep||receipt.from!==peerAddress(ep.address))return;
        if(['held','refused','expired'].includes(receipt.status))this.store.transition(m.id,receipt.status,receipt.reason??'Claude peer 回执');
        else if(receipt.status==='delivered')this.store.transition(m.id,'runtimeQueued','Claude peer 回执：已释放入队');
        if(receipt.status==='delivered')this.claudeInbound.resolved(m);
        if(receipt.status==='refused'||receipt.status==='expired')this.claudeInbound.rejected(m,receipt.status,receipt.reason);
      }catch{}
    });
  }
  private retireCodexRuntime(runtime:Pick<Endpoint,'address'|'pid'|'procStart'|'runtimeId'>):void{
    for(const endpoint of this.store.endpoints())if(codexRuntimeEndpoint(endpoint,runtime)){
      this.store.deactivate(endpoint.peerId,endpoint.epoch);
      const peer=this.store.peer(endpoint.peerId);if(peer.kind==='subagent'&&!this.store.endpoint(peer.id))this.store.updatePeer(peer.id,{state:'offline'});
    }
  }
  private runtimePeer(sessionId:string,address?:string):Peer|undefined{
    const matches=this.store.peers().filter(p=>p.host==='codex'&&p.sessionId===sessionId&&!this.store.bindings.current(p.id)&&(!address||this.store.endpoints(p.id).some(e=>e.address===address)));
    return matches.length===1?matches[0]:undefined;
  }
  private observeActiveCodex(peer:Peer):Promise<void>{
    const endpoint=this.store.endpoint(peer.id);
    if(this.stopped||!codexUserWindow(peer)||!this.enabled(peer.id)||hostingGate(this.store,peer)||!['busy','needsHuman'].includes(peer.state)||!peer.sessionId||endpoint?.mode!=='app-server'||endpoint.daemon)return Promise.resolve();
    const key=endpoint.address+'|'+peer.sessionId,pending=this.codexObservationChecks.get(key);if(pending)return pending;
    const current=()=>!this.stopped&&this.enabled(peer.id)&&codexUserWindow(this.store.peer(peer.id))&&this.store.peer(peer.id).sessionId===peer.sessionId&&this.store.endpoint(peer.id)?.epoch===endpoint.epoch;
    const work=(async()=>{
                                              
      await this.adapters.codex.observeActive(peer,endpoint);if(!current())return;
      const revision=this.health.revision(endpoint.address,peer.sessionId!),snapshot=await this.adapters.codex.injectionState(peer,endpoint);if(!current())return;
      this.health.read(endpoint.address,snapshot.thread,revision);
      const turn=snapshot.thread.turns?.at(-1);if(turn?.id)this.codexDirect.continued(peer.id,turn.id);
      const receipts=[...snapshot.history.receipts,...(snapshot.thread.turns??[]).flatMap(turn=>(turn.items??[]).flatMap((item:any)=>codexContextReceipts(item,turn.id)))];
      for(const receipt of receipts)this.observeCodexContext(peer,receipt,'恢复运行中观察');
    })().finally(()=>{if(this.codexObservationChecks.get(key)===work)this.codexObservationChecks.delete(key);});
    this.codexObservationChecks.set(key,work);return work;
  }
  private async releaseIdleCodexSubscriptions(address?:string,legacySessionId?:string,wait=true):Promise<void>{
    const adapter=this.adapters.codex;
    const pending:Promise<unknown>[]=[];
                                          
    const targets=new Map<string,{peer:Peer;endpoint:Endpoint}>();
    for(const peer of this.store.peers())if(codexUserWindow(peer)&&peer.sessionId)for(const endpoint of this.store.endpoints(peer.id))if(endpoint.active||adapter.hasSubscription(peer,endpoint))targets.set(endpoint.address+'|'+peer.sessionId,{peer,endpoint});
    for(const target of adapter.userSubscriptions())targets.set(target.endpoint.address+'|'+target.peer.sessionId,target);
    for(const {peer,endpoint} of targets.values()){
      if(!codexUserWindow(peer)||!codexUserWindow(this.store.peer(peer.id))||endpoint.mode!=='app-server'||endpoint.daemon||address&&endpoint.address!==address)continue;
      const key=endpoint.address+'|'+peer.sessionId,fenceKey=codexForegroundEndKey(endpoint.address,peer.sessionId!),runtime=runtimeFor(this.home,{endpoint:endpoint.address})?.value;
                                               
      if(address&&(!legacySessionId||legacySessionId===peer.sessionId)&&(legacySessionId||adapter.hasSubscription(peer,endpoint)||this.store.pendingCount(peer.id))&&(legacySessionId||runtime?.threadUnloadDelaySecs===0))this.store.setSetting(fenceKey,{runtimeId:runtime?.id,pid:runtime?.pid,procStart:runtime?.procStart,epoch:endpoint.epoch,exact:!!legacySessionId} satisfies CodexForegroundEnd);
      const checking=this.codexSubscriptionChecks.get(key);
      if(checking){pending.push(checking);continue;}
      const observedSession=this.store.peer(peer.id).sessionId;
      const canRelease=()=>{
        const current=this.store.peer(peer.id),pair=this.store.pairFor(peer.id);
        if(this.stopped||!codexUserWindow(current)||current.sessionId!==observedSession||this.takeovers.get(peer.id)||this.memberLifecycle.isPreparing(peer.id)||this.memberLifecycle.isRestarting(peer.id)||this.memberLifecycle.isRetiring(peer.id))return false;
        if(current.sessionId!==peer.sessionId)return true;
        if(codexForegroundEnd(this.store,peer,endpoint))return true;
        if(current.state==='needsHuman'||this.codexDirect.pending(peer.id))return false;
        if(pair){const counts=this.store.deliveryCounts(pair.id,pair[otherHost(peer.host)]);if(counts.accepted+counts.sending+counts.runtimeQueued||this.store.questions(true).some(q=>q.pairId===pair.id)||this.deliveryHealth.peek(pair.id,peer.id).some(n=>n.wake))return false;}
        return true;
      };
      if(!canRelease())continue;
      const work=this.store.faults.run('codex_subscription:'+key,async()=>{
        const result=await adapter.releaseIdle(peer,endpoint,canRelease,!!codexForegroundEnd(this.store,peer,endpoint));
                                                     
        const ended=codexForegroundEnd(this.store,peer,endpoint),currentRuntime=ended?runtimeFor(this.home,{endpoint:endpoint.address})?.value:undefined;
                                                        
        const sameRuntime=currentRuntime?.id===ended?.runtimeId&&currentRuntime?.pid===ended?.pid&&currentRuntime?.procStart===ended?.procStart;
        const legacyClosed=sameRuntime&&currentRuntime?.kind==='owned'&&currentRuntime.threadUnloadDelaySecs!==0&&ended?.exact&&(result==='released'||result==='idle');
        if((result==='unloaded'||legacyClosed)&&canRelease()&&this.store.peer(peer.id).sessionId===peer.sessionId&&this.store.endpoint(peer.id)?.epoch===endpoint.epoch){closeHostedWindow(this.store,this.store.peer(peer.id),endpoint.epoch);if(ended)this.store.setSetting(fenceKey,null);}
        else if(ended&&canRelease()){
          if(currentRuntime&&!sameRuntime){this.store.setSetting(fenceKey,null);return;}
                                                   
          if(sameRuntime&&currentRuntime?.threadUnloadDelaySecs===0&&ended.released&&result==='idle')this.store.setSetting(fenceKey,null);
          else if(result==='released'||result==='idle')this.store.setSetting(fenceKey,{...ended,released:true});
        }
      }).finally(()=>{if(this.codexSubscriptionChecks.get(key)===work)this.codexSubscriptionChecks.delete(key);});
      this.codexSubscriptionChecks.set(key,work);pending.push(work);
    }
    if(wait)await Promise.all(pending);
  }
  private async endCodexForeground(window:CodexForegroundWindow):Promise<void>{
    await this.releaseIdleCodexSubscriptions(window.endpoint,window.sessionId,false);
    for(const peer of this.store.peers())if(codexUserWindow(peer)&&(!window.sessionId||peer.sessionId===window.sessionId))for(const endpoint of this.store.endpoints(peer.id))if(endpoint.active&&endpoint.address===window.endpoint){const native=endpoint.native??endpoint;if(native.pid&&native.procStart&&(await probeProcesses([{pid:native.pid,procStart:native.procStart}]))[0]==='dead')closeHostedWindow(this.store,this.store.peer(peer.id),endpoint.epoch);}
  }
  private refreshHookTrust(peer:Peer):void{
    if(this.stopped||this.hookChecks.has(peer.id))return;
    const evidence=this.pairAnomalies.evidence(peer),endpoint=this.store.endpoint(peer.id),configHome=endpoint?.configHome??this.config.codexHome;
    if(!evidence.hookError||!hookApprovalRequired(evidence.hookError)||!configHome||!endpoint)return;
    const identity=JSON.stringify([endpoint.epoch,endpoint.native?.procStart??endpoint.procStart,configHome]);
    const work=(async()=>{
      const trust=await this.hookTrust.check(configHome,peer.cwd);
      if(this.stopped)return;
      const current=this.store.peer(peer.id),active=this.store.endpoint(peer.id),fresh=this.pairAnomalies.evidence(current);
      if(!active||fresh.scope!==evidence.scope||fresh.hookError!==evidence.hookError||fresh.lastHookAt!==evidence.lastHookAt||JSON.stringify([active.epoch,active.native?.procStart??active.procStart,active.configHome??this.config.codexHome])!==identity)return;
      const issue=trust==='required'?'hooks_trust_required':trust==='trusted'?'hooks_restart_required':undefined;
      if(fresh.hookTrustIssue===issue)return;
      this.pairAnomalies.integration(current,{hookTrustIssue:issue??null});
      const pair=this.store.pairFor(peer.id);if(pair)this.runtimeHealth.refreshNoticeConditions(pair,'hook_trust_refreshed');
    })();
    this.hookChecks.set(peer.id,work);
    this.background('hook_trust:'+peer.id,()=>work.finally(()=>{if(this.hookChecks.get(peer.id)===work)this.hookChecks.delete(peer.id);}));
  }
  private syncLaunchPreferences():void{
    const preferred:Partial<Record<Host,string>>={},pairs=this.store.pairs();
                                       
    if(pairs.length===1)for(const host of ['codex','claude'] as const){const peer=this.store.getPeer(pairs[0]![host]);if(peer?.owner==='user'&&peer.sessionId)preferred[host]=peer.sessionId;}
    const key=JSON.stringify(preferred);if(key===this.launchPreferenceKey)return;
    setPreferredProfiles(this.home,preferred);
    this.launchPreferenceKey=key;
  }
  async start():Promise<void>{
                                           
    if(process.platform==='win32'){
      this.hookIdentity??=new WindowsIdentitySession(this.home);
      this.background('hook_identity_prepare',()=>this.hookIdentity!.prepare());
    }
    this.communicationTips.cooperation.restarted();
    await this.pumpStage('startup_legacy',()=>{captureLegacyTakeovers(this.store,this.home);});
    await this.pumpStage('startup_controls',()=>{writeMemberControls(this.home,this.store);});
    for(const peer of this.store.peers())await this.pumpStage('startup_member:'+peer.id,()=>{if(!this.enabled(peer.id))this.adapters[peer.host].setEnabled?.(peer,this.runtimeEndpoint(peer.id),false);});
    await this.pumpStage('startup_routes',()=>this.restoreOwnedCodexRoutes());
    await this.pumpStage('startup_receipts',()=>this.store.recoverEmbeddedReceipts());
    await this.pumpStage('startup_questions',()=>this.questions.sweep());
    for(const pair of this.store.pairs())for(const id of [pair.claude,pair.codex])await this.pumpStage('startup_integration:'+id,()=>{if(this.enabled(id))this.pairAnomalies.integration(this.store.peer(id),{});});
    await this.pumpStage('startup_migration',async()=>{for(const note of await migrateLegacyOwnership(this.home,this.store))this.store.event('process.migration.failed',{message:note});});
    await this.pumpStage('startup_bindings',()=>this.backfillWindowBindings());
    await this.pumpStage('startup_retirements',()=>{
      const pending=this.store.setting<Record<string,{attempts:number;nextAt:number;error?:string}>>('processRetirements')??{};
      const ids=new Set([...ownedProcesses(this.home).records.map(value=>value.peerId),...nativeOwnershipRecords(this.home).map(value=>value.peerId)]);
      for(const peer of this.store.peers())if(peer.owner==='nxbridge'&&!this.store.pairFor(peer.id)&&ids.has(peer.id))pending[peer.id]??={attempts:0,nextAt:0};
      this.store.setSetting('processRetirements',pending);
    });
    const pairs=this.store.pairs(),interrupted=new Map(pairs.flatMap(pair=>[pair.codex,pair.claude].map(id=>[id,this.store.deliveryCounts(pair.id,id).sending] as const)));
    this.store.recover();
    this.questions.recover();
    for(const pair of pairs)for(const id of [pair.codex,pair.claude])await this.pumpStage('startup_delivery:'+id,()=>this.deliveryHealth.restarted(pair,this.store.peer(id),this.store.deliveryCounts(pair.id,id),this.store.unsettledDeliveryFacts(pair.id,id),interrupted.get(id)??0));
    this.maintain();
    const endpoints=[...new Set(this.store.endpoints().filter(e=>e.mode==='app-server'&&this.enabled(e.peerId)).map(e=>e.address))];
    await Promise.allSettled(endpoints.map(e=>this.adapters.codex.connect(e).catch(error=>{
      if(isCodexIdentityError(error)){for(const endpoint of this.store.endpoints().filter(value=>value.address===e))this.store.setSetting('codexIdentity:'+endpoint.peerId,{code:error.code,message:'投递已暂停：'+error.message,endpoint:e});}
      else this.disconnected(e);throw error;
    })));
    await this.refreshCodexSubagents();
    const tick=()=>{
      if(this.stopped)return;
      this.background('member_recovery_tick',()=>Promise.all(this.schedulePairedRecoveries().values()));
      this.background('managed_exits',()=>this.memberLifecycle.observeManagedExits());this.background('timer_pump',()=>this.pump());
      observeBrokerReachable(this.home);
      let interval=5000;this.store.faults.sync('timer_pending',()=>{if(this.store.pendingCount())interval=1000;});
      if(!this.stopped)this.timer=setTimeout(tick,interval);
    };
    void tick();
    void this.pumpStage('reconcile',()=>this.reconcile());
  }
  private async backfillWindowBindings():Promise<void>{
    for(const peer of this.store.peers()){
      if(!this.enabled(peer.id))continue;
      if(peer.owner!=='user'||!peer.sessionId||!['root','fork'].includes(peer.kind)||this.store.bindings.current(peer.id))continue;
      const endpoints=this.store.endpoints(peer.id).filter(e=>e.active&&e.mode!=='app-server'&&e.processKind!=='app-server'&&e.configHome&&e.pid&&e.procStart);
      if(endpoints.length!==1)continue;
      const endpoint=endpoints[0]!;
      try{
        const identity=await processIdentity(endpoint.pid!);
        if(identity.startedAt!==endpoint.procStart||!new RegExp('^'+peer.host+'(?:\\.exe)?$','i').test(identity.name)||peer.host==='codex'&&await codexIsAppServer(identity))continue;
        this.store.transaction(()=>{const binding=this.store.bindings.activate({host:peer.host,configHome:endpoint.configHome!,pid:identity.pid,procStart:identity.startedAt},peer.id,peer.sessionId!,'legacy verified window');this.store.saveEndpoint({...endpoint,bindingEpoch:binding.epoch});});
      }catch(error){this.store.event('context.backfill.unverified',{peerId:peer.id,error:describeError(error)});}
    }
  }
  private disconnected(address:string):void{
    for(const ep of this.store.endpoints())if(ep.mode==='app-server'&&ep.address===address){
      if(!this.enabled(ep.peerId))continue;
      this.store.saveEndpoint({...ep,active:false});const peer=this.store.peer(ep.peerId);
      if(peer.state!=='offline')this.store.updatePeer(peer.id,{state:'offline'});
    }
  }
  private maintain():void{
    this.lastMaintenance=Date.now();
    this.store.faults.sync('retention',()=>{
      this.store.maintain(this.config.retention);
      for(const peer of this.store.peers()){
        const intent=this.store.setting<{peerId:string;sessionId:string}>('implicitPartner:'+peer.id);
        if(!intent||this.memberLifecycle.isPreparing(intent.peerId)||this.deletedSessions.ownsReservation(peer.id,intent.peerId)||peer.sessionId===intent.sessionId&&peer.state!=='offline'&&this.store.selections.pending(peer.id,intent.sessionId))continue;
        this.retireImplicitPartner({...peer,sessionId:intent.sessionId},intent.peerId);
      }
      const sessions=new Map(this.store.peers().map(peer=>[peer.id,peer.sessionId]));
      this.health.prune(new Set(this.store.endpoints().flatMap(endpoint=>sessions.get(endpoint.peerId)?[this.health.key(endpoint.address,sessions.get(endpoint.peerId)!)]:[])),Date.now()-({...DEFAULT_RETENTION,...this.config.retention}).maintenanceIntervalMs);
    });
    if(!this.recordMaintenance){
      this.recordMaintenance=pruneDeadProcessRecords(this.home,{retention:this.config.retention,referencedPeers:new Set(this.store.peers().filter(peer=>this.store.pairFor(peer.id)||this.managedRecovery.get(peer.id)&&this.managedRecovery.get(peer.id)!.state!=='closed').map(peer=>peer.id))}).then(result=>{
        if(result.owned||result.runtime||result.artifacts||result.notes.length)this.store.event('process.records.maintained',result);
        this.store.checkpoint();
      }).catch(error=>this.pumpFailed('process_maintenance',error)).finally(()=>{this.recordMaintenance=undefined;});
    }
  }
  async stop(releaseOwned=false,cause:PairLossCause|null={reason:'broker_shutdown'}):Promise<string[]>{
    this.hookIdentity?.close();for(const receipt of this.hookReceipts.values())clearTimeout(receipt.timer);this.hookReceipts.clear();
    this.resources?.stop();
    this.stopped=true;this.runtimeHealth.abortNotices();clearInterval(this.timer);await this.modReads.close();await Promise.allSettled(this.lifecycle.values());while(this.pumping||this.memberLifecycle.pending||this.reconciling.size||this.runtimeHealth.pending||this.recordMaintenance)await delay(20);
    await Promise.allSettled([this.memberLifecycle.waitForReleases(),...this.codexSubscriptionChecks.values(),...this.codexObservationChecks.values()]);
    this.questions.recover();
    const notes:string[]=[];
    if(releaseOwned){
      for(const pair of this.store.pairs())this.store.unpair(pair.id,cause??undefined);notes.push(...await this.memberLifecycle.releaseOwned(this.store.peers().filter(p=>p.owner==='nxbridge').map(p=>p.id)));
      try{const note=await this.adapters.codex.releaseRuntime(this.store.peers().filter(peer=>peer.owner==='user'&&!(peer.host==='codex'&&peer.kind==='subagent')).flatMap(peer=>this.store.endpoints(peer.id)));if(note)notes.push(note);}catch(error){notes.push('托管 App Server 回收未完成：'+describeError(error));}
    }
    this.daemons.close();this.adapters.codex.close();this.adapters.claude.close();return notes;
  }
  private actor(input:Actor):Peer {
    let peer=this.store.resolve(input);
    if(!peer)throw new BridgeError('unregistered','当前会话尚未登记。');
    if(peer.kind==='unknown')throw new BridgeError('unverified_identity','无法核验该线程是根会话、fork 还是子代理，请从原生 App Server 挂接或通过可信 hooks 登记。');
    const seen=new Set<string>();
    while(peer.kind==='subagent'){
      if(this.config.subagentSend==='deny')throw new BridgeError('subagent_denied','当前配置要求由主会话对外发信。');
      if(!peer.parentId||seen.has(peer.id))throw new BridgeError('unverified_parent','缺少可核验的子代理父链。');
      seen.add(peer.id);const parent:Peer|undefined=peer.rootPeerId?this.store.peer(peer.rootPeerId):this.store.find(peer.host,peer.parentId);if(!parent)throw new BridgeError('unverified_parent','父会话尚未通过宿主登记。');peer=parent;
    }
    if(!['root','fork'].includes(peer.kind))throw new BridgeError('unverified_parent','父链没有到达可核验的独立主会话。');
    return peer;
  }
                                              
  private partnerActor(input:Actor):Peer {
    if(input.host!=='codex')return this.actor(input);
    const peer=this.store.resolve(input);
    if(!peer)throw new BridgeError('unregistered','当前会话尚未登记。');
    if(peer.kind==='subagent')throw new BridgeError('subagent_denied','Codex 子代理只能向父代理汇报，由独立主会话与 Claude 搭档通信。');
    if(!['root','fork'].includes(peer.kind))throw new BridgeError('unverified_identity','尚未核验独立 Codex 主会话身份，不能调用搭档工具。');
    return peer;
  }
  private enabled(id:string):boolean{const peer=this.store.getPeer(id);return !!peer&&memberEnabled(this.store,peer);}
  private offResult(peer:Peer){return memberOffResultFor(peer.enabled!==false&&peer.rootPeerId?this.store.getPeer(peer.rootPeerId)??peer:peer);}
  private requireEnabled(peer:Peer):void{requireMemberEnabled(this.store,peer);}
  private async restoreOwnedCodexIngress(input:RegisterInput,peers:Peer[]):Promise<void>{
    const source=input.endpoint;
    if(input.host!=='codex'||source.mode!=='embedded'||source.daemon||source.processKind==='foreground'||!source.pid||!source.procStart)return;
    const routes=peers.filter(peer=>peer.owner==='nxbridge'&&!this.store.bindings.current(peer.id)).flatMap(peer=>this.store.endpoints(peer.id).filter(endpoint=>{
      const native=endpoint.native??endpoint;
      if(endpoint.mode!=='app-server'||endpoint.daemon||!localCodexEndpoint(this.home,endpoint.address)||native.pid!==source.pid||native.procStart!==source.procStart)return false;
      const runtime=runtimeFor(this.home,{peerId:peer.id,endpoint:endpoint.address})?.value;
      return runtime?.kind==='owned'&&runtime.state==='ready'&&runtime.pid===source.pid&&runtime.procStart===source.procStart;
    }).map(endpoint=>({peer,endpoint})));
    if(!routes.length)return;
    if(routes.length!==1)throw new BridgeError('ambiguous_context','原生进程对应多个托管路由，未恢复观察端点。');
    const {peer,endpoint}=routes[0]!;input.endpoint.processKind='app-server';
    if(endpoint.active&&!this.store.endpoints(peer.id).some(value=>value.active&&value.mode==='embedded'))return;
    if((await probeProcesses([{pid:source.pid,procStart:source.procStart}]))[0]!=='alive')throw new BridgeError('process_identity_unknown','托管进程代次未核验，未恢复观察端点。');
    this.requireEnabled(peer);
    const current=this.store.peer(peer.id),endpoints=this.store.endpoints(peer.id);
    const ownIngress=(value:Endpoint)=>value.mode==='embedded'&&value.processKind==='app-server'&&!value.daemon&&value.pid===source.pid&&value.procStart===source.procStart;
    if(this.stopped||current.owner!=='nxbridge'||current.sessionId!==input.sessionId||this.store.bindings.current(peer.id)||endpoints.some(value=>value.active&&value.epoch!==endpoint.epoch&&!ownIngress(value)))throw new BridgeError('session_changed','托管路由或窗口已变化，未恢复观察端点。');
    this.store.transaction(()=>{
                                               
      for(const value of endpoints)if(value.active&&ownIngress(value))this.store.deactivate(peer.id,value.epoch);
      this.store.saveEndpoint({...endpoint,active:true,seenAt:Date.now()});
      this.store.updatePeer(peer.id,{...(current.state==='offline'?{state:'unknown' as const}:{}),launchFailure:undefined});
    });
  }
  private async restoreOwnedCodexRoutes():Promise<void>{
    if(this.stopped)return;
    await Promise.allSettled(this.store.pairs().filter(pair=>!pair.paused).map(pair=>this.pumpStage('restore_route:'+pair.codex,async()=>{
      const peer=this.store.peer(pair.codex);
      if(hostingGate(this.store,peer))return;
      if(!this.enabled(peer.id)||peer.owner!=='nxbridge'||!peer.sessionId||this.store.bindings.current(peer.id)||['paused','needsHuman'].includes(peer.state)||this.memberLifecycle.isRetiring(peer.id)||this.memberLifecycle.isRestarting(peer.id)||this.memberLifecycle.isPreparing(peer.id)||this.store.setting('managedSessionConflict:'+peer.id)||this.memberLifecycle.retryPending(peer.id))return;
      const endpoints=this.store.endpoints(peer.id);
      if(endpoints.some(value=>value.active&&value.mode==='app-server')&&!endpoints.some(value=>value.active&&value.mode==='embedded'))return;
      try{
        const runtime=runtimeFor(this.home,{peerId:peer.id})?.value;
        if(runtime?.kind!=='owned'||runtime.state!=='ready'||!runtime.pid||!runtime.procStart||!endpoints.some(value=>value.mode==='app-server'&&!value.daemon&&value.address===runtime.endpoint))return;
                                                
        await this.restoreOwnedCodexIngress({host:'codex',sessionId:peer.sessionId,cwd:peer.cwd,endpoint:{mode:'embedded',address:'',epoch:'owned-observer',pid:runtime.pid,procStart:runtime.procStart,processKind:'app-server'}},[peer]);
        const restored=this.store.endpoint(peer.id);
        if(restored?.mode==='app-server'&&restored.address===runtime.endpoint)await this.adapters.codex.attach(this.store.peer(peer.id),restored);
      }catch(error){if(isCodexIdentityError(error))return;this.memberLifecycle.delayRetry(peer.id,30000);this.store.event('codex.route.restore.failed',{peerId:peer.id,error:describeError(error)});}
    })));
  }
  private disabledRegistration(input:RegisterInput):Peer|undefined{
    const native=input.endpoint.native??input.endpoint;
    const exact=this.store.peers().filter(peer=>peer.host===input.host&&this.store.endpoints(peer.id).some(endpoint=>{const saved=endpoint.native??endpoint;return saved.pid===native.pid&&saved.procStart===native.procStart&&(!(endpoint.daemon||endpoint.processKind==='app-server'||endpoint.mode==='app-server')||peer.sessionId===input.sessionId||peer.sessionId===input.parentId);}));
    if(exact.some(peer=>this.enabled(peer.id)))return;
    const peer=this.store.peers().find(peer=>peer.host===input.host&&!this.enabled(peer.id)&&(peer.sessionId===input.sessionId||peer.sessionId===input.parentId||this.store.endpoints(peer.id).some(endpoint=>{
      const native=endpoint.native??endpoint;return !endpoint.daemon&&endpoint.mode!=='app-server'&&endpoint.processKind!=='app-server'&&native.pid===input.endpoint.pid&&native.procStart===input.endpoint.procStart;
    })));
    if(!peer)return;const binding=this.store.bindings.current(peer.id);return{...peer,enabled:false,...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{})};
  }
  private switchMember(peer:Peer,enabled:boolean):unknown{
    if(this.memberLifecycle.isRetiring(peer.id))throw new BridgeError('peer_releasing','成员正在释放，无法切换，请等待释放完成。');
    if(peer.enabled!==enabled)this.store.updatePeer(peer.id,{enabled});
    writeMemberControls(this.home,this.store);
    const endpoint=this.runtimeEndpoint(peer.id),pair=this.store.pairFor(peer.id);
    this.adapters[peer.host].setEnabled?.(peer,endpoint,enabled,!enabled&&!this.store.endpoints().some(value=>value.peerId!==peer.id&&value.active&&value.address===endpoint?.address));
    if(!enabled){
      this.wakeSignals.consumed(peer.id);this.codexWake.clear(peer.id);this.subagentCompletions.started(peer,true);this.identityConflicts.delete(peer.id);
      if(pair)for(const id of [pair.claude,pair.codex])for(const notice of this.deliveryHealth.peek(pair.id,id))this.deliveryHealth.cancel(pair.id,id,notice.id);
    }else{
      this.memberLifecycle.clearRetryDelay(peer.id);queueMicrotask(()=>void this.pump());
    }
    this.store.event('member.switch',{peerId:peer.id,enabled});
    return{member_id:peer.id,host:peer.host,enabled,paired:!!pair,message:enabled?'此窗口的 nxbridge 已开启；后续安全投递会继续。':'此窗口的 nxbridge 已关闭；窗口和配对保留，已有消息保持原状，不会启动替代窗口。'};
  }
  private pairedSender(actor:Actor,excluded?:ReadonlyMap<string,number>){
    if(this.stopped)throw new BridgeError('pair_changing','协调器正在关闭，请稍后重试。');
    const sender=this.partnerActor(actor);
    this.requireEnabled(sender);
    if(this.changingMembers.has(sender.id))throw new BridgeError('pair_changing','本窗口的配对正在切换，请等待释放完成后重试。');
    if(this.memberLifecycle.isRetiring(sender.id))throw new BridgeError('peer_releasing','当前会话正在解除配对并释放后台进程，请等待操作结束。');
    let pair=this.store.pairFor(sender.id);
    if(!pair){
      if(pairLoss(this.store,sender))throw new BridgeError('pair_lost','原配对已解除；请恢复原搭档或明确选择新搭档，未自动创建。');
      this.windowRecovery.assertUnbound(sender);
      const candidates=this.selectionResolver.pairingCandidates(sender,excluded);
      if(candidates.length)throw new BridgeError('selection_required','同项目存在已打开的未配对窗口，需要用户明确选择。');
      if(candidates.length===0&&this.config.implicit==='never')throw new BridgeError('partner_missing','没有对方会话，且隐式创建已关闭。');
      if(candidates.length===0){this.requireIndependentBackground();assertLaunchPreconditions(selectHostLaunch(otherHost(sender.host),this.config,{home:this.home,cwd:sender.cwd}));}
      const target=candidates[0]??this.store.placeholder(otherHost(sender.host),sender.cwd);
      if(this.memberLifecycle.isRetiring(target.id))throw new BridgeError('peer_releasing','候选搭档正在释放，未重新绑定。请等待操作结束。');
      pair=this.store.pair(sender.host==='claude'?sender.id:target.id,sender.host==='codex'?sender.id:target.id);
    }
    this.requireEnabled(this.store.peer(pair[otherHost(sender.host)]));return{sender,pair};
  }
  private requireIndependentBackground():void{
    if(process.platform==='win32'&&this.runtime&&!this.runtime.windowsIndependent)throw new BridgeError('bootstrap_required','要启动独立后台搭档，请在普通 PowerShell 窗口运行一次 nxbridge bootstrap，完成后重新发送消息。');
  }
  private async pairCode(actor:Actor,code:string):Promise<unknown>{
    const target=this.actor(actor),binding=this.store.bindings.validate(actor),requester=this.store.selections.codeRequester(code);this.requireEnabled(target);this.requireEnabled(requester.peer);
    if(this.memberLifecycle.isRetiring(target.id)||this.memberLifecycle.isRetiring(requester.peer.id))throw new BridgeError('peer_releasing','所选成员仍在回收，配对没有改变。');
    if(!binding||target.kind==='subagent'||actor.via)throw new BridgeError('unverified_identity','配对码只接受已核验的原生主窗口输入。');
    if(this.store.pairFor(target.id))throw new BridgeError('target_paired','这个窗口已有搭档，配对没有改变。');
    const [sourceState,targetState]=await probeProcesses([requester.binding,binding],10000);
    if(sourceState!=='alive')throw new BridgeError('requester_changed','发起配对的窗口已关闭或无法核验，配对没有改变。');
    if(targetState!=='alive')throw new BridgeError('unverified_identity','当前原生窗口身份无法核验，配对没有改变。');
    const previous=this.store.pairFor(requester.peer.id),result=this.store.selections.commitCode(actor,code,intent=>this.selectionSend(intent));
    await this.finalizeSelection(requester.peer,previous);
    const pair=this.store.pairFor(target.id),permission=pair?permissionGuidance(this.store.peer(pair.codex),this.store.peer(pair.claude),this.store.endpoint(pair.claude)):undefined;
    return{...(await this.selectionDelivery(result,target) as object),requester_name:requester.peer.name,requester_host:requester.peer.host,...(permission?{permission_guidance:permission}:{})};
  }
  private async finalizeSelection(sender:Peer,previous:Pair|undefined):Promise<void>{
    this.deletedSessions.bootstrapSelected(sender);
    this.retireImplicitPartner(sender);
    const pair=this.store.pairFor(sender.id);
    if(previous&&previous.id!==pair?.id){
      for(const id of [previous.claude,previous.codex])this.questions.cancelPeer(id);
      const release=this.memberLifecycle.queueRetirements([previous.claude,previous.codex].filter(id=>id!==pair?.claude&&id!==pair?.codex));this.background('retirements',()=>this.memberLifecycle.releaseOwned(release));
    }
    if(pair)for(const id of [pair.claude,pair.codex]){const target=this.store.peer(id);if(target.owner==='nxbridge'&&(!target.sessionId||!this.memberLifecycle.ownedClaudeLaunchReady(target)))try{await this.memberLifecycle.prepare(target);}catch(error){this.store.event('pair.partner.start.failed',{peerId:id,error:describeError(error)});}}
    queueMicrotask(()=>void this.pump());
  }
  private selectionSend(intent:SendIntent,wake=true,selectedPair?:Pair):unknown{
    this.deletedSessions.bootstrapSelected(this.actor(intent.actor));
                                             
    return selectedPair?this.acceptMessage(this.partnerActor(intent.actor),selectedPair,intent,wake):this.send(intent,wake);
  }
  private async selectionDelivery(result:unknown,target:Peer):Promise<unknown>{
    if(this.deletedSessions.pendingCreation(target.id)){
                                                                                                                          
      const message='partner selected but its session start is unconfirmed: launch sent, identity not verified yet; pairing kept, no second create. wait for it to register (nxbridge status); if it never does, tell user (they may unpair or choose another).';
      return{...result as object,status:'launch_precondition',launch_precondition:{code:'session_unverified',message,member_id:target.id},message};
    }
    const failure=this.store.peer(target.id).launchFailure;
    if(failure)return{...result as object,status:'launch_precondition',launch_precondition:{code:failure.code??'launch_pending',message:failure.message},message:failure.message+((result as {message_id?:string}).message_id?' 原消息已保存；完成前置条件后重试同一配对选择即可，不要重发任务。':' 配对已保留；完成前置条件后可继续使用原会话。')};
    const endpoint=this.store.endpoint(target.id);if(!endpoint?.daemon)return result;
    await this.daemons.wakeReady(target,endpoint);
    const guidance=this.runtimeHealth.deliveryGuidance(this.store.peer(target.id)),updated={...(result as Record<string,unknown>),...guidance,message:'paired w/ '+target.name+(guidance.delivery_wait?'; '+guidance.delivery_wait.message:'; queued for bounded daemon delivery; receipt still required')};
    if(!guidance.delivery_wait)delete updated.delivery_wait;return updated;
  }
  private retireImplicitPartner(sender:Peer,expected?:string):void{
    const key='implicitPartner:'+sender.id,intent=this.store.setting<{peerId:string;sessionId:string}>(key);
    if(!intent||intent.sessionId!==sender.sessionId||expected&&intent.peerId!==expected||this.store.pairFor(intent.peerId))return;
    this.store.setSetting(key,null);const release=this.memberLifecycle.queueRetirements([intent.peerId]);this.background('implicit-retirement:'+intent.peerId,()=>this.memberLifecycle.releaseOwned(release));
  }
  private async applySelection(raw:unknown):Promise<unknown>{
    const p=z.object({actor:actorSchema,selection_id:text,key:text.optional(),action:z.enum(['choose','create','cancel','unpair','adopt','wait']).optional(),...modelProfileSchema.shape}).parse(raw);
    if(hasProfile(p)&&p.action!=='create')throw new BridgeError('invalid_arguments','model/effort 只能在新建后台搭档（action=create）时指定；要改当前的后台搭档，用 partner_profile。');
    const root=this.actor(p.actor);if(!['root','fork'].includes(root.kind)||p.actor.via)throw new BridgeError('subagent_denied','搭档选择只能由当前原生主窗口提交。');
    const view=this.store.selections.view(p.actor,p.selection_id,this.config) as {status:string;reason?:string;hosting_action?:string;candidates?:{key:string;member_id:string;former_partner?:true;continuation_of?:string}[]};
    if(view.candidates?.some(candidate=>candidate.key===p.key&&candidate.former_partner))await this.refreshDeletedHistory(root);
    if(view.reason==='pair_lost'&&['cancel','wait','unpair'].includes(p.action??'')){
      const loss=pairLoss(this.store,root);if(loss?.reason==='session_deleted')this.store.setSetting(pairLossKey(root.id),{...loss,replacement_suppressed:true});
    }
    if(view.reason==='hosting'&&['adopt','wait'].includes(p.action??'')||view.hosting_action){
      const result=this.store.selections.commit(p.actor,p,this.config,intent=>this.selectionSend(intent,false)) as {hosting_action:string},pair=this.store.pairFor(root.id);if(!pair)throw new BridgeError('selection_expired','原配对已经改变。');
      const target=this.store.peer(pair.codex);
      try{const applied=result.hosting_action==='adopt'?await this.transfers.adopt(target):target.owner==='nxbridge'?await this.transfers.release(target):await this.transfers.wait(target);queueMicrotask(()=>void this.pump());return this.store.selections.hostingResult(p.actor,p.selection_id,{...result,...applied as object});}
      catch(error){return this.store.selections.hostingResult(p.actor,p.selection_id,{...result,hosting:hostingStatus(this.store,this.store.peer(target.id)),error:{code:(error as BridgeError).code,message:describeError(error)}});}
    }
    if(this.store.selections.committed(p.actor,p.selection_id)){const sender=this.actor(p.actor),pair=this.store.pairFor(sender.id);if(pair)await this.finalizeSelection(sender,pair);return pair?{...await this.selectionDelivery(view,this.store.peer(pair[otherHost(sender.host)])) as object,selection_id:p.selection_id}:view;}
    if(view.status==='selection_declined'||view.status==='unpaired')return view;
    if(p.action==='create'){this.requireIndependentBackground();profileDefaults(this.home,this.config,otherHost(root.host),modelProfileSchema.parse(p));}
    if(!p.action||p.action==='choose'){
      const candidate=view.candidates?.find(c=>c.key===p.key);
      if(!candidate)throw new BridgeError('selection_expired','候选标识无效，请重新选择。');
      const peer=this.store.peer(candidate.member_id);this.requireEnabled(peer);
      if(this.memberLifecycle.isRetiring(peer.id))throw new BridgeError('peer_releasing','所选成员仍在回收，配对没有改变。');
      if(candidate.former_partner){
        return this.changePair(async()=>{
          if(peer.owner==='nxbridge')await this.memberLifecycle.assertNoLiveSessionHolder(peer);
          const loss=pairLoss(this.store,root),home=partnerConfigHome(this.store,peer,loss?.partner_id===peer.id?loss.partner_config_home:undefined);
          const sender=this.actor(p.actor),previous=this.store.pairFor(sender.id),result=this.store.selections.commit(p.actor,p,this.config,intent=>this.selectionSend(intent,false,this.store.pairFor(sender.id)!));
          await this.resumeRestoredPair(this.store.pairFor(peer.id)!,home?new Map([[peer.id,home]]):undefined);await this.finalizeSelection(sender,previous);
          return this.selectionDelivery(result,peer);
        },this.store.pairFor(root.id)?.id,[root.id,peer.id]);
      }
      const availability=await this.runtimeHealth.probeRuntime(peer,true);
      if(!this.selectionResolver.candidateAvailable(peer,availability)){
        if(availability.nativeState==='dead'||!availability.nativeState&&availability.state==='blocked')this.store.updatePeer(peer.id,{state:'offline'});
        throw new BridgeError('selection_expired','候选窗口已关闭或当前无法核验，请刷新候选。');
      }
    }
    const sender=this.actor(p.actor),previous=this.store.pairFor(sender.id),result=this.store.selections.commit(p.actor,p,this.config,intent=>this.selectionSend(intent,false));
    const selectedPair=this.store.pairFor(sender.id);if(p.action==='create'&&hasProfile(p)&&selectedPair)this.profiles.set(this.store.peer(selectedPair[otherHost(sender.host)]),modelProfileSchema.parse(p));
    const adopted=view.candidates?.find(candidate=>candidate.key===p.key)?.continuation_of,lease=adopted?this.takeovers.get(adopted):undefined;if(adopted&&lease?.adopted)await this.memberLifecycle.returnTakeover(adopted,lease.id);await this.finalizeSelection(sender,previous);const pair=this.store.pairFor(sender.id);
    return pair?{...await this.selectionDelivery(result,this.store.peer(pair[otherHost(sender.host)])) as object,selection_id:p.selection_id}:result;
  }
  private async resumeRestoredPair(pair:Pair,homes?:ReadonlyMap<string,string>):Promise<void>{
                                        
    const retirements=this.store.setting<Record<string,unknown>>('processRetirements')??{};
    for(const id of [pair.claude,pair.codex])delete retirements[id];this.store.setSetting('processRetirements',retirements);
    for(const id of [pair.claude,pair.codex]){
      const peer=this.store.peer(id);if(peer.owner!=='nxbridge')continue;
      const saved=this.store.setting<StoredLaunchProof>('managedLaunchProof:'+id);
      const home=partnerConfigHome(this.store,peer,homes?.get(id));
      if(home)this.store.setSetting('managedLaunchProof:'+id,{...(saved?.sessionId===peer.sessionId?saved:{}),sessionId:peer.sessionId!,configHome:home,...(saved?.nativeLaunchId&&saved.sessionId===peer.sessionId?{restorePairId:pair.id}:{})});
      try{await this.memberLifecycle.prepare(peer);}
      catch(error){
                                                  
        if(!this.store.peer(id).launchFailure)this.store.updatePeer(id,{launchFailure:{at:Date.now(),...(error instanceof BridgeError?{code:error.code}:{}),message:describeError(error).slice(0,1200)}});
        this.store.event('pair.partner.start.failed',{peerId:id,error:describeError(error)});
      }
    }
    queueMicrotask(()=>void this.pump());
  }
  private async refreshDeletedHistory(peer:Peer):Promise<void>{
    const loss=pairLoss(this.store,peer);if(loss?.reason!=='session_deleted')return;
    const partner=this.store.getPeer(loss.partner_id);if(!partner||partner.sessionId!==loss.partner_session_id)return;
    const endpoint=this.store.endpoint(partner.id)??this.store.endpoints(partner.id).sort((a,b)=>b.seenAt-a.seenAt)[0];
    if(endpoint)await verifySessionHistory(this.store,partner,endpoint,{fresh:true});
  }
  private async restoreLostPair(id:string):Promise<unknown>{
    const pair=this.store.pairById(id);if(!pair)throw new BridgeError('pair_restore_unavailable','原配对不存在。');
    if(!pair.archived){
      let result:unknown={restored:true,pair_id:id};
      for(const member of [pair.claude,pair.codex]){const peer=this.store.peer(member);if(peer.owner==='nxbridge')result=await this.selectionDelivery(result,peer);}return result;
    }
    const members=[this.store.peer(pair.claude),this.store.peer(pair.codex)];
    const homes=new Map(members.flatMap(member=>{const loss=pairLoss(this.store,member);return loss?.partner_config_home?[[loss.partner_id,loss.partner_config_home] as const]:[];}));
    for(const member of members)this.requireEnabled(member);
    for(const member of members)await this.refreshDeletedHistory(member);
    if(members.some(peer=>this.store.pairFor(peer.id)))throw new BridgeError('pair_exists','原成员已有其他搭档，不能恢复旧配对。');
    for(const peer of members){
      if(this.memberLifecycle.isRetiring(peer.id))throw new BridgeError('peer_releasing','原成员仍在回收，请稍后恢复。');
      const loss=pairLossView(this.store,peer,this.config,true);
      if(!loss&&members.some(member=>{const recovered=pairLossView(this.store,member,this.config,true);return recovered?.pair_id===id&&recovered.reason==='session_deleted'&&recovered.deleted_member_id===peer.id&&recovered.restore_state==='resumable';}))continue;
      if(!loss){
        if(members.some(member=>member.owner==='nxbridge')&&(peer.owner==='user'||restorableOwnedPartner(this.store,peer,partnerConfigHome(this.store,peer,homes.get(peer.id)),true)))continue;
      }else if(loss.pair_id===id&&loss.restore_state!=='gone'&&(this.store.peer(loss.partner_id).owner==='user'||restorableOwnedPartner(this.store,this.store.peer(loss.partner_id),partnerConfigHome(this.store,this.store.peer(loss.partner_id),homes.get(loss.partner_id)),true)))continue;
      throw new BridgeError('pair_restore_unavailable','原会话历史缺失或已切换，未恢复，也未创建新搭档。');
    }
    return this.changePair(async()=>{
      for(const peer of members)if(peer.owner==='nxbridge')await this.memberLifecycle.assertNoLiveSessionHolder(peer);
      for(const peer of members)if(peer.owner==='nxbridge'&&!restorableOwnedPartner(this.store,this.store.peer(peer.id),partnerConfigHome(this.store,this.store.peer(peer.id),homes.get(peer.id)),true))throw new BridgeError('pair_restore_unavailable','原会话历史或配对状态已改变，未恢复配对。');
      const restored=this.store.restorePair(id);authorizeDaemonWake(this.store,restored,'terminal');await this.resumeRestoredPair(restored,homes);
      let result:unknown={restored:true,pair_id:id,claude:pair.claude,codex:pair.codex,sessions:members.map(peer=>({member_id:peer.id,session_id:peer.sessionId}))};
      for(const peer of members)if(peer.owner==='nxbridge')result=await this.selectionDelivery(result,peer);return result;
    },id,[pair.claude,pair.codex]);
  }
  private configurationSession(actor:Actor):ConfigurationSession{
    const peer=this.actor(actor);
    if(peer.sessionId!==actor.sessionId||actor.via)throw new BridgeError('subagent_denied','配置入口只接受当前独立根会话。');
    const endpoint=this.store.endpoint(peer.id);
    const native=this.configurationWindows.get(peer.id),runtime=endpoint?.pid&&endpoint.procStart?endpoint:native?.epoch===endpoint?.epoch?native:undefined;
    if(!endpoint?.active||!runtime?.pid||!runtime.procStart)throw new BridgeError('config_context_unverified','尚未核验当前宿主进程，请重新加载插件后再试。');
    return{host:actor.host,sessionId:actor.sessionId,window:`${runtime.pid}:${runtime.procStart}`,name:peer.name,cwd:peer.cwd};
  }
  private applyConfiguration():void{
    const latest=loadBridgeConfig(this.home);
    syncFrozenProfiles(this.home,latest);
    for(const key of Object.keys(this.config))delete(this.config as unknown as Record<string,unknown>)[key];
    Object.assign(this.config,latest);this.memberLifecycle.launchInputsChanged();
    this.profiles.syncConfiguration();
    this.configurationReload.applied();
    queueMicrotask(()=>{if(!this.stopped)void this.pump();});
  }
  private syncPartnerProfile(id:string):Promise<void>{return this.profileCoordination.synchronize(id);}
  private async partnerProfile(raw:unknown):Promise<unknown>{
    const p=targetSchema.extend({host:host.optional(),action:z.enum(['get','set','reset']).default('get'),...modelProfileSchema.shape}).parse(raw);
    if(p.actor){const caller=this.actor(p.actor);if(!['root','fork'].includes(caller.kind)||p.actor.via)throw new BridgeError('subagent_denied','只有主会话能修改搭档的模型和推理强度。');if(p.host&&p.host===caller.host)throw new BridgeError('invalid_target','这里只能修改你的搭档的模型和推理强度，不能改自己的。');}
    const pair=this.targetPair(p),targetHost=p.actor?otherHost(p.actor.host):p.host;
    if(!targetHost)throw new BridgeError('invalid_arguments','在终端里要指明改哪一方：nxbridge partner-profile codex 或 nxbridge partner-profile claude。');
    const peer=this.store.peer(pair[targetHost]);this.requireEnabled(peer);
    if(p.peer_id&&p.peer_id!==peer.id)throw new BridgeError('invalid_target','指定的成员不是这一方的搭档。');
    return this.profileCoordination.command(peer,p.action,p);
  }
  private async hostingTarget(p:TargetSelector&{home?:string;cwd?:string},create=false):Promise<Peer>{
    let member=p.peer_id?this.store.peer(p.peer_id):undefined;
    if(p.pair_id){
      const pair=this.store.pairById(p.pair_id);if(!pair)throw new BridgeError('unpaired','所选配对不存在。');
      if(member&&![pair.claude,pair.codex].includes(member.id))throw new BridgeError('pair_selector_mismatch','成员与配对不一致。');
      if(pair.archived){
        if(!create)throw new BridgeError('unpaired','所选配对已归档；只有 adopt 可以明确恢复历史配对。');
        for(const id of [pair.claude,pair.codex]){
          const peer=this.store.peer(id);await this.refreshDeletedHistory(peer);
          const loss=pairLossView(this.store,peer,this.config,true);
          if(loss?.reason==='session_deleted'&&loss.restore_state!=='resumable')throw new BridgeError('pair_restore_unavailable','原会话历史仍然缺失，未恢复托管配对。');
        }
        this.store.restorePair(pair.id);
      }
      member=this.store.peer(pair.codex);
    }
    if(p.session_id){
      let matches=this.store.peers().filter(peer=>peer.host==='codex'&&peer.sessionId===p.session_id&&peer.kind!=='subagent'&&(!p.home||this.store.endpoints(peer.id).some(ep=>ep.configHome&&sameDirectory(ep.configHome,p.home!))||sameDirectory(hostingRecord(this.store,peer)?.configHome??'',p.home!)));
      const paired=matches.filter(peer=>this.store.pairFor(peer.id));if(paired.length)matches=paired;
      if(member?.host==='codex'){if(member.sessionId!==p.session_id)throw new BridgeError('pair_selector_mismatch','成员与原会话 ID 不一致。');matches=[member];}
      if(matches.length>1)throw new BridgeError('ambiguous_context','同一会话对应多名成员或多个配置目录，请用 --member 或 --home 指定。');
      let target=matches[0];
      if(!target&&create){
        if(!member||member.host!=='claude')throw new BridgeError('partner_required','这个会话还没有配对记录；请同时用 --member 指定要配对的 Claude 成员。');
        if(this.store.pairFor(member.id))throw new BridgeError('target_paired','该 Claude 已有搭档，请先通过搭档选择明确更换。');
        const launch=selectHostLaunch('codex',this.config,{home:this.home,cwd:p.cwd??member.cwd,configHome:p.home}),file=sessionFile(p.home??launch.configHome,p.session_id),profile=await readSessionProfile(file,p.session_id);
        if(!profile.verified)throw new BridgeError('session_not_found','所选配置目录中没有原会话持久历史，未创建新会话。');
        target=this.store.register({host:'codex',sessionId:p.session_id,cwd:profile.settings.cwd??profile.meta.cwd??p.cwd??member.cwd,name:'Codex',kind:'root',state:'offline',endpoint:{mode:'app-server',epoch:'adopt:'+randomUUID(),address:'',pid:null,procStart:null,configHome:p.home??launch.configHome}});this.store.deactivate(target.id);this.store.pair(member.id,target.id);
      }
      if(!target)throw new BridgeError('session_not_found','找不到原会话成员；可用 --home 指定配置目录，并用 --member 指定 Claude 搭档。');
      if(member?.host==='claude'&&this.store.pairFor(target.id)?.claude!==member.id)throw new BridgeError('pair_selector_mismatch','所选 Claude 不是原会话的搭档，未更换配对。');member=target;
    }
    if(member?.host==='claude'){const pair=this.store.pairFor(member.id);if(!pair)throw new BridgeError('unpaired','所选 Claude 没有 Codex 搭档。');member=this.store.peer(pair.codex);}
    if(!member)member=this.store.peer(this.targetPair(p).codex);
    if(member.host!=='codex'||!member.sessionId)throw new BridgeError('session_missing','目标不是已有持久 ID 的 Codex 主会话。');
    if(!this.store.pairFor(member.id)){
      if(!create)throw new BridgeError('unpaired','原配对已结束。要接回，在搭档选择里选“之前的后台搭档”，或运行 nxbridge pair --restore <原配对ID>。');
      const history=[...new Map(this.store.pairHistory(member.id).filter(pair=>pair.archived&&!this.store.pairFor(pair.claude)&&!this.store.pairFor(pair.codex)).reverse().map(pair=>[pair.claude,pair] as const)).values()];
      if(history.length!==1)throw new BridgeError('pair_selector_required','这个会话配过不止一个搭档，或原搭档已配给别的窗口。用 --pair <原配对ID> 指定要接回哪一组。');
      for(const id of [history[0]!.claude,history[0]!.codex]){
        const peer=this.store.peer(id);await this.refreshDeletedHistory(peer);
        const loss=pairLossView(this.store,peer,this.config,true);
        if(loss?.reason==='session_deleted'&&loss.restore_state!=='resumable')throw new BridgeError('pair_restore_unavailable','原会话历史仍然缺失，未恢复托管配对。');
      }
      this.store.restorePair(history[0]!.id);
    }
    return member;
  }
  private targetPair(raw:unknown):Pair{
    const p=targetSchema.parse(raw??{});
    let member=p.actor?this.actor(p.actor):p.peer_id?this.store.peer(p.peer_id):undefined;
    if(p.native){const matches=this.store.bindings.all().filter(b=>b.active&&b.host===p.native!.host&&b.pid===p.native!.pid&&b.procStart===p.native!.procStart);if(matches.length!==1)throw new BridgeError('ambiguous_context','当前原生进程没有唯一窗口绑定，请通过 --pair、--member 或 --session 明确选择。');const current=this.store.peer(matches[0]!.peerId);if(member&&current.id!==member.id)throw new BridgeError('pair_selector_mismatch','指定成员与当前窗口不一致。');member=current;}
    if(p.session_id){const matches=this.store.peers().filter(peer=>peer.sessionId===p.session_id&&peer.kind!=='subagent');if(matches.length!==1)throw new BridgeError('ambiguous_context','会话 ID 不唯一或不存在，请通过 --member 或 --pair 明确选择。');if(member&&matches[0]!.id!==member.id)throw new BridgeError('pair_selector_mismatch','指定会话与成员不一致。');member=matches[0];}
    const pair=member?this.store.pairFor(member.id):this.store.currentPair(p.pair_id);
    if(!pair)throw new BridgeError('unpaired','找不到这个窗口的当前配对。要接回之前的后台搭档，打开搭档选择（Claude 里 /nxbridge pair，Codex 里 nxbridge pair），或在终端运行 nxbridge pair 查看 ID，再用 nxbridge pair --claude <ID> --codex <ID> 配对。');
    if(p.pair_id&&p.pair_id!==pair.id||p.peer_id&&!([pair.claude,pair.codex].includes(p.peer_id)))throw new BridgeError('pair_selector_mismatch','指定配对与当前窗口不一致。');
    return pair;
  }
  private diagnosticContext(raw:unknown):unknown{
    const p=targetSchema.strict().parse(raw??{});
    if(p.peer_id||p.pair_id||p.session_id||!p.native&&!p.actor)throw new BridgeError('diagnostic_context_required','doctor --current 只能读取当前原生窗口，不能选择其他会话。');
    const ids=p.native?[...new Set([
      ...this.store.bindings.all().filter(b=>b.active&&b.host===p.native!.host&&b.pid===p.native!.pid&&b.procStart===p.native!.procStart).map(b=>b.peerId),
      ...this.store.endpoints().filter(e=>{const native=e.native??e;return e.active&&native.pid===p.native!.pid&&native.procStart===p.native!.procStart&&this.store.peer(e.peerId).host===p.native!.host;}).map(e=>e.peerId),
    ])]:[this.actor(p.actor!).id];
    if(ids.length!==1)throw new BridgeError('diagnostic_context_required','当前窗口没有唯一登记身份，停止自动诊断并告知用户。');
    const peer=this.store.peer(ids[0]!),binding=this.store.bindings.current(peer.id);
    if(!peer.sessionId||peer.kind==='subagent'||p.actor&&this.actor(p.actor).id!==peer.id)throw new BridgeError('diagnostic_context_required','无法核验当前主会话身份。');
    const pair=this.store.pairFor(peer.id),codex=peer.host==='codex'?peer:pair?this.store.peer(pair.codex):undefined,endpoint=codex?this.store.endpoint(codex.id):undefined;
    return{status:modelStatus(this.status({host:peer.host,memberId:peer.id,sessionId:peer.sessionId,callId:randomUUID(),...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{})})),...(codex?{codex:{cwd:codex.cwd,configHome:endpoint?.configHome??this.config.codexHome}}:{})};
  }
  private dismissLostPair(raw:unknown):boolean{
    const p=targetSchema.parse(raw??{});let members:Peer[]=[];
    if(p.actor)members=[this.actor(p.actor)];
    else if(p.peer_id)members=[this.store.peer(p.peer_id)];
    else if(p.session_id){members=this.store.peers().filter(peer=>peer.sessionId===p.session_id&&peer.kind!=='subagent');if(members.length!==1)throw new BridgeError('ambiguous_context','会话 ID 不唯一或不存在，请用 --member 指定。');}
    else if(p.native){members=this.store.bindings.all().filter(binding=>binding.active&&binding.host===p.native!.host&&binding.pid===p.native!.pid&&binding.procStart===p.native!.procStart).map(binding=>this.store.peer(binding.peerId));if(members.length!==1)throw new BridgeError('ambiguous_context','当前窗口绑定无法核验，请用 --member 指定。');}
    else if(p.pair_id){const pair=this.store.pairById(p.pair_id);if(pair?.archived)members=[this.store.peer(pair.claude),this.store.peer(pair.codex)];}
    if(!members.length||members.some(peer=>this.store.pairFor(peer.id)))return false;
    const selected=members.filter(peer=>pairLoss(this.store,peer));if(!selected.length)return false;
    for(const peer of selected)this.store.setSetting(pairLossKey(peer.id),null);
    this.store.event('pair.loss.dismissed',{members:selected.map(peer=>peer.id)});return true;
  }
  send(input:SendIntent,schedule=true,excluded?:ReadonlyMap<string,number>):{message_id:string} {
    const {sender,pair}=this.pairedSender(input.actor,excluded);
    return this.acceptMessage(sender,pair,input,schedule);
  }
  private acceptMessage(sender:Peer,pair:Pair,input:SendIntent,schedule:boolean):{message_id:string}{
    const m=this.store.transaction(()=>{
      const callId=`${input.actor.sessionId}:${input.actor.callId}`,previous=this.store.messageByCall(sender.id,callId);
      if(previous)return this.store.accept(pair,sender,input.message,callId,input.in_reply_to??(previous.replySource==='auto'?previous.inReplyTo??undefined:undefined),input.actor.via,previous.replySource,input.reply_expected??previous.replyExpected??false);
      let replyTo=input.in_reply_to,source:'explicit'|'auto'='explicit';
      if(!replyTo&&input.auto_reply_to&&input.auto_reply_text&&sender.host==='claude'&&!input.actor.via&&sender.sessionId===input.actor.sessionId){
        try{
          const original=this.store.message(input.auto_reply_to);
                                                            
          if(original.pairId===pair.id&&original.to===sender.id&&original.from===pair.codex&&input.auto_reply_text.includes(this.references.message(original).replaceAll('</cross-session-message>','&lt;/cross-session-message&gt;'))){replyTo=original.id;source='auto';}
        }catch(error){if(!(error instanceof BridgeError)||!['message_missing','ref_missing'].includes(error.code))throw error;}
      }
      const expanded=this.references.expand(sender,input.message);
      const accepted=this.store.accept(pair,sender,input.message,callId,replyTo,input.actor.via??(sender.sessionId!==input.actor.sessionId?input.actor.sessionId:undefined),source,input.reply_expected??false);
      this.references.snapshot(accepted,expanded);this.communicationTips.partnerSent(sender,accepted);return accepted;
    });
    if(schedule)queueMicrotask(()=>void this.pump());
    return{message_id:m.id};
  }
  private runtimeEndpoint(peerId:string):Endpoint|undefined{return this.store.endpoint(peerId)??this.store.endpoints(peerId).at(-1);}
  private async sendWithHealth(input:SendIntent,automaticSelection?:string,excluded=new Map<string,number>()):Promise<unknown>{
    const authorize=()=>{if(automaticSelection&&!this.store.selections.automaticDraft(input.actor,automaticSelection,this.config))throw new BridgeError('selection_expired','原发送草稿已结束，未自动启动或重发。');};authorize();
    const invoking=this.partnerActor(input.actor);
    this.requireEnabled(invoking);const invokingPair=this.store.pairFor(invoking.id);if(invokingPair)this.requireEnabled(this.store.peer(invokingPair[otherHost(invoking.host)]));
    await this.syncPendingWindows(invokingPair?new Set([invokingPair.claude,invokingPair.codex]):undefined);
                                           
    if(!this.store.pairFor(invoking.id))refreshRestoreObservations(this.store,true);
    if(pairLoss(this.store,invoking))return this.store.selections.create(invoking,input.actor,this.config,input,'pair_lost');
    const held=this.windowRecovery.hold(input,this.config);if(held)return held;
    if(!this.store.pairFor(invoking.id))await this.selectionResolver.probeCandidates(invoking,excluded);
    const previouslyPaired=!!this.store.pairFor(invoking.id);
    if(!previouslyPaired&&!this.selectionResolver.pairingCandidates(invoking,excluded).length&&this.config.implicit!=='never'){
      try{await prepareOwnedLaunch(selectHostLaunch(otherHost(invoking.host),this.config,{home:this.home,cwd:invoking.cwd}));}
      catch(error){if(recoveryPrecondition(error))return this.store.selections.launchBlocked(invoking,input.actor,this.config,input,error,this.selectionResolver.currentExclusions(excluded));throw error;}
      if(this.store.pairFor(invoking.id))throw new BridgeError('session_changed','预检期间配对已改变，请重新查看当前搭档。');
    }
    let stagedPartner=false,automaticTarget:Peer|undefined;
    if(!previouslyPaired&&!this.store.pairFor(invoking.id)&&!this.selectionResolver.pairingCandidates(invoking,excluded).length&&this.config.implicit!=='never'){
      authorize();
      const key='implicitPartner:'+invoking.id,previous=this.store.setting<{peerId:string;sessionId:string}>(key),target=previous?.sessionId===invoking.sessionId?this.store.peer(previous.peerId):this.store.placeholder(otherHost(invoking.host),invoking.cwd);
      this.store.setSetting(key,{peerId:target.id,sessionId:invoking.sessionId,callId:input.actor.callId});
      try{await this.memberLifecycle.prepare(target,undefined,{peerId:invoking.id,sessionId:invoking.sessionId!,authorize});}
      catch(error){if((error as BridgeError).code==='selection_expired')throw error;return this.store.selections.launchBlocked(invoking,input.actor,this.config,input,error,this.selectionResolver.currentExclusions(excluded));}
      authorize();const current=this.partnerActor(input.actor),pair=this.store.pairFor(current.id);
      if(current.sessionId!==invoking.sessionId||pair&&pair[otherHost(current.host)]!==target.id)throw new BridgeError('session_changed','后台就绪前发起窗口或搭档已变化，原消息未发送。');
      if(!pair&&this.selectionResolver.pairingCandidates(current,excluded).length){const choice=this.store.selections.create(current,input.actor,this.config,input) as {selection_id:string};return this.store.selections.refresh(input.actor,choice.selection_id,this.config,this.selectionResolver.currentExclusions(excluded));}
      if(!pair){if(automaticSelection)automaticTarget=target;else this.store.pair(current.host==='claude'?current.id:target.id,current.host==='codex'?current.id:target.id);}
      if(!automaticSelection)this.store.setSetting(key,null);stagedPartner=true;
    }
    let saved:{message_id:string};
    try{saved=automaticSelection?this.store.selections.commitAutomatic(input.actor,automaticSelection,this.config,intent=>{
      if(automaticTarget){this.store.pair(invoking.host==='claude'?invoking.id:automaticTarget.id,invoking.host==='codex'?invoking.id:automaticTarget.id);this.store.setSetting('implicitPartner:'+invoking.id,null);}
      return this.send(intent,false,excluded);
    }):this.send(input,false,excluded);}catch(error){if(error instanceof BridgeError&&['selection_required','bootstrap_required'].includes(error.code)){const view=this.store.selections.create(this.actor(input.actor),input.actor,this.config,input,error.code==='bootstrap_required'?error.code:undefined) as {selection_id:string};return excluded.size?this.store.selections.refresh(input.actor,view.selection_id,this.config,this.selectionResolver.currentExclusions(excluded)):view;}throw error;}
    const message=this.store.message(saved.message_id),sender=this.store.peer(message.from),partner=this.store.peer(message.to),pair=this.store.pairById(message.pairId)!;
    const tip=this.runtimeHealth.communicationTip(sender,input.message,'partner',input.actor,message.id);
    if(hostingGate(this.store,partner)&&message.state==='accepted'){
      const hosting=hostingStatus(this.store,partner),record=hostingRecord(this.store,partner),choice=!record?.released&&!record?.background?this.store.selections.hosting(sender,input.actor,this.config,message.id):undefined;
      return{...saved,persisted:true,delivery_state:message.state,read_confirmed:false,status:'held',holding_reason:hosting?.phase??'window_closed',hosting,...(tip?{tip}:{}),...(choice as object??{})};
    }
    const newPartner=stagedPartner||!previouslyPaired&&partner.owner==='nxbridge'&&!partner.sessionId;
    let availability:RuntimeAvailability;
    try{availability=await this.runtimeHealth.deliveryAvailability(sender,partner);}
    catch{availability={state:'unknown',reasons:['runtime availability check failed'],checked_at:Date.now()};}
    if(this.store.pairFor(sender.id)?.id===pair.id&&!this.store.pairFor(sender.id)?.paused)this.deliveryHealth.observe(pair,sender,partner,this.store.deliveryCounts(pair.id,sender.id),availability);
    const current=this.store.message(saved.message_id),health=this.runtimeHealth.peerHealth(partner),failed=health?.state==='failed'&&current.evidence?.includes('turn='+health.turnId+'，'),observed=['contextObserved','responded'].includes(current.state)&&!failed,paused=this.store.pairFor(sender.id)?.paused||['paused','needsHuman'].includes(this.store.peer(partner.id).state);
    const partnerEndpoint=this.store.endpoint(partner.id);if(partnerEndpoint?.daemon)await this.daemons.wakeReady(this.store.peer(partner.id),partnerEndpoint);
    const guidance=this.runtimeHealth.deliveryGuidance(this.store.peer(partner.id),observed?0:undefined),wait=guidance.delivery_wait;
    const status=observed?'observed':['unknown','refused','expired','held'].includes(current.state)?current.state:paused?'paused':availability.state==='blocked'?'blocked':availability.state==='unknown'?'unverified':availability.state==='starting'?'starting':wait?.state==='waiting_native_input'||wait?.state==='waiting_native_interaction'?wait.state:'queued';
    queueMicrotask(()=>void this.pump());
    const waitingContext=this.store.bindings.current(partner.id)?.transitioning===true||this.store.endpoint(partner.id)?.pendingContext===true;
    const admission=partner.host==='claude'&&!observed?inboundAdmission(sender.permission,this.store.endpoint(partner.id)):'accept',warning=inboundWarning(admission);
    const permission=permissionGuidance(this.store.peer(pair.codex),this.store.peer(pair.claude),this.store.endpoint(pair.claude));
    return{...saved,persisted:true,status,delivery_state:current.state,read_confirmed:observed,partner_runtime:availability,notes:this.runtimeHealth.incidentNotes([partner.id]),...(failed?{processing_failure:{turn_id:health.turnId,error:health.error??'native turn failed',notice:'消息已进入宿主历史，但该轮次失败，不能据此确认模型已处理；请检查原轮次，不要自动重发。'}}:{}),...(waitingContext?{waiting_context:true}:{}),...(newPartner?{notice:`no partner for this window -> started NEW ${partner.host} partner (no prior context; brief fully). expected an existing partner? tell user: nxbridge pair`}:{}),
      ...(warning?{inbound_admission:{state:admission,warning}}:{}),...(permission?{permission_guidance:permission}:{}),...(health?.nativeIssue&&health.nativeIssue.kind!=='tool_failed'?{native_issue:health.nativeIssue}:{}),...guidance,
      message:(observed?'native context/reply evidence confirmed':status==='unknown'?'submission outcome unknown; may have arrived; NEVER automatically replayed':wait?wait.message:partner.host==='codex'&&this.store.peer(partner.id).state==='paused'?"held: user interrupted codex window; delivers on user's next prompt there. tell user only if waiting matters":['refused','expired','held'].includes(status)?`saved; native delivery ${status}; not confirmed read`:paused?'saved; delivery paused or awaiting human':waitingContext?'accepted; partner context changing; msgs held until next verified native context':status==='blocked'?'saved; delivery blocked; not confirmed read; built-in monitor will report recovery':status==='unverified'?'saved; runtime availability unverified; not confirmed read':status==='starting'?'saved; partner startup pending; not submitted to native runtime yet':'handed to nxbridge; it delivers + reports problems itself (routine, not user news)')+(warning?'; '+warning:''),...(tip?{tip}:{})};
  }
  private async syncPendingWindows(peerIds?:ReadonlySet<string>):Promise<void>{
    if(!peerIds)await this.pumpStage('daemon_sync',()=>this.daemons.sync());
                                         
    const peers=peerIds?[...peerIds].map(id=>this.store.peer(id)):this.store.peers();
    await Promise.allSettled(peers.map(peer=>this.pumpStage('paused_window:'+peer.id,async()=>{
      if(peer.state!=='paused'||!this.enabled(peer.id))return;
      const endpoint=this.store.endpoint(peer.id);if(!endpoint||endpoint.daemon||endpoint.pendingContext)return;
      const value=await this.runtimeHealth.probeRuntime(peer,true);
      if((value.nativeState==='dead'||!value.nativeState&&value.state==='blocked')&&this.store.peer(peer.id).state==='paused'&&this.store.endpoint(peer.id)?.epoch===endpoint.epoch){this.store.deactivate(peer.id,endpoint.epoch);this.store.updatePeer(peer.id,{state:'offline'});}
    })));
    const endpoints=this.store.endpoints().filter(e=>(!peerIds||peerIds.has(e.peerId))&&this.enabled(e.peerId)&&e.active&&e.pendingContext&&e.pid&&e.procStart);
    if(!endpoints.length)return;
    const states=await probeProcesses(endpoints.map(e=>({pid:e.pid!,procStart:e.procStart!})));
    for(let i=0;i<states.length;i++)if(states[i]==='dead')await this.pumpStage('pending_window:'+endpoints[i]!.peerId,()=>{
      const endpoint=endpoints[i]!,peer=this.store.getPeer(endpoint.peerId);
      if(!peer||!this.store.endpoint(peer.id)?.pendingContext)return;
      this.store.deactivate(peer.id,endpoint.epoch);this.store.updatePeer(peer.id,{state:'offline'});
      const record=this.store.setting<{peerId:string;proposedSessionId?:string}>('pendingCodex:'+windowKey({host:'codex',pid:endpoint.pid!,procStart:endpoint.procStart!,configHome:endpoint.configHome!}));
      const pair=this.store.pairFor(peer.id);
      if(pair&&record&&!record.proposedSessionId){for(const m of this.store.pending(peer.id))this.store.transition(m.id,'held','未开始对话的窗口已退出，原配对已解除，消息保留。');this.store.unpair(pair.id,{reason:'window_exit',actor:'native window monitor'});}else if(pair&&peer.sessionId)closeHostedWindow(this.store,peer,endpoint.epoch);
    });
  }
  private async monitorSession(raw:unknown):Promise<unknown>{
    const p=z.object({actor:actorSchema,context_key:text.optional(),mod_version:z.string().max(100).optional(),mod_revision:z.string().regex(/^[a-f0-9]{16}$/).optional(),admit:z.boolean().optional(),notice_id:text.optional(),ready_boundary:z.boolean().optional()}).strict().parse(raw),sender=this.actor(p.actor),pair=this.store.pairFor(sender.id);
    if(p.admit!==false)this.runtimeHealth.assertClaudeNoticeSession(sender);
    if(sender.sessionId===p.actor.sessionId&&(sender.host!=='codex'||p.context_key&&this.store.setting('hookContext:'+p.context_key)===sender.sessionId)){const changed=changeNotices(this.store,sender,{admit:p.admit,noticeId:p.notice_id});if(changed.length)return{notices:changed};}
    const loss=pairLoss(this.store,sender);
    if(loss&&sender.sessionId===p.actor.sessionId){
      if(sender.host==='codex'&&(!p.context_key||this.store.setting('hookContext:'+p.context_key)!==sender.sessionId))return{notices:[]};
      return this.store.transaction(()=>({notices:lossNotices(this.store,sender,loss,{admit:p.admit,noticeId:p.notice_id})}));
    }
    if(sender.sessionId!==p.actor.sessionId||!pair||pair[sender.host]!==sender.id||pair.paused)return{notices:[]};
    if(sender.host==='codex'&&(!p.context_key||this.store.setting('hookContext:'+p.context_key)!==sender.sessionId))return{notices:[]};
    if(sender.host==='claude')this.pairAnomalies.integration(sender,{mod:true,modVersion:p.mod_version,modRevision:p.mod_revision});
    const requestedNotice=p.notice_id?this.deliveryHealth.get(pair.id,sender.id,p.notice_id):undefined;
    if(p.admit!==false&&requestedNotice?.readyOnly&&!p.ready_boundary)return{notices:[],deferred:true};
    const scope=this.runtimeHealth.noticeScope(pair,sender),offered=await this.runtimeHealth.prepareNotices(p.actor,p.notice_id?[p.notice_id]:undefined,false);
                                               
    if(p.admit!==false&&p.ready_boundary&&sender.host==='claude')await this.finalForwards.scan(this.store.peer(pair.codex));
    return this.store.transaction(()=>{
    const current=this.actor(p.actor),currentPair=this.store.pairFor(current.id);
    if(!currentPair||currentPair.id!==pair.id||currentPair.paused||this.runtimeHealth.noticeScope(currentPair,current)!==scope)return{notices:[]};
    if(p.admit!==false)this.runtimeHealth.assertClaudeNoticeSession(current);
    if(p.admit!==false&&p.ready_boundary&&current.host==='claude')this.finalForwards.refresh(currentPair,true);
    if(p.admit!==false&&requestedNotice?.readyOnly&&!this.finalForwards.ready(currentPair,true))return{notices:[],deferred:true};
    const notices=p.admit===false?offered:this.runtimeHealth.admitNotices(currentPair,current,offered,scope,false,p.ready_boundary===true);
    const rotations:RuntimeNotice[]=this.store.contextNotices(sender.id).map(rotation=>({id:rotation.id,message:contextNotice(rotation,this.store.peer(rotation.peerId)),state:'pending',source:'context_rotation',wake:false}));
    const selected=[...rotations.filter(n=>(!p.notice_id||n.id===p.notice_id)&&(p.admit===false||this.store.admitContextNotice(sender.id,n.id))),...notices];
                                            
    const recovery=this.runtimeHealth.outageRecovery(sender,p.admit!==false,p.notice_id);if(recovery)selected.push(recovery);
                                                 
    return{notices:p.admit===false?selected.filter(n=>!n.readyOnly||this.store.endpoint(current.id)?.modRevision===MOD_REVISION).map(noticeSignal):selected};
    });
  }
  private async register(input:RegisterInput,options:{managedCodexChecked?:boolean}={}):Promise<Peer & {binding?:Actor['binding']}>{
    const disabled=this.disabledRegistration(input);if(disabled)return disabled;
    for(const managed of this.store.peers().filter(peer=>peer.owner==='nxbridge'&&peer.host===input.host&&peer.sessionId===input.sessionId)){
      const runtime=input.host==='codex'?runtimeFor(this.home,{peerId:managed.id})?.value:undefined;
      if(runtime)this.store.setSetting('managedLaunchProof:'+managed.id,{sessionId:managed.sessionId,runtimeId:runtime.id,configHome:runtime.configHome,executable:runtime.executable,profileId:runtime.profileId,version:runtime.version});
    }
    const child=input.host==='claude'&&process.platform==='linux'?findClaudeChild(this.home,input.sessionId):undefined;
    const owned=child?.native?.pid===input.endpoint.pid&&child.native.startedAt===input.endpoint.procStart?child:undefined;
    const peer=owned?this.store.adopt(owned.peerId,input):await this.takeovers.registration(input)??await this.windowRecovery.register(input,options),binding=this.store.bindings.current(peer.id)??(input.endpoint.daemon?peer.rootBinding:undefined);
    const autoEndpoint=this.store.endpoint(peer.id);if(autoEndpoint)observeClaudeAuto(this.store,peer,autoEndpoint);
    if(autoEndpoint)this.deletedSessions.observe(peer,autoEndpoint);
    if(this.store.setting('legacyTakeoverNeedsUser:'+peer.id))this.store.setSetting('legacyTakeoverNeedsUser:'+peer.id,null);
    const lease=this.takeovers.get(peer.id);if(lease?.adopted)await this.memberLifecycle.returnTakeover(peer.id,lease.id);
    this.store.selections.resumeHeld(peer.id,intent=>this.send(intent,false));
    const endpoint=this.store.endpoint(peer.id),evidence=endpoint?.codexPermission??endpoint?.daemon;if(evidence)this.store.updatePeer(peer.id,{permission:daemonPermission(evidence)});
    this.pairAnomalies.integration(peer,input.host==='claude'&&input.endpoint.questionSupport?{mod:true,modVersion:input.endpoint.modVersion,modRevision:input.endpoint.modRevision}:{});
    const result=()=>({...this.store.peer(peer.id),...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{})});
    if(process.platform==='linux'&&input.host==='claude'&&input.kind!=='subagent'&&input.endpoint.pid&&input.endpoint.procStart)recordClaudeForeground(this.home,peer.id,input.endpoint.pid,input.endpoint.procStart);
    return result();
  }
  private modReadPeer(actor:Actor,receipt:ModReadReceipt,endpointEpoch?:string):{peer:Peer;endpoint:Endpoint}{
    const peer=this.actor(actor),endpoint=this.store.endpoint(peer.id),binding=this.store.bindings.current(peer.id);
    if(this.stopped||peer.host!=='claude'||!binding?.active||binding.transitioning||binding.key!==actor.binding?.key||binding.epoch!==actor.binding.epoch||
      peer.sessionId!==receipt.sessionId||!endpoint?.active||endpoint.mode!=='claude-inbox'||endpoint.pid!==receipt.native.pid||endpoint.procStart!==receipt.native.procStart||
      endpoint.modRevision!==receipt.revision||endpointEpoch!==undefined&&endpoint.epoch!==endpointEpoch)throw new BridgeError('mod_read_unavailable','Mod 只读通道不可用。');
    return{peer,endpoint};
  }
  private async modWrite(input:Record<string,unknown>,actor:Actor,receipt:ModReadReceipt,endpointEpoch:string,admit:()=>void):Promise<unknown>{
    const binding=input.binding as Actor['binding'];
    if(input.sessionId!==receipt.sessionId||input.contextStart!==false||!binding||binding.key!==actor.binding?.key||binding.epoch!==actor.binding.epoch)throw new BridgeError('session_changed','Mod 写入上下文已改变。');
    if(!path.isAbsolute(receipt.configHome)||process.platform==='win32'&&/^(?:\\\\|\/\/)/.test(receipt.configHome))throw new BridgeError('hook_identity_unavailable','此配置目录须由 Mod 进程直接核验。');
    const deadline=performance.now()+9000;
    const identity=await claudeIdentity(receipt.sessionId,{pid:receipt.native.pid,home:receipt.configHome,timeout:2000,...(process.platform==='win32'?{readNative:()=>{this.hookIdentity??=new WindowsIdentitySession(this.home);return this.hookIdentity.read(receipt.native.pid,2000,false,'claude');}}:{})});
    const {endpoint}=this.modReadPeer(actor,receipt,endpointEpoch);
    if(!endpoint.configHome||identity.pid!==receipt.native.pid||identity.native.startedAt!==receipt.native.procStart||input.inbox!==endpoint.address||input.mod_revision!==receipt.revision)throw new BridgeError('unverified_identity','Mod 写能力不属于当前原生窗口。');
    admit();
    return mod(input,{home:this.home,configHome:endpoint.configHome!,identity,request:async<T>(method:string,params:unknown,options:Parameters<ModExecution['request']>[2])=>{
      const timeout=remainingTime(deadline,options?.timeout??130000);let timer:NodeJS.Timeout|undefined;
      try{return await Promise.race([this.dispatch(method,params) as Promise<T>,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new DeliveryError('timeout','Mod 本地调用超时，结果尚未确认。',true)),timeout);})]);}
      finally{clearTimeout(timer);}
    }});
  }
  private async modRead(actor:Actor,operation:ModReadOperation,receipt:ModReadReceipt,endpointEpoch:string,nativeHealth?:TurnHealth):Promise<unknown>{
    const {peer,endpoint:ownEndpoint}=this.modReadPeer(actor,receipt,endpointEpoch),pair=this.store.pairFor(peer.id);
    if(!this.enabled(peer.id))return operation==='monitor'?{...this.offResult(peer),notices:[]}:this.offResult(peer);
                                        
    return this.store.transaction(()=>{
    if(nativeHealth&&(!ownEndpoint.nativeHealth||nativeHealth.lastEventAt>ownEndpoint.nativeHealth.lastEventAt))this.store.saveEndpoint({...ownEndpoint,nativeHealth:{...nativeHealth,source:'native-mod'}});
    this.pairAnomalies.integration(peer,{mod:true,modRevision:receipt.revision});
    if(operation==='monitor'){
      const changed=changeNotices(this.store,peer,{admit:false});if(changed.length)return{notices:changed};
      const loss=pairLoss(this.store,peer);if(loss)return{notices:lossNotices(this.store,peer,loss,{admit:false})};
      if(!pair||pair.paused||['paused','needsHuman','offline'].includes(peer.state))return{notices:[]};
                                                        
      this.runtimeHealth.refreshNoticeConditions(pair,'mod_monitor');
      const recovery=this.runtimeHealth.outageRecovery(peer,false);
      return{notices:[...this.store.contextNotices(peer.id).map(n=>({id:n.id,source:'context_rotation',wake:false})),...this.deliveryHealth.peek(pair.id,peer.id).map(noticeSignal),...(recovery?[noticeSignal(recovery)]:[])]};
    }
    const partner=pair?this.store.peer(pair.codex):undefined,endpoint=partner?this.store.endpoint(partner.id):undefined,loss=!pair?pairLossView(this.store,peer,this.config):undefined;
    const health=partner?this.runtimeHealth.peerHealth(partner):undefined;
    if(health?.nativeIssue?.kind==='tool_failed')delete health.nativeIssue;
    const permission=pair?permissionGuidance(partner!,peer,ownEndpoint):undefined;
    return{incidents:this.runtimeHealth.incidentViews([peer.id,...(partner?[partner.id]:[])]),notes:this.runtimeHealth.incidentNotes(partner?[partner.id]:[]),paired:!!pair,self:{id:peer.id,state:peer.state,enabled:this.enabled(peer.id)},...(loss?{pair_lost:loss}:{}),...(permission?{permission_guidance:permission}:{}),...(pair?{paused:pair.paused,waiting_context:(this.store.bindings.current(partner!.id)?.transitioning===true||endpoint?.pendingContext===true)&&this.store.pendingCount(partner!.id)>0,partner:{state:partner!.state,enabled:this.enabled(partner!.id),...this.runtimeHealth.deliveryGuidance(partner!),...(health?.nativeIssue?{native_issue:health.nativeIssue}:{}),...(health?{health:{state:health.state,progressEvidence:health.progressEvidence,...(health.retry?{retry:health.retry}:{}),...(health.modelRequest?{modelRequest:health.modelRequest}:{})}}:{})}}:{}),
      ...(pair?{delivery_admission:this.runtimeHealth.deliveryAdmission(peer,pair)}:{}),
      integrationIssues:[peer.id,...(partner?[partner.id]:[])].flatMap(peerId=>this.runtimeHealth.integrationIssues(peerId)),
                                                           
      ...((action=>action?{integrationAction:action}:{})(reloadAction(this.store,peer.id,this.pairAnomalies.issues(peer.id).find(issue=>issue.kind==='mod_stale')?.firstSeenAt,MOD_REVISION)))};
    });
  }
  status(actor?:Actor):unknown {
    for(const pair of this.store.pairs())this.store.faults.sync('subagent_hold:'+pair.codex,()=>this.refreshSubagentHold(this.store.peer(pair.codex)));
    const retirements=Object.entries(this.store.setting<Record<string,RetirementRecord>>('processRetirements')??{}).map(([peerId,value])=>({peerId,...value,exhausted:value.attempts>=3||value.nextAt===Number.MAX_SAFE_INTEGER,action:'nxbridge retire --member '+peerId}));
    const background=claudeBackground(this.home,this.config),observer=actor?this.actor(actor):undefined,pairScope=observer?this.store.pairFor(observer.id):undefined;
    const ids=(observer?pairScope?[pairScope.claude,pairScope.codex]:[observer.id]:this.store.peers().map(peer=>peer.id)).filter(id=>this.enabled(id));
    const capability={identityIssues:this.store.faults.map('status_identity',ids,id=>id,peerId=>{const issue=this.store.setting('codexIdentity:'+peerId);return issue?[{peerId,...issue as object}]:[];}).flat(),...(background?{claudeBackground:background}:{}),pluginCaches:installedCacheStatus(this.home),processProbes:processProbeStatus(),processAncestry:processAncestryStatus(),...(this.resources?{resources:this.resources.snapshot()}:{}),integrationIssues:this.store.faults.map('status_integration',ids,id=>id,peerId=>this.runtimeHealth.integrationIssues(peerId,true)).flat()};
    Object.assign(capability,{retirements:actor?retirements.filter(value=>ids.includes(value.peerId)):retirements,incidents:this.runtimeHealth.incidentViews(ids),notes:this.runtimeHealth.incidentNotes(ids),rpc:this.adapters.codex.rpcMetrics?.(),degraded:this.store.faults.status().filter(value=>value.degraded).map(value=>actor?{stage:value.stage.split(':')[0],count:value.count,retryAt:value.retryAt}:value),outageLedger:brokerOutageDiagnostic(this.home)});
    Object.assign(capability,{hookTimings:ids.flatMap(id=>{const timing=this.pairAnomalies.hookTimings(this.store.peer(id));return timing?[timing]:[];})});
    const frozen=frozenProfileStatus(this.home,this.config);Object.assign(capability,{configurationReload:this.configurationReload.status,frozen_profiles:frozen.profiles,...(frozen.warnings.length?{profile_warnings:frozen.warnings}:{})});
    const describePeer=(p:Peer)=>{
      const binding=this.store.bindings.current(p.id),endpoint=this.store.endpoint(p.id),child=p.host==='claude'?claudeChild(this.home,p.id):undefined,health=this.runtimeHealth.peerHealth(p),budget=endpoint?this.providerRetries.get(endpoint.address):undefined;
      return{...p,permission_facts:permissionFacts(p,endpoint),...this.runtimeHealth.deliveryGuidance(p),...(this.memberLifecycle.recoveryStatus(p)?{recovery:this.memberLifecycle.recoveryStatus(p)}:{}),...(health?.nativeIssue?{native_issue:health.nativeIssue}:{}),...(p.host==='codex'?{nativeHistory:this.store.setting('codexHistoryCompatibility:'+p.id),directDelivery:this.codexDirect.status(p.id)}:{}),...(binding?{context:{sessionId:binding.sessionId,epoch:binding.epoch,transitioning:binding.transitioning,lineage:this.store.bindings.lineage(p.id)}}:{}),...(health?{health}:{}),...(budget?{retryBudget:budget}:{}),...(child?{backgroundMode:'child',worker:{phase:child.phase,pid:child.worker?.pid,nativePid:child.native?.pid,configHome:child.configHome,...(child.human?{human:child.human}:{}),...(child.error?{error:child.error}:{})},takeoverCommand:`nxbridge open claude --member ${p.id}`+(p.state==='busy'?' --interrupt':'')}:{})};
    };
    const withHealth=(peer:Peer)=>{
      let result:unknown={...peer,diagnosticUnavailable:true};
      this.store.faults.sync('status:'+peer.id,()=>{const children=this.subagentCompletions.status(peer),forward=this.finalForwards.status(peer);result={...describePeer(peer),partner_profile:this.profiles.view(peer),...(children?{childCompletions:{...children,hold:this.pairAnomalies.evidence(peer).subagentHold??null}}:{}),...(forward?{final_forward:forward}:{})};});return result;
    };
    if(!actor){const pairs=this.store.pairs();return{pairs,...(pairs.length<=1?{pair:pairs[0]??null}:{}),peers:this.store.peers().map(withHealth),lostPairs:this.store.faults.map('status_loss',this.store.peers(),peer=>peer.id,peer=>{const loss=pairLossView(this.store,peer,this.config);return loss?[{...loss,member_id:peer.id,member_name:peer.name}]:[];}).flat(),bindings:this.store.bindings.all(),endpoints:this.store.endpoints(),messages:this.store.messages(100),questions:this.store.questions(),degraded:this.store.faults.status(),communicationTips:this.store.faults.map('status_tips',this.store.peers(),peer=>peer.id,p=>{const stats=this.communicationTips.summary(p.id);return stats?[{peerId:p.id,host:p.host,...stats}]:[];}).flat(),capabilities:{compatibilityWake:this.config.compatibilityWake,hookObserved:this.store.setting('lastHook')??null,...capability}};}
    const peer=this.actor(actor),pair=this.store.pairFor(peer.id);
    if(!pair||pair[peer.host]!==peer.id){const loss=pairLossView(this.store,peer,this.config);return{paired:false,self:peer,...capability,...(loss?{pair_lost:loss}:{notice:'需要协作时可直接发信；已有窗口必须由人明确选择，没有候选时才按配置新建后台搭档。'}),...(this.windowRecovery.status(peer.id)?{window_recovery:this.windowRecovery.status(peer.id)}:{}),communicationTips:this.communicationTips.summary(peer.id)};}
    const partner=this.store.peer(pair[otherHost(peer.host)]);
    const permission=permissionGuidance(this.store.peer(pair.codex),this.store.peer(pair.claude),this.store.endpoint(pair.claude));
    return{paired:true,pair_id:pair.id,paused:pair.paused,self:withHealth(peer),partner:withHealth(partner),...(permission?{permission_guidance:permission}:{}),delivery_admission:this.runtimeHealth.deliveryAdmission(peer,pair),waiting_context:(this.store.bindings.current(partner.id)?.transitioning===true||this.store.endpoint(partner.id)?.pendingContext===true)&&this.store.pendingCount(partner.id)>0,...capability,communicationTips:this.communicationTips.summary(peer.id),receive_mode:this.store.endpoint(peer.id)?.mode??'unavailable',pending:this.store.pendingCount(peer.id),questions:this.store.questions().filter(q=>q.pairId===pair.id&&['pending','awaiting_user','needs_user'].includes(q.status)).map(q=>this.questions.view(peer,q.id))};
  }
  receive(actor:Actor):unknown {
    const peer=this.partnerActor(actor),pair=this.store.pairFor(peer.id);
    if(!this.enabled(peer.id))return{...this.offResult(peer),messages:[]};
    if(!pair||pair[peer.host]!==peer.id)throw new BridgeError('unpaired','当前窗口不是已配对成员。');
    if(!this.enabled(pair.claude)||!this.enabled(pair.codex))return{...this.offResult(this.store.peer(!this.enabled(pair.claude)?pair.claude:pair.codex)),messages:[]};
    if(hostingGate(this.store,peer))return{messages:[],status:'held',hosting:hostingStatus(this.store,peer)};
    if(this.profiles.blocks(peer))return{messages:[],status:'held',partner_profile:this.profiles.view(peer)};
    if(pair.paused||peer.state==='paused'||peer.state==='needsHuman')return{messages:[],status:'paused'};
                           
    const endpoint=this.store.endpoint(peer.id);
    if(endpoint?.mode!=='embedded'&&!(peer.host==='codex'&&endpoint?.mode==='app-server'))return{status:'automatic'};
    const key=`receive:${peer.id}:${actor.binding?.epoch??actor.sessionId}:${actor.callId}`,cached=this.store.setting<{messages:{message:string}[];status:string}>(key);
    const result=cached??this.store.transaction(()=>{
      const selected=this.store.pending(peer.id),messages=[];
      let bytes=Buffer.byteLength(JSON.stringify({messages:[],status:'received'}));
      for(const m of selected){
        const body=this.deliveryBody(m);if(body===undefined)continue;
        const message={message_id:m.id,from:modelPeerName(this.store.peer(m.from)),message:body,...(m.replyExpected?{reply_expected:true}:{}),...(m.inReplyTo?{in_reply_to:m.inReplyTo}:{}),...(m.via?{via:m.via}:{})};
        const size=Buffer.byteLength(JSON.stringify(message))+(messages.length?1:0);
                                                   
        if(messages.length&&bytes+size>RECEIVE_BATCH_BYTES)break;
        if(!this.store.claim(m.id))continue;
        messages.push(message);bytes+=size;this.store.transition(m.id,'unknown','取件结果已生成，等待宿主工具完成证据');
        if(messages.length===20)break;
      }
      const response={messages,status:'received'};this.store.setSetting(key,response);return response;
    });
    return{...result,messages:result.messages.map(m=>({...m,...fileHintFields(m.message,peer.cwd)}))};
  }
  private deliveryBody(message:Message):string|undefined{
    try{return this.references.message(message);}
    catch(error){
      if(!(error instanceof BridgeError)||error.code!=='ref_missing')throw error;
                                   
      this.store.transition(message.id,'expired',undefined,describeError(error));return undefined;
    }
  }
  private async checkCodexIdentities():Promise<void>{
    await this.restoreOwnedCodexRoutes();
    await Promise.allSettled(this.store.pairs().filter(pair=>!pair.paused).map(pair=>this.pumpStage('codex_identity:'+pair.codex,async()=>{
      const peer=this.store.peer(pair.codex),endpoint=this.store.endpoint(peer.id);
      if(!this.enabled(peer.id)||!peer.sessionId||!endpoint||endpoint.mode!=='app-server'||endpoint.daemon||this.memberLifecycle.isRetiring(peer.id)||this.memberLifecycle.isRestarting(peer.id)||['paused','needsHuman'].includes(peer.state)||this.memberLifecycle.retryPending(peer.id))return;
      const conflict=this.identityConflicts.get(peer.id),runtime=conflict?runtimeFor(this.home,{endpoint:endpoint.address})?.value:undefined;
      if(conflict&&runtime?.pid===conflict.pid&&runtime.procStart===conflict.procStart&&endpoint.address===conflict.endpoint){await this.migrateCodexIdentity(peer,endpoint,conflict.error);return;}
      this.identityConflicts.delete(peer.id);
      try{await this.adapters.codex.connect(endpoint.address);if(this.store.setting('codexIdentity:'+peer.id))this.store.setSetting('codexIdentity:'+peer.id,null);}
      catch(error){if(isCodexIdentityError(error))await this.migrateCodexIdentity(peer,endpoint,error);}
    })));
  }
  private async verifyCodexRestartHistory(peer:Peer,thread:CodexThread,guard:()=>void):Promise<Set<string>>{
    const absent=new Set<string>(),repairKey='codexHistoryRepair:'+peer.id;
    if(!this.store.restartUnsettled(peer.id)){if(this.store.setting(repairKey))this.store.setSetting(repairKey,null);return absent;}
    const attempts=this.codexDirect.status(peer.id)?.attempts??[],cursor=attempts.flatMap(attempt=>attempt.historyCursor?[attempt.historyCursor]:[]).sort((a,b)=>a.offset-b.offset)[0];
                                              
    const scan=this.store.setting<{sessionId:string;path:string;checkpoint:HistoryCheckpoint}>(repairKey);
    let resume=scan?.sessionId===peer.sessionId&&scan.path===thread.path?scan.checkpoint:undefined;
    let history:Awaited<ReturnType<typeof readCodexHistory>>;
    do{
      guard();history=await readCodexHistory(thread.path,peer.sessionId!,cursor?{cursor}:{checkpoint:true,resume});
      if(!cursor)this.store.setSetting(repairKey,history.checkpoint?{sessionId:peer.sessionId,path:thread.path,checkpoint:history.checkpoint}:null);
      guard();
      if(history.status!=='supported'||!history.complete&&!history.bytesRead)throw new BridgeError('delivery_unsettled','旧投递缺少完整持久历史核验，未停止原运行时；未知消息保持原状，不会自动重发。');
      if(!history.complete){resume=history.checkpoint;await delay(0);}
    }while(!history.complete);
    const receipts=[...history.receipts,...(thread.turns??[]).flatMap(turn=>(turn.items??[]).flatMap((item:any)=>codexContextReceipts(item,turn.id)))];
    for(const receipt of receipts)this.observeCodexContext(peer,receipt,'重启前只读历史');
                                            
    for(const message of this.store.reconcilable(peer.id))if((!cursor||attempts.some(attempt=>attempt.id===message.id&&attempt.historyCursor))&&!receipts.some(receipt=>receipt.messageId===message.id))absent.add(message.id);
    return absent;
  }
  private async migrateCodexIdentity(peer:Peer,endpoint:Endpoint,error:BridgeError):Promise<void>{
    this.requireEnabled(peer);
    const key='codexIdentity:'+peer.id,pair=this.store.pairFor(peer.id);
    const hold=(reason:string)=>{const value={code:error.code,sessionId:peer.sessionId,endpoint:endpoint.address,message:'投递已暂停：'+reason};if(JSON.stringify(this.store.setting(key))!==JSON.stringify(value))this.store.setSetting(key,value);};
    if(!this.store.setting(key))hold(error.message);this.memberLifecycle.delayRetry(peer.id,30000);
    if(error.code!=='codex_identity_conflict'||peer.owner!=='nxbridge'||!localCodexEndpoint(this.home,endpoint.address)||endpoint.daemon)throw error;
    const runtime=runtimeFor(this.home,{endpoint:endpoint.address})?.value;
    if(!runtime||runtime.peerId!==peer.id){hold('无法证明此端点是当前成员的专用后台；请在原生宿主中完成重载。');throw error;}
    const previous=this.identityConflicts.get(peer.id),conflict={endpoint:endpoint.address,pid:runtime.pid!,procStart:runtime.procStart!,error,attempts:previous&&previous.pid===runtime.pid&&previous.procStart===runtime.procStart?previous.attempts:0};
    this.identityConflicts.set(peer.id,conflict);
    const absent=new Set<string>();
    const verifyDelivery=async(thread:CodexThread)=>{for(const id of await this.verifyCodexRestartHistory(peer,thread,()=>guard(false)))absent.add(id);};
    const guard=(checkDelivery=true)=>{
      if(!pair||this.store.pairFor(peer.id)?.paused||this.memberLifecycle.isRetiring(peer.id)||this.store.bindings.current(peer.id)?.transitioning||this.store.endpoint(peer.id)?.pendingContext)throw new BridgeError('session_changed','配对或上下文正在变化，等待稳定后迁移。');
      this.restartGuard(peer,endpoint,pair,checkDelivery,undefined,{identityMigration:true,absent});
    };
    if(this.memberLifecycle.isRestarting(peer.id))throw error;
    const releaseRestart=this.memberLifecycle.beginRestart(peer.id);
    try{
      guard(false);
                                                            
      const result=await this.adapters.codex.restart(peer,endpoint,guard,{identityMigration:true,requesterSession:codexRequester(this.store,peer),verifyDelivery});
      this.store.deactivate(peer.id,endpoint.epoch);this.store.setSetting(key,null);
      for(const id of absent)this.store.retireQueuedDelivery(id,'旧运行时已空闲，原生队列为空，完整持久历史和线程回执均无此消息；原会话身份迁移后保留未知，不自动重发。');
      this.identityConflicts.delete(peer.id);
      this.memberLifecycle.clearBackoff(peer.id);
      this.pairAnomalies.restarted(this.store.peer(peer.id));
      this.store.event('codex.identity.migrated',{peerId:peer.id,sessionId:peer.sessionId,oldPid:result.oldPid,pid:result.pid});
    }catch(failure){
      hold(describeError(failure));this.memberLifecycle.delayRetry(peer.id,Math.min(30000,5000*2**Math.min(conflict.attempts++,3)));
      if(failure instanceof BridgeError&&failure.code==='restart_incomplete')this.store.updatePeer(peer.id,{state:'paused',pauseReason:'restart_incomplete'});
      throw error;
    }finally{releaseRestart();}
  }
  private schedulePairedRecoveries():Map<string,Promise<boolean>>{
    if(this.stopped)return new Map();
    this.store.faults.sync('configuration_reload',()=>{const result=this.configurationReload.poll(()=>this.applyConfiguration());if(result==='failed'||result==='applied')this.store.event('configuration.reload.'+result,this.configurationReload.status);});
    return this.memberLifecycle.schedulePairedRecoveries();
  }
  pump():Promise<void>{
    if(this.stopped)return Promise.resolve();
    if(this.pumping)return this.pumping;
    if(!this.store.faults.ready('pump'))return Promise.resolve();
    const work=this.pumpOnce().then(()=>this.store.faults.recovered('pump'),error=>this.pumpFailed('pump',error)).finally(()=>{if(this.pumping===work)this.pumping=undefined;});
    this.pumping=work;return work;
  }
  private pumpFailed(stage:string,error:unknown):void{
    this.store.faults.failed(stage,error);
  }
  private background(stage:string,work:()=>unknown|Promise<unknown>):void{
    if(this.stopped)return;
    void this.runtimeHealth.trackHealth(this.pumpStage(stage,work));
  }
  private async pumpStage(stage:string,work:()=>unknown|Promise<unknown>):Promise<boolean>{
    return this.store.faults.run(stage,work);
  }
  private async pumpOnce():Promise<void>{
    const recoveries=this.schedulePairedRecoveries();
    await this.pumpStage('launch_preferences',()=>this.syncLaunchPreferences());
    const foregroundReady=await this.pumpStage('codex_foreground',()=>this.codexForeground.sweep());
    const windowsReady=await this.pumpStage('window_recovery',()=>this.windowRecovery.retry(input=>this.send(input,false)));
    const pendingReady=await this.pumpStage('pending_windows',()=>this.syncPendingWindows());
      await this.pumpStage('questions',()=>this.questions.sweep());
      await this.pumpStage('codex_subscriptions',()=>this.releaseIdleCodexSubscriptions(undefined,undefined,false));
      await this.pumpStage('retirement_schedule',()=>{if(!this.pairChanges){
        const pending=this.store.setting<Record<string,{nextAt:number}>>('processRetirements')??{};
        const due=Object.entries(pending).filter(([,value])=>value.nextAt<=Date.now()).map(([id])=>id);
        if(due.length&&!this.stopped)void this.memberLifecycle.releaseOwned(due).catch(error=>this.pumpFailed('retirements',error));
      }});
      if(this.stopped)return;
      this.background('deleted_sessions',()=>this.deletedSessions.sweep());
      await this.pumpStage('claude_children',()=>this.syncClaudeChild());
      await this.pumpStage('claude_auto_mode',()=>this.memberLifecycle.sweepClaudeAuto());
      for(const pair of this.store.pairs())if(!pair.paused)for(const id of [pair.claude,pair.codex])this.background('partner_profile:'+id,()=>this.syncPartnerProfile(id));
      if(this.stopped)return;
      const identitiesReady=await this.pumpStage('codex_identities',()=>this.checkCodexIdentities());
      if(this.stopped)return;
      await this.pumpStage('claude_inbound',()=>this.claudeInbound.sweep());
      for(const pair of this.store.pairs())await this.pumpStage('codex_final:'+pair.codex,()=>this.finalForwards.scan(this.store.peer(pair.codex)));
      for(const pair of this.store.pairs())await this.pumpStage('notice_conditions:'+pair.id,()=>{this.refreshSubagentHold(this.store.peer(pair.codex));this.runtimeHealth.refreshNoticeConditions(pair,'periodic_pump');});
      for(const peer of this.store.peers())if(!this.store.pairFor(peer.id)&&['root','fork'].includes(peer.kind))await this.pumpStage('cooperation_unpaired:'+peer.id,()=>this.communicationTips.cooperation.observe(peer));
      await this.pumpStage('delivery_health',()=>this.runtimeHealth.checkDeliveryHealth());
      if(this.stopped)return;
      await this.pumpStage('turn_health',()=>this.runtimeHealth.checkTurnHealth());
      if(this.stopped)return;
      if(Date.now()-this.lastMaintenance>({...DEFAULT_RETENTION,...this.config.retention}).maintenanceIntervalMs)await this.pumpStage('maintenance',()=>this.maintain());
                                             
      if(!foregroundReady||!windowsReady||!pendingReady||!identitiesReady)return;
      const byTarget=new Map<string,PendingMessageFacts[]>();for(const m of this.store.pendingFacts()){const list=byTarget.get(m.to)??[];list.push(m);byTarget.set(m.to,list);}
      for(const pair of this.store.pairs())if(!pair.paused&&this.codexDirect.pending(pair.codex)&&!byTarget.has(pair.codex))byTarget.set(pair.codex,[]);
      for(const pair of this.store.pairs())if(!pair.paused&&this.subagentCompletions.pending(this.store.peer(pair.codex))&&!byTarget.has(pair.codex))byTarget.set(pair.codex,[]);
                                   
      for(const id of byTarget.keys())if(!recoveries.has(id))recoveries.set(id,this.memberLifecycle.schedulePairedRecovery(id,true));
      const deliveries=[...byTarget].map(([id,messages])=>this.pumpStage('delivery:'+id,async()=>{
                                               
        const recovering=this.memberLifecycle.recoveryWork(id);if(recovering&&this.memberLifecycle.isRestoring(id))return this.memberLifecycle.deferRecoveryDelivery(id,recovering);
        if(!await recoveries.get(id))return SKIPPED;
        if(this.memberLifecycle.isRetiring(id)||this.memberLifecycle.isRestarting(id)||this.store.setting('managedSessionConflict:'+id))return SKIPPED;
        if(this.memberLifecycle.retryPending(id)||!this.incidents.canAttempt(this.store.peer(id),this.runtimeEndpoint(id)))return SKIPPED;
        let target=this.store.peer(id);
        if(this.profiles.blocks(target))return SKIPPED;
        if(claudeAutoHolds(this.store,target))return SKIPPED;
        if(hostingGate(this.store,target))return SKIPPED;
        if(!this.enabled(id))return SKIPPED;
        const targetPair=this.store.pairFor(id);if(!targetPair||targetPair.paused||!this.enabled(targetPair.claude)||!this.enabled(targetPair.codex))return SKIPPED;
        const child=process.platform==='linux'&&target.host==='claude'?claudeChild(this.home,id):undefined;if(child&&['handoff','user'].includes(child.phase)&&target.owner==='nxbridge')return SKIPPED;
        if(target.state==='paused'||target.state==='needsHuman'||target.launchFailure&&!target.sessionId)return SKIPPED;
        try{
          const endpoint=this.store.endpoint(id);
          if(!target.sessionId||!endpoint||target.state==='offline'||endpoint.pendingContext)return SKIPPED;
          if(!this.enabled(id))return SKIPPED;
          if(target.host==='claude'&&target.owner==='nxbridge')await this.memberLifecycle.verifyOwnedClaudeLaunch(id,false);
          if(endpoint.daemon)return this.signalCodexWake(target,endpoint);
          if(endpoint.pid&&!liveProcess(endpoint.pid)){this.store.deactivate(id,endpoint.epoch);this.store.updatePeer(id,{state:'offline'});return SKIPPED;}
          const availability=await this.runtimeHealth.probeRuntime(target);
          if(!this.enabled(id))return SKIPPED;
          if(availability.state==='blocked'){
            this.memberLifecycle.delayRetry(id,5000);this.store.deactivate(id,endpoint.epoch);this.store.updatePeer(id,{state:'offline'});return SKIPPED;
          }
          if(endpoint.mode==='embedded'){
            if(this.config.compatibilityWake==='notify')await this.signalEmbeddedWake(target,endpoint);
            return;
          }
          if(target.host==='codex'&&endpoint.mode==='app-server'){
            return this.signalCodexWake(target,endpoint);
          }
          for(const facts of messages){
            if(this.memberLifecycle.isRetiring(id)||this.memberLifecycle.isRestarting(id))break;
            const currentPair=this.store.pairFor(id),currentTarget=this.store.peer(id),binding=this.store.bindings.current(id);
            if(this.stopped||currentPair?.paused||currentPair?.id!==facts.pairId)break;
            if(binding?.transitioning||currentTarget.sessionId!==target.sessionId||['paused','needsHuman'].includes(currentTarget.state))break;
            const message=this.store.pendingMessage(facts);if(!message)continue;
            const body=this.deliveryBody(message);if(body===undefined)continue;
            const sender=this.store.peer(message.from),senderBinding=this.store.bindings.current(sender.id)?.epoch,targetBinding=binding?.epoch;
            if(this.memberLifecycle.isRestarting(id)||!this.store.claim(message.id))continue;
            try{
              const delivery={...message,body,...fileHintFields(body,target.cwd),senderSnapshot:()=>this.store.peer(sender.id),beforeSubmit:async()=>{
                const currentTarget=this.store.peer(id),currentSender=this.store.peer(sender.id),pair=this.store.pairFor(id);
                return memberEnabled(this.store,currentTarget)&&memberEnabled(this.store,currentSender)&&!this.profiles.blocks(currentTarget)&&this.memberLifecycle.ownedClaudeLaunchReady(currentTarget)&&!this.memberLifecycle.isRestarting(id)&&!this.memberLifecycle.isRetiring(id)&&pair?.id===message.pairId&&!pair.paused&&currentTarget.sessionId===target.sessionId&&currentSender.sessionId===sender.sessionId&&this.store.bindings.current(sender.id)?.epoch===senderBinding&&this.store.bindings.current(id)?.epoch===targetBinding;
              }};
              const result=await this.adapters.claude.deliver(target,endpoint,delivery,sender);
              if(result.state!=='expired')this.runtimeHealth.deliverySucceeded(target,endpoint);
              const current=this.store.message(message.id);
                                                  
              if(current.state==='sending')this.store.transition(message.id,result.state==='expired'?'accepted':result.state,result.evidence);
              if(result.state==='expired'){this.memberLifecycle.delayRetry(id,1000);break;}
            }catch(error){
              const uncertain=!(error instanceof DeliveryError)||error.uncertain;
              this.store.transition(message.id,uncertain?'unknown':'accepted',undefined,describeError(error));
              throw error;
            }
          }
        }catch(error){
          if(target.host==='codex'&&isCodexIdentityError(error)){const endpoint=this.store.endpoint(id);if(endpoint)await this.migrateCodexIdentity(target,endpoint,error);return;}
          if(target.host!=='codex')this.incidents.failed(target,this.runtimeEndpoint(id),error,messages.map(message=>message.id));
          this.memberLifecycle.delayRetry(id,10000);
          this.store.event('delivery.blocked',{peerId:id,error:describeError(error)});
          if(!target.sessionId)this.store.updatePeer(id,{state:'offline'});
          throw error;
        }
      }));
      await Promise.all(deliveries);
    if(Date.now()-this.lastReconcile>30000){this.lastReconcile=Date.now();await this.pumpStage('reconcile',()=>this.reconcile());}
  }
  private async syncClaudeChild():Promise<void>{
    await Promise.allSettled(this.store.pairs().map(pair=>this.pumpStage('claude_child:'+pair.claude,()=>this.syncClaudePair(pair))));
  }
  private async syncClaudePair(pair:Pair):Promise<void>{
    if(!this.enabled(pair.claude))return;
    const peer=this.store.peer(pair.claude),child=claudeChild(this.home,peer.id);if(!child)return;
    if(child.phase==='user'&&child.foreground&&child.handoffId){
      const lease=this.takeovers.get(peer.id);if(lease){await this.memberLifecycle.returnTakeover(peer.id,lease.id);return;}
      let exited=!liveProcess(child.foreground.pid);if(!exited)try{exited=(await processIdentity(child.foreground.pid)).startedAt!==child.foreground.startedAt;}catch(error){if((error as BridgeError).code==='process_missing')exited=true;else throw error;}
      if(exited){this.memberLifecycle.returnClaudeChild(peer,child,child.handoffId);this.profiles.clear(peer);this.store.deactivate(peer.id);this.store.updatePeer(peer.id,{owner:'nxbridge',state:'offline'});this.store.event('claude.foreground.returned',{peerId:peer.id,sessionId:peer.sessionId,evidence:'前台 PID 与代次核验已退出'});}return;
    }
    if(peer.owner!=='nxbridge'||['handoff','user','released','stopped'].includes(child.phase))return;
    let workerDead=!!child.worker&&!liveProcess(child.worker.pid);if(child.worker&&!workerDead)try{workerDead=(await processIdentity(child.worker.pid)).startedAt!==child.worker.startedAt;}catch(error){if((error as BridgeError).code==='process_missing')workerDead=true;else throw error;}
    const next=child.phase==='failed'||workerDead?'offline':child.human?'needsHuman':undefined;
    if(next&&peer.state!=='paused'&&peer.state!==next){this.store.updatePeer(peer.id,{state:next});if(next==='needsHuman')this.store.event('claude.needsHuman',{peerId:peer.id,tool:child.human?.tool,takeoverCommand:'nxbridge open claude'});}
    if(child.phase==='failed'||workerDead)this.store.deactivate(peer.id);
    const health=this.runtimeHealth.claudeHealth(peer,child);
    if(health?.state==='networkRetrying'||health?.state==='silent'||health?.state==='failed'){
      const key='claudeHealth:'+peer.id,signature=health.turnId+':'+health.state;if(this.store.setting(key)!==signature){this.store.setSetting(key,signature);this.store.event('claude.health',{peerId:peer.id,state:health.state,takeoverCommand:'nxbridge open claude --interrupt',error:health.error??null});}
    }
  }
  private observeCodexContext(peer:Peer,receipt:CodexContextReceipt,source:string,context?:{sessionId:string|null;epoch?:string}):void{
    if(!this.enabled(peer.id))return;
    let message:Message;
    try{message=this.store.message(receipt.messageId);}catch(error){if(error instanceof BridgeError&&error.code==='message_missing')return;throw error;}
    if(message.to!==peer.id)return;
    this.store.transition(message.id,'contextObserved',`Codex ${source} 确认工具输出进入上下文，thread=${peer.sessionId}，turn=${receipt.turnId}，item=${receipt.itemId}`);
    const current=this.store.peer(peer.id);
                                      
    if(!context||context.sessionId===current.sessionId&&context.epoch===this.store.bindings.current(peer.id)?.epoch)this.communicationTips.partnerReceived(current,message);
  }
  async reconcile(peerId?:string):Promise<void>{
    if(this.stopped)return;
    const groups=new Map<string,Set<string>>();
    for(const message of this.store.reconcilable(peerId)){const ids=groups.get(message.to)??new Set<string>();ids.add(message.id);groups.set(message.to,ids);}
    if(!peerId)for(const id of this.reconcileOffline.keys())if(!groups.has(id))this.reconcileOffline.delete(id);
    await Promise.allSettled([...groups].map(([id,ids])=>{
      if(!this.store.faults.ready('reconcile:'+id))return Promise.resolve();
      const pending=this.reconciling.get(id);if(pending)return pending;
      const work=(async()=>{
        let target:{endpoint:Endpoint;sessionId:string|null}|undefined;
        try{
          const peer=this.store.peer(id);if(peer.host!=='codex'||!this.enabled(id))return;
                                               
          const endpoint=this.store.endpoint(id)??this.store.endpoints(id).filter(e=>e.mode==='app-server'||e.daemon).sort((a,b)=>a.seenAt-b.seenAt).at(-1);
          if(endpoint?.mode!=='app-server'&&!endpoint?.daemon)return;
          target={endpoint,sessionId:peer.sessionId};
          const offline=this.reconcileOffline.get(id);
          if(!endpoint.active&&offline&&offline.sessionId===peer.sessionId&&offline.endpoint.address===endpoint.address&&offline.endpoint.epoch===endpoint.epoch&&offline.endpoint.seenAt===endpoint.seenAt&&Date.now()<offline.retryAt)return;
          const context={sessionId:peer.sessionId,epoch:this.store.bindings.current(peer.id)?.epoch};
          const since=Math.min(...[...ids].map(messageId=>this.store.message(messageId).createdAt));
          const receipts=await(endpoint.daemon?this.daemons.reconcile(peer,endpoint,{since}):this.adapters.codex.reconcile(peer,endpoint,{since}));if(this.stopped||!this.enabled(id))return;
          for(const receipt of receipts)if(ids.has(receipt.messageId))this.observeCodexContext(peer,receipt,'thread/read',context);
          this.reconcileOffline.delete(id);
          this.store.faults.recovered('reconcile:'+id);
        }catch(error){
          if(this.stopped)return;
          const code=(error as {code?:string})?.code,missingSocket=code==='ENOENT'&&(error as {syscall?:string}).syscall==='connect';
                                                  
          if(target&&!target.endpoint.active&&(missingSocket||['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','ERR_STREAM_PREMATURE_CLOSE','proxy_closed','disconnected','timeout'].includes(code??''))){
            if(!this.reconcileOffline.has(id))this.store.event('reconcile.offline',{peerId:id,endpoint:target.endpoint.address,error:describeError(error)});
            this.reconcileOffline.set(id,{...target,retryAt:Date.now()+60000});this.store.faults.recovered('reconcile:'+id);
          }else{this.reconcileOffline.delete(id);this.pumpFailed('reconcile:'+id,error);}
        }
      })();
      this.reconciling.set(id,work);
      void work.then(()=>{if(this.reconciling.get(id)===work)this.reconciling.delete(id);},error=>{this.reconciling.delete(id);this.pumpFailed('reconcile:'+id,error);});
      return work;
    }));
  }
  private serialCodexWake(peer:Peer,work:()=>Promise<void|typeof SKIPPED>):Promise<void|typeof SKIPPED>{
    const active=this.codexWakeWork.get(peer.id);if(active)return active;
    const next=work().finally(()=>{if(this.codexWakeWork.get(peer.id)===next)this.codexWakeWork.delete(peer.id);});
    this.codexWakeWork.set(peer.id,next);return next;
  }
  private codexWakeAllowed(peer:Peer,endpoint:Endpoint,pairId:string):boolean{
    const current=this.store.peer(peer.id),pair=this.store.pairFor(peer.id),active=this.store.endpoint(peer.id);
    return !this.stopped&&pair?.id===pairId&&!pair.paused&&this.enabled(pair.claude)&&this.enabled(pair.codex)
      &&current.sessionId===peer.sessionId&&current.state==='ready'&&!hostingGate(this.store,current)&&!this.profiles.blocks(current)
      &&!this.memberLifecycle.isRestarting(peer.id)&&!this.memberLifecycle.isRetiring(peer.id)&&!this.store.setting('managedSessionConflict:'+peer.id)
      &&!!active?.active&&active.epoch===endpoint.epoch&&active.address===endpoint.address&&active.bindingEpoch===endpoint.bindingEpoch
      &&!active.pendingContext&&!this.store.bindings.current(peer.id)?.transitioning;
  }
  private finalForwardGate(codex:Peer,claude:Peer):string|undefined{
    const pair=this.store.pairFor(codex.id);if(this.stopped||!pair)return'context_changed';
    if(pair.paused)return'paused';
    if(!this.enabled(codex.id)||!this.enabled(claude.id))return'disabled';
    for(const peer of [codex,claude]){
      const endpoint=this.store.endpoint(peer.id);
      if(!endpoint?.active||endpoint.pendingContext||this.store.bindings.current(peer.id)?.transitioning)return'context_changed';
      if(peer.state==='paused')return'interrupted';
      const health=this.runtimeHealth.peerHealth(peer);
      if(peer.state==='needsHuman'||health?.state==='needsHuman'||health?.humanRequests?.length)return'needs_human';
      if(hostingGate(this.store,peer))return'hosting_pending';
      if(this.profiles.blocks(peer))return'profile_pending';
      if(this.memberLifecycle.isRestarting(peer.id)||this.memberLifecycle.isRetiring(peer.id)||this.store.setting('managedSessionConflict:'+peer.id))return'runtime_pending';
      if(peer.state!=='ready')return peer.host==='claude'?'claude_busy':'codex_busy';
    }
    if(this.store.endpoint(claude.id)?.modRevision!==MOD_REVISION)return'mod_pending';
    if(claudeAutoHolds(this.store,claude)||!this.memberLifecycle.ownedClaudeLaunchReady(claude))return'native_policy';
    return;
  }
  private subagentContextAllowed(peer:Peer,synthetic:boolean):boolean{
    const current=this.store.peer(peer.id),pair=this.store.pairFor(peer.id),endpoint=this.store.endpoint(peer.id);
    return !this.stopped&&!!pair&&!pair.paused&&this.enabled(pair.claude)&&this.enabled(pair.codex)
      &&current.sessionId===peer.sessionId
      &&!hostingGate(this.store,current)&&!this.profiles.blocks(current)&&!['paused','needsHuman','offline'].includes(current.state)
      &&!this.memberLifecycle.isRestarting(peer.id)&&!this.memberLifecycle.isRetiring(peer.id)&&!this.store.setting('managedSessionConflict:'+peer.id)
      &&!!endpoint?.active&&!endpoint.pendingContext&&!this.store.bindings.current(peer.id)?.transitioning
      &&(!synthetic||!endpoint.daemon||daemonWakeAuthorized(this.store,pair)&&!daemonContextChanged(this.store,current,endpoint));
  }
  private refreshSubagentHold(peer:Peer):void{
    const view=this.subagentCompletions.status(peer),pair=this.store.pairFor(peer.id),endpoint=view?this.store.endpoint(peer.id):undefined,retry=this.codexWake.status(peer.id);
    let reason:string|undefined;
    if(view?.batchId&&pair&&(view.needsWake||view.awaitingContext)){
      if(pair.paused)reason='配对已暂停';
      else if(!this.enabled(pair.claude)||!this.enabled(pair.codex))reason='nxbridge 已禁用';
      else if(peer.state==='paused')reason=peer.pauseReason==='interrupted'?'用户已中断主线程':'主线程已暂停';
      else if(peer.state==='needsHuman')reason='原生会话正在等待人工处理';
      else if(hostingGate(this.store,peer))reason='宿主交接尚未完成';
      else if(this.profiles.blocks(peer))reason='模型设置正在核验，投递暂缓';
      else if(this.store.setting('managedSessionConflict:'+peer.id))reason='原生会话身份冲突，投递暂缓';
      else if(peer.state==='busy')reason=undefined;
      else if(!endpoint||['offline','unknown','starting'].includes(peer.state))reason='当前原生会话不可达或尚未核验';
      else if(endpoint.daemon&&(!daemonWakeAuthorized(this.store,pair)||daemonContextChanged(this.store,peer,endpoint)))reason='用户窗口没有当前上下文的主动唤醒授权';
      else if(endpoint.mode==='embedded'&&!endpoint.daemon&&this.config.compatibilityWake!=='notify')reason='此用户窗口未启用兼容唤醒';
      else if(view.wake?.state==='unknown')reason='上次唤醒结果不明，未重复提交';
      else if(view.wake&&Date.now()-view.wake.at>=30000)reason=view.wake.state==='queued'?'提醒已入队，尚未观察到主线程消费':'原生已接受提醒，尚未确认主线程继续';
      else if(view.needsWake&&retry?.anchor===view.batchId&&(retry.exhausted||retry.error))reason=retry.exhausted?'唤醒次数已用完，自动尝试已停止':'唤醒通道未通过核验：'+retry.error;
    }
    const hold=reason&&view?.batchId?{batchId:view.batchId,reason}:null,previous=this.pairAnomalies.evidence(peer).subagentHold;
    if(JSON.stringify(previous??null)===JSON.stringify(hold))return;
    this.pairAnomalies.integration(peer,{subagentHold:hold});
    if(pair)this.runtimeHealth.refreshNoticeConditions(pair,'subagent_completion_hold');
  }
  private async submitCodexSignal(peer:Peer,channel:string,guard:()=>boolean,submit:(authorize:()=>Promise<boolean>)=>Promise<void|string|undefined>,queued=false):Promise<boolean>{
    let id:string|undefined;
    try{
      const result=await submit(async()=>{if(!guard())return false;id=this.subagentCompletions.reserve(peer,channel);return !!id;});
      if(id)this.subagentCompletions.outcome(peer,id,channel==='native'&&result===undefined?'not_submitted':queued?'queued':'submitted',typeof result==='string'?result:undefined);
      return !!id&&(channel!=='native'||result!==undefined);
    }catch(error){
      const notSubmitted=channel==='queue'?(error as {code?:string}).code!=='queue_result_unknown':(error as {uncertain?:boolean}).uncertain===false;
      if(id)this.subagentCompletions.outcome(peer,id,notSubmitted?'not_submitted':'unknown');
      throw error;
    }
  }
  private async signalSubagentWake(peer:Peer,endpoint:Endpoint,pair:Pair):Promise<void>{
    const batch=this.subagentCompletions.batch(peer);if(!batch||this.subagentCompletions.blocked(peer))return;
    const guard=()=>this.codexWakeAllowed(peer,endpoint,pair.id)&&this.subagentCompletions.pending(peer)&&!this.subagentCompletions.blocked(peer);
    const scope=JSON.stringify([pair.id,peer.sessionId,endpoint.epoch,endpoint.bindingEpoch]);
    await this.codexWake.signal(peer.id,scope,batch,async()=>{
      if(!guard())return false;
      try{
        return await this.submitCodexSignal(peer,'native',guard,authorize=>endpoint.daemon?this.daemons.wake(peer,endpoint,authorize):this.adapters.codex.wakeSubagents(peer,endpoint,this.runtimeHealth.abortSignal,authorize))?undefined:false;
      }catch(error){
                                                      
        const safe=error instanceof DeliveryError&&!error.uncertain&&['attach_failed','disconnected','timeout','daemon_identity_changed','-32601','method_not_found','unsupported'].includes(error.code);
        if(!safe||!guard())throw error;
        this.store.event('subagent.wake.fallback',{peerId:peer.id,batchId:batch,reason:error.code});
        return await this.submitCodexSignal(peer,'queue',guard,authorize=>this.adapters.codex.queueWake(peer,endpoint,async()=>{
          if(!await(endpoint.daemon?this.daemons:this.adapters.codex).queueWakeReady(peer,endpoint)||!await authorize())throw new DeliveryError('wake_unavailable','父会话已不再满足唤醒条件。');
        },()=>{}),true)?undefined:false;
      }
    });
  }
  private async signalEmbeddedWake(peer:Peer,endpoint:Endpoint):Promise<void>{
    try{await this.serialCodexWake(peer,()=>this.signalEmbeddedWakeInner(peer,endpoint));}finally{this.refreshSubagentHold(this.store.peer(peer.id));}
  }
  private async signalEmbeddedWakeInner(peer:Peer,endpoint:Endpoint):Promise<void>{
    this.requireEnabled(peer);
    const pair=this.store.pairFor(peer.id),current=this.store.peer(peer.id);
    if(!pair||endpoint.mode!=='embedded'||endpoint.daemon||!peer.sessionId||!this.codexWakeAllowed(peer,endpoint,pair.id)||this.subagentCompletions.blocked(peer))return;
    const config={...this.config,...(endpoint.configHome?{codexHome:endpoint.configHome}:{})},home=config.codexHome;
    if(!home)return;
    const needed=()=>this.store.pendingCount(peer.id)>0||this.deliveryHealth.peek(pair.id,peer.id).some(n=>n.wake===true)||this.subagentCompletions.pending(peer);
    if(!needed())return;
    const scope=JSON.stringify([pair.id,peer.sessionId,endpoint.epoch,endpoint.bindingEpoch]);
    const error=await this.wakeSignals.signal(peer.id,scope,home,peer.sessionId,async()=>{
      if(!this.codexWakeAllowed(peer,endpoint,pair.id)||this.subagentCompletions.blocked(peer)||!needed())return;
      const message=this.store.pendingCount(peer.id)?WAKE_NOTICE:HEALTH_WAKE_NOTICE;
      await this.submitCodexSignal(peer,'embedded_queue',()=>this.codexWakeAllowed(peer,endpoint,pair.id)&&needed(),authorize=>this.adapters.codex.queueWake(peer,endpoint,async()=>{if(!await authorize())throw new DeliveryError('wake_unavailable','父会话已不再满足唤醒条件。');},()=>{},message),true);
    });
    this.pairAnomalies.integration(current,{wakeQueueError:error});
  }
  private async signalCodexWake(peer:Peer,endpoint:Endpoint):Promise<void|typeof SKIPPED>{
    return this.serialCodexWake(peer,async()=>{
      if(!this.incidents.canAttempt(peer,endpoint))return SKIPPED;
      try{return await this.signalCodexWakeInner(peer,endpoint);}catch(error){this.incidents.failed(peer,endpoint,error,this.store.pendingFacts(peer.id).map(message=>message.id));throw error;}finally{this.refreshSubagentHold(this.store.peer(peer.id));}
    });
  }
  private async signalCodexWakeInner(peer:Peer,endpoint:Endpoint):Promise<void|typeof SKIPPED>{
    this.requireEnabled(peer);
    await this.codexForeground.sweep();
    if(hostingGate(this.store,peer))return SKIPPED;
    const pair=this.store.pairFor(peer.id),current=this.store.peer(peer.id);
    if(!pair||!peer.sessionId||!this.codexWakeAllowed(peer,endpoint,pair.id)||this.subagentCompletions.blocked(peer))return SKIPPED;
    if(endpoint.daemon&&!await this.daemons.wakeReady(peer,endpoint))return SKIPPED;
    if(this.subagentCompletions.pending(peer)&&!this.codexDirect.status(peer.id)?.continuation?.uncertain)return this.signalSubagentWake(peer,endpoint,pair);
    if(localCodexEndpoint(this.home,endpoint.address)){
      const actor:Actor={host:'codex',memberId:peer.id,sessionId:peer.sessionId,callId:randomUUID()};
      const notices=this.deliveryHealth.peek(pair.id,peer.id).filter(n=>n.wake===true).map(notice=>({id:notice.id,pairId:pair.id,from:pair.claude,to:peer.id,body:notice.message,callId:notice.id,state:'accepted' as const,createdAt:Date.now(),updatedAt:Date.now(),attempts:0,inReplyTo:null,via:null,evidence:null,error:null,notice:true}));
      const guard=()=>{const fresh=this.store.pairFor(peer.id),active=this.store.endpoint(peer.id);return !hostingGate(this.store,this.store.peer(peer.id))&&!this.profiles.blocks(this.store.peer(peer.id))&&this.enabled(peer.id)&&!this.stopped&&!this.memberLifecycle.isRestarting(peer.id)&&fresh?.id===pair.id&&!fresh.paused&&this.store.peer(peer.id).sessionId===peer.sessionId&&this.store.peer(peer.id).state==='ready'&&active?.epoch===endpoint.epoch&&!this.store.bindings.current(peer.id)?.transitioning;};
      await this.codexDirect.deliver(peer,endpoint,[...this.store.pending(peer.id),...notices],async message=>{
        if(message.notice){const notice=(await this.runtimeHealth.prepareNotices(actor,[message.id],true,true))[0];return notice?JSON.stringify({messages:[],notices:[{notice_id:notice.id,source:notice.source??'runtime_monitor',message:notice.message}]}):undefined;}
        const body=this.deliveryBody(message);return body===undefined?undefined:JSON.stringify({messages:[{message_id:message.id,from:modelPeerName(this.store.peer(message.from)),message:body,...(message.replyExpected?{reply_expected:true}:{}),...(message.inReplyTo?{in_reply_to:message.inReplyTo}:{}),...(message.via?{via:message.via}:{}),...fileHintFields(body,peer.cwd)}],status:'received'});
      },guard,receipt=>{this.observeCodexContext(peer,receipt,'原生持久历史');this.deliveryHealth.outcome(pair.id,peer.id,receipt.messageId,'submitted');},id=>this.deliveryHealth.recordedCanWake(pair.id,peer.id,id));
      if(this.subagentCompletions.pending(peer)&&!this.subagentCompletions.blocked(peer)&&!this.codexDirect.status(peer.id)?.continuation?.uncertain)await this.signalSubagentWake(peer,endpoint,pair);
      return;
    }
    const anchor=this.store.firstPendingId(peer.id)??this.deliveryHealth.peek(pair.id,peer.id).find(n=>n.wake===true)?.id;
    if(!anchor){this.codexWake.clear(peer.id);return;}
    const scope=JSON.stringify([pair.id,peer.sessionId,endpoint.epoch,endpoint.bindingEpoch]);
    await this.codexWake.signal(peer.id,scope,anchor,async()=>{await this.submitCodexSignal(peer,'native_existing',()=>this.codexWakeAllowed(peer,endpoint,pair.id)&&(this.store.pendingCount(peer.id)>0||this.deliveryHealth.peek(pair.id,peer.id).some(n=>n.wake===true)),authorize=>this.adapters.codex.wake(peer,endpoint,this.runtimeHealth.abortSignal,authorize));});
    const reservation=this.codexWake.status(peer.id);
    if(this.store.pendingCount(peer.id)||this.deliveryHealth.peek(pair.id,peer.id).some(n=>n.wake===true))this.pairAnomalies.integration(current,{pickup:reservation??null});
  }
  private recoveredCodexInterrupt(peer:Peer,turnId:unknown):boolean{
    const fence=this.store.setting<{sessionId:string;endpointEpoch:string;pairId:string;turnId:string}>('codexRecoveryFence:'+peer.id);
    return typeof turnId==='string'&&fence?.turnId===turnId&&fence.sessionId===peer.sessionId&&fence.endpointEpoch===this.store.endpoint(peer.id)?.epoch&&fence.pairId===this.store.pairFor(peer.id)?.id;
  }
  private async recoverTurn(turnId?:string,preview=false,requestId?:string,selector:TargetSelector={},terminalOrigin?:TerminalOrigin):Promise<unknown>{
    const selected=this.targetPair(selector);this.requireEnabled(this.store.peer(selected.codex));
    const {pair,peer}=this.restartTarget(selector),endpoint=this.store.endpoint(peer.id);
    if(!pair||pair.paused)throw new BridgeError('unowned_runtime','当前配对不可用或已暂停，未执行恢复；请先查看配对状态。');
    if(peer.owner!=='nxbridge')throw new BridgeError('unowned_runtime','目标由用户窗口管理，未执行自动恢复；请在原生窗口中断。');
    if(endpoint?.mode!=='app-server')throw new BridgeError('unowned_runtime','当前托管 Codex 尚未登记可核验的 App Server 端点，未执行恢复；请等待原宿主完成登记后查看状态。');
    const health=await this.runtimeHealth.probeTurnHealth(peer,endpoint);
    const failed=health?.state==='failed',failedKey='codexFailedRecovery:'+peer.id,previous=this.store.setting<{sessionId:string;turnId:string;noticeId:string}>(failedKey),alreadyRequested=failed&&previous?.sessionId===peer.sessionId&&previous.turnId===health.turnId;
    const guard=()=>{
      const current=this.store.peer(peer.id),active=this.store.endpoint(peer.id);
      this.requireEnabled(current);
      if(this.stopped||current.owner!=='nxbridge'||current.sessionId!==peer.sessionId||this.store.pairFor(peer.id)?.id!==pair.id||!active?.active||active.epoch!==endpoint.epoch||active.address!==endpoint.address)throw new BridgeError('session_changed','目标会话、配对或原生端点已经变化，未执行恢复。');
      if(this.store.pairFor(peer.id)?.paused||current.state==='paused'||active.pendingContext||this.store.bindings.current(peer.id)?.transitioning)throw new BridgeError('turn_waiting','目标已暂停或正在切换上下文，未执行恢复。');
      if(current.state==='needsHuman'||this.store.questions(true).some(q=>q.from===peer.id||q.to===peer.id))throw new BridgeError('turn_waiting','目标正在等待问题或审批，未执行恢复；请先处理等待。');
    };
    if(preview){
      const eligible=health&&health.progressEvidence!==false&&!health.tools.length&&!health.humanRequests?.length&&health.state!=='needsHuman'&&!this.memberLifecycle.isRestarting(peer.id)&&!alreadyRequested&&(failed||health.state!=='ready'&&health.state!=='networkRetrying'&&!providerBlocked(health)&&Date.now()-health.lastProgressAt>=RECENT_PROGRESS_MS);
      let available=!!eligible;try{guard();}catch{available=false;}
      return{session_id:peer.sessionId,peer_id:peer.id,pair_id:pair.id,runtime:endpoint.pid&&endpoint.procStart?{pid:endpoint.pid,procStart:endpoint.procStart}:undefined,health,...(alreadyRequested?{recoveryBlocked:'recovery_already_requested',notice_id:previous!.noticeId}:{}),recoveryCommand:available?`nxbridge recover codex --member ${peer.id} --turn ${health!.turnId}`:null};
    }
    if(health?.state==='networkRetrying')await requireExternalTerminal(terminalOrigin);
    if(!health||health.turnId!==turnId)throw new BridgeError('turn_changed','活动 turn 已改变，未中断；请重新查看 status。');
    if(health.progressEvidence===false)throw new BridgeError('progress_unverified','无法核验原生最新轮次，未执行恢复；请先查看 status。');
    if(alreadyRequested)throw new BridgeError('recovery_already_requested','已为这一失败轮次提交过继续指令，不会重复提交；请用 nxbridge status 核对原会话。');
    if(health.state==='ready'||!failed&&Date.now()-health.lastProgressAt<RECENT_PROGRESS_MS)throw new BridgeError('turn_recovered','Codex 最近 30 秒内仍有进展，或这一轮已经正常结束，未执行恢复。');
    if(health.state==='needsHuman'||health.tools.length||health.humanRequests?.length)throw new BridgeError('turn_waiting','目标正在运行工具、等待问题或审批，未执行恢复；请在原生窗口处理。');
    guard();
    if(this.memberLifecycle.isRestarting(peer.id))throw new BridgeError('restart_in_progress','目标正在恢复，请勿重复提交。');
    const releaseRestart=this.memberLifecycle.beginRestart(peer.id);
    const response={request_id:requestId,pair_id:pair.id,peer_id:peer.id,session_id:peer.sessionId,turn_id:turnId},resultKey='codexRecovery:'+requestId;
    try{
      this.store.setSetting(resultKey,{...response,state:failed?'preparing':'interrupting'});
      const rpc=await this.adapters.codex.connect(endpoint.address);
                                                 
      let fresh=this.runtimeHealth.modelRequestHealth(peer,endpoint,this.health.get(endpoint.address,peer.sessionId!));
      if(fresh?.state==='networkRetrying')await requireExternalTerminal(terminalOrigin);
      guard();
      if(failed){
        const thread=await readCodexThread(rpc,peer.sessionId!,{timeout:3000}),latest=thread.turns?.at(-1);
        fresh=this.runtimeHealth.modelRequestHealth(peer,endpoint,this.health.get(endpoint.address,peer.sessionId!));
        guard();
        if(latest?.id!==turnId||latest.status!=='failed'||!codexThreadIdle(thread)||fresh?.turnId!==turnId||fresh.state!=='failed')throw new BridgeError('turn_recovered','执行前复核发现最新失败轮次或原生空闲状态已改变，未追加继续指令。');
      }else{
        if(fresh?.turnId!==turnId||['ready','failed'].includes(fresh.state)||Date.now()-fresh.lastProgressAt<RECENT_PROGRESS_MS)throw new BridgeError('turn_recovered','执行前复核发现 Codex 已有新进展，或这一轮已经变化，未中断。');
        this.store.setSetting('codexRecoveryFence:'+peer.id,{sessionId:peer.sessionId,endpointEpoch:endpoint.epoch,pairId:pair.id,turnId});
        try{await rpc.request('turn/interrupt',{threadId:peer.sessionId,turnId},{mutation:true,timeout:10000});}
        catch(error){if((error as {uncertain?:boolean}).uncertain===false)this.store.setSetting('codexRecoveryFence:'+peer.id,null);throw error;}
        const deadline=Date.now()+10000;
        while(true){
          const result={thread:await readCodexThread(rpc,peer.sessionId!,{turnId,timeout:3000})},turn=result.thread?.turns?.find((t:any)=>t.id===turnId);
          if(turn?.status==='interrupted')break;
          if(turn?.status&&turn.status!=='inProgress')throw new BridgeError('turn_recovered','这一轮已自行结束，未追加继续指令。');
          if(Date.now()>=deadline)throw new DeliveryError('recovery_uncertain','没能确认这一轮已中断；不会重复中断，也不会重发任务，请用 nxbridge status 查看。',true);await delay(100);
        }
      }
      if(this.store.pairFor(peer.id)?.id!==pair.id||this.store.pairFor(peer.id)?.paused)throw new BridgeError('session_changed','中断后配对改变或暂停，未继续目标。');
      const noticeId=randomUUID();
      this.store.transaction(()=>{
        if(failed)this.store.setSetting(failedKey,{sessionId:peer.sessionId,turnId,noticeId,requestId,requestedAt:Date.now()});
        this.deliveryHealth.enqueue(pair.id,peer.id,{id:noticeId,source:'turn_health',state:'pending',kind:'explicit_recovery',scope:this.runtimeHealth.noticeScope(pair,peer),...(failed?{factKey:'explicit_failed:'+peer.sessionId+':'+turnId}:{}),message:(failed?`The user explicitly requested recovery after failed native turn ${turnId}${health.modelRequest?' ('+modelRequestText(health.modelRequest)+')':''}. This does not repair the model provider. `:'Explicit recovery after a stalled turn. ')+'Continue the existing authorized task in this same session. First inspect partial file changes and existing command sessions; a command may still be running or may have completed. Do not rerun completed mutations/tests or resend prior messages. Report any uncertainty and continue from durable state.'});
      });
      this.store.updatePeer(peer.id,{state:'ready'});
                                       
      releaseRestart();
      await this.signalCodexWake(peer,endpoint);
      const result={...response,recovered:true,notice_id:noticeId,action:failed?'continue_failed':'interrupt_stalled',text:(failed?'已在原会话中提交一次用户要求的“检查已有进度后继续”指令，没有中断或重放失败轮次；模型服务故障仍需按实际结果处理。':'已中断卡住的这一轮，并在原会话中发出一次“检查已有进度后继续”的指令。')+'文件、后台命令和消息记录都已保留；Codex 是否已经继续工作，请稍后用 nxbridge status 确认。'+(providerBlocked(health)?' 本次明确恢复只缩短原生重试等待，不会修复模型服务。':'')};
      this.store.setSetting(resultKey,{...result,state:'submitted'});return result;
    }catch(error){this.store.setSetting(resultKey,{...response,state:error instanceof DeliveryError&&error.uncertain?'uncertain':'stopped',error:describeError(error)});throw error;}
    finally{releaseRestart();queueMicrotask(()=>void this.pump());}
  }
  private restartTarget(selector:RestartSelector|string={}):{pair:Pair|undefined;peer:Peer}{
    const input=typeof selector==='string'?{session_id:selector}:selector,sessionId=input.session_id;
    if(input.partner){
      if((input.native?.host??input.actor?.host)!=='claude')throw new BridgeError('partner_context_required','--partner 只能从搭档 Claude 的原生窗口执行，不能由 Codex 自重启或从外部终端选择其他配对。');
      const pair=this.targetPair({actor:input.actor,native:input.native}),caller=this.store.peer(pair.claude),peer=this.store.peer(pair.codex);
      if(!['root','fork'].includes(caller.kind)||input.actor?.via)throw new BridgeError('partner_context_required','仅独立的 Claude 主会话可重启当前搭档。');
      if(input.peer_id&&input.peer_id!==peer.id||input.pair_id&&input.pair_id!==pair.id||sessionId&&sessionId!==peer.sessionId)throw new BridgeError('session_changed','预检后的搭档或配对已经变化，未执行重启。');
      if(peer.owner!=='nxbridge')throw new BridgeError('unowned_runtime','当前搭档由用户窗口管理，不能由 AI 自动重启；请告知用户在原窗口恢复原会话。');
      if(!peer.sessionId||!['root','fork'].includes(peer.kind))throw new BridgeError('invalid_restart_target','当前搭档没有可恢复的独立 Codex 会话。');
      return{pair,peer};
    }
    const selected=sessionId?this.store.find('codex',sessionId):undefined;
    if(sessionId&&!selected)throw new BridgeError('session_missing','指定的 Codex 会话未登记，未选择其他配对。');
    const pair=selected?this.store.pairFor(selected.id):Object.keys(input).length||this.store.pairs().length?this.targetPair(input):undefined,peer=selected??(pair?this.store.peer(pair.codex):undefined);
    if(!peer?.sessionId)throw new BridgeError('session_missing','没有可选择的 Codex 会话；请通过 --session 指定已登记的原会话 ID。');
    if(!['root','fork'].includes(peer.kind))throw new BridgeError('invalid_restart_target','只能重启独立的 Codex 主会话或 fork，不能重启子代理。');
    return{pair,peer};
  }
  private async refreshCodexSubagents(root?:Peer,runtime?:Endpoint):Promise<void>{
    const peers=this.store.peers(),endpoints=this.store.endpoints();
    for(const peer of peers)if(peer.host==='codex'&&peer.kind==='subagent'&&this.enabled(peer.id))
      for(const endpoint of endpoints.filter(ep=>ep.peerId===peer.id&&ep.active&&ep.mode==='app-server'&&(!runtime||ep.address===runtime.address))){
                                           
        if((!runtime||!codexRuntimeEndpoint(endpoint,runtime))&&endpoint.pid&&endpoint.procStart&&await ownedProcessState({pid:endpoint.pid,startedAt:endpoint.procStart})==='dead'){
          const current=this.store.endpoints(peer.id).find(ep=>ep.epoch===endpoint.epoch&&ep.active&&ep.address===endpoint.address&&ep.pid===endpoint.pid&&ep.procStart===endpoint.procStart&&ep.runtimeId===endpoint.runtimeId);
          if(current){this.store.deactivate(peer.id,current.epoch);if(!this.store.endpoint(peer.id))this.store.updatePeer(peer.id,{state:'offline'});}
          continue;
        }
        if(root&&(!runtime||!codexRuntimeEndpoint(endpoint,runtime)||!codexRuntimeChild(root,peer,runtime,peers,endpoints)))continue;
        await this.pumpStage('subagent_observe:'+peer.id,()=>this.adapters.codex.observe(peer,endpoint));
      }
  }
  private codexRestartChildren(peer:Peer,runtime:Endpoint):Peer[]{
    const peers=this.store.peers(),endpoints=this.store.endpoints(),children=peers.filter(child=>child.id!==peer.id&&codexRuntimeChild(peer,child,runtime,peers,endpoints)),ids=new Set(children.map(child=>child.id));
    if(endpoints.some(ep=>ep.active&&ep.mode==='app-server'&&ep.address===runtime.address&&ep.peerId!==peer.id&&(!codexRuntimeEndpoint(ep,runtime)||!ids.has(ep.peerId))))
      throw new BridgeError('shared_runtime','这个后台还运行着另一个 Codex 会话，未执行重启。');
    return children;
  }
  private restartGuard(peer:Peer,endpoint:Endpoint,pair:Pair|undefined,checkDelivery=true,selector?:RestartSelector,options:{identityMigration?:boolean;beforeReconcile?:boolean;absent?:ReadonlySet<string>;verifiedUnknown?:ReadonlyMap<string,{attempts:number;updatedAt:number}>}={}):void{
    const {identityMigration=false,beforeReconcile=false,absent,verifiedUnknown}=options;
    this.requireEnabled(peer);
    if(this.takeovers.get(peer.id))throw new BridgeError('foreground_active','接管窗口仍在使用该后台，未重启。');
    if(selector?.partner){
      const selected=this.restartTarget(selector);
      if(selected.pair?.id!==pair?.id||selected.peer.id!==peer.id)throw new BridgeError('session_changed','当前 Claude 的搭档已经改变，未执行重启。');
      if(selected.pair!.paused)throw new BridgeError('pair_paused','当前配对已暂停，未执行自动重启。');
      if(this.store.peer(peer.id).state!=='ready')throw new BridgeError('session_busy','搭档尚未就绪，未执行重启。');
      if([selected.pair!.claude,peer.id].some(id=>this.store.bindings.current(id)?.transitioning||this.store.endpoint(id)?.pendingContext))throw new BridgeError('context_transition','配对窗口正在切换上下文，未执行重启。');
                                            
      const unsettled=this.store.partnerRestartUnsettled(selected.pair!.id,peer.id,verifiedUnknown,checkDelivery);
      if(unsettled)throw new BridgeError('delivery_unsettled',`发往目标 Codex 的消息 ${unsettled.id} 仍为 ${unsettled.state}，未执行重启。`);
      checkDelivery=false;
    }
    if(!identityMigration){
      const direct=this.codexDirect.status(peer.id),wake=this.codexWake.status(peer.id);
      if(direct?.attempts.length||direct?.continuation?.uncertain||wake?.attempts)throw new BridgeError('delivery_unsettled','目标仍有未确认的注入、续跑或唤醒预约，未执行重启；先核对宿主接收状态，不会自动重发。');
    }
    const current=this.store.peer(peer.id);
    if(this.stopped||current.owner!=='nxbridge'||current.sessionId!==peer.sessionId)throw new BridgeError('session_changed','会话归属或身份已经变化，未执行重启。');
    if(pair&&this.store.pairFor(peer.id)?.id!==pair.id)throw new BridgeError('session_changed','目标配对已经切换或解除，未执行重启。');
                                              
    const currentEndpoint=this.store.endpoint(peer.id)??(identityMigration?this.store.endpoints(peer.id).filter(value=>value.mode==='app-server').sort((a,b)=>b.seenAt-a.seenAt)[0]:undefined);
    if(!currentEndpoint||currentEndpoint.epoch!==endpoint.epoch||currentEndpoint.address!==endpoint.address||this.store.endpoints(peer.id).some(e=>e.active&&e.mode==='embedded'))throw new BridgeError('session_changed','目标端点已经变化或接入用户窗口，未执行重启。');
                                                   
    if(identityMigration?['paused','needsHuman'].includes(current.state):!['ready','paused'].includes(current.state))throw new BridgeError('session_busy','目标未处于空闲状态，未执行重启；不会中断任务、问题或审批。');
    if(this.store.questions(true).some(q=>q.from===peer.id||q.to===peer.id))throw new BridgeError('question_pending','目标有挂起问题，未执行重启；请先回答或升级当前问题。');
    const unsettled=!selector?.partner&&(checkDelivery||!identityMigration&&!beforeReconcile)?this.store.restartUnsettled(peer.id,identityMigration?absent:undefined,{verifiedUnknown,checkUnknown:checkDelivery}):undefined;
    if(unsettled)throw new BridgeError('delivery_unsettled',`消息 ${unsettled.id} 仍为 ${unsettled.state}，未执行重启；先核对宿主接收状态，不会自动重发。`);
    for(const child of this.codexRestartChildren(peer,endpoint)){
      if(this.store.endpoints(child.id).some(ep=>ep.active&&codexRuntimeEndpoint(ep,endpoint))&&!['ready','paused','offline'].includes(child.state))
        throw new BridgeError('subagent_active','Codex 还有子代理在运行，未执行重启；等它们结束后再试一次。');
      if(this.store.questions(true).some(question=>question.from===child.id||question.to===child.id))throw new BridgeError('question_pending','子代理有挂起问题，未执行重启；请先处理当前问题。');
      const direct=this.codexDirect.status(child.id),wake=this.codexWake.status(child.id),unsettled=this.store.subagentRestartUnsettled(child.id);
      if(direct?.attempts.length||direct?.continuation?.uncertain||wake?.attempts||unsettled)throw new BridgeError('delivery_unsettled','子代理仍有未确认的消息、输入或唤醒预约，未执行重启；先核对宿主接收状态，不会自动重发。');
    }
  }
  private async restartCodex(selector:RestartSelector={}):Promise<unknown>{
    const {pair,peer}=this.restartTarget(selector);
    if(peer.owner==='user')return{restarted:false,session_id:peer.sessionId,text:manualCodexRestart(peer)};
    if(this.memberLifecycle.isRestarting(peer.id))throw new BridgeError('restart_in_progress','目标会话正在重启，请勿重复提交。');
    const endpoint=this.store.endpoint(peer.id);
    if(!endpoint||endpoint.mode!=='app-server')throw new BridgeError('unowned_runtime','目标没有可核验的独立 App Server，未执行重启；请通过原生方式恢复原会话。');
    const verifiedUnknown=new Map<string,{attempts:number;updatedAt:number}>();
    const guard=(checkDelivery=true,beforeReconcile=false)=>this.restartGuard(peer,endpoint,pair,checkDelivery,selector,{verifiedUnknown,beforeReconcile});
    const verifyDelivery=async(thread:CodexThread)=>{
      guard(false);
      const unknown=this.store.reconcilable(peer.id).map(value=>this.store.message(value.id)).filter(message=>message.state==='unknown'&&(!selector.partner||message.pairId===pair!.id));
      if(!unknown.length)return;
      const absent=await this.verifyCodexRestartHistory(peer,thread,()=>guard(false));
      for(const message of unknown)if(absent.has(message.id))verifiedUnknown.set(message.id,{attempts:message.attempts,updatedAt:message.updatedAt});
    };
                                            
    await this.refreshCodexSubagents(peer,endpoint);guard(false,true);const releaseRestart=this.memberLifecycle.beginRestart(peer.id);
    try{
                                            
      await this.pumping;await this.memberLifecycle.preparation(peer.id);guard(false,true);
      await this.reconcile(peer.id);guard(false);
      const result=await this.adapters.codex.restart(peer,endpoint,guard,{requesterSession:codexRequester(this.store,peer),verifyDelivery});
      if(this.store.peer(peer.id).state==='paused')this.store.updatePeer(peer.id,{state:'ready'});
      this.store.deactivate(peer.id,endpoint.epoch);
      this.pairAnomalies.restarted(this.store.peer(peer.id));if(pair)this.runtimeHealth.refreshNoticeConditions(pair,'codex_restarted');
      this.memberLifecycle.clearBackoff(peer.id);
      this.store.event('codex.restarted',{peerId:peer.id,sessionId:peer.sessionId,oldPid:result.oldPid,pid:result.pid});
      const response={restarted:true,session_id:peer.sessionId,old_pid:result.oldPid,pid:result.pid,notes:result.notes??[],text:`Codex 已用新运行时恢复原会话 ${peer.sessionId}（进程 ${result.oldPid} → ${result.pid}）。历史、模型 ${result.resumed.model} 和推理强度 ${result.resumed.reasoningEffort??'默认'} 保持；后续调用加载当前 MCP、插件和技能。`+(result.notes?.length?'\n'+result.notes.join('\n'):'')};
      return response;
    }catch(error){
      if(error instanceof BridgeError&&error.code==='restart_incomplete')this.store.updatePeer(peer.id,{state:'paused',pauseReason:'restart_incomplete'});
      if(!(error instanceof BridgeError))throw new BridgeError('restart_verification_failed','无法完成宿主核验，未发出停止请求。原因：'+describeError(error));
      throw error;
    }finally{releaseRestart();queueMicrotask(()=>void this.pump());}
  }
  async dispatch(method:string,raw:unknown):Promise<unknown>{
    try{const result=await this.dispatchRequest(method,raw);this.recordModCall(method,raw);return result;}
    catch(error){this.recordModCall(method,raw,error);if(['hook','hook.client','hook.client.mcp','hook.client.claude'].includes(method))this.recordHookFailure(raw,error);throw error;}
  }
  private recordHookFailure(raw:unknown,error:unknown):void{
    if(!raw||typeof raw!=='object')return;
    const input=raw as Record<string,unknown>,event=(input.input??input) as Record<string,unknown>,sessionId=event.session_id;
    if(typeof sessionId!=='string')return;
    const detail=describeError(error),code=String((error as {code?:unknown})?.code??'hook_failed');
    if(['hook_identity_unavailable','process_identity_unknown','native_identity_unavailable'].includes(code))return;
    const key=typeof event.context_key==='string'?event.context_key:undefined;
    if(!key){process.stderr.write(`nxbridge hook failed (${code}): ${detail}\n`);return;}
    const candidates=this.store.peers().filter(peer=>{
      const endpoint=this.store.endpoint(peer.id),native=endpoint?.native??endpoint;
      return peer.sessionId===sessionId&&endpoint?.active&&key.startsWith(`${native?.pid}:${native?.procStart}:`);
    });
    for(const peer of candidates){
      const key='hookCallFailure:'+peer.id,previous=this.store.setting<{at:number;error:string}>(key);
      if(!previous||previous.error!==detail||Date.now()-previous.at>=60000){
        this.store.setSetting(key,{at:Date.now(),error:detail});
        this.store.event('hook.broker.failed',{peerId:peer.id,sessionId,event:event.hook_event_name,code});
        process.stderr.write(`nxbridge hook failed (${peer.id}, ${code}): ${detail}\n`);
      }
      this.pairAnomalies.integration(peer,{hookError:detail});
    }
  }
                                         
  private recordModCall(method:string,raw:unknown,error?:unknown):void{
    if(!raw||typeof raw!=='object')return;
    const input=raw as Record<string,unknown>,reported=modDiagnosticsSchema.safeParse(input.mod_diagnostics),questions=method==='register'?questionDiagnosticsSchema.safeParse(input.question_diagnostics):undefined;
    let operation=method==='observe'?'observe':method==='peer.state'?'state':method==='register'&&['observe','state'].includes(String(input.mod_operation))?String(input.mod_operation):undefined;
    if(!operation&&!reported.success&&!questions?.success)return;
    let sessionId:string|undefined,peerId:string|undefined,binding:Actor['binding'],reportedBinding:Actor['binding'];
    if(method==='register'){
      const parsed=registerSchema.safeParse(raw);if(!parsed.success)return;
      sessionId=parsed.data.sessionId;const window=registrationWindow(parsed.data),current=window?this.store.bindings.get(windowKey(window)):undefined;
      peerId=current?.peerId;if(current)binding={key:current.key,epoch:current.epoch};
      const expected=actorSchema.shape.binding.safeParse(input.expectedBinding);if(expected.success)reportedBinding=expected.data;
    }else{
      const parsed=actorSchema.safeParse(input.actor);if(!parsed.success)return;
      sessionId=parsed.data.sessionId;reportedBinding=parsed.data.binding;
      const current=reportedBinding?this.store.bindings.get(reportedBinding.key):undefined;peerId=current?.peerId??parsed.data.memberId;
      if(current)binding={key:current.key,epoch:current.epoch};
    }
    const context={peerId,sessionId,binding,reportedBinding};
    if(questions?.success&&questions.data.length)this.store.event('mod.question_source',{...context,trace:questions.data});
    if(reported.success){
      const key=peerId?'modReceiptDiagnostic:'+peerId:undefined,old=key?this.store.setting<{diagnostic:z.infer<typeof modDiagnosticsSchema>}>(key):undefined,last=old?.diagnostic.last_error;
      if(!last||last.at!==reported.data.last_error.at||last.op!==reported.data.last_error.op||last.code!==reported.data.last_error.code){
        this.store.event('mod.receipt.failure',{...context,diagnostic:reported.data});
      }
      if(key)this.store.setSetting(key,{...context,diagnostic:reported.data,reportedAt:Date.now()});
    }
    if(error&&operation)this.store.event('mod.rpc.rejected',{...context,method,operation,code:error instanceof BridgeError?error.code:error instanceof Error?error.name:'unknown'});
  }
  private async dispatchRequest(method:string,raw:unknown):Promise<unknown>{
    const actor=(raw as {actor?:Actor}|undefined)?.actor;
    if(actor&&!['status','member.switch'].includes(method)){
      const peer=this.store.resolve(actor);if(peer&&!this.enabled(peer.id)){
        const input=raw as Record<string,unknown>;
        if(method==='hook'&&input.hook_event_name==='UserPromptSubmit'&&isEmbeddedWake(input.prompt))return{continue:false};
        return{...this.offResult(peer),...(method==='receive'?{messages:[]}:{})};
      }
    }
    this.questions.sweep();
    this.syncLaunchPreferences();
    switch(method){
      case'hosting.status':{const p=targetSchema.extend({home:text.optional(),cwd:text.optional()}).strict().parse(raw??{}),peer=await this.hostingTarget(p);return{hosting:hostingStatus(this.store,peer)};}
      case'hosting.adopt':case'hosting.release':{
        const p=targetSchema.extend({home:text.optional(),cwd:text.optional(),terminal_origin:terminalOriginSchema.optional()}).strict().parse(raw??{});if(!p.terminal_origin)throw new BridgeError('user_terminal_required',HOSTING_TERMINAL_MESSAGE);await requireExternalTerminal(p.terminal_origin);
        const peer=await this.hostingTarget(p,method==='hosting.adopt');this.requireEnabled(peer);
        const result=method==='hosting.adopt'?await this.transfers.adopt(peer,p):await this.transfers.release(peer);queueMicrotask(()=>void this.pump());return result;
      }
      case'member.switch':{
        const p=z.object({actor:actorSchema,target:z.enum(['self','partner']),enabled:z.boolean(),user_requested:z.literal(true),origin:z.literal('composer').optional()}).strict().parse(raw),peer=this.actor(p.actor);
        if(p.actor.via||peer.sessionId!==p.actor.sessionId||!['root','fork'].includes(peer.kind))throw new BridgeError('subagent_denied','开关只接受用户明确要求的原生根窗口操作。');
        const pair=this.store.pairFor(peer.id),target=p.target==='self'?peer:pair?this.store.peer(pair[otherHost(peer.host)]):undefined;
        if(!target)throw new BridgeError('unpaired','没有可切换的搭档。');
        if(p.enabled&&p.origin!=='composer')throw new BridgeError('member_enable_human_required','开启必须由用户亲自输入：Claude /nxbridge on [codex|claude|self]，Codex nxbridge on [codex|claude|self]；或在独立终端运行 nxbridge on <宿主> --member <成员 ID>。');
        return this.switchMember(target,p.enabled);
      }
      case'member.switch.terminal':{
        const p=targetSchema.extend({host,enabled:z.boolean(),terminal_origin:terminalOriginSchema.optional()}).strict().parse(raw);
        await requireExternalTerminal(p.terminal_origin);
        const peer=p.peer_id?this.store.peer(p.peer_id):p.session_id?this.store.find(p.host,p.session_id):this.store.peer(this.targetPair(p)[p.host]);
        if(!peer||peer.host!==p.host)throw new BridgeError('target_mismatch','目标成员与指定宿主不符。');return this.switchMember(peer,p.enabled);
      }
      case'launch.status':return launchStatus(this.home,this.config);
      case'launch.capture':{
        const capture=z.object({host,sessionId:text,nativePid:z.number().int().positive(),nativeGeneration:text,sourcePid:z.number().int().positive(),sourceGeneration:text,env:z.record(z.string(),z.string()),force:z.boolean().optional()}).parse(raw);
        const matches=this.store.peers().filter(p=>p.host===capture.host&&p.sessionId===capture.sessionId&&this.store.endpoints(p.id).some(e=>{const native=e.native??e;return native.pid===capture.nativePid&&native.procStart===capture.nativeGeneration;})),peer=matches.length===1?matches[0]:undefined;if(!peer||!this.enabled(peer.id)||!['root','fork'].includes(peer.kind))return{captured:false};
                                                              
        const owned=peer.owner==='nxbridge'||ownedProcesses(this.home).records.some(record=>record.identity.pid===capture.nativePid&&record.identity.startedAt===capture.nativeGeneration)||nativeOwnershipRecords(this.home).some(record=>record.native?.pid===capture.nativePid&&record.native.startedAt===capture.nativeGeneration);
        const endpoint=this.store.endpoint(peer.id);if(endpoint?.daemon){const observation=await captureDaemonLaunch(this.home,peer,endpoint);this.memberLifecycle.launchInputsChanged(peer.id);if(observation)queueMicrotask(()=>void this.pump());return{captured:!!observation,kind:'daemon'};}
        const result=await this.captureLaunch(this.home,capture,peer,endpoint?.pid,{owned});
                                                 
        const current=this.store.endpoint(peer.id);
        if(this.enabled(peer.id)&&endpoint&&current?.epoch===endpoint.epoch&&current.bindingEpoch===endpoint.bindingEpoch&&this.store.peer(peer.id).sessionId===peer.sessionId)this.store.saveEndpoint({...current,configHome:result.configHome,...(result.profile?{launchProfileId:result.profile.id}:{})});
        if(!result.cached){this.memberLifecycle.launchInputsChanged(peer.id);this.store.event('launch.capture',{peerId:peer.id,owned:result.owned,profile:result.profile?profileMetadata(result.profile):null});queueMicrotask(()=>void this.pump());}
        return{captured:!!result.profile,owned:result.owned};
      }
      case'ping':if(this.stopped)throw new BridgeError('stopping','协调器正在关闭，请等待新实例就绪。');return{version:VERSION,pid:process.pid,...(this.store.faults.status().some(row=>row.degraded)?{degraded:this.store.faults.status().filter(row=>row.degraded)}:{}),...(this.origin?{origin:this.origin}:{}),...(this.runtime?{runtime:this.runtime}:{})};
      case'config.model':{const p=z.object({actor:actorSchema,input:modelConfigurationSchema}).strict().parse(raw),session=this.configurationSession(p.actor);return this.configuration.model(session,p.input);}
      case'config.human.refused':{
        const p=z.object({actor:actorSchema,origin:z.string().max(64),surfaces:z.array(z.string().max(64)).max(8),command:z.enum(['config','pair','switch']).optional()}).strict().parse(raw),peer=this.actor(p.actor);
        this.store.event('config.human.refused',{peerId:peer.id,sessionId:peer.sessionId,origin:p.origin,surfaces:p.surfaces,command:p.command??'config'});return{recorded:true};
      }
      case'config.human':{
        const p=z.object({actor:actorSchema,origin:z.literal('composer'),args:z.array(z.string())}).strict().parse(raw);
        if(p.actor.host!=='claude')throw new BridgeError('config_human_origin_required','此入口仅接受 Claude 原生输入框命令。');
        const session=this.configurationSession(p.actor);return this.configuration.human(session,p.args);
      }
      case'register':{
        const input=registerSchema.extend(profileSchema.shape).extend({ownedLaunch:z.object({peerId:z.string().uuid(),launchId:z.string().uuid()}).optional(),endpoint:registerSchema.shape.endpoint.extend({nativeHealth:nativeHealthSchema.optional(),modVersion:z.string().min(1).max(100).optional(),modRevision:z.string().regex(/^[a-f0-9]{16}$/).optional(),nativePermission:z.object({permission:z.enum(['prompting','bypass','unknown']),mode:z.string().max(64).optional(),observedAt:z.number().finite().nonnegative()}).optional(),nativeDecision:nativeDecisionSchema.optional(),nativeAutoMode:nativeAutoModeSchema.optional(),nativeBackground:nativeBackgroundSchema.optional(),nativeInbound:nativeInboundSchema.extend({permission:z.enum(['prompting','bypass','unknown']).optional()}).optional(),nativeProfile:nativeProfileSchema.optional()}),expectedBinding:actorSchema.shape.binding,boundaryStartedAt:z.number().finite().optional(),mcpInteraction:z.literal(true).optional()}).parse(raw);
        const peer=await this.register(input);if(input.mcpInteraction&&peer.host==='claude'&&this.enabled(peer.id)){this.pairAnomalies.integration(peer,{mcp:true});const pair=this.store.pairFor(peer.id);if(pair)this.pairAnomalies.observe(pair,peer,this.runtimeHealth.peerHealth(peer),this.communicationTips.syncReminder(peer,this.config.syncTipMinutes),'mcp_register');}return peer;
      }
      case'mod.read.open':{
        const p=z.object({actor:actorSchema,credential:z.unknown()}).strict().parse(raw);
        const receipt=bindModReadReceipt(this.home,p.credential,p.actor.sessionId,p.actor.binding),{peer,endpoint}=this.modReadPeer(p.actor,receipt);
        return this.modReads.open(receipt,{...p.actor,memberId:peer.id},endpoint.epoch);
      }
      case'window.pending':{
        const p=z.object({window:z.object({host:z.literal('codex'),configHome:text,pid:z.number().int().positive(),procStart:text}),cwd:text,sessionId:z.string().uuid().optional(),bridge:processSchema}).strict().parse(raw);
        const disabled=disabledMember(this.home,{...p.window,sessionId:p.sessionId});if(disabled)return memberOffResultFor({host:disabled.host,id:disabled.peerId});
        if((await probeProcesses([p.window]))[0]!=='alive')throw new BridgeError('process_identity_unknown','启动窗口的进程代次尚未核验，未加入候选。');
        return registerPendingCodex(this.store,p);
      }
      case'mcp.register':{
        const {context_key,...registration}=mcpRegisterSchema.parse(raw),input:RegisterInput={...registration,...(context_key?{hookContextKey:context_key}:{})};
                                                 
        if(input.host==='codex'){
          const child=this.store.peers().find(peer=>peer.host==='codex'&&peer.sessionId===input.sessionId&&peer.kind==='subagent');
          if(child){input.kind='subagent';input.parentId=child.parentId??undefined;}
        }
        const disabled=this.disabledRegistration(input);if(disabled)return disabled;
        const owned=await managedCodexRegistration(this.store,this.home,input,(runtime,id)=>this.adapters.codex.inspectThread(runtime,id));if(owned)return owned;
        const managedCodexChecked=input.host==='codex';
        if(input.endpoint.daemon){
          const endpoint=input.endpoint;
          if(input.host!=='codex'||!endpoint.configHome||!endpoint.pid||!endpoint.procStart)throw new BridgeError('unverified_identity','daemon 登记缺少原生进程与配置目录。');
          const prior=this.store.bindings.get(windowKey({host:'codex',configHome:endpoint.configHome,pid:endpoint.pid,procStart:endpoint.procStart,threadId:input.sessionId}));
          const verified=await this.daemons.registration(endpoint.configHome,{pid:endpoint.pid,procStart:endpoint.procStart},input.sessionId,input.contextStart);
          return this.register({...verified,permission:input.permission,replyContract:input.replyContract,hookContextKey:context_key,...(prior?.active?{boundaryStartedAt:input.boundaryStartedAt}:{}),contextStart:input.contextStart,contextReason:input.contextReason,endpoint:{...verified.endpoint,...(endpoint.codexPermission?{codexPermission:endpoint.codexPermission}:{}),daemon:{...verified.endpoint.daemon!,...(endpoint.daemon!.sandbox?{sandbox:endpoint.daemon!.sandbox}:{}),...(endpoint.daemon!.approval?{approval:endpoint.daemon!.approval}:{}),...(endpoint.daemon!.autoReview===undefined?{}:{autoReview:endpoint.daemon!.autoReview})},...(endpoint.bridge?{bridge:endpoint.bridge}:{})}});
        }
        const sameSession=this.store.peers().filter(p=>p.host===input.host&&p.sessionId===input.sessionId);
        await this.restoreOwnedCodexIngress(input,sameSession);
                                                                    
        if(input.host==='codex'&&input.endpoint.mode==='embedded'&&input.endpoint.processKind===undefined&&sameSession.some(p=>!this.store.bindings.current(p.id)&&this.store.endpoints(p.id).some(e=>{const native=e.native??e;return e.active&&e.mode==='app-server'&&native.pid===input.endpoint.pid&&native.procStart===input.endpoint.procStart&&native.pid&&native.procStart;})))input.endpoint.processKind='app-server';
        const window=registrationWindow(input),bound=window?this.store.bindings.get(windowKey(window)):undefined;
        const matches=sameSession.filter(p=>input.endpoint.processKind!=='app-server'||!this.store.bindings.current(p.id)&&this.store.endpoints(p.id).some(e=>{const native=e.native??e;return native.pid===input.endpoint.pid&&native.procStart===input.endpoint.procStart;}));
        let existing=bound?.active?this.store.peer(bound.peerId):matches.length===1?matches[0]:undefined;
        if(!existing&&input.endpoint.processKind==='app-server'){
                                                      
          const routes=sameSession.filter(p=>!this.store.bindings.current(p.id));
          if(routes.length===1&&this.store.endpoints(routes[0]!.id).some(e=>e.active&&e.mode==='app-server'&&!(e.native??e).pid))existing=routes[0];
          else if(routes.length)throw new BridgeError('ambiguous_context','无法将原生调用唯一关联到现有 App Server 路由，请重新加载插件并核对运行时。');
        }
        if(existing&&!window&&this.store.endpoints(existing.id).some(e=>e.mode==='app-server'&&e.active)){
          const endpoint=this.store.endpoint(existing.id)!;
                                                                         
          if(input.host==='codex'&&input.endpoint.mode==='embedded'&&input.endpoint.pid&&input.endpoint.procStart)this.configurationWindows.set(existing.id,{epoch:endpoint.epoch,pid:input.endpoint.pid,procStart:input.endpoint.procStart});
          if(input.host==='codex'&&input.endpoint.mode==='embedded'&&input.endpoint.pid&&input.endpoint.procStart)this.store.saveEndpoint(observeCodexPermission({...endpoint,native:{pid:input.endpoint.pid,procStart:input.endpoint.procStart},...(input.endpoint.bridge?{bridge:input.endpoint.bridge}:{})},existing.sessionId,input.endpoint.codexPermission??{},'mcp'));
          if(input.replyContract===1)this.store.adoptReplyContract(existing.id,'mcp');
          if(input.endpoint.codexPermission&&input.endpoint.pid&&input.endpoint.procStart){const permission=daemonPermission(this.store.endpoint(existing.id)!.codexPermission??{});if(permission!=='unknown')this.store.updatePeer(existing.id,{permission});}
          else if(input.permission&&input.permission!=='unknown')this.store.updatePeer(existing.id,{permission:input.permission});return this.store.peer(existing.id);
        }
        return this.register(input,{managedCodexChecked});
      }
      case'context.end':{const p=z.object({actor:actorSchema,reason:z.enum(['reset','switch','fork','unknown']).optional()}).parse(raw);const ended=this.store.endContext(p.actor,p.reason);if(ended&&p.actor.binding)this.modReads.revoke(p.actor.binding);return{ended};}
      case'context.lookup':{
        const p=z.object({host,configHome:text,pid:z.number().int().positive(),procStart:text,session_id:text,threadId:text.optional(),boundary_started_at:z.number().finite()}).parse(raw),binding=this.store.bindings.get(windowKey(p));
        if(!binding?.active||binding.transitioning||binding.sessionId!==p.session_id||!this.store.bindings.acceptsBoundary(binding,p.session_id,p.boundary_started_at))return{};
        return{binding:{key:binding.key,epoch:binding.epoch}};
      }
      case'peer.state':return this.peerState(z.object({actor:actorSchema,state:z.enum(['ready','busy','needsHuman','offline','paused'])}).extend(profileSchema.shape).parse(raw));
      case'peer.prompt':{
        const p=z.object({actor:actorSchema}).parse(raw),peer=this.actor(p.actor);
        if(p.actor.sessionId!==peer.sessionId)throw new BridgeError('subagent_denied','子代理不能恢复根会话。');
        this.finalForwards.human(peer);this.store.updatePeer(peer.id,{state:'busy',activityAt:Date.now()});queueMicrotask(()=>void this.pump());return{resumed:true};
      }
      case'ref.expand':{const p=z.object({actor:actorSchema,text}).parse(raw);return{text:this.references.expand(this.actor(p.actor),p.text)};}
      case'tip.agent':{const p=z.object({actor:actorSchema,text}).parse(raw),peer=this.actor(p.actor);return{tip:this.runtimeHealth.communicationTip(peer,p.text,'agent',p.actor)};}
      case'tip.sync':{
        const p=z.object({actor:actorSchema,usage:z.object({tokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),observedAt:z.number().finite().nonnegative()}).optional(),compaction:z.object({id:z.string().min(1).max(256),at:z.number().finite().nonnegative()}).optional()}).parse(raw),peer=this.actor(p.actor);
        if(p.actor.sessionId!==peer.sessionId||p.actor.via)return{};
        if(p.compaction)this.communicationTips.cooperation.compacted(peer,p.compaction.id,p.compaction.at);
        if(p.usage)this.communicationTips.cooperation.usage(peer,{tokens:p.usage.tokens,at:p.usage.observedAt});
        return{tip:!providerBlocked(this.runtimeHealth.peerHealth(peer))?this.communicationTips.syncTip(peer,this.config.syncTipMinutes):undefined};
      }
      case'mod.reload.attempt':{
        const p=z.object({actor:actorSchema,attempt_id:z.string().uuid(),target_revision:z.string().regex(/^[a-f0-9]{16}$/)}).parse(raw),peer=this.actor(p.actor);
        if(peer.host!=='claude'||peer.sessionId!==p.actor.sessionId||p.actor.via)throw new BridgeError('subagent_denied','自动重新加载只接受 Claude 根会话。');
        return recordReloadAttempt(this.store,peer.id,p.attempt_id,p.target_revision);
      }
      case'ref.capture':{const p=z.object({actor:actorSchema,agent_id:text,text}).parse(raw),peer=this.actor(p.actor);if(peer.sessionId!==p.actor.sessionId)throw new BridgeError('subagent_denied','最终答案必须由根会话登记。');this.references.capture(peer,p.agent_id,p.text);return{recorded:true};}
      case'question.create':{const p=z.object({actor:actorSchema,questions:z.unknown(),turn_id:z.string().optional(),tool_use_id:z.string().optional(),task_message_id:z.string().optional()}).parse(raw),{sender,pair}=this.pairedSender(p.actor);if(sender.host==='claude'){if(!p.task_message_id)throw new BridgeError('unknown_turn_source','缺少可核验的 Codex 任务来源。');this.questionOrigin(sender,p.task_message_id);}const value=this.questions.create(pair,sender,p.actor,p);queueMicrotask(()=>void this.pump());return value;}
      case'question.origin':{const p=z.object({actor:actorSchema,message_id:text}).parse(raw);return this.questionOrigin(this.actor(p.actor),p.message_id);}
      case'question.get':case'question.wait':case'question.cancel':{const p=z.object({actor:actorSchema,request_id:text,form_lease:text.optional()}).parse(raw),peer=method==='question.cancel'?this.partnerActor(p.actor):this.actor(p.actor);return method==='question.wait'?this.questions.wait(peer,p.request_id):method==='question.cancel'?this.questions.cancel(peer,p.request_id,p.form_lease):this.questions.view(peer,p.request_id);}
      case'question.cancel_turn':{const p=z.object({actor:actorSchema,turn_id:z.string().optional()}).parse(raw),peer=this.partnerActor(p.actor);for(const q of this.store.questions(true))if((q.from===peer.id&&(!p.turn_id||q.turnId===p.turn_id))||(q.to===peer.id&&q.status==='awaiting_user'))this.questions.cancel(peer,q.id);return{cancelled:true};}
      case'question.answer':case'question.answer_user':{const p=z.object({actor:actorSchema,input:z.unknown(),form_lease:text.optional()}).parse(raw);const value=this.questions.answer(this.partnerActor(p.actor),p.actor,p.input,method==='question.answer_user',p.form_lease);queueMicrotask(()=>void this.pump());return value;}
      case'send':return this.runtimeHealth.trackHealth(this.sendWithHealth(z.object({actor:actorSchema,message:text,in_reply_to:z.string().optional(),auto_reply_to:z.string().optional(),auto_reply_text:z.string().optional(),reply_expected:z.boolean().optional()}).parse(raw)));
      case'pair.selection.get':case'pair.selection.refresh':{const p=z.object({actor:actorSchema,selection_id:text}).parse(raw),peer=this.actor(p.actor);await this.syncPendingWindows();if(method==='pair.selection.refresh'){await this.refreshDeletedHistory(peer);refreshRestoreObservations(this.store);}return method==='pair.selection.refresh'?this.store.selections.refresh(p.actor,p.selection_id,this.config):this.store.selections.view(p.actor,p.selection_id,this.config);}
      case'pair.selection.commit':return this.selectionResolver.commitSelection(raw);
      case'partner.profile':return this.partnerProfile(raw);
      case'pair.selection.resolve':return this.selectionResolver.resolveSelection(raw);
      case'pair.code':{const p=z.object({actor:actorSchema}).parse(raw),peer=this.actor(p.actor);if(!['root','fork'].includes(peer.kind)||p.actor.via)throw new BridgeError('subagent_denied','只有当前原生主窗口可以打开搭档选择。');await this.syncPendingWindows();await this.refreshDeletedHistory(peer);refreshRestoreObservations(this.store);return this.store.selections.create(peer,p.actor,this.config);}
      case'pair.code.commit':{const p=z.object({actor:actorSchema,code:z.string().regex(/^\d{4}$/),origin:z.literal('composer')}).parse(raw);if(p.actor.host!=='claude')throw new BridgeError('pairing_human_origin_required','此入口只接受 Claude 原生输入框。');return this.pairCode(p.actor,p.code);}
      case'pair.inventory':await this.syncPendingWindows();return{pairs:this.store.pairs().map(pair=>({...pair,claude:this.store.peer(pair.claude),codex:this.store.peer(pair.codex)})),members:this.store.selections.inventory(),previous_partners:this.store.selections.previousPartners()};
      case'pair.restore':{const p=z.object({pair_id:text}).strict().parse(raw);return this.restoreLostPair(p.pair_id);}
      case'health.monitor':return this.runtimeHealth.trackHealth(this.monitorSession(raw).catch(error=>{throw preSubmitError(error,'health.monitor','prepare');}));
      case'status':{const p=z.object({actor:actorSchema.optional(),model_view:z.boolean().optional()}).parse(raw??{}),status=this.status(p.actor) as Record<string,unknown>;if(!p.actor){const [retirements,launches,processes]=await Promise.all([retirementViews(this.home,this.store.setting<Record<string,RetirementRecord>>('processRetirements')??{}),verifiedLaunchStatus(this.home,this.config),processOwnershipSummary(this.home)]);(status.capabilities as Record<string,unknown>).retirements=retirements;return{...status,launches,processes};}return p.model_view&&p.actor?modelStatus(status):status;}
      case'receive':{
        const actor=actorSchema.parse(raw),result=this.receive(actor) as Record<string,unknown>;
        if(result.status==='paused'||result.status==='automatic'||result.status==='held'&&result.partner_profile)return result;
        const notices=await this.runtimeHealth.prepareNotices(actor);
        const receiver=this.actor(actor);
        if(!this.store.pendingCount(receiver.id)){this.codexWake.clear(receiver.id);this.pairAnomalies.integration(receiver,{pickup:null});}
        return{...result,...(notices.length?{notices:notices.map(n=>({notice_id:n.id,source:n.source??'runtime_monitor',message:n.message}))}:{})};
      }
      case'checkpoint':{const p=z.object({actor:actorSchema,input:z.unknown()}).strict().parse(raw);return this.recovery.checkpoint(p.actor,p.input);}
      case'messages.pending-hint':{
        const {hint_deadline,...actor}=actorSchema.extend({hint_deadline:z.number().finite().optional()}).parse(raw),peer=this.store.resolve(actor);
        if(!peer||!['root','fork'].includes(peer.kind)||actor.via||!this.enabled(peer.id))return{};
        const turn=actor.turnId??this.store.setting<string>('communicationTurn:'+peer.id);
        if(!turn||!this.store.pendingCount(peer.id)||hostingGate(this.store,peer)||['paused','needsHuman'].includes(peer.state)||this.store.setting('pendingHintTurn:'+peer.id)===turn||hint_deadline!==undefined&&Date.now()>=hint_deadline)return{};
        this.store.setSetting('pendingHintTurn:'+peer.id,turn);return{pending_inbound:WAKE_NOTICE};
      }
      case'recovery.facts':{const p=z.object({actor:actorSchema,include_messages:z.boolean().optional(),message_ids:z.array(z.string().min(1).max(128)).optional()}).strict().parse(raw);return this.recovery.facts(p.actor,{includeMessages:p.include_messages,messageIds:p.message_ids});}
      case'messages.read':{
        const p=readMessagesSchema.extend({actor:actorSchema}).parse(raw),peer=this.store.resolve(p.actor);
        if(!peer)throw new BridgeError('unregistered','当前会话尚未登记。');
        if(peer.kind==='unknown')throw new BridgeError('unverified_identity','尚未核验独立主会话身份，不能读取历史消息。');
        if(!['root','fork'].includes(peer.kind)||p.actor.via)throw new BridgeError('subagent_denied','历史消息入口只接受当前根窗口。');
        return readMessages(this.store,peer,{message_ids:p.message_ids});
      }
      case'events':{const p=z.object({after:z.number().int().nonnegative().default(0)}).parse(raw??{});return this.store.events(p.after);}
      case'message':{const p=z.object({message_id:text}).parse(raw);return this.store.message(p.message_id);}
      case'pair':{const p=z.object({claude:text,codex:text,replace:z.boolean().default(false)}).parse(raw),scope=this.store.pairFor(p.claude)?.id??this.store.pairFor(p.codex)?.id??'admin';return this.changePair(async()=>{
        const restoring=[p.claude,p.codex].map(id=>this.store.peer(id)).filter(peer=>peer.owner==='nxbridge'&&!!peer.sessionId&&!this.store.pairFor(peer.id)&&(peer.state==='offline'||!this.store.endpoint(peer.id)));
        for(const peer of restoring)await this.memberLifecycle.assertNoLiveSessionHolder(peer);
        const result=this.store.transaction(()=>{
          for(const peer of restoring)if(!restorableOwnedPartner(this.store,this.store.peer(peer.id),undefined,true))throw new BridgeError('pair_restore_unavailable','无法核验原后台会话，配对没有改变；请检查原配置目录与会话历史。');
          const old=[this.store.pairFor(p.claude),this.store.pairFor(p.codex)].filter((v):v is Pair=>!!v),pair=this.store.pair(p.claude,p.codex,p.replace);
          const changes=old.filter((value,index)=>value.id!==pair.id&&old.findIndex(other=>other.id===value.id)===index).map(value=>settleChangedPair(this.store,value));
          authorizeDaemonWake(this.store,pair,'terminal');
          for(const previous of old)if(previous.id!==pair.id)for(const id of [previous.claude,previous.codex])this.questions.cancelPeer(id);
          const release=this.memberLifecycle.queueRetirements([...new Set(old.flatMap(p=>[p.claude,p.codex]))].filter(id=>id!==pair.claude&&id!==pair.codex));
          return{pair,release,cancelled_message_ids:changes.flatMap(value=>value.cancelled_message_ids),uncertain_message_ids:changes.flatMap(value=>value.uncertain_message_ids)};
        });
        this.background('retirements',()=>this.memberLifecycle.releaseOwned(result.release));
        if(restoring.length)await this.resumeRestoredPair(result.pair);
        let delivery:unknown={...result.pair,...(restoring.length?{restored_members:restoring.map(peer=>({member_id:peer.id,host:peer.host,name:peer.name,session_id:peer.sessionId}))}:{}),cancelled_message_ids:result.cancelled_message_ids,uncertain_message_ids:result.uncertain_message_ids,...(result.release.length?{releasePending:result.release}:{})};
        for(const id of [result.pair.claude,result.pair.codex]){const peer=this.store.peer(id);if(peer.owner==='nxbridge')delivery=await this.selectionDelivery(delivery,peer);}return delivery;
      },scope,[p.claude,p.codex]);}
      case'pause':{const pair=this.targetPair(raw);this.store.setPaused(true,pair.id);this.questions.sweep();return{paused:true,pair_id:pair.id};}
      case'reload':{this.applyConfiguration();return{reloaded:true};}
      case'runtime.retire':{
        const {peer_id}=z.object({peer_id:z.string().uuid()}).strict().parse(raw),peer=this.store.peer(peer_id);
        if(peer.owner!=='nxbridge'||this.store.pairFor(peer.id))throw new BridgeError('runtime_in_use','只允许回收已解除配对、由 nxbridge 启动的成员；活动配对或用户窗口保持运行。');
        this.requireEnabled(peer);const pending=this.store.setting<Record<string,{attempts:number;nextAt:number;error?:string}>>('processRetirements')??{};
        pending[peer.id]={attempts:0,nextAt:0};this.store.setSetting('processRetirements',pending);
        const notes=await this.memberLifecycle.releaseOwned([peer.id]);if(!notes.length)return{released:true,notes};
        const retired=await retireUnconfirmedContainers(this.home,{peerId:peer.id,protectedPeers:this.store.peers().filter(value=>value.owner==='user'||!!this.store.pairFor(value.id)).map(value=>value.id),protectedEndpoints:this.store.peers().filter(value=>value.owner==='user'||!!this.store.pairFor(value.id)).flatMap(value=>this.store.endpoints(value.id)),guard:(ids,endpoints)=>{const protectedPeers=this.store.peers().filter(value=>value.owner==='user'||!!this.store.pairFor(value.id));if(protectedPeers.some(value=>ids.includes(value.id)||this.store.endpoints(value.id).some(endpoint=>endpoint.active&&endpoints.includes(endpoint.address))))throw new BridgeError('runtime_in_use','成员已经重新配对或交给用户窗口，未撤销容器归属。');}});
        if(retired.peerIds.includes(peer.id)){
          const pending=this.store.setting<Record<string,RetirementRecord>>('processRetirements')??{};delete pending[peer.id];this.store.setSetting('processRetirements',pending);this.store.deactivate(peer.id);this.store.updatePeer(peer.id,{state:'offline'});this.store.event('release.unconfirmed_retired',{peerId:peer.id});return{released:true,unconfirmedContainersRetired:true,notes:retired.notes};
        }
        return{released:false,notes:[...notes,...retired.notes]};
      }
      case'resume':{const pair=this.targetPair(raw);this.store.setPaused(false,pair.id);for(const id of [pair.claude,pair.codex]){const p=this.store.peer(id);if(p.state==='paused'||(!p.sessionId&&p.host==='claude'&&p.owner==='nxbridge'))this.store.updatePeer(id,{state:p.sessionId?'ready':'starting'});}void this.pump();return{paused:false,pair_id:pair.id};}
      case'unpair':{if(this.dismissLostPair(raw))return{unpaired:true,dismissed:true};const selected=this.targetPair(raw);return this.changePair(async()=>{const result=this.store.transaction(()=>{const changes=settleChangedPair(this.store,selected),pair=this.store.unpair(selected.id);if(pair)for(const id of [pair.claude,pair.codex])this.questions.cancelPeer(id);return{...changes,release:this.memberLifecycle.queueRetirements(pair?[pair.claude,pair.codex]:[])};});this.background('retirements',()=>this.memberLifecycle.releaseOwned(result.release));return{unpaired:true,cancelled_message_ids:result.cancelled_message_ids,uncertain_message_ids:result.uncertain_message_ids,...(result.release.length?{releasePending:result.release}:{})};},selected.id,[selected.claude,selected.codex]);}
      case'retry':{const p=z.object({message_id:text}).parse(raw),m=this.store.message(p.message_id);if(m.state!=='unknown')throw new BridgeError('not_uncertain','仅允许人工重试 unknown 消息。');this.store.transition(m.id,'accepted','用户显式要求重试，目标可能已经收到原消息');return{queued:true};}
      case'doctor.current':return this.diagnosticContext(raw);
      case'hosting.resolve':{
        const p=z.object({session_id:text,home:text,loaded_only:z.boolean().optional()}).strict().parse(raw),runtime=p.loaded_only?await this.adapters.codex.loadedRuntime(p.session_id,p.home):undefined;
        if(p.loaded_only&&!runtime)return{};
        if(runtime?.peerId&&(!this.store.pairFor(runtime.peerId)||this.memberLifecycle.isRetiring(runtime.peerId)||this.store.setting<Record<string,unknown>>('processRetirements')?.[runtime.peerId]))return{unavailable:'此会话刚解除配对或仍在后台收尾，尚不能打开。请稍等几秒再运行 codex resume '+p.session_id+'，或用 nxbridge status 查看状态。'};
        const matches=this.store.peers().filter(peer=>peer.host==='codex'&&peer.sessionId===p.session_id&&this.store.pairFor(peer.id)&&this.store.endpoints(peer.id).some(ep=>ep.configHome&&sameDirectory(ep.configHome,p.home)&&(!runtime||ep.address===runtime.endpoint)));
        if(matches.length>1)throw new BridgeError('ambiguous_context','同一会话有多个活动成员，请用 nxbridge open/release --member 指定。');const peer=matches[0];return{...(runtime?{endpoint:runtime.endpoint}:{}),...(peer?{member_id:peer.id,owner:peer.owner,cwd:peer.cwd,hosting:hostingStatus(this.store,peer)}:{})};
      }
      case'codex.endpoint':{const p=z.object({cwd:text.optional(),session_id:text.optional(),home:text.optional()}).parse(raw??{});return{endpoint:await this.adapters.codex.ensureEndpoint(p.cwd,undefined,undefined,p.session_id,p.home)};}
      case'codex.foreground.started':{const p=z.object({endpoint:text,session_id:text.optional(),foreground:processSchema}).strict().parse(raw);this.codexForeground.register({endpoint:p.endpoint,sessionId:p.session_id,foreground:p.foreground});if(p.session_id)this.store.setSetting(codexForegroundEndKey(p.endpoint,p.session_id),null);return{registered:true};}
      case'codex.foreground.prepare':{const p=z.object({endpoint:text,session_id:text,cwd:text,home:text}).strict().parse(raw);this.store.setSetting(codexForegroundEndKey(p.endpoint,p.session_id),null);await this.adapters.codex.resumeForeground(p.endpoint,p.home);return{ready:true};}
      case'codex.foreground.end':{
        const p=z.object({endpoint:text,session_id:text.optional(),foreground:processSchema}).strict().parse(raw);
                                                   
        await this.codexForeground.end({endpoint:p.endpoint,sessionId:p.session_id,foreground:p.foreground});await Promise.all(this.codexSubscriptionChecks.values());
        return{closed:true};
      }
      case'codex.connect':{const p=z.object({endpoint:text,bearerToken:z.string().optional()}).parse(raw);await this.adapters.codex.connect(p.endpoint,p.bearerToken);return{connected:true};}
      case'codex.restart':{
        const p=restartSchema.extend({request_id:text.optional(),broker_pid:z.number().int().positive().optional(),broker_generation:text.optional()}).strict().parse(raw??{});
        try{
          if((p.broker_pid!==undefined||p.broker_generation!==undefined)&&(p.broker_pid!==process.pid||p.broker_generation!==this.runtime?.generation))throw new BridgeError('broker_changed','协调器在核验后发生变化，未停止 Codex；请在外部终端重试。');
          const response=await this.restartCodex(p);if(p.request_id)this.store.event('codex.restart.result',{requestId:p.request_id,response});return response;
        }
        catch(error){if(p.request_id)this.store.event('codex.restart.result',{requestId:p.request_id,error:{code:error instanceof BridgeError?error.code:'internal',message:describeError(error),...(error instanceof DeliveryError?{uncertain:error.uncertain}:{})}});throw error;}
      }
      case'codex.restart.target':{
        const p=restartSchema.strict().parse(raw??{}),{pair,peer}=this.restartTarget(p);
        if(peer.owner==='nxbridge'){
          if(this.memberLifecycle.isRestarting(peer.id))throw new BridgeError('restart_in_progress','目标会话正在重启，请勿重复提交。');
          const endpoint=this.store.endpoint(peer.id);if(!endpoint||endpoint.mode!=='app-server')throw new BridgeError('unowned_runtime','目标没有可核验的独立 App Server，未执行重启；请通过原生方式恢复原会话。');
                                             
          await this.refreshCodexSubagents(peer,endpoint);
          this.restartGuard(peer,endpoint,pair,false,p);
        }
        const endpoint=this.store.endpoint(peer.id);
        return{owner:peer.owner,session_id:peer.sessionId,peer_id:peer.id,pair_id:pair?.id,runtime:endpoint?.pid&&endpoint.procStart?{pid:endpoint.pid,procStart:endpoint.procStart}:undefined,broker:{pid:process.pid,generation:this.runtime?.generation,windowsIndependent:this.runtime?.windowsIndependent},...(peer.owner==='user'?{text:manualCodexRestart(peer)}:{})};
      }
      case'codex.restart.result':{
        const p=z.object({request_id:text}).strict().parse(raw),outcome=this.store.restartResult(p.request_id);
        if(outcome?.error)throw new DeliveryError(outcome.error.code,outcome.error.message,outcome.error.uncertain);
        if(outcome&&Object.hasOwn(outcome,'response'))return outcome.response;
        throw new BridgeError('restart_result_missing','没有此请求的完成记录；未自动重复重启，请先检查 status。');
      }
      case'codex.recover':{const p=targetSchema.extend({turn_id:text.optional(),preview:z.boolean().default(false),request_id:text.optional(),terminal_origin:terminalOriginSchema.optional()}).strict().parse(raw??{});return this.recoverTurn(p.turn_id,p.preview,p.request_id,p,p.terminal_origin);}
      case'partner.recover':{
        const p=recoverPartnerSchema.extend({actor:actorSchema}).parse(raw),caller=this.actor(p.actor),pair=this.store.pairFor(caller.id);
        if(p.actor.via||!['root','fork'].includes(caller.kind))throw new BridgeError('subagent_denied','仅当前配对的主窗口可申请搭档恢复。');
        if(!pair||pair.paused)throw new BridgeError('unpaired','当前窗口没有可恢复的活动搭档。');
        const peer=this.store.peer(pair[otherHost(caller.host)]);this.requireEnabled(caller);this.requireEnabled(peer);
        const incident=this.managedRecovery.get(peer.id);
        if(!incident)return{incident:null,...(peer.owner==='user'?{user_step:'nxbridge status'}:{})};
        if(incident.pairId!==pair.id||incident.sessionId!==peer.sessionId||p.incident_id&&p.incident_id!==incident.id)throw new BridgeError('incident_changed','配对或恢复事件已经改变，请重新查看状态。');
        if(p.action==='retry'){
          if(claudeAutoHolds(this.store,peer))throw new BridgeError('claude_start_pending','权限恢复尚未结算，未用托管恢复覆盖原生副本启动记录。');
          if(!p.incident_id||!p.reason)throw new BridgeError('invalid_arguments','额外恢复需要原事件 ID 和记录原因。');
          if(peer.owner!=='nxbridge')throw new BridgeError('process_owned_by_user','用户窗口只能由用户恢复。');
          if(!incident.attempts.some(row=>row.extra))await this.memberLifecycle.recover(peer,p.reason);
        }
        return{incident:this.managedRecovery.get(peer.id),recovery:this.memberLifecycle.recoveryStatus(this.store.peer(peer.id))};
      }
      case'codex.recover.result':{const p=z.object({request_id:text}).strict().parse(raw),saved=this.store.setting<any>('codexRecovery:'+p.request_id);if(saved?.request_id!==p.request_id)throw new BridgeError('recovery_result_missing','找不到这次恢复请求的记录；没有重复中断，请用 nxbridge status 核对 Codex 状态。');return saved;}
      case'open.candidates':{
        const p=z.object({cwd:text}).strict().parse(raw),candidates=this.store.pairs().flatMap(pair=>{
          const peer=this.store.peer(pair.codex),partner=this.store.peer(pair.claude),endpoint=this.store.endpoint(peer.id);
          return sameDirectory(partner.cwd,p.cwd)&&this.enabled(peer.id)&&this.enabled(partner.id)&&peer.owner==='nxbridge'&&peer.state==='needsHuman'&&peer.sessionId&&endpoint?.active&&endpoint.mode==='app-server'&&!endpoint.daemon&&endpoint.pid&&endpoint.procStart?[{peer,partner,endpoint}]:[];
        });
        const states=await probeProcesses(candidates.map(row=>({pid:row.endpoint.pid!,procStart:row.endpoint.procStart!})));
        return{candidates:candidates.filter((_,index)=>states[index]==='alive').map(({peer,partner})=>({member_id:peer.id,name:peer.name,partner_name:partner.name,session_id:peer.sessionId,cwd:peer.cwd}))};
      }
      case'open':{
        const p=z.object({host,interrupt:z.boolean().default(false),request_id:text.optional(),terminal_origin:terminalOriginSchema.optional(),controller:processSchema.optional()}).parse(raw),pair=this.targetPair(raw);let peer=this.store.peer(pair[p.host]);this.requireEnabled(peer);
        if(this.memberLifecycle.isRestarting(peer.id))throw new BridgeError('restart_in_progress','目标会话正在重启，请稍后打开。');
        const releaseRestart=p.host==='claude'?this.memberLifecycle.beginRestart(peer.id):undefined;
        try{
        const old=this.takeovers.get(peer.id);if(old&&!await this.memberLifecycle.returnTakeover(peer.id,old.id))throw new BridgeError('foreground_active','已有接管窗口，请返回该窗口。');
        const auto=claudeAutoStatus(this.store,peer);
        if(auto?.phase==='ready'&&!auto.mode_checked)this.store.setSetting(claudeAutoKey(peer.id),{...this.store.setting<ClaudeAutoFallback>(claudeAutoKey(peer.id))!,mode_checked:true});
        if(auto&&auto.phase!=='ready'&&auto.phase!=='resolved'){
          const value=this.store.setting<ClaudeAutoFallback>(claudeAutoKey(peer.id))!,proof=nativeOwnership(this.home,peer.id);
          if(value.session_id===peer.sessionId)this.store.setSetting(claudeAutoKey(peer.id),{...value,phase:'resolved',error:undefined});
          else if(value.source&&!proof){
            const native=value.source.native;
            if(!native||ownedProcesses(this.home).records.some(record=>record.peerId===peer.id&&record.role==='claude-native')||(await probeProcesses([{pid:native.pid,procStart:native.startedAt}]))[0]!=='dead')throw new BridgeError('process_identity_unknown','原后台退出和新启动记录尚未核验，请运行 nxbridge doctor；未恢复旧会话。');
            saveNativeOwnership(value.source);this.store.setSetting(claudeAutoKey(peer.id),{...value,phase:'resolved',error:undefined});
          }else if(value.source&&proof?.id!==value.source.id){
            const discovered=await this.adapters.claude.manualCopyRegistration(peer);
            if(!discovered)throw new BridgeError('claude_start_pending','副本启动身份尚未核验；请运行 nxbridge doctor 检查原生后台清单，未恢复旧会话。');
            this.memberLifecycle.completeClaudeAuto(peer,discovered,value);peer=this.store.peer(peer.id);
          }else this.store.setSetting(claudeAutoKey(peer.id),{...value,phase:'resolved',error:undefined});
        }
        if(p.terminal_origin&&await isExternalTerminal(p.terminal_origin))this.managedRecovery.authorize(peer.id,p.request_id??randomUUID());
        const child=p.host==='claude'?claudeChild(this.home,peer.id):undefined;
        if(child?.phase==='user')throw new BridgeError('claude_foreground_active','Claude 已由前台窗口接管，请返回该窗口。');
        if(child?.phase!=='handoff'&&(!this.store.endpoint(peer.id)||peer.state==='offline'||!peer.sessionId))await this.memberLifecycle.prepare(peer);peer=this.store.peer(peer.id);
        if(this.store.pairFor(peer.id)?.id!==pair.id)throw new BridgeError('session_changed','打开期间配对已改变，未接管。');
        const result=p.host==='claude'&&claudeChild(this.home,peer.id)?await this.openClaudeChild(peer,p.interrupt) as any:{peer,endpoint:this.store.endpoint(peer.id),...(p.host==='claude'&&peer.sessionId?{handle:await this.adapters.claude.handle(peer.sessionId)}:{})};
        const lease=peer.owner==='nxbridge'?this.takeovers.begin(peer,result.endpoint,result.handoffId,p.controller,result.handle):undefined;return{...result,...(lease?{leaseId:lease.id}:{})};
        }finally{releaseRestart?.();}
      }
      case'open.claim':{
        const p=z.object({peer_id:text,session_id:text,handoff_id:text.optional(),lease_id:text.optional(),foreground:processSchema.optional()}).parse(raw),peer=this.store.peer(p.peer_id);
        if(peer.sessionId!==p.session_id)throw new BridgeError('session_changed','接管会话已经改变。');
        if(p.lease_id&&p.foreground){if((await probeProcesses([p.foreground]))[0]!=='alive')throw new BridgeError('process_identity_unknown','接管窗口代次无法核验。');this.takeovers.claim(peer.id,p.lease_id,p.foreground);}
        else if(peer.owner==='nxbridge')throw new BridgeError('takeover_required','接管需要本次临时控制记录，未永久转交后台归属。');
        if(p.handoff_id)childHandoff(this.home,peer.id,'user',p.handoff_id);return this.store.peer(peer.id);
      }
      case'open.return':{const p=z.object({peer_id:text,session_id:text,handoff_id:text.optional(),lease_id:text,foreground_ended:z.boolean().optional()}).parse(raw);return{returned:await this.memberLifecycle.returnTakeover(p.peer_id,p.lease_id,p.foreground_ended===true)};}
      case'hook.client':return this.clientHook(raw);
      case'hook.client.mcp':return this.clientHook(raw,'codex',true);
      case'hook.client.claude':return this.clientHook(raw,'claude');
      case'hook.client.ack':{
        const {receipt}=z.object({receipt:z.string().uuid()}).strict().parse(raw),pending=this.hookReceipts.get(receipt);
        if(pending){this.hookReceipts.delete(receipt);clearTimeout(pending.timer);await pending.ack();}return{};
      }
      case'hook':return this.hook(z.record(z.string(),z.unknown()).parse(raw));
      case'observe':{
        const p=z.object({actor:actorSchema,message_id:text,state:z.enum(['observed','runtimeQueued','contextObserved','held','refused']),admission:z.literal('approval_required').optional()}).parse(raw),peer=this.actor(p.actor),m=this.store.message(p.message_id);
        if(m.to!==peer.id)throw new BridgeError('receipt_target','观察回执不属于当前会话。');
        if(p.state==='observed'){this.store.event('message.observed',{messageId:m.id,peerId:peer.id});this.claudeInbound.received(peer,m,p.admission);}
        else this.store.transition(m.id,p.state,'目标宿主插件报告');
        if(['contextObserved','runtimeQueued','refused'].includes(p.state))this.claudeInbound.resolved(m);
        if(p.state==='contextObserved')this.communicationTips.partnerReceived(peer,m);
        return{recorded:true};
      }
      default:throw new BridgeError('unknown_method',`不支持的操作：${method}`);
    }
  }
  private questionOrigin(peer:Peer,id:string):unknown{
    const message=this.store.message(id),pair=this.store.pairFor(peer.id);
    if(peer.host!=='claude'||!pair||message.pairId!==pair.id||message.to!==peer.id||message.from!==pair.codex)throw new BridgeError('unknown_turn_source','消息不是当前已配对 Codex 发给本 Claude 会话的任务。');
    return{message_id:message.id,body:this.references.message(message)};
  }
  private async openClaudeChild(peer:Peer,interrupt:boolean):Promise<unknown>{
    const home=this.home;let child=claudeChild(home,peer.id)!;
    const releaseRestart=this.memberLifecycle.beginRestart(peer.id);
    try{
      if(this.pumping)await this.pumping;
      if(child.phase==='active')child=await childCall(home,child,'status');
      if(child.phase==='user')throw new BridgeError('claude_foreground_active','Claude 已由前台窗口接管。');
      const current=this.store.peer(peer.id),health=this.runtimeHealth.claudeHealth(current,child);
      if(child.phase!=='handoff'&&!interrupt&&!child.human&&current.state!=='needsHuman'&&(current.state==='busy'||health&&!['ready','failed','needsHuman'].includes(health.state)))throw new BridgeError('claude_turn_busy','Claude 仍在工作；运行 nxbridge open claude --interrupt 先中断再接管。');
      const handoffId=child.phase==='handoff'&&child.handoffId?child.handoffId:randomUUID(),stopped=await stopClaudeChild(home,child,handoffId);
      this.store.deactivate(peer.id);this.questions.cancelPeer(peer.id);this.store.updatePeer(peer.id,{state:'needsHuman'});this.store.event('claude.handoff',{peerId:peer.id,sessionId:peer.sessionId});
      return{peer:this.store.peer(peer.id),mode:'child',handoffId,resume:stopped.hasSession,modelProfile:stopped.modelProfile,notice:'正在接管原会话。尚未完成的审批或问题已由原生中断拒绝，请在前台重新提出需要执行的操作。'};
    }finally{releaseRestart();}
  }
  private peerState(p:{actor:Actor;state:PeerState;model?:string|null;effort?:string|number|null}):Peer{
    const peer=this.actor(p.actor);
    if(p.actor.sessionId!==peer.sessionId)throw new BridgeError('subagent_denied','子代理不能改写根会话状态。');
    if(peer.host==='claude'&&p.state==='busy'&&(!['busy','needsHuman'].includes(peer.state)||!this.store.setting('claudeTurnStart:'+peer.id)))this.store.setSetting('claudeTurnStart:'+peer.id,Date.now());
    if(p.state==='offline'||p.state==='paused')this.questions.cancelPeer(peer.id);
    if(p.state==='offline'){
      this.configuration.cancel(p.actor);this.store.deactivate(peer.id);
                                                 
    }
    const profile=runtimeProfile(peer,p),updated=this.store.updatePeer(peer.id,{state:peer.state==='paused'&&p.state!=='offline'?'paused':p.state,model:profile.model,effort:profile.effort});this.profiles.observed(updated,p);return updated;
  }
  private changePair<T>(work:()=>Promise<T>,scope='admin',members:string[]=[]):Promise<T>{
    if(this.stopped)return Promise.reject(new BridgeError('stopping','协调器正在关闭，未切换配对。'));
    if(members.some(id=>this.memberLifecycle.isRetiring(id)))return Promise.reject(new BridgeError('peer_releasing','所选旧成员仍在回收，请稍后重新配对。'));
    const scopes=[...new Set(members.flatMap(id=>this.changingMembers.get(id)?.scope??[]))];
    if(scopes.length>1)return Promise.reject(new BridgeError('pair_changing','所选窗口分别正在切换配对，请等待完成后重试。'));
    scope=scopes[0]??scope;
    for(const id of members)this.changingMembers.set(id,{scope,count:(this.changingMembers.get(id)?.count??0)+1});
    this.pairChanges++;
    const next=(this.lifecycle.get(scope)??Promise.resolve()).catch(()=>{}).then(()=>{if(members.some(id=>this.memberLifecycle.isRetiring(id)))throw new BridgeError('peer_releasing','所选旧成员仍在回收，配对没有改变。');return work();}).finally(()=>{this.pairChanges--;for(const id of members){const current=this.changingMembers.get(id)!;if(--current.count===0)this.changingMembers.delete(id);}if(this.lifecycle.get(scope)===next)this.lifecycle.delete(scope);});
    this.lifecycle.set(scope,next);return next;
  }
                                               
  private async clientHook(raw:unknown,host:Host='codex',mcp=false):Promise<unknown>{
    if(this.stopped)throw new BridgeError('stopping','协调器正在关闭。');
    const claude=host==='claude'?claudeHookClientSchema.parse(raw):undefined,mcpInput=mcp?mcpHookClientSchema.parse(raw):undefined,p=claude??mcpInput??hookClientSchema.parse(raw);
                                                
    if(!path.isAbsolute(p.config_home)||process.platform==='win32'&&/^(?:\\\\|\/\/)/.test(p.config_home))throw new BridgeError('hook_identity_unavailable','此配置目录须由 hook 进程直接核验。');
    const event=z.string().parse(p.input.hook_event_name),sessionId=z.string().min(1).parse(p.input.session_id),home=this.home;
                                                       
    let input:any={...p.input,session_id:sessionId,cwd:p.input.cwd??p.cwd};delete input.actor;delete input.context_key;delete input.nxbridge_timing;
    const deadline=performance.now()+Math.max(1,(host==='codex'&&['SessionEnd','Interrupt'].includes(event)?2300:9000)-Math.max(0,Date.now()-p.started_at));
    const began=performance.now();
    const execution:HookExecution={home,configHome:p.config_home,startedAt:p.started_at,deadline,elapsedMs:p.elapsed_ms,call:async<T>(method:string,params:unknown)=>{remainingTime(deadline,2000);return await this.dispatch(method,params) as T;}};
    const nativeIdentity=async(pid:number,timeout=2000)=>{
      this.hookIdentity??=new WindowsIdentitySession(home);return this.hookIdentity.read(pid,timeout,true,host);
    };
    if(host==='codex')execution.runtime=await codexProcessIdentity(remainingTime(deadline,2000),p.hook_pid,process.platform==='win32'?async(pid,_home,_host,timeout)=>nativeIdentity(pid,timeout):undefined,true);
    else execution.claude={identity:await claudeIdentity(sessionId,{pid:p.hook_pid,home:p.config_home,skipOrigin:true,timeout:remainingTime(deadline,2000),readNative:()=>nativeIdentity(p.hook_pid,remainingTime(deadline,2000))}),address:claude?.messaging_socket,configHome:p.config_home,ownedLaunch:claude?.owned_launch};
    if(mcpInput){
      const native=execution.runtime!;
      const known=this.store.peers().filter(peer=>peer.host==='codex'&&peer.sessionId===sessionId&&['root','fork'].includes(peer.kind)&&this.store.endpoints(peer.id).some(endpoint=>{const identity=endpoint.native??endpoint;return endpoint.active&&identity.pid===native.pid&&identity.procStart===native.procStart&&endpoint.configHome&&sameDirectory(endpoint.configHome,p.config_home);}));
      input=await codexHookContext(input,mcpInput.thread_id,known.length===1);
                                                
      if(input.agent_id)return{output:{}};
    }
    execution.identityMs=performance.now()-began;
    let acknowledge:(()=>Promise<void>)|undefined;
    let output:unknown;
    try{output=await executeHook(host,input,ack=>{acknowledge=ack;},execution);}
    catch(error){throw new DeliveryError('hook_execution_failed',describeError(error),(error as {uncertain?:boolean}).uncertain===true);}
    let receipt:string|undefined;
    if(acknowledge){receipt=randomUUID();const key=receipt,timer=setTimeout(()=>this.hookReceipts.delete(key),10000);timer.unref();this.hookReceipts.set(receipt,{ack:acknowledge,timer});}
    return{output,...(input.nxbridge_disabled?{disabled:true}:{}),...(receipt?{receipt}:{})};
  }
  private async hook(p:Record<string,unknown>):Promise<unknown>{
    const id=z.string().parse(p.session_id),event=z.string().parse(p.hook_event_name),actor:Actor=p.actor?actorSchema.parse(p.actor):{host:'codex',sessionId:id,callId:randomUUID()};
                                                            
    if(!actor.memberId&&!actor.binding&&typeof p.context_key==='string'){
      const key=p.context_key,candidates=this.store.peers().filter(peer=>peer.host===actor.host&&peer.sessionId===id&&this.store.endpoints(peer.id).some(endpoint=>{
        const native=endpoint.native??endpoint;return endpoint.active&&!!native.pid&&!!native.procStart&&hookContextMatches(key,id,{pid:native.pid,procStart:native.procStart});
      }));
      if(candidates.length>1)throw new BridgeError('ambiguous_context','同一原生代次对应多个活动会话，hook 未执行。');
      if(candidates.length===1)actor.memberId=candidates[0]!.id;
    }
    const peer=this.store.resolve(actor);
                                                   
    if(peer&&this.enabled(peer.id)&&typeof p.context_key==='string'&&!p.agent_id&&!p.agent_transcript_path&&!actor.via&&['root','fork'].includes(peer.kind)&&actor.host==='codex'&&actor.sessionId===id){
      const key='hookContext:'+p.context_key;
      if(this.store.setting(key)===undefined){
      const binding=this.store.bindings.validate(actor);let native:{pid:number|null;procStart:string|null}|undefined=binding;
      if(!native&&!this.store.bindings.current(peer.id))try{const endpoint=this.store.endpoint(peer.id);if(endpoint?.active)native=endpoint.native??endpoint;}catch(error){if((error as {code?:string}).code!=='ambiguous_endpoint')throw error;this.store.warnHookContext(p.context_key,id,event,'ambiguous_endpoint',peer.id);}
      if(native?.pid&&native.procStart&&hookContextMatches(p.context_key,id,{pid:native.pid,procStart:native.procStart})){
        this.store.transaction(()=>{this.store.setSetting(key,id);this.store.event('hook.context.recovered',{peerId:peer.id,sessionId:id,event});});
      }
      }
    }
    if(peer&&!this.enabled(peer.id))return event==='UserPromptSubmit'&&isEmbeddedWake(p.prompt)?{continue:false}:{};
    if(peer&&this.store.bindings.current(peer.id)&&!actor.binding){this.store.warnHookContext(typeof p.context_key==='string'?p.context_key:undefined,id,event,'missing_binding',peer.id);return{};}
    if(event==='UserPromptSubmit'&&!p.agent_id&&!p.agent_transcript_path&&typeof p.prompt==='string'&&/^\s*nxbridge\s+pair(?:\s|$)/.test(p.prompt)){
      let reason:string;
      try{
        const binding=this.store.bindings.validate(actor);
        if(!binding||typeof p.context_key!=='string'||!p.context_key.startsWith(binding.pid+':'+binding.procStart+':')||this.store.setting('hookContext:'+p.context_key)!==id)throw new BridgeError('unverified_identity','配对码必须由当前已登记的原生主窗口输入。');
        if(/^\s*nxbridge\s+pair\s*$/.test(p.prompt)){
          if(!peer||!['root','fork'].includes(peer.kind)||actor.via)throw new BridgeError('subagent_denied','只有原生主窗口可以选择搭档。');
          this.store.updatePeer(peer.id,{state:'busy',activityAt:Date.now()});
          return{hookSpecificOutput:{hookEventName:event,additionalContext:'User requested the native partner picker. Call claude.choose_partner now; user selects in the native form. Do not send partner messages or perform other task work. Current pairing stays unless user explicitly changes it. After the tool returns, briefly report the result; pick_in_chat -> discuss candidates with user and use select_partner only after their explicit choice.'}};
        }
        const match=/^\s*nxbridge\s+pair\s+(\d{4})\s*$/.exec(p.prompt);
        if(!match)throw new BridgeError('pairing_code_invalid','输入 nxbridge pair 打开搭档选择，或输入 nxbridge pair 和四位配对码。');
        const result=await this.pairCode(actor,match[1]!) as {requester_name:string;message_id?:string};
        reason='已与 Claude 窗口「'+result.requester_name+'」配对。'+(result.message_id?'对方的消息已送出。':'');
      }catch(error){reason=describeError(error);}
      return{decision:'block',reason};
    }
    if(event==='UserPromptSubmit'&&!p.agent_id&&!p.agent_transcript_path&&typeof p.prompt==='string'&&/^\s*nxbridge\s+config\s+(?:pending|confirm)(?:\s|$)/.test(p.prompt)){
      let reason:string;
      try{
        const match=/^\s*nxbridge config (pending|confirm(?: ([a-f0-9]{16})))\s*$/.exec(p.prompt);
        if(!match)throw new BridgeError('invalid_arguments','请完整输入提案给出的 nxbridge config confirm 确认行。');
        const session=this.configurationSession(actor);
        if(!peer||typeof p.context_key!=='string'||!p.context_key.startsWith(session.window+':')||this.store.setting('hookContext:'+p.context_key)!==id)throw new BridgeError('config_context_unverified','确认不是当前已登记的原生根窗口输入，请重新加载并信任 nxbridge hooks 后再提出变更。');
        if(match[1]==='pending')reason='待确认的配置变更：\n'+JSON.stringify(this.configuration.pending(session),null,2);
        else{const result=this.configuration.confirm(session,match[2]!) as {notice:string};reason=result.notice;}
      }catch(error){reason=describeError(error);}
                                                                   
      return{decision:'block',reason};
    }
    const tool=p.tool_input as Record<string,unknown>|undefined;
    const expand=event==='PreToolUse'&&typeof p.tool_name==='string'&&/(?:^|[._]|^collaboration)spawn_agent$/.test(p.tool_name)&&typeof tool?.message==='string'&&tool.message.includes('nxref:');
    const deny=(reason:string)=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:referenceDeny(reason)}});
    if(!peer){this.store.warnHookContext(typeof p.context_key==='string'?p.context_key:undefined,id,event,'unregistered');return expand?deny('root session not registered'):{};}
    if(typeof p.context_key==='string'){
      const key='hookContext:'+p.context_key;
      if(this.store.setting(key)!==id){this.store.warnHookContext(p.context_key,id,event,this.store.setting(key)===undefined?'missing':'mismatch',peer.id);return expand?deny('root context unverified'):{};}
    }
    if(event==='SubagentStop'&&typeof p.agent_id==='string'){
      if(typeof p.last_assistant_message==='string'&&p.last_assistant_message.trim()){
        this.references.capture(peer,p.agent_id,p.last_assistant_message);
        if(typeof p.agent_path==='string')this.references.capture(peer,p.agent_path,p.last_assistant_message);
      }
      this.subagentCompletions.record(peer,p.agent_id,p.turn_id,p.agent_path,p.transcript_path);
      queueMicrotask(()=>void this.pump());
      return{};
    }
    if(expand){
      try{return{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...tool,message:this.references.expand(peer,tool!.message as string)}}};}
      catch(error){return deny(modelError(error).message);}
    }
    if(p.agent_id||p.agent_transcript_path)return{};
    const completionContext=event==='UserPromptSubmit'?this.subagentCompletions.context(peer):undefined;
    if(event==='SessionStart'&&p.source!=='compact'||event==='UserPromptSubmit'&&typeof p.prompt==='string'&&p.prompt.trim()&&!isEmbeddedWake(p.prompt))this.daemons.nativeInteraction(peer);
    const wakeContexts:string[]=[];
    if(event==='UserPromptSubmit'&&isEmbeddedWake(p.prompt)){
      this.wakeSignals.consumed(peer.id);
      this.subagentCompletions.started(peer,true);
      const pair=this.store.pairFor(peer.id);
      const discard=()=>{this.store.event('wake.discarded',{peerId:peer.id,sessionId:id});return{continue:false};};
      if(!this.subagentContextAllowed(peer,true))return discard();
                                                 
      if(this.subagentCompletions.available(peer))this.store.updatePeer(peer.id,{state:'busy'});
      if(!this.store.pendingCount(peer.id)){
        const notices=await this.runtimeHealth.prepareNotices(actor,undefined,true,true);
        if(!this.subagentContextAllowed(peer,true)||!notices.length&&!this.subagentCompletions.available(peer))return discard();
        if(notices.length)wakeContexts.push('nxbridge: runtime health facts only; no partner message pickup required',...notices.map(runtimeNoticeText));
      }
    }
    const timing=z.object({identityMs:z.number().nonnegative(),registrationMs:z.number().nonnegative(),elapsedBeforeBrokerMs:z.number().nonnegative()}).safeParse(p.nxbridge_timing);
    this.store.setSetting('lastHook',{peerId:peer.id,event,at:Date.now(),...(typeof p.turn_id==='string'?{turnId:p.turn_id}:{}),...(timing.success?{timing:timing.data}:{})});
    this.store.setSetting('hookCallFailure:'+peer.id,null);
    this.pairAnomalies.integration(peer,{hookSeen:true,...(event==='SessionStart'?{sessionStart:true as const}:{}),...(event==='UserPromptSubmit'?{nativeInput:true as const}:{})});
    const recoveredInterrupt=event==='Interrupt'&&this.recoveredCodexInterrupt(peer,p.turn_id);
    if(event==='Interrupt'&&!recoveredInterrupt){this.questions.cancelPeer(peer.id);this.store.updatePeer(peer.id,{state:'paused',pauseReason:'interrupted'});}
    if(event==='SessionEnd'){this.configuration.cancel({host:'codex',sessionId:id});this.store.endContext(actor);return{};}
    if(event==='UserPromptSubmit'){
      this.store.setSetting('communicationTurn:'+peer.id,randomUUID());
      this.foregroundHealth.observe(peer,'start',typeof p.turn_id==='string'?p.turn_id:undefined);
      this.store.updatePeer(peer.id,{state:'busy',...(!isEmbeddedWake(p.prompt)&&typeof p.prompt==='string'&&p.prompt.trim()?{activityAt:Date.now()}:{})});queueMicrotask(()=>void this.pump());
    }
    const nativeTurnId=typeof p.turn_id==='string'?p.turn_id:undefined,toolId=typeof p.tool_use_id==='string'?p.tool_use_id:undefined;
    if(typeof p.transcript_path==='string'){
      const endpoint=this.runtimeEndpoint(peer.id);if(endpoint)this.deletedSessions.observe(peer,endpoint,p.transcript_path);
      const known=this.store.setting<{sessionId:string;file:string}>('codexTranscript:'+peer.id);
      if(known?.sessionId!==peer.sessionId||known.file!==p.transcript_path)this.store.setSetting('codexTranscript:'+peer.id,{sessionId:peer.sessionId,file:p.transcript_path});
    }
    if(event==='PreToolUse')this.foregroundHealth.observe(peer,'tool_start',nativeTurnId,toolId,!String(p.tool_name).endsWith('receive_messages'));
    if(event==='PostToolUse')this.foregroundHealth.observe(peer,'tool_end',nativeTurnId,toolId,!String(p.tool_name).endsWith('receive_messages'),p.tool_response,typeof p.tool_name==='string'?p.tool_name:undefined);
    if(event==='PermissionRequest')this.foregroundHealth.observe(peer,'human',nativeTurnId,toolId);
    if(event==='Interrupt'&&!recoveredInterrupt)this.foregroundHealth.observe(peer,'paused',nativeTurnId);
    if(event==='Stop'){
      this.subagentCompletions.settle(peer,p.transcript_path,nativeTurnId);
      this.foregroundHealth.observe(peer,'ready',nativeTurnId);
      queueMicrotask(()=>void this.pump());
    }
    const permission=p.permission_mode;
    if(typeof p.model==='string'){const profile=runtimeProfile(peer,{model:p.model});this.store.updatePeer(peer.id,{model:profile.model,effort:profile.effort});}
    if(typeof permission==='string'&&codexHookApproval(permission)!=='unknown'){
      const endpoint=this.store.endpoint(peer.id);
      if(endpoint){const observed=observeCodexPermission(endpoint,peer.sessionId,{approval:codexHookApproval(permission)},'native-hook');this.store.saveEndpoint(observed);this.store.updatePeer(peer.id,{permission:daemonPermission(observed.codexPermission??{})});}
    }
    await this.runtimeHealth.refreshCodexPermission(peer,p.transcript_path);
    if(event==='PostToolUse'&&typeof p.tool_name==='string'&&p.tool_name.endsWith('receive_messages')){
      for(const id of receivedIds(p.tool_response))try{const m=this.store.message(id);if(m.to===peer.id&&['unknown','runtimeQueued'].includes(m.state)){this.store.transition(m.id,'contextObserved','宿主 PostToolUse 确认取件输出进入上下文');this.communicationTips.partnerReceived(peer,m);}}catch{}
    }
    const contexts:string[]=[...wakeContexts];
    if(event==='UserPromptSubmit'){
      const synthetic=isEmbeddedWake(p.prompt);
      if(synthetic&&(!this.subagentContextAllowed(peer,true)||this.subagentCompletions.context(peer)!==completionContext))return{continue:false};
      if(this.subagentContextAllowed(peer,synthetic)){const completion=this.subagentCompletions.consume(peer,completionContext);if(completion)contexts.push(completion);}
    }
    if(event==='UserPromptSubmit'&&typeof p.prompt==='string'&&/^\s*nxbridge\s+(?:pickup|收信)\s*$/i.test(p.prompt)){
      contexts.push('nxbridge pickup trigger: collect pending partner messages with receive_messages. This trigger grants no approvals and supplies no selection or task answer. If the inbox is empty, report that fact without starting another task.');
      this.store.event('message.pickup.requested',{peerId:peer.id,sessionId:peer.sessionId});
    }
    if(event==='SessionStart'&&['compact','resume'].includes(String(p.source))&&this.store.pairFor(peer.id)){
      const messageIds=z.array(z.string().min(1).max(128)).optional().parse(p.nxbridge_compacted_message_ids);
      const recovery=this.recovery.facts(actor,{includeMessages:p.source==='compact',messageIds});if(recovery)contexts.push(recovery.text);
    }
    if(['PostToolUse','UserPromptSubmit'].includes(event)&&!hostingGate(this.store,this.store.peer(peer.id))&&this.store.pendingCount(peer.id)&&!['paused','needsHuman'].includes(this.store.peer(peer.id).state))contexts.push(WAKE_NOTICE);
    if(event==='PostToolUse'&&!providerBlocked(this.runtimeHealth.peerHealth(peer))){const tip=this.communicationTips.syncTip(peer,this.config.syncTipMinutes);if(tip)contexts.push(tip);}
    if(contexts.length)return{hookSpecificOutput:{hookEventName:event,additionalContext:contexts.join('\n')}};
    return{};
  }
}

function receivedIds(response:any):string[]{
  if(typeof response==='string'){try{return receivedIds(JSON.parse(response));}catch{return[];}}
  if(!response||typeof response!=='object')return[];
  if(Array.isArray(response.messages))return response.messages.map((m:any)=>m?.message_id).filter((id:unknown)=>typeof id==='string');
  return Array.isArray(response.content)?response.content.filter((c:any)=>c.type==='text').flatMap((c:any)=>receivedIds(c.text)):[];
}

