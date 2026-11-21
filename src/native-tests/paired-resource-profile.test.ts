import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli,runCli} from '../process/host-command.js';
import {delay} from '../shared/time.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { NativeTerminal } from './terminal-fixture.js';

                                  
test('实际双端配对 Mod 空闲资源：单变体 60 秒外部 OS 测量', {skip:process.platform!=='win32'||!process.env.NXBRIDGE_PAIRED_PROFILE,timeout:170000},async t=>{
  const label=process.env.NXBRIDGE_PAIRED_PROFILE!,publish=label==='baseline'?process.env.NXBRIDGE_PROFILE_BASELINE!:path.join(PACKAGE_ROOT,'publish');
  assert.ok(publish);assert.ok(['baseline','candidate'].includes(label));
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex'),metrics=path.join(root,'metrics');
  for(const directory of [home,claudehome,codexhome,metrics])mkdirSync(directory,{recursive:true});
  const preload=path.join(root,'profile.mjs');
                                 
  writeFileSync(preload,`import{channel}from'node:diagnostics_channel';import{appendFileSync}from'node:fs';import path from'node:path';const file=path.join(process.env.NXBRIDGE_PROFILE_DIR,process.pid+'.jsonl'),record=value=>appendFileSync(file,JSON.stringify({...value,pid:process.pid,at:Date.now()})+'\\n');record({type:'boot',parent:process.ppid,args:process.argv});channel('child_process').subscribe(event=>process.nextTick(()=>record({type:'spawn',child:event.process.pid,command:event.process.spawnfile})));process.on('exit',()=>record({type:'exit',cpu:process.cpuUsage(),peakRssBytes:process.resourceUsage().maxRSS*1024}));`,'utf8');
  const requests:{claude:number;codex:number}={claude:0,codex:0},errors:string[]=[];
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/v1/messages')&&!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw.toString()),claude=req.url.includes('/v1/messages'),id='profile-'+(claude?++requests.claude:++requests.codex),text='PAIRED_PROFILE_READY';
    if(claude&&!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const item={type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text}]};
    const events=claude?[{type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}]:[{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}];
    for(const event of events)res.write((claude?'event: '+event.type+'\n':'')+'data: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(model.address() as any).port}`;
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,NXBRIDGE_PROFILE_DIR:metrics,NODE_OPTIONS:'--import '+JSON.stringify(pathToFileURL(preload).href),ANTHROPIC_API_KEY:'paired-profile-local-only',ANTHROPIC_BASE_URL:url,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  let claude:NativeTerminal|undefined,codex:NativeTerminal|undefined,service:ChildProcess|undefined,closed:Promise<void>|undefined;
  t.after(async()=>{try{
    await claude?.close();await codex?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}
    if(service&&service.exitCode===null&&service.signalCode===null)service.kill();await closed;await temp.cleanup();
  }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  const entry=path.join(publish,'nxbridge.mjs');
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:url,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'local_profile',model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',suppress_unstable_features_warning:true,check_for_update_on_startup:false,features:{hooks:true,apps:false,remote_plugin:false},model_providers:{local_profile:{name:'本地资源测量',base_url:url+'/v1',wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'}}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:publish,launcher:entry});
                                                              
  for(const host of ['claude','codex']){const runtimeFile=path.join(marketplace,'plugins',host,'runtime.json'),runtime=JSON.parse(readFileSync(runtimeFile,'utf8'));delete runtime.launcher;writeFileSync(runtimeFile,JSON.stringify(runtime),'utf8');}
  await runCli('codex',['plugin','marketplace','add',marketplace,'--json']);await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json']);
  service=spawn(process.execPath,[entry,'service'],{env:process.env,windowsHide:true,stdio:['ignore','ignore','pipe']});service.stderr!.on('data',chunk=>errors.push(String(chunk)));closed=new Promise<void>(resolve=>service!.once('close',()=>resolve()));
  let ready=false;for(let n=0;n<100;n++){try{await brokerCall('ping',{}, {home,start:false,timeout:1000});ready=true;break;}catch{await delay(100);}}assert.ok(ready,errors.join(''));
  const c=resolveCli('claude'),x=resolveCli('codex');
  claude=await NativeTerminal.start(root,home,c.command,[...c.prefix,'--plugin-dir',path.join(marketplace,'plugins/claude'),'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  codex=await NativeTerminal.start(root,home,x.command,[...x.prefix,'--no-daemon','--no-alt-screen','--dangerously-bypass-hook-trust'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  await claude.prompt('初始化空闲资源测量');await claude.wait(()=>claude!.output.includes('PAIRED_PROFILE_READY'),'Claude 初始化未完成',30000);
  await codex.prompt('初始化空闲资源测量');await codex.wait(()=>codex!.output.includes('PAIRED_PROFILE_READY'),'Codex 初始化未完成',30000);
  const status=()=>brokerCall<any>('status',{}, {home,start:false}),initial=await status(),cp=initial.peers.find((peer:any)=>peer.host==='claude'&&peer.context),xp=initial.peers.find((peer:any)=>peer.host==='codex'&&peer.context);assert.ok(cp);assert.ok(xp);
  const pair=await brokerCall<any>('pair',{claude:cp.id,codex:xp.id},{home,start:false});await delay(3000);
  const rows=()=>readdirSync(metrics).filter(file=>file.endsWith('.jsonl')).flatMap(file=>readFileSync(path.join(metrics,file),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  const beforeRows=rows(),exited=new Set(beforeRows.filter(row=>row.type==='exit').map(row=>row.pid)),live=beforeRows.filter(row=>row.type==='boot'&&!exited.has(row.pid)&&(row.args.includes('service')||row.args.includes('mcp'))),pids=[...live.map(row=>row.pid),claude.identity.pid,codex.identity.pid];
  const snapshot=async()=>{
    const script='$rows=@();foreach($profileId in @('+pids.join(',')+')){$p=Get-Process -Id $profileId -ErrorAction Stop;$rows+=@{pid=$p.Id;generation=$p.StartTime.ToFileTimeUtc().ToString();privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds}};ConvertTo-Json -InputObject @($rows) -Compress';
    return JSON.parse((await promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,env:{...process.env,NODE_OPTIONS:''}})).stdout) as any[];
  };
  const before=await snapshot(),start=Date.now(),requestsBefore={...requests};await delay(60000);const after=await snapshot(),end=Date.now(),afterRows=rows(),final=await status();
  for(const row of before)assert.equal(after.find(value=>value.pid===row.pid)?.generation,row.generation);
  assert.equal(final.pair.id,pair.id);assert.deepEqual(requests,requestsBefore,'空闲测量不能唤醒模型');
  const idleRows=afterRows.filter(row=>row.at>=start&&row.at<=end),nodeIds=new Set(live.map(row=>row.pid)),totals=(ids:Set<number>)=>after.filter(row=>ids.has(row.pid)).reduce((sum,row)=>({processes:sum.processes+1,privateBytes:sum.privateBytes+row.privateBytes,workingSetBytes:sum.workingSetBytes+row.workingSetBytes,cpuMs:sum.cpuMs+row.cpuMs-before.find(value=>value.pid===row.pid).cpuMs}),{processes:0,privateBytes:0,workingSetBytes:0,cpuMs:0});
  const born=new Set(idleRows.filter(row=>row.type==='boot').map(row=>row.pid)),transient=idleRows.filter(row=>row.type==='exit'&&born.has(row.pid)&&!nodeIds.has(row.pid));
  t.diagnostic(JSON.stringify({label,build:JSON.parse(readFileSync(path.join(publish,'publish.json'),'utf8')).buildId,elapsedMs:end-start,node:totals(nodeIds),persistentNodeArgs:live.map(row=>({pid:row.pid,args:row.args})),native:totals(new Set([claude.identity.pid,codex.identity.pid])),idleNodeStarts:idleRows.filter(row=>row.type==='boot').map(row=>({pid:row.pid,parent:row.parent,operation:row.args.includes('mod')?JSON.parse(row.args.at(-1)).operation:row.args.slice(1)})),idleChildStarts:idleRows.filter(row=>row.type==='spawn').map(row=>({parent:row.pid,child:row.child,command:row.command})),transientNodeCompleted:transient.length,transientNodeCpuMs:transient.reduce((sum,row)=>sum+(row.cpu.user+row.cpu.system)/1000,0),transientNodePeakRssBytes:transient.map(row=>row.peakRssBytes),requests,realModelCalls:0,scope:'actual paired Claude Mod + Codex TUI; external persistent-process CPU/memory; complete-interval transient Node CPU; native helper CPU, boundary-crossing transient CPU and physical disk IO not measured; terminal controllers/supervisor excluded'}));
});
