import { copyNodeBinary } from './support/node-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHmac,randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {temporaryDirectory} from './support/temporary.js';
import {FakeAdapter} from './support/fake-adapter.js';
import {Store} from '../storage/store.js';
import {Broker} from '../broker/coordinator.js';
import {listenBroker} from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';
import {processIdentity} from '../process/process.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {BridgeError} from '../shared/errors.js';
import {openModReadReceipt} from '../integration/mod/mod-read-receipt.js';
import type {ModReadTransport} from '../integration/mod/mod-read-server.js';

test('Claude 薄 hook 逐次核验官方父会话；旧版可回退，身份冲突及未知结果不重放',{timeout:60000},async t=>{
  const inherited=Object.fromEntries(['NXBRIDGE_MANAGED_PEER','NXBRIDGE_OWNED_LAUNCH'].map(key=>[key,process.env[key]]));
  t.after(()=>{for(const [key,value] of Object.entries(inherited)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
                                       
  process.env.NXBRIDGE_MANAGED_PEER='0b25357d-dfc4-4d4f-ac9f-7151d659d22e';process.env.NXBRIDGE_OWNED_LAUNCH='claude:e9157d0e-cf67-4e05-9813-df0986cd97a8';
  const temporary=temporaryDirectory(),root=temporary.directory,home=path.join(root,'bridge'),configHome=path.join(root,'claude'),binary=path.join(root,'bin',process.platform==='win32'?'claude.exe':'claude');
  await ensureHome(home);mkdirSync(path.join(configHome,'sessions'),{recursive:true});mkdirSync(path.dirname(binary));copyNodeBinary(binary);
  const store=new Store(':memory:'),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{codex:new FakeAdapter(),claude:new FakeAdapter()} as any,home);
  let unavailable:string|undefined,uncertain=false,forgeHook=false;const calls:string[]=[];
  const server=await listenBroker(home,async(method,params:any)=>{
    calls.push(method);
    if(method==='hook.client.claude'){
      if(unavailable)throw new BridgeError(unavailable,'尚未执行 hook');
      if(uncertain)throw new BridgeError('timeout','已提交的结果未知');
      if(forgeHook){const identity=await processIdentity(params.hook_pid);writeFileSync(path.join(configHome,'sessions',params.hook_pid+'.json'),JSON.stringify({sessionId:'claude-thin',cwd:root,procStart:identity.procStart??identity.startedAt,procStartFt:identity.procStartFt}),'utf8');}
    }
    return broker.dispatch(method,params);
  });
  const script="process.title='claude';const{spawn}=require('node:child_process');process.on('message',({testEnv,...input})=>{const child=spawn(process.execPath,"+JSON.stringify([path.join(PACKAGE_ROOT,'publish/hook-entry.mjs'),'hook','--host','claude'])+",{env:{...process.env,...testEnv},windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('close',code=>process.send({code,out,err}));child.stdin.end(JSON.stringify(input));});process.send('ready');";
  const parent=spawn(binary,['-e',script],{env:{...process.env,NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:configHome,CLAUDE_CODE_MESSAGING_SOCKET:'unix://'+path.join(root,'inbox.sock'),NXBRIDGE_HOOK_STARTED_AT:'',NXBRIDGE_MANAGED_PEER:'',NXBRIDGE_OWNED_LAUNCH:''},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),ended=once(parent,'exit');
  t.after(async()=>{await server.close();await broker.stop();if(parent.exitCode===null&&parent.signalCode===null)parent.kill();await ended;store.close();await temporary.cleanup();});await once(parent,'message');
  const native=await processIdentity(parent.pid!),official=path.join(configHome,'sessions',parent.pid+'.json'),record={sessionId:'claude-thin',cwd:root,procStart:native.procStart??native.startedAt,procStartFt:native.procStartFt};
  const save=(value:unknown)=>writeFileSync(official,JSON.stringify(value),'utf8');save(record);
  const invoke=async(event='SessionStart',extra:Record<string,unknown>={})=>{
    calls.length=0;const ready=once(parent,'message');parent.send({hook_event_name:event,session_id:'claude-thin',cwd:root,source:'startup',transcript_path:path.join(root,'claude-thin.jsonl'),...extra});const result=(await ready)[0];assert.equal(result.code,0,result.err);return{...result,result:JSON.parse(result.out),calls:[...calls]};
  };
  const first=await invoke();assert.equal(first.err,'');assert.deepEqual(first.calls,['hook.client.claude']);
  const peer=store.find('claude','claude-thin')!;assert.ok(peer);assert.equal(peer.owner,'user');assert.equal(store.bindings.current(peer.id)?.pid,parent.pid);assert.equal(store.endpoint(peer.id)?.configHome,configHome);
  const wrong=await invoke('SessionStart',{session_id:'forged-session'});assert.match(wrong.err,/会话已经切换/);assert.equal(store.find('claude','forged-session'),undefined);assert.deepEqual(wrong.calls,['hook.client.claude']);
  save({...record,procStart:'0',procStartFt:'0'});const stale=await invoke();assert.match(stale.err,/进程代次不符/);assert.deepEqual(stale.calls,['hook.client.claude']);save(record);
  unlinkSync(official);forgeHook=true;const forged=await invoke();assert.match(forged.err,/无法从官方会话登记核验/);assert.deepEqual(forged.calls,['hook.client.claude']);forgeHook=false;save(record);
  for(const code of ['unknown_method','process_identity_unknown','native_identity_unavailable']){
    unavailable=code;const old=await invoke();assert.equal(old.err,'',code);assert.deepEqual(old.calls,['hook.client.claude','ping','register'],code);
  }unavailable=undefined;
  for(const config_home of ['relative-config',...(process.platform==='win32'?['\\\\server\\share']:[])])await assert.rejects(broker.dispatch('hook.client.claude',{hook_pid:parent.pid,config_home,cwd:root,started_at:Date.now(),elapsed_ms:0,input:{hook_event_name:'SessionStart',session_id:'claude-thin'}}),{code:'hook_identity_unavailable'});
  uncertain=true;const unknown=await invoke();assert.match(unknown.err,/结果未知/);assert.deepEqual(unknown.calls,['hook.client.claude']);uncertain=false;
  const dispatch=broker.dispatch.bind(broker);t.mock.method(broker,'dispatch',async(method:string,params:any)=>{const result=await dispatch(method,params);if(method==='register')throw new BridgeError('starting','登记后出现同名错误');return result;});
  const committed=await invoke();assert.match(committed.err,/登记后出现/);assert.deepEqual(committed.calls,['hook.client.claude']);t.mock.restoreAll();
  const end=await invoke('SessionEnd',{testEnv:{CLAUDE_CODE_MESSAGING_SOCKET:''}});assert.equal(end.err,'');assert.deepEqual(end.calls,['hook.client.claude']);assert.equal(store.bindings.current(peer.id)?.transitioning,true);
  save({...record,sessionId:'claude-resumed'});const resumed=await invoke('SessionStart',{session_id:'claude-resumed',source:'resume'});assert.equal(resumed.err,'');
  const resumedPeer=store.find('claude','claude-resumed')!;assert.ok(resumedPeer);assert.equal(store.bindings.current(resumedPeer.id)?.pid,parent.pid);assert.equal(store.bindings.current(resumedPeer.id)?.transitioning,false);
  const binding=store.bindings.current(resumedPeer.id)!,actor={host:'claude' as const,sessionId:resumedPeer.sessionId!,callId:'write-probe',binding:{key:binding.key,epoch:binding.epoch}};
  const credential=await openModReadReceipt(home,configHome,{pid:parent.pid!,native,record:{...record,sessionId:resumedPeer.sessionId!}});
  const transport=await broker.dispatch('mod.read.open',{actor,credential}) as ModReadTransport;assert.ok(transport.write);
  const write=async(token:ModReadTransport,input:unknown)=>{
    const nonce=randomBytes(32).toString('hex'),post=(value:unknown)=>{const body=JSON.stringify(value);return fetch(transport.write!.url,{method:'POST',headers:{'Content-Type':'application/json','X-Nxbridge-Id':token.id,Authorization:'HMAC '+createHmac('sha256',Buffer.from(token.secret,'hex')).update(body).digest('hex')},body});};
    const ready=await post({phase:'prepare',nonce,operation:'state',bytes:Buffer.byteLength(JSON.stringify(input))});if(ready.status!==200)return ready;
    const ticket=JSON.parse((await ready.json()).body).ticket;
    return post({phase:'commit',nonce,ticket,input});
  };
  const input={operation:'state',sessionId:resumedPeer.sessionId,binding:actor.binding,contextStart:false,inbox:store.endpoint(resumedPeer.id)!.address,state:'busy'};
  assert.equal((await write(transport,input)).status,401,'只读能力不能写入');
  const changed=await write(transport.write!,input);assert.equal(changed.status,200,await changed.text());assert.equal(store.peer(resumedPeer.id).state,'busy');
  save({...record,sessionId:resumedPeer.sessionId,procStart:'0',procStartFt:'0'});
  assert.equal((await write(transport.write!,{...input,state:'ready'})).status,409,'身份拒绝发生于业务准入之前');assert.equal(store.peer(resumedPeer.id).state,'busy');
  save({...record,sessionId:resumedPeer.sessionId});
});
