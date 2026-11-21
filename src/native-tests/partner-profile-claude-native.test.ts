import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish } from './publish-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import { processIdentity, claudeBackgroundHost, processAncestors, codexArguments } from '../process/process.js';
import {readJson} from '../shared/files.js';
import { writeConfiguration } from '../config/configuration.js';
import { stopOwnedProcess } from '../process/process-stop.js';
import { nativeOwnership } from '../process/owned-native.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';

                                                              
test('Windows 原生后台 Claude：新建核对、被结束后以同一会话恢复，保留模型与推理强度且不改用户设置',{skip:process.platform!=='win32',timeout:175000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex');
  for(const directory of [home,claudehome,codexhome])mkdirSync(directory);
  const errors:string[]=[],models:string[]=[];let requests=0,status:any,passed=false;
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests++;models.push(body.model);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{id:'profile-'+requests,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'PROFILE_DONE'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end();}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'profile-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{try{
    if(!passed){const adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeHome:claudehome,codexHome:codexhome},home);try{const agents=await adapter.list(undefined,claudehome).catch(()=>[]),native=agents.find((agent:any)=>agent.pid),identity=native?await processIdentity(native.pid):undefined,controller=identity?await claudeBackgroundHost(identity,native.sessionId):undefined,daemon:any=readJson(path.join(claudehome,'daemon.status.json'));if(identity)t.diagnostic(JSON.stringify({stage:'ancestry',chain:await Promise.all((await processAncestors(identity.pid,3)).map(async process=>({identity:process,argv:(await codexArguments(process)).map(arg=>/^--[a-z-]+$|^[a-f0-9-]{36}$/i.test(arg)?arg:'（参数值省略）')})))}));t.diagnostic(JSON.stringify({requests,models,errors,status,agents,controller,parent:controller?await processIdentity(controller.parentPid):undefined,daemon:{pid:daemon.pid,procStart:daemon.procStart,supervisorPid:daemon.supervisorPid,supervisorProcStart:daemon.supervisorProcStart},events:await brokerCall('events').catch(()=>undefined)}));}finally{adapter.close();}}
    await temp.cleanup();
  }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,compatibilityWake:'strict',claudeHome:claudehome,codexHome:codexhome}),'utf8');
  writeConfiguration(home,[{key:'partners.claude.model',value:'opus'},{key:'partners.claude.effort',value:'high'}],'setup');
  writeFileSync(path.join(codexhome,'config.toml'),'web_search="disabled"\n[features]\napps=false\nremote_plugin=false\n','utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
                                        
  const settings=JSON.stringify({skipDangerousModePermissionPrompt:true,permissions:{defaultMode:'default'},env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});writeFileSync(path.join(claudehome,'settings.json'),settings,'utf8');
  await setupPublish();const userSettings=readFileSync(path.join(claudehome,'settings.json'),'utf8'),native=await processIdentity(process.pid);
  await brokerCall<any>('register',{host:'codex',sessionId:'profile-source',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'source',pid:process.pid,procStart:native.startedAt}});
  const receipt=await brokerCall('send',{actor:{host:'codex',sessionId:'profile-source',callId:'task'},message:'PROFILE_LOCAL_TASK'});
  const end=Date.now()+60000;while(true){status=await brokerCall('status');if(status.messages.find((m:any)=>m.id===receipt.message_id)?.state==='contextObserved'&&requests>=1)break;assert.ok(Date.now()<end,'新后台未在核对后收到首份任务');await delay(200);}
  const peer=status.peers.find((p:any)=>p.host==='claude'&&p.owner==='nxbridge'),endpoint=status.endpoints.find((e:any)=>e.peerId===peer?.id&&e.active);
  const profile=endpoint?.nativeProfile,view=peer?.partner_profile;
  t.diagnostic(JSON.stringify({nativeProfile:profile,partnerProfile:view,peerModel:peer?.model,peerEffort:peer?.effort,requestModels:models}));
  assert.ok(profile,'Mod 必须回报原生模型和推理强度');
  assert.deepEqual(profile.flag,{model:'opus',effort:'high'});assert.equal(profile.effective?.model,'opus');assert.equal(typeof profile.model,'string');
  assert.equal(view?.status,'applied');assert.equal(view?.delivery_held,false);
  assert.ok(models.length>=1&&models.every(value=>value===profile.model),'首份任务必须用核对过的已解析模型');assert.equal(peer.model,profile.model);assert.equal(peer.effort,'high');
  assert.equal(readFileSync(path.join(claudehome,'settings.json'),'utf8'),userSettings);assert.deepEqual(errors,[]);
  const idle=Date.now()+15000;while(status.peers.find((p:any)=>p.id===peer.id)?.state!=='ready'){assert.ok(Date.now()<idle,'首份任务未结束');await delay(100);status=await brokerCall('status');}
  const ownership=nativeOwnership(home,peer.id);assert.ok(ownership?.native);
  await stopOwnedProcess(ownership.native,{force:true});
  const adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeHome:claudehome,codexHome:codexhome},home);
  try{t.diagnostic(JSON.stringify({stage:'killed',ownership,agents:await adapter.list(undefined,claudehome)}));}finally{adapter.close();}
  const before=requests,recovered=await brokerCall('send',{actor:{host:'codex',sessionId:'profile-source',callId:'after-kill'},message:'PROFILE_RECOVERY_TASK'}),recoveryEnd=Date.now()+40000;
  while(true){status=await brokerCall('status');if(status.messages.find((m:any)=>m.id===recovered.message_id)?.state==='contextObserved'&&requests>before)break;assert.ok(Date.now()<recoveryEnd,'原生后台退出后未恢复同一会话并继续投递');await delay(200);}
  const current=status.peers.find((p:any)=>p.id===peer.id),rebound=status.endpoints.find((e:any)=>e.peerId===peer.id&&e.active),restored=nativeOwnership(home,peer.id);
  assert.equal(current.sessionId,peer.sessionId);assert.equal(restored?.sessionId,peer.sessionId);assert.notEqual(rebound.pid,endpoint.pid);
  assert.equal(current.partner_profile.status,'applied');assert.equal(current.partner_profile.delivery_held,false);assert.equal(current.model,profile.model);assert.equal(current.effort,'high');
  assert.ok(models.every(value=>value===profile.model));assert.equal(readFileSync(path.join(claudehome,'settings.json'),'utf8'),userSettings);assert.deepEqual(errors,[]);
  assert.equal(restored?.handle,ownership.handle,'原生管理器重建时必须保留原 handle，不能创建副本');
  t.diagnostic(JSON.stringify({stage:'recovered',sessionId:current.sessionId,beforePid:endpoint.pid,afterPid:rebound.pid,profile:current.partner_profile,requests,realModelCalls:0}));
                                               
  const settled=Date.now()+15000;while(status.peers.find((p:any)=>p.id===peer.id)?.state!=='ready'){assert.ok(Date.now()<settled,'恢复后的任务未结束');await delay(100);status=await brokerCall('status');}
  await brokerCall('pause');
  const controller=await claudeBackgroundHost(await processIdentity(restored!.native!.pid)),daemon:any=readJson(path.join(claudehome,'daemon.status.json'));
  assert.ok(controller);assert.ok(restored?.supervisor);
  await stopOwnedProcess(restored.supervisor,{force:true});
  await stopOwnedProcess(controller,{force:true});await stopOwnedProcess(restored.native!,{force:true});
  if(daemon.pid&&daemon.pid!==restored.supervisor.pid){const identity=await processIdentity(daemon.pid).catch(()=>undefined);if(identity)await stopOwnedProcess(identity,{force:true});}
  const coldBefore=requests,cold=await brokerCall('send',{actor:{host:'codex',sessionId:'profile-source',callId:'after-tree-kill'},message:'PROFILE_COLD_RECOVERY_TASK'});
  await brokerCall('resume');const coldEnd=Date.now()+50000;
  while(true){status=await brokerCall('status');if(status.messages.find((m:any)=>m.id===cold.message_id)?.state==='contextObserved'&&requests>coldBefore)break;assert.ok(Date.now()<coldEnd,'整棵原生后台树退出后未以同一会话冷恢复');await delay(200);}
  const coldPeer=status.peers.find((p:any)=>p.id===peer.id),coldOwnership=nativeOwnership(home,peer.id);
  assert.equal(coldPeer.sessionId,peer.sessionId);assert.equal(coldOwnership?.sessionId,peer.sessionId);assert.notEqual(coldOwnership?.supervisor?.pid,restored.supervisor.pid);
  assert.equal(coldPeer.partner_profile.status,'applied');assert.equal(coldPeer.partner_profile.delivery_held,false);assert.equal(coldPeer.model,profile.model);assert.equal(coldPeer.effort,'high');
  assert.ok(models.every(value=>value===profile.model));assert.equal(readFileSync(path.join(claudehome,'settings.json'),'utf8'),userSettings);assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify({stage:'cold-recovered',sessionId:coldPeer.sessionId,profile:coldPeer.partner_profile,requests,realModelCalls:0}));passed=true;
});
