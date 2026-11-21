import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,cpSync,linkSync,readdirSync,realpathSync,symlinkSync,readlinkSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { gunzipSync,zstdDecompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {homedir} from 'node:os';
                                                

const {workspace,directory:root,wakeProbeOnly=false}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const load=name=>import(pathToFileURL(path.join(workspace,'dist',name+'.js'))),require=createRequire(path.join(workspace,'package.json')),{stringify}=require('smol-toml');
const {preparePlugins}=await load('install/setup'),{DEFAULT_CONFIG}=await load('config/defaults'),{brokerCall,ensureBroker}=await load('ipc/ipc'),{configClient}=await load('hosts/codex/stdio-codex'),{startTerminal,codexComposerReady}=await load('native-tests/portable-terminal-fixture'),{resolveCli,runCli}=await load('process/host-command'),{delay}=await load('shared/time'),{processIdentity,codexArguments,codexAppServerArguments}=await load('process/process'),{recordOwnedProcess}=await load('process/owned-processes');
const home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude'),eventsFile=path.join(root,'hooks.jsonl'),hookOutputFile=path.join(root,'hook-output.jsonl'),resultFile=path.join(root,'result.json');
const stage=value=>appendFileSync(path.join(root,'stages.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n','utf8');
let terminal,secondTerminal,client,model,daemonIdentity,modelFailure,daemonLaunchAttempted=false;const result={},requests=[],requestHeaders=[],acceptance=true;
const rememberDaemon=async pid=>{
  const identity=await processIdentity(pid),command=await codexArguments(identity);
  assert.ok(codexAppServerArguments(command)&&command.includes('--managed-daemon'));
  if(daemonIdentity?.pid!==identity.pid||daemonIdentity.startedAt!==identity.startedAt)await recordOwnedProcess(home,{role:'codex-runtime',identity,configHome:codexhome,parent:await processIdentity(process.pid),proof:{kind:'native-session',launchId:path.basename(root)}});
  daemonIdentity=identity;return command;
};
try{
  for(const dir of [home,codexhome,claudehome])mkdirSync(dir,{recursive:true});
  Object.assign(process.env,{NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'isolated-local-only'});
  stage({phase:'原生 daemon 隔离验收',platform:process.platform,root});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,codexHome:codexhome,claudeHome:claudehome,implicit:'never',compatibilityWake:'strict'}),'utf8');
                                
  const sourceCatalog=path.join(homedir(),'.codex','.tmp');
  for(const name of ['plugins','plugins.sha','app-server-remote-plugin-sync-v1'])if(existsSync(path.join(sourceCatalog,name))){mkdirSync(path.join(codexhome,'.tmp'),{recursive:true});cpSync(path.join(sourceCatalog,name),path.join(codexhome,'.tmp',name),{recursive:true});}
  if(process.platform==='linux'&&existsSync(path.join(homedir(),'.codex/packages/app-server-daemon/current'))){
                                                              
    const source=realpathSync(path.join(homedir(),'.codex/packages/app-server-daemon/current')),packages=path.join(codexhome,'packages/app-server-daemon'),tag=path.basename(source);
    const linkTree=(from,to)=>{mkdirSync(to,{recursive:true});for(const item of readdirSync(from,{withFileTypes:true})){const a=path.join(from,item.name),b=path.join(to,item.name);if(item.isDirectory())linkTree(a,b);else if(item.isSymbolicLink())symlinkSync(readlinkSync(a),b);else linkSync(a,b);}};
    linkTree(source,path.join(packages,'releases',tag));symlinkSync(path.join('releases',tag),path.join(packages,'current'),'dir');
  }
  model=http.createServer(async(req,res)=>{try{
    const chunks=[];for await(const c of req)chunks.push(Buffer.from(c));let raw=Buffer.concat(chunks);
    if(req.headers['content-encoding']==='zstd')raw=zstdDecompressSync(raw);if(req.headers['content-encoding']==='gzip')raw=gunzipSync(raw);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push(body);requestHeaders.push({ua:req.headers['user-agent'],originator:req.headers.originator});
    const id='daemon-repro-'+requests.length,probe=body.tools?.length?/MCP_(?:PROBE|PULL)_\d+/.exec(JSON.stringify(body.input.findLast(i=>i.role==='user'))??'')?.[0]:undefined,callId='call-'+probe,toolName=probe?.includes('PULL')?'receive_messages':'status';
    let spec;
    for(const tool of body.tools??[]){
      if(tool.type==='namespace'&&/^(?:mcp__)?claude$/.test(tool.name)){const found=tool.tools.find(v=>v.name===toolName);if(found)spec={...found,namespace:tool.name};}
      else if(tool.name===toolName||new RegExp('^(?:mcp__)?claude(?:__|[._])'+toolName+'$').test(tool.name))spec=tool;
    }
    if(probe&&!spec){
      stage({phase:'隔离模型缺少 MCP 工具',probe,tools:body.tools.map(tool=>({name:tool.name,type:tool.type,keys:Object.keys(tool),description:tool.description?.slice(0,180),parameters:Object.keys(tool.parameters?.properties??{}),tools:tool.tools?.map(inner=>({name:inner.name,type:inner.type}))}))});
      throw Error('缺少真实 MCP status 工具：'+JSON.stringify(body.tools.map(t=>t.name)));
    }
    const call=probe&&spec&&!body.input.some(i=>i.type==='function_call_output'&&i.call_id===callId);
    let item=call?{type:'function_call',id:'fc-'+id,call_id:callId,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:'{}'}:{type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'DAEMON_LOCAL_DONE_'+requests.length}]};
    if(wakeProbeOnly&&JSON.stringify(body.input).includes('DAEMON_APPROVAL_PROBE')&&!body.input.some(value=>value.type==='function_call_output'&&value.call_id==='daemon-approval-probe')){
      let command;for(const tool of body.tools??[]){if(tool.type==='namespace'){const inner=tool.tools.find(value=>value.name==='exec_command');if(inner)command={...inner,namespace:tool.name};}else if(tool.name==='exec_command')command=tool;}
      if(!command)throw Error('隔离审批探针缺少原生 exec_command 工具');
      item={type:'function_call',id:'fc-approval-probe',call_id:'daemon-approval-probe',name:command.name,...(command.namespace?{namespace:command.namespace}:{}),arguments:JSON.stringify({cmd:'printf daemon-approval-probe',sandbox_permissions:'require_escalated',justification:'隔离测试：验证没有 TUI 时审批不会被自动放行'})};
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const e of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(e)+'\n\n');res.end();
  }catch(error){modelFailure=error;stage({modelError:String(error)});res.writeHead(500);res.end(String(error));}});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'daemon_local',model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',suppress_unstable_features_warning:true,check_for_update_on_startup:false,thread_unload_delay_secs:2,analytics:{enabled:false},features:{hooks:true,apps:false,remote_plugin:false,daemon_auto_start:true,code_mode:false},model_providers:{daemon_local:{name:'本地 daemon 隔离验收',base_url:`http://127.0.0.1:${model.address().port}/v1`,wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'},[path.join(root,'other-project')]:{trust_level:'trusted'}}}),'utf8');
  mkdirSync(path.join(codexhome,'app-server-daemon'),{recursive:true});writeFileSync(path.join(codexhome,'app-server-daemon','settings.json'),JSON.stringify({remoteControlEnabled:false,shutdownGraceSeconds:0,updater:{autoUpdateEnabled:false}}),'utf8');
  const capture=path.join(root,'capture.cjs');writeFileSync(capture,`const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify({pid:process.pid,ppid:process.ppid,input:JSON.parse(input)})+'\\n');console.log('{}');});`,'utf8');
  writeFileSync(path.join(codexhome,'hooks.json'),JSON.stringify({hooks:Object.fromEntries(['SessionStart','SessionEnd','UserPromptSubmit','Stop','Interrupt'].map(name=>[name,[{hooks:[{type:'command',command:'node "'+capture+'"',timeout:name==='SessionEnd'||name==='Interrupt'?3:5}]}]]))}),'utf8');
  const marketplace=await preparePlugins(home);stage({phase:'插件已准备'});
                                               
  const tracedBridge=path.join(marketplace,'plugins','codex','bridge.cjs');
  if(process.env.NXBRIDGE_DAEMON_HOOK_TRACE!=='0')writeFileSync(tracedBridge,`if(process.argv[2]==='hook'){const trace={at:Date.now(),pid:process.pid,ppid:process.ppid,input:'',stdout:'',stderr:''},read=process.stdin.read;process.stdin.read=function(...args){const value=read.apply(this,args);if(value)trace.input+=String(value);return value;};for(const key of ['stdout','stderr']){const stream=process[key],write=stream.write;stream.write=function(chunk,...args){trace[key]+=String(chunk);return write.call(this,chunk,...args);};}process.once('exit',code=>require('node:fs').appendFileSync(${JSON.stringify(hookOutputFile)},JSON.stringify({...trace,code,endedAt:Date.now()})+'\\n'));}\n`+readFileSync(tracedBridge,'utf8'),'utf8');
  await runCli('codex',['plugin','marketplace','add',marketplace,'--json']);await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json']);
  const config={...DEFAULT_CONFIG,codexHome:codexhome,claudeHome:claudehome};
  const control=await configClient(config,home);try{const hooks=(await control.request('hooks/list',{cwds:[root]})).data.flatMap(row=>row.hooks??[]);await control.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map(h=>[h.key,{enabled:true,trusted_hash:h.currentHash}])),mergeStrategy:'replace'}],filePath:path.join(codexhome,'config.toml')},{mutation:true});stage({phase:'隔离 hook 已信任',hooks:hooks.length});}finally{await control.close();}
  (await ensureBroker(home)).close();const exe=resolveCli('codex'),events=()=>existsSync(eventsFile)?readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],status=()=>brokerCall('status',{}, {home,start:false});
  const start=async(noDaemon,cwd=root,resume)=>{
    stage({phase:noDaemon?'启动 embedded 对照':'启动默认 daemon'});if(!noDaemon)daemonLaunchAttempted=true;
    const value=await startTerminal(root,home,exe.command,[...exe.prefix,'--no-alt-screen',...(noDaemon?['--no-daemon']:[]),...(resume?['resume',resume]:[])],cwd,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
    await value.wait(()=>stripVTControlCharacters(value.output).includes('gpt-5.1-codex low'),'原生 TUI 尚未完成加载',20000);
                                         
    const pidfile=path.join(codexhome,'app-server-daemon','daemon.pid');
    if(!noDaemon&&existsSync(pidfile))await rememberDaemon(JSON.parse(readFileSync(pidfile,'utf8')).pid);
    return value;
  };
  const turn=async(text)=>{const offset=terminal.output.length,count=requests.length,stops=events().filter(e=>e.input.hook_event_name==='Stop').length;await terminal.prompt(text);await terminal.wait(()=>{if(modelFailure)throw modelFailure;return requests.length>count&&events().filter(e=>e.input.hook_event_name==='Stop').length>stops&&stripVTControlCharacters(terminal.output.slice(offset)).includes('DAEMON_LOCAL_DONE_');},'本地模型轮次未完成',35000);await delay(400);};
  terminal=await start(false);await turn('MCP_PROBE_1 默认 daemon 模式隔离复现');
  const pidfile=path.join(codexhome,'app-server-daemon','daemon.pid');result.daemonPidfile=existsSync(pidfile)?JSON.parse(readFileSync(pidfile,'utf8')):null;
  result.daemonInfo=JSON.parse(await runCli('codex',['app-server','daemon','version']));
  const hostPid=result.daemonPidfile?.pid??events()[0]?.ppid;
  if(hostPid)result.daemonCommand=await rememberDaemon(hostPid);
  result.daemonStatus=await status();result.daemonHooks=events();result.daemonTui=terminal.identity;result.daemonTerminal=stripVTControlCharacters(terminal.output).slice(-3500);stage({phase:'默认模式完成',daemon:result.daemonPidfile,peers:result.daemonStatus.peers.map(p=>({id:p.id,sessionId:p.sessionId})),hooks:result.daemonHooks.map(e=>({event:e.input.hook_event_name,session:e.input.session_id,ppid:e.ppid}))});
  const {DatabaseSync}=await import('node:sqlite'),contextDb=new DatabaseSync(path.join(home,'nxbridge.db'),{readOnly:true});
  try{const first=events().find(e=>e.input.hook_event_name==='SessionStart').input,contexts=contextDb.prepare("SELECT key,value FROM settings WHERE key LIKE 'hookContext:%'").all();assert.ok(contexts.some(row=>JSON.parse(row.value)===first.session_id),'首次原生轮次后必须已经持久化 hook 上下文');stage({phase:'首次轮次 hook 上下文已持久化',sessionId:first.session_id,contexts:contexts.length});}finally{contextDb.close();}
  stage({phase:'daemon 官方控制信息',info:result.daemonInfo,command:result.daemonCommand});assert.ok(daemonIdentity,'未取得 daemon 身份，不能据 embedded 结果宣称 daemon 已验收');assert.notEqual(daemonIdentity.pid,terminal.identity.pid);
  if(wakeProbeOnly){
    const {connectAppServer}=await load('hosts/codex/adapter'),{readCodexHistory}=await load('hosts/codex/codex-history');
    client=await connectAppServer('unix://'+result.daemonInfo.socketPath,config,undefined,home,{readOnly:true});
    const firstId=events().find(e=>e.input.hook_event_name==='SessionStart').input.session_id;
    stage({phase:'唤醒探针读取原生空闲状态'});
    const idleDeadline=Date.now()+5000;while((await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread.status.type!=='idle'){assert.ok(Date.now()<idleDeadline,'唤醒探针要求原生线程先处于空闲');await delay(50);}
    const before=(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread,headers=requestHeaders.at(-1),offset=terminal.output.length,count=requests.length,callId='nxbridge-daemon-native-wake-probe',messageId='daemon-native-wake-probe';
    let tui={pid:terminal.identity.pid};
    if(process.platform==='linux'){
      const nativeEnvironment=Object.fromEntries(readFileSync('/proc/'+terminal.identity.pid+'/environ','utf8').split('\0').filter(Boolean).map(value=>{const split=value.indexOf('=');return[value.slice(0,split),value.slice(split+1)];}));
      tui={...tui,homeMatches:realpathSync(nativeEnvironment.CODEX_HOME)===realpathSync(codexhome),stdin:readlinkSync('/proc/'+terminal.identity.pid+'/fd/0'),stdout:readlinkSync('/proc/'+terminal.identity.pid+'/fd/1')};
    }else if(process.platform==='darwin'){
      const {readMacProcessOutput,parseLsofFields}=await load('hosts/macos-tui');
      const files=parseLsofFields(await readMacProcessOutput('/usr/sbin/lsof',['-nP','-a','-p',String(terminal.identity.pid),'-d','0,1','-F','pftn']));
      const input=files.find(file=>file.pid===terminal.identity.pid&&/^0/.test(file.fd)),output=files.find(file=>file.pid===terminal.identity.pid&&/^1/.test(file.fd));
      assert.equal(input?.type,'CHR');assert.equal(output?.name,input?.name);assert.match(input.name,/^\/dev\/(?:ttys|pts\/)/);
                                                         
      tui={...tui,requestedHome:codexhome,stdin:input.name,stdout:output.name};
    }
    result.wakeProbe={threadKeys:Object.keys(before),status:before.status,canAcceptDirectInput:before.canAcceptDirectInput,tui};
    try{
      await client.request('thread/inject_items',{threadId:firstId,items:[{type:'function_call',call_id:callId,name:'receive_messages',namespace:'claude',arguments:'{}'},{type:'function_call_output',call_id:callId,name:'receive_messages',namespace:'claude',output:JSON.stringify({messages:[{message_id:messageId,from:'隔离测试搭档',message:'DAEMON_INJECTED_WAKE_PROBE'}],status:'received'})}]},{mutation:true});
      result.wakeProbe.injected=true;
      const started=await client.request('turn/start',{threadId:firstId,input:[]},{mutation:true});result.wakeProbe.turn=started.turn;
      await terminal.wait(()=>requests.length>count&&stripVTControlCharacters(terminal.output.slice(offset)).includes('DAEMON_LOCAL_DONE_'),'外部启动轮次未在附着 TUI 显示',15000);
      stage({phase:'唤醒探针外部轮次已显示，读取历史'});
      result.wakeProbe.tuiRendered=true;result.wakeProbe.headers={before:headers,after:requestHeaders.at(-1)};
      const after=(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread,history=await readCodexHistory(after.path,firstId);
      result.wakeProbe.receipt=history.receipts.find(value=>value.callId===callId&&value.messageId===messageId);result.wakeProbe.persistentReceipt=!!result.wakeProbe.receipt;
      assert.deepEqual(requestHeaders.at(-1),headers,'daemon 主动续跑不得改变用户全局 UA 或 originator');
      const completedBy=Date.now()+5000;while((await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread.status.type!=='idle'){assert.ok(Date.now()<completedBy,'注入轮次尚未真正空闲');await delay(50);}
    }catch(error){result.wakeProbe.error=String(error);}
    await terminal.close();terminal=undefined;
    stage({phase:'唤醒探针关闭 TUI 后读取状态'});
    const afterClose=(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread;result.wakeProbe.justClosed={status:afterClose.status,canAcceptDirectInput:afterClose.canAcceptDirectInput};
    if(afterClose.status.type==='idle'){
      const closedCount=requests.length;
      stage({phase:'唤醒探针无 TUI 时启动隔离空输入轮次'});
      try{await client.request('turn/start',{threadId:firstId,input:[]},{mutation:true});const end=Date.now()+3000;while(requests.length===closedCount&&Date.now()<end)await delay(50);result.wakeProbe.noTuiRan=requests.length>closedCount;}
      catch(error){result.wakeProbe.noTuiError=String(error);}
      const idleBy=Date.now()+5000;while((await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread.status.type==='active'&&Date.now()<idleBy)await delay(50);
      stage({phase:'唤醒探针无 TUI 轮次已结束，检查审批'});
      const approvalCall='nxbridge-daemon-approval-probe';
      try{
        const approvals=[];client.on('request',message=>approvals.push({method:message.method,threadId:message.params?.threadId}));
        await client.request('thread/inject_items',{threadId:firstId,items:[{type:'function_call',call_id:approvalCall,name:'receive_messages',namespace:'claude',arguments:'{}'},{type:'function_call_output',call_id:approvalCall,name:'receive_messages',namespace:'claude',output:JSON.stringify({messages:[{message_id:'daemon-approval-task',from:'隔离测试搭档',message:'DAEMON_APPROVAL_PROBE'}],status:'received'})}]},{mutation:true});
        const approval=await client.request('turn/start',{threadId:firstId,input:[],approvalPolicy:'on-request'},{mutation:true});
        await delay(2000);const pending=(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread;
        result.wakeProbe.noTuiApproval={requests:approvals,status:pending.status};
        if(pending.status.type==='active')await client.request('turn/interrupt',{threadId:firstId,turnId:approval.turn.id},{mutation:true});
      }catch(error){result.wakeProbe.noTuiApprovalError=String(error);}
    }
    const deadline=Date.now()+12000;let final;
    do{final=(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread.status;if(final.type==='notLoaded')break;await delay(200);}while(Date.now()<deadline);
    result.wakeProbe.afterTuiClosed=final;stage({phase:'隔离 daemon 外部注入续跑探针',...result.wakeProbe});
    result.daemonReproduced=true;result.realModelCalls=0;
  }
  if(acceptance&&!wakeProbeOnly){
    const beforeReadOnly=requestHeaders.at(-1),{connectAppServer}=await load('hosts/codex/adapter');client=await connectAppServer('unix://'+result.daemonInfo.socketPath,config,undefined,home,{readOnly:true});
    const wait=async check=>{const deadline=Date.now()+14000;while(!await check()){assert.ok(Date.now()<deadline,'原生状态未在期限内收敛');await delay(200);}};
    const firstId=events().find(e=>e.input.hook_event_name==='SessionStart').input.session_id,rootPeer=result.daemonStatus.peers.find(p=>p.sessionId===firstId);
                                                      
    await wait(async()=>(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread.status.type==='idle');
                                                     
    const {Store}=await load('storage/store'),{Broker}=await load('broker/coordinator'),{FakeAdapter}=await load('tests/support/fake-adapter'),idleStore=new Store(':memory:'),idleBroker=new Broker(idleStore,config,{codex:new FakeAdapter(),claude:new FakeAdapter()},home);
    try{
      await idleBroker.daemons.scan(codexhome);
      const total=()=>Number(idleStore.db.prepare('SELECT total_changes() AS n').get().n),before=total(),cpu=process.cpuUsage(),began=performance.now();
      for(let index=0;index<6;index++){await delay(5000);await idleBroker.daemons.scan(codexhome);}
      const used=process.cpuUsage(cpu);result.daemonIdle={loadedThreads:idleStore.peers().length,scans:6,wallMs:performance.now()-began,sqliteRowsChanged:total()-before,cpuMs:(used.user+used.system)/1000};
      assert.ok(result.daemonIdle.loadedThreads>0);assert.equal(result.daemonIdle.sqliteRowsChanged,0);stage({phase:'真实 daemon 空闲增量扫描',...result.daemonIdle});
    }finally{await idleBroker.stop();idleStore.close();}
    const readOnlyCalls=requests.length;await turn('DAEMON_IDENTITY_AFTER_READ_ONLY');assert.ok(requests.length>readOnlyCalls);assert.deepEqual(requestHeaders.at(-1),beforeReadOnly,'只读发现连接不得改写用户 daemon 的实际出站 UA');result.daemonIdentity={before:beforeReadOnly,after:requestHeaders.at(-1),unchanged:true};stage({phase:'共享 daemon 用户 UA 在只读连接前后逐字不变',...result.daemonIdentity});
    await wait(async()=>(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread.status.type==='idle');
    const c=await brokerCall('register',{host:'claude',sessionId:'fixture-claude',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'claude-inbox',address:path.join(root,'fixture-inbox.sock'),epoch:'fixture-claude',pid:process.pid,procStart:(await processIdentity(process.pid)).startedAt,configHome:claudehome}},{home,start:false});
    const pair=await brokerCall('pair',{claude:c.id,codex:rootPeer.id},{home,start:false}),actor={host:'claude',memberId:c.id,sessionId:c.sessionId,callId:'acceptance-send',binding:c.binding};
    const {DeliveryHealth}=await load('broker/health/delivery'),noticeStore=new Store(path.join(home,'nxbridge.db')),passiveMarker='DAEMON_PASSIVE_HEALTH_FACT';
                                                               
    try{new DeliveryHealth(noticeStore).enqueue(pair.id,rootPeer.id,{id:'native-passive-health',state:'pending',tier:3,kind:'native-passive-information',message:passiveMarker});}finally{noticeStore.close();}
    const passiveRequests=requests.length;await delay(6500);assert.equal(requests.length,passiveRequests,'信息类通知不能启动真实 daemon 模型轮次');
    await turn('DAEMON_PASSIVE_NEXT_NATURAL');
    const passiveVisible=requests.slice(passiveRequests).some(value=>JSON.stringify(value).includes(passiveMarker));
    stage({phase:'被动通知 hook 回执',visible:passiveVisible,hookOutput:existsSync(hookOutputFile)?readFileSync(hookOutputFile,'utf8').trim().split('\n').map(JSON.parse):[]});
    if(!passiveVisible){const debugStore=new Store(path.join(home,'nxbridge.db'));try{stage({phase:'被动通知诊断',record:debugStore.setting('turnHealthDelivery:'+pair.id+':'+rootPeer.id),admission:debugStore.setting('healthNoticeAdmission:'+rootPeer.id),lastHook:debugStore.setting('lastHook'),peers:debugStore.peers(),endpoints:debugStore.endpoints(),bindings:debugStore.db.prepare('SELECT * FROM window_bindings').all(),contexts:debugStore.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'hookContext:%'").all(),recentEvents:debugStore.events(0,1000).slice(-15),hooks:events(),hookOutput:existsSync(hookOutputFile)?readFileSync(hookOutputFile,'utf8').trim().split('\n').map(JSON.parse):[],inputKeys:requests.slice(passiveRequests).map(value=>Object.keys(value))});}finally{debugStore.close();}}
    assert.ok(passiveVisible,'下一次正常原生输入必须看到被动通知');
    await wait(async()=>(await client.request('thread/read',{threadId:firstId,includeTurns:false})).thread.status.type==='idle');
    stage({phase:'真实 daemon 信息通知零自动轮次，正常下一轮可见'});
    const marker='DAEMON_BOUNDED_WAKE_SAVED',outputOffset=terminal.output.length,wakeStops=events().filter(e=>e.input.hook_event_name==='Stop').length,sent=await brokerCall('send',{actor,message:marker},{home,start:false});assert.equal(sent.delivery_mode,'daemon-direct',JSON.stringify(sent));assert.equal(sent.read_confirmed,false);
    assert.equal((await client.request('thread/queue/list',{threadId:firstId})).data.length,0);
    await terminal.wait(()=>{const output=stripVTControlCharacters(terminal.output.slice(outputOffset)),done=output.lastIndexOf('DAEMON_LOCAL_DONE_');return requests.some(r=>JSON.stringify(r.input).includes(marker))&&events().filter(e=>e.input.hook_event_name==='Stop').length>wakeStops&&done>=0&&output.slice(done).includes('Worked for');},'有限唤醒未在原生窗口完成轮次及 hooks',15000);
    await wait(async()=>(await brokerCall('message',{message_id:sent.message_id},{home,start:false})).state==='contextObserved');
    assert.equal((await brokerCall('message',{message_id:sent.message_id},{home,start:false})).attempts,1);assert.deepEqual(requestHeaders.at(-1),beforeReadOnly);
    assert.equal((await status()).peers.find(p=>p.id===rootPeer.id).permission,'prompting');stage({phase:'明确配对后原生有限唤醒、D1准确回执、原UA和只读权限通过'});
    const forkOffset=terminal.output.length;await terminal.prompt('/fork');await terminal.wait(()=>stripVTControlCharacters(terminal.output.slice(forkOffset)).replace(/\s+/gu,'').includes('Forkcreated.Youcancontinuehere.'),'fork 界面未出现');await turn('MCP_PROBE_4');
    const forkId=events().filter(e=>e.input.hook_event_name==='SessionStart').at(-1).input.session_id;assert.equal((await client.request('thread/read',{threadId:forkId})).thread.forkedFromId,firstId);
    const parentAfterFork=(await client.request('thread/read',{threadId:firstId})).thread;
    if(parentAfterFork.status.type!=='notLoaded'){
      assert.equal((await status()).peers.find(p=>p.id===rootPeer.id)?.sessionId,firstId);
      stage({phase:'fork 后父线程仍有原生订阅，保持原配对',parentStatus:parentAfterFork.status});
      secondTerminal=await start(false,root,forkId);await terminal.close();terminal=secondTerminal;secondTerminal=undefined;
    }
    await wait(async()=>(await status()).peers.find(p=>p.id===rootPeer.id)?.sessionId===forkId);assert.equal((await status()).pairs.find(p=>p.id===pair.id)?.codex,rootPeer.id);
    const firstTerminal=terminal,other=path.join(root,'other-project');mkdirSync(other);secondTerminal=await start(false,other);terminal=secondTerminal;await turn('MCP_PROBE_2');
    const secondId=events().filter(e=>e.input.hook_event_name==='SessionStart').at(-1).input.session_id,secondPeer=(await status()).peers.find(p=>p.sessionId===secondId);assert.equal(secondPeer.cwd,other);assert.notEqual(secondPeer.id,rootPeer.id);terminal=firstTerminal;
    const newOffset=terminal.output.length;await terminal.prompt('/new');await terminal.wait(()=>codexComposerReady(terminal.output.slice(newOffset),'gpt-5.1-codex low'),'新会话尚未准备好接收输入');
                                                      
    await turn('MCP_PROBE_3');
    const newId=events().filter(e=>e.input.hook_event_name==='SessionStart').at(-1).input.session_id;assert.notEqual(newId,forkId);
    await wait(async()=>!(await status()).endpoints.some(endpoint=>endpoint.peerId===rootPeer.id&&endpoint.active));
    const held=await brokerCall('send',{actor:{...actor,callId:'held-after-new'},message:'HELD_AFTER_NEW_NO_HEADLESS'},{home,start:false});
    assert.equal(held.persisted,true);assert.equal(held.read_confirmed,false);assert.equal(held.status,'selection_required');assert.equal(held.reason,'hosting');assert.equal(held.current_pair_id,pair.id);assert.ok(held.hosting);assert.ok(held.allowed_actions.includes('wait'));assert.match(held.message,/message saved;/);assert.equal(held.delivery_state,'accepted');
    assert.equal((await client.request('thread/queue/list',{threadId:forkId})).data.length,0);
    await terminal.close();terminal=secondTerminal;secondTerminal=undefined;
                                              
    await wait(async()=>!(await status()).endpoints.some(endpoint=>endpoint.peerId===rootPeer.id&&endpoint.active));
    assert.equal((await status()).pairs.find(p=>p.id===pair.id)?.codex,rootPeer.id);
    const saved=await brokerCall('message',{message_id:held.message_id},{home,start:false});assert.equal(saved.state,'accepted');assert.equal(saved.attempts,0);assert.equal(saved.to,rootPeer.id);assert.equal(saved.body,'HELD_AFTER_NEW_NO_HEADLESS');assert.equal(requests.some(r=>JSON.stringify(r.input).includes('HELD_AFTER_NEW_NO_HEADLESS')),false);
    assert.equal((await status()).lostPairs.some(p=>p.pair_id===pair.id),false);assert.equal((await client.request('thread/read',{threadId:secondId})).thread.status.type,'idle');
    stage({phase:'原生 fork 唯一继承、跨项目双 TUI、new 后保留消息与原配对通过'});
    const otherTerminal=terminal;secondTerminal=await start(false,root,forkId);terminal=secondTerminal;
    await terminal.wait(()=>requests.some(r=>JSON.stringify(r.input).includes('HELD_AFTER_NEW_NO_HEADLESS')),'原窗口重新加入后未读取保留消息',15000);
    await wait(async()=>(await brokerCall('message',{message_id:held.message_id},{home,start:false})).state==='contextObserved');
    assert.equal((await brokerCall('message',{message_id:held.message_id},{home,start:false})).attempts,1);
    const {readCodexHistory}=await load('hosts/codex/codex-history'),restored=(await client.request('thread/read',{threadId:forkId,includeTurns:false})).thread,restoredHistory=await readCodexHistory(restored.path,forkId);
    assert.equal(restoredHistory.receipts.filter(receipt=>receipt.messageId===held.message_id).length,1);assert.equal((await status()).pairs.find(p=>p.id===pair.id)?.codex,rootPeer.id);
    await terminal.close();terminal=otherTerminal;secondTerminal=undefined;stage({phase:'旧会话原生重新加入，保留消息准确投递一次且历史回执唯一'});
    await brokerCall('shutdown',{releaseOwned:false},{home,start:false});(await ensureBroker(home)).close();await wait(async()=>(await status()).peers.some(p=>p.id===secondPeer.id&&p.state!=='offline'));assert.equal((await client.request('thread/read',{threadId:secondId})).thread.status.type,'idle');
    await terminal?.close();terminal=undefined;await secondTerminal?.close();secondTerminal=undefined;client.close();client=undefined;
    await runCli('codex',['app-server','daemon','stop'],{timeout:12000});terminal=await start(false,other,secondId);await turn('MCP_PROBE_5');
    const info=JSON.parse(await runCli('codex',['app-server','daemon','version'])),newPid=events().filter(e=>e.input.session_id===secondId).at(-1).ppid;await rememberDaemon(newPid);
    assert.notEqual(newPid,hostPid);const resumed=(await status()).peers.filter(p=>p.sessionId===secondId);assert.equal(resumed.length,1);assert.equal(resumed[0].id,secondPeer.id);stage({phase:'broker 重启不卸载用户线程；daemon 新代次恢复同一成员通过',oldPid:hostPid,newPid,info});
  }
  if(!wakeProbeOnly){
  await terminal?.close();terminal=undefined;
  terminal=await start(true);await turn('no-daemon 模式隔离对照');result.embeddedStatus=await status();result.embeddedTui=terminal.identity;result.embeddedHooks=events().slice(result.daemonHooks.length);
  const fixed=true,daemonRegistered=result.daemonStatus.peers.some(p=>p.host==='codex'&&p.sessionId),embeddedRegistered=result.embeddedStatus.peers.some(p=>p.host==='codex'&&p.sessionId);result.daemonReproduced=(fixed?daemonRegistered:!daemonRegistered)&&embeddedRegistered;assert.ok(result.daemonReproduced,JSON.stringify({fixed,daemonRegistered,embeddedRegistered}));if(fixed)assert.ok(result.daemonStatus.endpoints.some(e=>e.daemon&&e.mode==='embedded'));result.realModelCalls=0;stage({phase:fixed?'修复及原生对照通过':'复现已确认',daemonReproduced:result.daemonReproduced,embeddedPeers:result.embeddedStatus.peers.map(p=>({id:p.id,sessionId:p.sessionId}))});
  }
}catch(error){result.error=error.stack??String(error);if(terminal)result.terminal=stripVTControlCharacters(terminal.output).slice(-1500);const log=path.join(home,'run','broker.log');if(existsSync(log))result.brokerLog=readFileSync(log,'utf8').slice(-2000);stage({phase:'失败',error:result.error,brokerLog:result.brokerLog,terminal:result.terminal});process.exitCode=1;}
finally{
  const failures=[],steps=[['终端',()=>terminal?.close()],['第二终端',()=>secondTerminal?.close()],['控制连接',()=>client?.close()]];
  if(daemonLaunchAttempted)steps.push(['隔离 daemon',()=>runCli('codex',['app-server','daemon','stop'],{timeout:12000})]);
                           
  for(const [name,finish] of steps)try{await finish();}catch(error){failures.push(name+'：'+String(error));}
  try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}
  if(failures.length){result.cleanupError=failures.join('\n');process.exitCode=1;}
  model?.closeAllConnections();if(model)await new Promise(resolve=>model.close(resolve));writeFileSync(resultFile,JSON.stringify(result,null,2),'utf8');
}
