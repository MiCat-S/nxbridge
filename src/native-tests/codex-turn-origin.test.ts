import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {stripVTControlCharacters} from 'node:util';
import {stringify} from 'smol-toml';
import {configClient} from '../hosts/codex/stdio-codex.js';
import {readCodexTurnEvidence} from '../hosts/codex/codex-turn-evidence.js';
import {queueCodexWake} from '../hosts/codex/queue-wake.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {temporaryDirectory} from '../tests/support/temporary.js';
import {overrideEnvironment} from '../tests/support/environment.js';
import {delay} from '../shared/time.js';
import {resolveCli} from '../process/host-command.js';
import {processIdentity} from '../process/process.js';
import {privateDirectory} from '../process/permissions.js';
import {spawnContainedCommand} from '../process/contained-command.js';
import {HEALTH_WAKE_NOTICE,type Endpoint,type Peer} from '../types.js';
import {NativeTerminal} from './terminal-fixture.js';
import {readModelBody} from './model-http-fixture.js';

async function localFixture(t:TestContext,close:()=>Promise<void>){
                                                     
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexHome=root;
  mkdirSync(home);
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexHome,OPENAI_API_KEY:'turn-origin-local-only'},restore=overrideEnvironment(env);
  const config={...DEFAULT_CONFIG,codexHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  const requests:unknown[][]=[];let providerError:unknown;
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString('utf8'));requests.push(body.input);
    const id='turn-origin-'+requests.length;
    const item={type:'message',id:'msg-'+id,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'TURN_ORIGIN_DONE_'+requests.length}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}])res.write('data: '+JSON.stringify(event)+'\n\n');
    res.end();
  }catch(error){providerError=error;res.writeHead(500);res.end(String(error));}});
  t.after(async()=>{try{await close();await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restore();}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  writeFileSync(path.join(codexHome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'origin_local',web_search:'disabled',approval_policy:'never',sandbox_mode:'read-only',check_for_update_on_startup:false,suppress_unstable_features_warning:true,features:{apps:false,remote_plugin:false},model_providers:{origin_local:{name:'本地来源验收',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'}}}),'utf8');
  const wait=async(check:()=>boolean|Promise<boolean>,why:string)=>{
    const end=Date.now()+30000;while(!await check()){if(providerError)throw providerError;assert.ok(Date.now()<end,why);await delay(50);}
  };
  return{root,home,codexHome,env,config,requests,wait};
}

test('原生直接轮次及原生队列保留精确的调用方来源标识',{timeout:65000},async t=>{
  let original:Awaited<ReturnType<typeof configClient>>|undefined;
  const f=await localFixture(t,async()=>{await original?.close();}),events:any[]=[];
  original=await configClient(f.config,f.home);original.on('notification',event=>events.push(event));
  const {thread}=await original.request('thread/start',{cwd:f.root,approvalPolicy:'never',sandbox:'read-only'});
  const firstClient=randomUUID(),trigger='nxbridge:'+randomUUID();
  const first=await original.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'直接轮次来源验收'}],turnTrigger:trigger,clientUserMessageId:firstClient});
  await f.wait(()=>events.some(event=>event.method==='turn/completed'&&event.params?.turn?.id===first.turn.id),'直接轮次未完成');
  const queueClient=randomUUID(),queued=await original.request('thread/queue/add',{threadId:thread.id,input:[{type:'text',text:'原生入队来源验收'}],clientUserMessageId:queueClient});
  assert.equal(queued.queuedSubmission.clientUserMessageId,queueClient);
  await f.wait(()=>events.some(event=>event.method==='turn/completed'&&event.params?.turn?.id!==first.turn.id),'同一后台未消费原生队列');
  const {thread:current}=await original.request('thread/read',{threadId:thread.id,includeTurns:false});
  assert.equal(current.id,thread.id);
  await f.wait(async()=>{
    const evidence=await readCodexTurnEvidence(current.path,thread.id);
    return evidence.caughtUp&&evidence.turns.length===2;
  },'原生历史未保存两个完整轮次');
  const {turns}=await readCodexTurnEvidence(current.path,thread.id);
  assert.deepEqual(turns.map(turn=>[turn.trigger,turn.userInputs]),[[trigger,[firstClient]],['queue',[queueClient]]]);
  assert.equal(turns[0]?.turnId,first.turn.id);
  assert.equal(f.requests.length,2);
  t.diagnostic(JSON.stringify({directClientIdPersisted:true,queueClientIdPersisted:true,requests:f.requests.length,realModelCalls:0}));
});

function terminalBinary(configured:string|undefined):string{
  const cli=resolveCli('codex',configured);
  if(!cli.prefix.length)return cli.command;
  const require=createRequire(cli.prefix[0]!);
  const packageFile=require.resolve('@openai/codex-win32-'+process.arch+'/package.json');
  const triple=(process.arch==='arm64'?'aarch64':'x86_64')+'-pc-windows-msvc';
  return path.join(path.dirname(packageFile),'vendor',triple,'bin','codex.exe');
}

test('真实嵌入式终端在原进程内消费队列，并拒绝运行中的同目录 daemon',{skip:process.platform!=='win32',timeout:100000},async t=>{
  let terminal:NativeTerminal|undefined,daemon:Awaited<ReturnType<typeof spawnContainedCommand>>|undefined,daemonDone:Promise<unknown>|undefined;
  const stopDaemon=async()=>{
    if(daemon&&daemon.exitCode===null&&daemon.signalCode===null)daemon.kill();
    await daemonDone;daemon=undefined;daemonDone=undefined;
  };
  const f=await localFixture(t,async()=>{try{await stopDaemon();}finally{await terminal?.close();}});
  const binary=terminalBinary(f.config.codexBinary);
  terminal=await NativeTerminal.start(f.root,f.home,binary,['--no-daemon','--no-alt-screen'],f.root,{...process.env,...f.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const sessions=path.join(f.codexHome,'sessions');
  const rollouts=()=>existsSync(sessions)?readdirSync(sessions,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.jsonl')).map(entry=>path.join(entry.parentPath,entry.name)):[];
  await terminal.prompt(HEALTH_WAKE_NOTICE);
  let file:string|undefined,sessionId:string|undefined;
  await terminal.wait(async()=>{
    file=rollouts()[0];if(!file)return false;
    const text=readFileSync(file,'utf8'),end=text.indexOf('\n');if(end<0)return false;
    sessionId=JSON.parse(text.slice(0,end)).payload.id;
    return (await readCodexTurnEvidence(file,sessionId!)).turns.length===1;
  },'实体终端未完成键入轮次',30000);
  const first=(await readCodexTurnEvidence(file!,sessionId!)).turns[0]!;
  assert.equal(first.trigger,'user');assert.equal(first.userInputs.length,1);assert.ok(first.userInputs[0]);
  const native=terminal.identity,peer:Peer={id:randomUUID(),host:'codex',kind:'root',owner:'user',state:'ready',sessionId:sessionId!,cwd:f.root,name:'来源验收终端',parentId:null,permission:'prompting',updatedAt:0};
  const endpoint:Endpoint={peerId:peer.id,epoch:'native-terminal',mode:'embedded',address:'',pid:native.pid,procStart:native.startedAt,configHome:f.codexHome,active:true,seenAt:0};
  const queueClient=randomUUID(),queue=()=>queueCodexWake(f.home,f.config,peer,endpoint,{clientUserMessageId:queueClient,message:HEALTH_WAKE_NOTICE,beforeSubmit:()=>{}});
  const socketDir=path.join(f.codexHome,'app-server-control'),socket=path.join(socketDir,'app-server-control.sock');
  await privateDirectory(socketDir);
  daemon=await spawnContainedCommand(binary,['--no-daemon','app-server','--listen','unix://'+socket],{home:f.home,cwd:f.root,env:{...process.env,...f.env},stdio:['ignore','ignore','pipe']});
  let daemonError='';daemon.stderr?.setEncoding('utf8').on('data',value=>{daemonError=(daemonError+value).slice(-4000);});
  daemonDone=once(daemon,'close');void daemonDone.catch(()=>{});
  await f.wait(()=>readdirSync(socketDir).includes(path.basename(socket))||daemon?.exitCode!==null,'隔离共享入口未启动');
  assert.ok(readdirSync(socketDir).includes(path.basename(socket)),daemonError);
  await assert.rejects(queue(),{code:'queue_daemon_collision'});
  await stopDaemon();
  assert.ok(readdirSync(socketDir).includes(path.basename(socket)),'原生进程退出后应保留待核验的旧 socket');
  assert.equal((await queue()).clientUserMessageId,queueClient);
  await terminal.wait(async()=>{
    const evidence=await readCodexTurnEvidence(file!,sessionId!);
    return evidence.caughtUp&&evidence.turns.some(turn=>turn.userInputs.includes(queueClient));
  },'原终端未消费带来源编号的队列输入',30000);
  const {turns}=await readCodexTurnEvidence(file!,sessionId!);
  assert.deepEqual(turns.map(turn=>[turn.trigger,turn.userInputs]),[['user',first.userInputs],['queue',[queueClient]]]);
  const final=turns[1]?.final;
  assert.ok(final);
  await terminal.wait(()=>stripVTControlCharacters(terminal!.output).includes(final.text),'队列轮次的最终回复没有出现在原终端');
  const userText=readFileSync(file!,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line))
    .filter(row=>row.type==='response_item'&&row.payload?.role==='user')
    .flatMap(row=>row.payload.content).filter(part=>part?.type==='input_text'&&part.text===HEALTH_WAKE_NOTICE);
  assert.equal(userText.length,2,'键入与队列唤醒应具有完全相同的文本');
  assert.notEqual(first.userInputs[0],queueClient);
  assert.equal((await processIdentity(native.pid)).startedAt,native.startedAt);
  assert.deepEqual(rollouts(),[file]);
  t.diagnostic(JSON.stringify({sameNativeProcess:true,oneNativeHistory:true,liveDaemonRejected:true,staleSocketAccepted:true,realModelCalls:0}));
});
