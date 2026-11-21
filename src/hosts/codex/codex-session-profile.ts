import { createReadStream, globSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {BridgeError} from '../../shared/errors.js';
import type { RpcClient } from '../../ipc/rpc.js';
import {delay} from '../../shared/time.js';

export interface SessionPolicy {
  source:'persisted'|'conservative';sandbox:unknown;approval:unknown;reviewer:unknown;
  unknown:string[];narrowed:{rule:string;effect:string}[];reason?:'policy_unknown'|'policy_partial';
}
export interface SessionProfile {
  sessionId:string;file?:string;offset:number;settingsOffset?:number;complete:boolean;verified:boolean;meta:Record<string,any>;settings:Record<string,any>;
  live?:Record<string,any>;livePermissionConfig?:Record<string,unknown>;
  turn?:{id:string;state:'running'|'ready'|'paused';at:number};
  usage?:{inputTokens:number;at:number};
  compaction?:{id:string;at:number};
}
interface Cache extends SessionProfile {dev:number;ino:number;size:number;mtime:number;invalid:boolean}
const caches=new Map<string,Cache>();
const fields={model:'model',model_provider:'modelProvider',model_provider_id:'modelProvider',approval_policy:'approvalPolicy',approvals_reviewer:'approvalsReviewer',permission_profile:'permissionProfile',sandbox_policy:'sandbox',cwd:'cwd',runtime_workspace_roots:'runtimeWorkspaceRoots',effort:'reasoningEffort',reasoning_effort:'reasoningEffort',collaboration_mode:'collaborationMode',service_tier:'serviceTier',disabled_plugin_ids:'disabledPluginIds'} as const;

                                            
export async function readSessionProfile(file:unknown,sessionId:string):Promise<SessionProfile>{
  const empty=():SessionProfile=>({sessionId,offset:0,complete:true,verified:false,meta:{},settings:{}});
  if(typeof file!=='string'||!file)return empty();
  const key=JSON.stringify([file,sessionId]);let stream:ReturnType<typeof createReadStream>|undefined;
  try{
    const stat=statSync(file);let cache=caches.get(key);
    if(cache&&!cache.invalid&&cache.dev===stat.dev&&cache.ino===stat.ino&&cache.size===stat.size&&cache.mtime===stat.mtimeMs)return structuredClone(cache);
    if(!cache||cache.dev!==stat.dev||cache.ino!==stat.ino||stat.size<cache.size||stat.size===cache.size&&stat.mtimeMs!==cache.mtime)cache={...empty(),file,dev:stat.dev,ino:stat.ino,size:0,mtime:0,invalid:false};
    let tail='';
    if(stat.size>cache.offset){
      stream=createReadStream(file,{encoding:'utf8',start:cache.offset,end:stat.size-1});
      for await(const chunk of stream){tail+=chunk;let newline:number;
        while((newline=tail.indexOf('\n'))>=0){
          const line=tail.slice(0,newline);tail=tail.slice(newline+1);cache.offset+=Buffer.byteLength(line+'\n');
          if(!line.trim())continue;
          if(cache.verified&&!/"(?:session_meta|turn_context|thread_settings_applied|task_started|task_complete|turn_aborted|token_count|compacted)"/.test(line))continue;
          let row:any;try{row=JSON.parse(line);}catch{cache.invalid=true;continue;}
                                            
          if(!cache.verified){
            if(row.type!=='session_meta'||row.payload?.id!==sessionId){cache.invalid=true;continue;}
            const m=row.payload;cache.meta={id:m.id,cwd:m.cwd,model_provider:m.model_provider,cli_version:m.cli_version,history_mode:m.history_mode};cache.verified=true;
          }else if(row.type==='session_meta')continue;
          else{
            const at=Date.parse(row.timestamp);
            if(row.type==='compacted'&&Number.isFinite(at)){cache.compaction={id:[stat.dev,stat.ino,cache.offset].join(':'),at};delete cache.usage;}
            if(row.type==='event_msg'&&row.payload?.type==='token_count'&&Number.isFinite(at)){
              const inputTokens=row.payload.info?.last_token_usage?.input_tokens;
              if(Number.isSafeInteger(inputTokens)&&inputTokens>=0&&at>=(cache.compaction?.at??0))cache.usage={inputTokens,at};
            }
            if(row.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(row.payload?.type)&&typeof row.payload.turn_id==='string'){
              const at=Date.parse(row.timestamp);if(Number.isFinite(at))cache.turn={id:row.payload.turn_id,state:row.payload.type==='task_started'?'running':row.payload.type==='turn_aborted'?'paused':'ready',at};
            }
            const value=row.type==='turn_context'?row.payload:row.type==='event_msg'&&row.payload?.type==='thread_settings_applied'&&row.payload.thread_id===sessionId?row.payload.thread_settings:undefined;
            if(!value||typeof value!=='object')continue;
            cache.settingsOffset=cache.offset;
            for(const [source,target] of Object.entries(fields))if(Object.hasOwn(value,source))cache.settings[target]=value[source];
                                                         
            if(Object.hasOwn(value,'permission_profile')&&!Object.hasOwn(value,'sandbox_policy'))delete cache.settings.sandbox;
          }
        }
      }
    }
    cache.size=stat.size;cache.mtime=stat.mtimeMs;cache.complete=!tail.trim();
    caches.delete(key);caches.set(key,cache);while(caches.size>24)caches.delete(caches.keys().next().value!);
    if(cache.invalid)return{...empty(),file,complete:cache.complete};
    return structuredClone(cache);
  }catch{return{...empty(),file};}finally{stream?.destroy();}
}

export function sessionFile(home:string,sessionId:string):string|undefined{
  if(!/^[a-zA-Z0-9_-]+$/.test(sessionId))throw new BridgeError('session_invalid','会话 ID 不能包含路径或通配符。');
  const files=[...new Set(['sessions/**/rollout-*-'+sessionId+'.jsonl','sessions/'+sessionId+'.jsonl','archived_sessions/**/rollout-*-'+sessionId+'.jsonl'].flatMap(pattern=>globSync(pattern,{cwd:home}).map(file=>path.resolve(home,file))))];
  if(files.length>1)throw new BridgeError('session_ambiguous','原配置目录存在多个同 ID 历史文件，请核对后再托管。');
  return files[0];
}

function canonical(value:any):any{
  if(Array.isArray(value))return value.map(canonical);
  if(!value||typeof value!=='object')return value;
  const output:Record<string,unknown>={};for(const key of Object.keys(value).sort())output[key]=canonical(value[key]);return output;
}
                              
export function normalizedPermission(value:any):any{
  if(!value||typeof value!=='object')return value;
  const result=structuredClone(value);
  if(Array.isArray(result.file_system?.entries))result.file_system.entries=[...new Map(result.file_system.entries.map((entry:any)=>{const v=canonical(entry);return[JSON.stringify(v),v];})).entries()].sort(([a],[b])=>String(a).localeCompare(String(b))).map(([,v])=>v);
  return canonical(result);
}
const samePermission=(a:unknown,b:unknown)=>isDeepStrictEqual(normalizedPermission(a),normalizedPermission(b));
const rank:Record<string,number>={none:0,read:1,write:2};
function permissionPlan(profile:SessionProfile){
  const saved=profile.settings,unknown:string[]=[],narrowed:SessionPolicy['narrowed']=[],filesystem:Record<string,string>={};
  let permission=saved.permissionProfile,network=false;
  if(permission?.type==='disabled')return{options:{sandbox:'danger-full-access'},permission,policy:{source:'persisted',sandbox:permission,approval:saved.approvalPolicy??'on-request',reviewer:saved.approvalsReviewer??'user',unknown,narrowed} as SessionPolicy};
  if(permission?.type==='managed'&&permission.file_system?.type==='restricted'&&Array.isArray(permission.file_system.entries)){
    for(const entry of permission.file_system.entries){
      const key=entry.path?.type==='path'&&typeof entry.path.path==='string'?entry.path.path:entry.path?.type==='special'&&['root','slash_tmp','tmpdir','project_roots'].includes(entry.path.value?.kind)?':'+entry.path.value.kind:undefined;
      if(!key||rank[entry.access]===undefined){unknown.push('filesystem');break;}
      if(entry.missing_path_behavior&&entry.missing_path_behavior!=='skip'){unknown.push('filesystem');break;}
      if(entry.missing_path_behavior==='skip'){
        narrowed.push({rule:key,effect:entry.access==='write'?'省略仅对现存路径生效的写权限':'将仅对现存路径生效的限制保持为固定限制'});
        if(entry.access==='write')continue;
      }
      if(filesystem[key]!==undefined&&filesystem[key]!==entry.access){narrowed.push({rule:key,effect:'同路径规则取较严格权限'});if(rank[filesystem[key]!]!<rank[entry.access]!)continue;}
      filesystem[key]=entry.access;
    }
    if(permission.network==='enabled'||permission.network==='restricted')network=permission.network==='enabled';else unknown.push('network');
    if(Object.keys(permission).some(key=>!['type','file_system','network'].includes(key))){unknown.push('network');network=false;}
  }else if(permission?.type==='managed'&&permission.file_system?.type==='unrestricted'){
    filesystem[':root']='write';network=permission.network==='enabled';if(!['enabled','restricted'].includes(permission.network))unknown.push('network');
  }else unknown.push('filesystem','network');
  if(unknown.includes('filesystem')){for(const key of Object.keys(filesystem))delete filesystem[key];filesystem[':root']='none';}
                                          
  if(!permission&&saved.sandbox){const sandbox=saved.sandbox;if(sandbox.type==='danger-full-access'||sandbox.type==='dangerFullAccess')return{options:{sandbox:'danger-full-access'},permission:{type:'disabled'},policy:{source:'persisted',sandbox,approval:saved.approvalPolicy??'on-request',reviewer:saved.approvalsReviewer??'user',unknown:[],narrowed} as SessionPolicy};}
  if(saved.approvalPolicy===undefined)unknown.push('approval');if(saved.approvalsReviewer===undefined)unknown.push('reviewer');
  const entries=Object.entries(filesystem).map(([key,access])=>({path:key.startsWith(':')?{type:'special',value:{kind:key.slice(1)}}:{type:'path',path:key},access}));
  permission={type:'managed',file_system:{type:'restricted',entries},network:network?'enabled':'restricted'};
  const reason=unknown.includes('filesystem')?'policy_unknown':unknown.length||narrowed.length?'policy_partial':undefined;
  return{options:{permissions:'nxbridge_transfer',config:{'permissions.nxbridge_transfer':{filesystem,network:{enabled:network}},default_permissions:'nxbridge_transfer'}},permission,policy:{source:unknown.length?'conservative':'persisted',sandbox:permission,approval:saved.approvalPolicy??'on-request',reviewer:saved.approvalsReviewer??'user',unknown:[...new Set(unknown)],narrowed,...(reason?{reason}:{})} as SessionPolicy};
}

function sandboxCandidate(profile:SessionProfile):any{
  if(profile.settings.sandbox){const p=structuredClone(profile.settings.sandbox);p.type=({read_only:'readOnly','read-only':'readOnly',workspace_write:'workspaceWrite','workspace-write':'workspaceWrite',danger_full_access:'dangerFullAccess','danger-full-access':'dangerFullAccess',external_sandbox:'externalSandbox','external-sandbox':'externalSandbox'} as any)[p.type]??p.type;
    for(const [a,b] of [['network_access','networkAccess'],['writable_roots','writableRoots'],['exclude_tmpdir_env_var','excludeTmpdirEnvVar'],['exclude_slash_tmp','excludeSlashTmp']])if(p[a!]!==undefined){p[b!]=p[a!];delete p[a!];}return p;
  }
  const p=profile.settings.permissionProfile,entries=p?.file_system?.entries;
  if(p?.type==='disabled')return{type:'dangerFullAccess'};
  if(p?.type!=='managed'||!Array.isArray(entries)||!['enabled','restricted'].includes(p.network))return;
  if(entries.length===1&&entries[0]?.path?.value?.kind==='root'&&entries[0].access==='read')return{type:'readOnly',networkAccess:p.network==='enabled'};
                                                            
  if(entries.some((e:any)=>e.access==='none'||e.path?.type==='special'&&!['root','slash_tmp','tmpdir'].includes(e.path.value?.kind)))return;
  if(!entries.some((e:any)=>e.path?.value?.kind==='root'&&e.access==='read')||!entries.some((e:any)=>e.path?.type==='path'&&e.path.path===profile.settings.cwd&&e.access==='write'))return;
  const cwd=profile.settings.cwd,protectedNames=new Set(['.git','.agents','.codex','.aws']);
  if(entries.some((e:any)=>e.access==='read'&&e.path?.type==='path'&&(e.missing_path_behavior!=='skip'||!protectedNames.has(path.basename(e.path.path)))))return;
  return{type:'workspaceWrite',writableRoots:[...new Set(entries.filter((e:any)=>e.access==='write'&&e.path?.type==='path'&&e.path.path!==cwd).map((e:any)=>e.path.path))],networkAccess:p.network==='enabled',excludeTmpdirEnvVar:!entries.some((e:any)=>e.path?.value?.kind==='tmpdir'&&e.access==='write'),excludeSlashTmp:!entries.some((e:any)=>e.path?.value?.kind==='slash_tmp'&&e.access==='write')};
}

async function persistedAfter(rpc:RpcClient,id:string,file:string,offset:number,settings:Record<string,unknown>):Promise<SessionProfile>{
  await rpc.request('thread/settings/update',{threadId:id,...settings},{mutation:true});
  const deadline=Date.now()+5000;
  do{const current=await readSessionProfile(file,id);if(current.verified&&current.complete&&(current.settingsOffset??0)>offset)return current;await delay(25);}while(Date.now()<deadline);
  throw new BridgeError('policy_verification_failed','宿主设置尚未完整落盘，已暂停投递；请稍后重试。');
}

                                                            
export async function snapshotLiveSession(rpc:RpcClient,id:string,file:string):Promise<SessionProfile>{
  const live=await rpc.request('thread/resume',{threadId:id,excludeTurns:true});
  if(live.thread?.id!==id)throw new BridgeError('session_changed','实时快照返回了其他线程。');
  const previous=await readSessionProfile(file,id);
  const profile=await persistedAfter(rpc,id,file,previous.offset,{approvalPolicy:live.approvalPolicy});
  profile.live=Object.fromEntries(['model','modelProvider','reasoningEffort','approvalPolicy','approvalsReviewer','cwd','runtimeWorkspaceRoots','activePermissionProfile','sandbox'].filter(key=>live[key]!==undefined).map(key=>[key,live[key]]));
  const active=profile.live.activePermissionProfile?.id;
  if(typeof active==='string'&&active.startsWith('nxbridge_')){
    const plan=permissionPlan(profile),definition='config' in plan.options?plan.options.config?.['permissions.nxbridge_transfer']:undefined;
    if(!definition||!samePermission(plan.permission,profile.settings.permissionProfile))throw new BridgeError('profile_unavailable','临时命名权限缺少可精确保留的完整定义，未停止运行时。');
    profile.livePermissionConfig={['permissions.'+active]:definition};
  }
  if(!profile.live.activePermissionProfile?.id&&!sandboxCandidate(profile))throw new BridgeError('profile_unavailable','实时权限既无命名 profile，也不能由原生旧策略精确保留，未停止运行时。');
  return profile;
}

                                       
export async function verifyResumedSession(rpc:RpcClient,id:string,original:SessionProfile):Promise<{resumed:any;policy:SessionPolicy;profile:SessionProfile}>{
  const resumed=await rpc.request('thread/resume',{threadId:id,excludeTurns:true});
  const current=await readSessionProfile(original.file??resumed.thread?.path,id),plan=permissionPlan(original);
  const exact=original.settings.permissionProfile&&samePermission(current.settings.permissionProfile,original.settings.permissionProfile);
  if(resumed.thread?.id!==id||!current.verified||!current.complete||!exact&&!samePermission(current.settings.permissionProfile,plan.permission))throw new BridgeError('policy_verification_failed','上次权限核验被中断，当前权限与原始或严格恢复方案不符，消息继续保留。');
  if((current.settingsOffset??0)<=(original.settingsOffset??0))throw new BridgeError('policy_verification_incomplete','上次恢复尚无新的权限落盘证据，等待安全冷恢复；消息继续保留。');
  for(const key of ['model','modelProvider','reasoningEffort','cwd','approvalPolicy','approvalsReviewer','runtimeWorkspaceRoots'])if(original.settings[key]!==undefined&&!isDeepStrictEqual(resumed[key],original.settings[key]))throw new BridgeError('policy_verification_failed','中断后的运行设置与原会话不符：'+key+'。');
  return{resumed,profile:current,policy:exact?{...plan.policy,source:'persisted',sandbox:current.settings.permissionProfile,unknown:[],narrowed:[],reason:undefined}:plan.policy};
}

                                                
export async function resumeSession(rpc:RpcClient,id:string,options:{file?:string;home?:string;cwd:string;profile?:SessionProfile;verify?:boolean}):Promise<{resumed:any;policy:SessionPolicy;profile:SessionProfile}>{
  const original=options.profile??await readSessionProfile(options.file??(options.home?sessionFile(options.home,id):undefined),id);
  if(original.verified&&!original.complete)throw new BridgeError('policy_verification_failed','原会话权限记录尚未写完，未恢复或投递。');
  const plan=permissionPlan(original),saved=original.settings,config={...('config' in plan.options?plan.options.config:{}),...(saved.reasoningEffort!==undefined&&saved.reasoningEffort!==null?{model_reasoning_effort:saved.reasoningEffort}:{})};
  const args:Record<string,unknown>={threadId:id,excludeTurns:true,...plan.options,config,cwd:saved.cwd??options.cwd,approvalPolicy:plan.policy.approval,approvalsReviewer:plan.policy.reviewer};
  if(original.live){
    const active=original.live.activePermissionProfile;
    delete args.sandbox;delete args.permissions;args.config={...original.livePermissionConfig,...(saved.reasoningEffort!==undefined?{model_reasoning_effort:saved.reasoningEffort}:{})};
    if(active?.id)args.permissions=active.id;
    else{
      const legacy=sandboxCandidate(original),mode=legacy&&({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'} as Record<string,string>)[legacy.type];
      if(!mode)throw new BridgeError('profile_unavailable','实时权限缺少可精确保留的原生表示。');
      args.sandbox=mode;
      if(legacy.type==='workspaceWrite')Object.assign(args.config!,{sandbox_workspace_write:{writable_roots:legacy.writableRoots??[],network_access:legacy.networkAccess??false,exclude_tmpdir_env_var:legacy.excludeTmpdirEnvVar??false,exclude_slash_tmp:legacy.excludeSlashTmp??false}});
      if(legacy.type==='readOnly')Object.assign(args.config!,{sandbox_read_only:{network_access:legacy.networkAccess??false}});
    }
  }
  for(const key of ['model','modelProvider','runtimeWorkspaceRoots'])if(saved[key]!==undefined)args[key]=saved[key];
  let resumed:any;
  try{resumed=await rpc.request('thread/resume',args,{timeout:30000});}
  catch(error){if(plan.policy.unknown.includes('filesystem')&&/sandbox helper|codex-linux-sandbox|failed to load AGENTS/i.test(String((error as Error).message)))throw new BridgeError('policy_unknown_unstartable','原会话权限未知，原生宿主无法在禁止读取的策略下初始化。消息继续保留；请在正常窗口明确设置权限并完成一次交互后重试。');throw error;}
  if(resumed.thread?.id!==id)throw new BridgeError('session_changed','恢复结果的线程 ID 与原会话不符，未投递。');
  for(const key of ['model','modelProvider','reasoningEffort','cwd','approvalPolicy','approvalsReviewer','runtimeWorkspaceRoots'])if(saved[key]!==undefined&&!isDeepStrictEqual(resumed[key],saved[key]))throw new BridgeError('policy_verification_failed','宿主未保留原会话的 '+key+'，已暂停投递。');
  const file=options.file??resumed.thread.path??original.file;
  if(options.verify===false)return{resumed,policy:plan.policy,profile:original};
  if(typeof file!=='string'||!file)throw new BridgeError('policy_verification_failed','无法读取原生权限生效证据，已暂停投递。');
  let current=await readSessionProfile(file,id),candidate=original.live?.activePermissionProfile?.id?undefined:sandboxCandidate(original);
  const settings:Record<string,unknown>={approvalPolicy:plan.policy.approval};
  for(const key of ['collaborationMode','serviceTier','disabledPluginIds'])if(saved[key]!==undefined)settings[key]=saved[key];
  if(candidate)settings.sandboxPolicy=candidate;
  current=await persistedAfter(rpc,id,file,current.offset,settings);
  if(original.live){
    if(!samePermission(current.settings.permissionProfile,original.settings.permissionProfile)||resumed.activePermissionProfile?.id!==original.live.activePermissionProfile?.id)throw new BridgeError('policy_verification_failed','重启后的实时权限或原生命名 profile 已改变，已暂停投递。');
    return{resumed,profile:current,policy:{...plan.policy,source:'persisted',sandbox:current.settings.permissionProfile,unknown:[],narrowed:[],reason:undefined}};
  }
  if(candidate&&samePermission(current.settings.permissionProfile,original.settings.permissionProfile)){
    const policy={...plan.policy,source:'persisted' as const,sandbox:current.settings.permissionProfile,narrowed:[],...(plan.policy.unknown.length?{reason:'policy_partial' as const}:{reason:undefined})};return{resumed,policy,profile:current};
  }
  if(candidate&&!samePermission(current.settings.permissionProfile,plan.permission)){
                                             
    const repaired=await rpc.request('thread/resume',args,{timeout:30000});if(repaired.thread?.id!==id)throw new BridgeError('session_changed','重新核验时原会话已经变化。');
    current=await readSessionProfile(file,id);current=await persistedAfter(rpc,id,file,current.offset,{approvalPolicy:plan.policy.approval});
  }
  if(!samePermission(current.settings.permissionProfile,plan.permission)||current.settings.approvalPolicy!==undefined&&!isDeepStrictEqual(current.settings.approvalPolicy,plan.policy.approval)||current.settings.approvalsReviewer!==undefined&&!isDeepStrictEqual(current.settings.approvalsReviewer,plan.policy.reviewer))throw new BridgeError('policy_verification_failed','无法核验不放宽权限的恢复结果，已暂停投递。');
  return{resumed,policy:plan.policy,profile:current};
}
