import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Actor,type BridgeConfig,type ModelProfile} from '../types.js';
import {delay} from '../shared/time.js';
import {ensureHome} from '../ipc/home.js';
import {sameDirectory} from '../shared/files.js';
import { runtimeFor } from '../hosts/managed-runtimes.js';
import { releaseRecordedProcesses } from '../process/owned-processes.js';
import { readSessionProfile, normalizedPermission } from '../hosts/codex/codex-session-profile.js';
import { frozenProfiles } from '../broker/profiles/frozen-profile.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { registration } from '../tests/support/registration.js';
import { temporaryDirectory } from '../tests/support/temporary.js';

                                             
test('真实自有 Codex：默认与显式选择、原会话双字段切换、持久重启及冻结默认值隔离原生配置漂移',{timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexHome=path.join(root,'codex');
  mkdirSync(codexHome);await ensureHome(home);
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:path.join(root,'claude'),OPENAI_API_KEY:'nxbridge-local-profile-test'};
  const restoreEnvironment=overrideEnvironment(env);
  const bodies:any[]=[],errors:string[]=[];
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    bodies.push(JSON.parse(raw.toString()));
    const id='partner-profile-'+bodies.length,item={type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'PROFILE_NATIVE_DONE_'+bodies.length}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  let config:BridgeConfig,adapter:CodexAdapter|undefined,store:Store|undefined,broker:Broker|undefined;
  t.after(async()=>{try{
    await broker?.stop();adapter?.close();assert.deepEqual(await releaseRecordedProcesses(home,()=>true),[]);
  }finally{
    store?.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));
    restoreEnvironment();
    await temp.cleanup();
  }});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const provider='partner_profile_local',nativeFile=path.join(codexHome,'config.toml');
  const nativeConfig=(profile:ModelProfile)=>stringify({model:profile.model,model_reasoning_effort:profile.effort,model_provider:provider,approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',check_for_update_on_startup:false,analytics:{enabled:false},features:{apps:false,remote_plugin:false,code_mode:false},model_providers:{[provider]:{name:'搭档配置原生隔离验收',base_url:`http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,wire_api:'responses',requires_openai_auth:false,request_max_retries:0,stream_max_retries:0}}});
  const defaults={model:'gpt-6.1-sol',effort:'xhigh'},selected={model:'gpt-5.1-codex',effort:'medium'};
  const initialNative=nativeConfig({model:'gpt-5.1-codex',effort:'low'});writeFileSync(nativeFile,initialNative,'utf8');
  config={...DEFAULT_CONFIG,implicit:'on-demand',compatibilityWake:'strict',syncTipMinutes:0,contextTipTokens:[],idleNoticeMinutes:0,codexHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{}),partnerProfiles:{codex:{source:'frozen',...defaults}}};
  const database=path.join(home,'profile-state.db');
  const open=()=>{store=new Store(database);adapter=new CodexAdapter(config,home);broker=new Broker(store,config,{codex:adapter,claude:new FakeAdapter()} as unknown as Adapters,home);};
  open();
  const wait=async(predicate:()=>boolean|Promise<boolean>,reason:string)=>{
    const until=Date.now()+15000;
    while(!await predicate()){assert.ok(Date.now()<until,reason+'；'+JSON.stringify({errors,requests:bodies.map(body=>({model:body.model,effort:body.reasoning?.effort})),events:store!.events(0,100).slice(-12)}));await delay(30);}
  };
  const create=async(name:string,choice:ModelProfile={})=>{
    const source=store!.register(registration('claude','profile-source-'+name,{cwd:root,permission:'bypass'}));
    const actor:Actor={host:'claude',sessionId:source.sessionId!,callId:'profile-create-'+name};
    const view=store!.selections.create(source,actor,config) as any;
    const before=bodies.length,result=await broker!.dispatch('pair.selection.commit',{actor,selection_id:view.selection_id,action:'create',...choice});
    const pair=store!.pairFor(source.id);assert.ok(pair,JSON.stringify(result));
    const peer=store!.peer(pair.codex);assert.ok(peer.sessionId,JSON.stringify({result,peer}));assert.equal(peer.owner,'nxbridge');
    assert.equal(bodies.length,before,'创建后台本身不应调用模型');
    return{actor,peerId:peer.id,sessionId:peer.sessionId,pairId:pair.id};
  };
  const native=async(peerId:string)=>{
    const peer=store!.peer(peerId),rpc=await adapter!.attach(peer,store!.endpoint(peerId)!);
    return{rpc,value:await rpc.request('thread/resume',{threadId:peer.sessionId,excludeTurns:true})};
  };
  const invariants=(value:any)=>({sessionId:value.thread.id,provider:value.modelProvider,cwd:value.cwd,approval:value.approvalPolicy,reviewer:value.approvalsReviewer,sandbox:value.sandbox,permission:value.activePermissionProfile});
  const run=async(peerId:string,marker:string,expected:ModelProfile)=>{
    const peer=store!.peer(peerId),{rpc}=await native(peerId),completed=new Map<string,any>(),before=bodies.length;
    const onNotification=(message:any)=>{if(message.method==='turn/completed')completed.set(message.params.turn.id,message.params.turn);};
    rpc.on('notification',onNotification);
    try{
      const started=await rpc.request('turn/start',{threadId:peer.sessionId,input:[{type:'text',text:marker}]},{mutation:true});
      await wait(()=>completed.has(started.turn.id)&&store!.peer(peerId).state==='ready','原生模型轮次没有完成');
      assert.equal(completed.get(started.turn.id).status,'completed');
      const request=bodies.slice(before).find(body=>JSON.stringify(body.input).includes(marker));assert.ok(request,'原生轮次没有到达本地模型');
      assert.equal(request.model,expected.model);assert.equal(request.reasoning?.effort,expected.effort);
    }finally{rpc.off('notification',onNotification);}
  };
  const primary=await create('default'),first=await native(primary.peerId);
  assert.equal(first.value.model,defaults.model);assert.equal(first.value.reasoningEffort,defaults.effort);
  assert.equal(first.value.modelProvider,provider);assert.equal(sameDirectory(first.value.cwd,root),true);
  const baseline=invariants(first.value),capture=frozenProfiles(home,config).codex!;
  assert.equal(capture.model,defaults.model);assert.equal(capture.effort,defaults.effort);
  assert.equal(readFileSync(nativeFile,'utf8'),initialNative);
  await run(primary.peerId,'PROFILE_DEFAULT_TURN',defaults);
  const originalPermission=normalizedPermission((await readSessionProfile(first.value.thread.path,primary.sessionId)).settings.permissionProfile);
  assert.ok(originalPermission,'原生权限需要有持久基线');
  const changed=await broker!.dispatch('partner.profile',{actor:primary.actor,action:'set',...selected}) as any;
  assert.equal(changed.status,'applied',JSON.stringify(changed));assert.deepEqual(changed.requested,selected);
  const hot=await native(primary.peerId);assert.equal(hot.value.model,selected.model);assert.equal(hot.value.reasoningEffort,selected.effort);
  assert.deepEqual(invariants(hot.value),baseline,'切换模型不得更换会话、提供方、目录或权限');
  await run(primary.peerId,'PROFILE_CHANGED_TURN',selected);
  assert.deepEqual(frozenProfiles(home,config).codex,capture,'成员选择不能改写首次冻结的宿主默认值');
  const oldRuntime=runtimeFor(home,{peerId:primary.peerId})!.value;
  const driftedNative=nativeConfig({model:'gpt-6-sol',effort:'high'});writeFileSync(nativeFile,driftedNative,'utf8');
                                           
  await broker!.stop();broker=undefined;adapter=undefined;store!.close();store=undefined;
  config={...config,partnerProfiles:{codex:{source:'frozen'}}};open();
  const persisted=await broker!.dispatch('partner.profile',{host:'codex',peer_id:primary.peerId,action:'get'}) as any;
  assert.deepEqual(persisted.requested,selected);assert.equal(persisted.status,'applied');
  const beforeRestart=bodies.length,restarted=await broker!.dispatch('codex.restart',{peer_id:primary.peerId}) as any;
  assert.equal(restarted.restarted,true);assert.equal(restarted.session_id,primary.sessionId);assert.notEqual(restarted.pid,oldRuntime.pid);
  assert.equal(bodies.length,beforeRestart,'重启恢复不得调用模型');
  const recovered=await native(primary.peerId);assert.deepEqual(invariants(recovered.value),baseline);
  assert.equal(recovered.value.model,selected.model);assert.equal(recovered.value.reasoningEffort,selected.effort);
  const restored=await readSessionProfile(recovered.value.thread.path,primary.sessionId);
  assert.equal(restored.settings.model,selected.model);assert.equal(restored.settings.reasoningEffort,selected.effort);
  assert.deepEqual(normalizedPermission(restored.settings.permissionProfile),originalPermission);
  assert.equal(store!.pairFor(primary.peerId)?.id,primary.pairId);
  await run(primary.peerId,'PROFILE_RECOVERED_TURN',selected);
  const subsequent=await create('frozen'),frozenNative=await native(subsequent.peerId);
  assert.equal(frozenNative.value.model,defaults.model);assert.equal(frozenNative.value.reasoningEffort,defaults.effort);
  await run(subsequent.peerId,'PROFILE_FROZEN_TURN',defaults);
  const picked={model:'gpt-6-sol',effort:'low'},explicit=await create('picked',picked),explicitNative=await native(explicit.peerId);
  assert.equal(explicitNative.value.model,picked.model);assert.equal(explicitNative.value.reasoningEffort,picked.effort);
  const explicitView=await broker!.dispatch('partner.profile',{host:'codex',peer_id:explicit.peerId,action:'get'}) as any;
  assert.deepEqual(explicitView.requested,picked);assert.equal(explicitView.source,'explicit');
  await run(explicit.peerId,'PROFILE_PICKED_TURN',picked);
  assert.deepEqual(frozenProfiles(home,config).codex,capture);assert.equal(readFileSync(nativeFile,'utf8'),driftedNative);assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify({session:primary.sessionId,default:defaults,selected,picked,provider,modelRequests:bodies.length,realModelCalls:0,brokerDatabaseReopened:true,nativeRuntimeRestarted:true}));
});
