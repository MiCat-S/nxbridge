import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {bridgeHome} from '../../shared/local-paths.js';
import {isElevated} from '../../process/permissions.js';
import {loadConfig} from '../../config/load.js';
import {runCli} from '../../process/host-command.js';
import { brokerCall } from '../../ipc/ipc.js';
import { configClient } from '../../hosts/codex/stdio-codex.js';
import {describeError} from '../../shared/errors.js';
import { inspectInstallation } from '../../install/installation.js';
import { providerRetryInfo } from '../../broker/health/turn-health.js';
import { activeRuntime, inspectRuntime } from '../../install/runtime-install.js';
import { launchStatus } from '../../hosts/host-launch.js';
import { loopbackProxyNames, persistentEnvironment } from '../../process/environment.js';
import { profileState } from '../../hosts/launch-profiles.js';
import {readJson} from '../../shared/files.js';
import { execFileSync } from 'node:child_process';
import { resolveNodeRuntime, supportedNode } from '../../install/node-runtime.js';
import { configurationStatus } from '../../config/configuration.js';
import { probeClaudeBackground } from '../../hosts/claude/claude-capability.js';
import { platformCompatibility, versionCompatibility, TESTED_VERSIONS } from '../../install/compatibility.js';
import { installedCacheStatus } from '../../install/installation.js';
import { auditOwnedProcesses } from '../../process/process-audit.js';
import { managedRuntimes, managedRuntimeState } from '../../hosts/managed-runtimes.js';
import { backgroundState } from '../../hosts/background-state.js';
import { inspectCodexRegistration } from '../../hosts/codex/codex-registration.js';
import { hookTrustMessage } from '../../hosts/codex/codex-hook-trust.js';
import type { TargetSelector } from '../../broker/pairing/admin-target.js';
import { brokerOutageState, brokerOutageDiagnostic } from '../../broker/broker-outage.js';
import { windowsHelperStatus } from '../../process/windows/windows-hook-identity.js';
import { containedCommandStatus } from '../../process/contained-command.js';

                                      
export async function diagnoseCurrent(selector:TargetSelector,home=bridgeHome()):Promise<Record<string,unknown>>{
  const [context,ping]=await Promise.all([
    brokerCall<{status:unknown;codex?:{configHome?:string;cwd:string}}>('doctor.current',selector,{home,start:false}),
    brokerCall('ping',{}, {home,start:false}),
  ]);
  const runtime=inspectRuntime(home),current=activeRuntime(home),result:Record<string,unknown>={status:context.status,runtime:{buildId:current?.buildId,brokerBuildId:ping.runtime?.buildId,matchesDisk:!!current?.buildId&&current.buildId===ping.runtime?.buildId,drift:runtime.drift},notice:'只读事实；只处理已核验的 nxbridge 自有原因，不改信任、用户配置或其他会话，不自动重发消息。'};
  if(context.codex?.configHome){
    let client;
    try{
      client=await configClient({...loadConfig(home),codexHome:context.codex.configHome},home);
      const hooks=await client.request('hooks/list',{cwds:[context.codex.cwd]},{timeout:5000});
      result.hooks=(hooks.data??[]).flatMap((row:any)=>row.hooks??[]).filter((hook:any)=>hook.pluginId==='nxbridge@nxbridge-local').map((hook:any)=>({event:hook.eventName,enabled:hook.enabled,trust:hook.trustStatus}));
    }catch(error){result.hooks={error:describeError(error)};}finally{await client?.close();}
  }
  result.degraded=(ping.degraded??[]).map((value:{stage:string;count:number;retryAt:number})=>({stage:value.stage.split(':')[0],count:value.count,retryAt:value.retryAt}));
  brokerOutageState(home);result.outageLedger=brokerOutageDiagnostic(home)??null;
  return result;
}

export async function diagnose(home=bridgeHome()):Promise<Record<string,unknown>>{
  const config=loadConfig(home),cwd=process.cwd();
  const result:Record<string,unknown>={node:process.version,platform:process.platform,elevated:await isElevated(),home,cwd,installation:inspectInstallation(home),runtime:inspectRuntime(home)};
  if(process.platform==='win32')result.windowsHelper={...windowsHelperStatus(home),repairCommand:'nxbridge update'};
  result.controlProcesses=containedCommandStatus(home);
  brokerOutageState(home);result.outageLedger=brokerOutageDiagnostic(home)??null;
  const pinned=activeRuntime(home)?.node,quote=(value:string)=>"'"+value.replaceAll("'",process.platform==='win32'?"''":"'\\''")+"'";
  if(pinned){
    const exists=existsSync(pinned);let version:string|null=null,fallback:string|null=null,error:string|null=null;
    try{if(exists)version=execFileSync(pinned,['--version'],{encoding:'utf8',windowsHide:true,timeout:3000}).trim();else fallback=resolveNodeRuntime(pinned);}catch(value){error=describeError(value);}
    result.nodeRuntime={pinned,exists,version,supported:version?supportedNode(version):null,current:process.execPath,pathChanged:path.resolve(pinned).toLowerCase()!==path.resolve(process.execPath).toLowerCase(),fallback,error,repairCommand:`${process.platform==='win32'?'& ':''}${quote(process.execPath)} ${quote(path.join(home,'bin','nxbridge.cjs'))} update`,notice:'Node 安装目录改变后，update 会修复运行入口、命令、未被用户改动的 shell 包装和插件注册。若全局命令或 MCP 的 Node 路径已失效，先用上面的完整命令修复，再重新加载插件。'};
  }
  result.launches=launchStatus(home,config,cwd);
  result.configuration=configurationStatus(home);
  result.codexRegistration=inspectCodexRegistration(home);
  result.pluginCaches=installedCacheStatus(home);
  result.processes=await auditOwnedProcesses(home);
  result.holderScope='持有者核验只覆盖本安装已登记的窗口和后台；未加载 nxbridge 插件或使用其他配置目录的进程不在观察范围内。';
  const native=managedRuntimes(home).map(record=>record.value),persistent=persistentEnvironment();
  result.managedRuntimes=await Promise.all(native.map(async value=>({...value,ownership:'本安装的启动记录',dedicatedProof:value.dedicated===true?'启动时已核验，停止前仍需重新核验':'尚未核验独占性',processState:await managedRuntimeState(home,value)})));
  result.background=backgroundState(home)??null;
  result.ownedEnvironment={receipts:['broker','codex-app-server','claude-background','claude-child'].flatMap(role=>{const file=path.join(home,'run','launch-'+role+'.json');return existsSync(file)?[{role,...readJson<Record<string,unknown>>(file)}]:[];}),warnings:(profileState(home).observations??[]).filter(value=>native.some(runtime=>runtime.pid===value.sourcePid&&runtime.procStart===value.sourceGeneration)).flatMap(value=>loopbackProxyNames(value.env).filter(key=>value.env[key]!==persistent[key]).map(key=>({host:value.host,pid:value.sourcePid,variable:key,message:'检测到窗口使用了一个系统环境里没有设置的本地代理（来自窗口登记时的记录，不是实时读取）。如果后台会话连不上模型服务，先检查这个代理。'})))};
  const probes:[string,()=>Promise<unknown>][]=[
    ['codexVersion',async()=>(await runCli('codex',['--version'],{config,home})).trim()],
    ['claudeVersion',async()=>(await runCli('claude',['--version'],{config,home})).trim()],
    ['claudePlugin',async()=>{
      const listed=JSON.parse(await runCli('claude',['plugin','list','--json'],{config,home}));
      const plugins=Array.isArray(listed)?listed:listed.plugins??listed.installed??[];
      return plugins.filter((p:any)=>JSON.stringify([p.id,p.name]).includes('nxbridge')).map((p:any)=>({id:p.id??p.name,enabled:p.enabled,scope:p.scope,version:p.version}));
    }],
    ['bridge',async()=>{
      const [s,identity]=await Promise.all([brokerCall('status',{}, {home,start:false}),brokerCall('ping',{}, {home,start:false})]),current=activeRuntime(home);
      result.retirements=s.capabilities?.retirements??[];const integrationIssues=(s.capabilities?.integrationIssues??s.integrationIssues??[]).map((issue:any)=>{
        const peer=s.peers.find((peer:any)=>peer.id===issue.peerId);
        return peer&&(issue.code==='hooks_trust_required'||issue.code==='hooks_restart_required')?{...issue,message:hookTrustMessage(peer,issue.code,true)}:issue;
      });
      return{runtime:identity.runtime??null,runtimeMatchesDisk:current?.buildId&&identity.runtime?.buildId?current.buildId===identity.runtime.buildId:null,pairs:s.pairs??(s.pair?[s.pair]:[]),peers:s.peers,endpoints:s.endpoints,capabilities:s.capabilities,degraded:s.degraded??identity.degraded??[],integrationIssues,communicationTips:s.communicationTips,pending:s.messages.filter((m:any)=>['accepted','unknown','held'].includes(m.state)).map((m:any)=>({id:m.id,state:m.state,error:m.error}))};
    }],
    ['codexCapabilities',async()=>{
      const client=await configClient(config,home);
      try{
        const methods:[string,unknown][]=[['config/read',{includeLayers:false,cwd}],['configRequirements/read',{}],['hooks/list',{cwds:[cwd]}],['plugin/list',{cwds:[cwd],marketplaceKinds:['local']}],['mcpServerStatus/list',{}]];
        const reads=await Promise.allSettled(methods.map(([method,params])=>client.request(method,params,{timeout:12000})));
        const values=Object.fromEntries(reads.map((r,i)=>[methods[i]![0],r.status==='fulfilled'?r.value:{error:describeError(r.reason)}]));
        const features=values['config/read'].config?.features??{};
        const hooks=(values['hooks/list'].data??[]).flatMap((e:any)=>e.hooks??[]).filter((h:any)=>h.pluginId?.includes('nxbridge')||h.sourcePath?.includes('nxbridge'));
        const plugins=(values['plugin/list'].marketplaces??values['plugin/list'].data??[]).flatMap((m:any)=>m.plugins??[]).filter((p:any)=>p.name==='nxbridge');
        const servers=(values['mcpServerStatus/list'].data??[]).filter((s:any)=>s.name?.includes('claude'));
        return{
          namespaces:{nonPrefixed:features.non_prefixed_mcp_tool_names??null,codeMode:features.code_mode??null,strictThirdParty:features.code_mode_only_strict_3p_tools??false},
          managedFeatures:values['configRequirements/read'].requirements?.featureRequirements??null,
          providerRetries:providerRetryInfo(values['config/read'].config),
          hooks:hooks.map((h:any)=>({event:h.eventName,enabled:h.enabled,trust:h.trustStatus,currentHash:h.currentHash})),
          plugin:plugins.map((p:any)=>({name:p.name,version:p.version,installPath:p.installPath,installed:p.installed,enabled:p.enabled,disabledReason:p.disabledReason})),
          mcp:servers.map((s:any)=>({name:s.name,tools:Object.keys(s.tools??{}),authStatus:s.authStatus})),
          errors:Object.fromEntries(Object.entries(values).filter(([,v])=>v.error).map(([k,v])=>[k,v.error])),
          reception:hooks.some((h:any)=>h.enabled&&['trusted','managed'].includes(h.trustStatus))?'已信任的 hooks 可参与兼容取件':'主路径用 App Server；embedded hooks 需在 /hooks 完成信任',
        };
      }finally{client.close();}
    }],
  ];
  const checks=await Promise.allSettled(probes.map(([,run])=>run()));
  checks.forEach((r,i)=>{result[probes[i]![0]]=r.status==='fulfilled'?r.value:{error:describeError(r.reason)};});
  result.claudeBackground=await probeClaudeBackground(args=>runCli('claude',args,{config,home}));
  result.compatibility={platform:platformCompatibility(),hosts:Object.fromEntries((['codex','claude'] as const).map(host=>[host,typeof result[host+'Version']==='string'?versionCompatibility(host,result[host+'Version'] as string):{status:'unavailable'}]))};
  result.localIpc={tokenPresent:existsSync(path.join(home,'run','token')),directoryMode:existsSync(home)&&process.platform!=='win32'?(statSync(home).mode&0o777).toString(8):null};
  result.notes=[`已验证版本：${(['codex','claude'] as const).map(host=>`${host==='codex'?'Codex':'Claude'} ${TESTED_VERSIONS[host].join('、')}`).join('；')}。其他版本以能力检查与实际测试为准。`,'控制面工具列表不等同于已有线程已加载新插件；首轮工具可用性由原生集成测试验证。','Claude 会话登记本身不证明 Mod 已加载；实际工具回执与上下文观察才能提供更强证据。组织限制、项目信任和原生入站审批均沿用宿主。','unknown 表示接受情况不确定，不表示发送失败；显式窗口存在性无法核实时保持未知。'];
  return result;
}
