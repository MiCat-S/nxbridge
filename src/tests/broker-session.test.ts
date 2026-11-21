import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerSession, connectBroker, listenBroker } from '../ipc/ipc.js';
import { RpcClient } from '../ipc/rpc.js';
import { registerMcpIdentity } from '../integration/mcp/server.js';
import {ensureHome} from '../ipc/home.js';
import { temporary } from './support/temporary.js';

test('长驻前端并行调用共用一条连接，断线恢复后不重放结果未知的写入',async t=>{
  const home=temporary(t);await ensureHome(home);let opens=0,writes=0,entered!:()=>void;
  const writing=new Promise<void>(resolve=>entered=resolve),handler=async(method:string)=>{if(method==='write'){writes++;entered();return new Promise(()=>{});}return{ok:true};};
  let server=await listenBroker(home,handler);const session=new BrokerSession(home,async()=>{opens++;return connectBroker(home);});
  t.after(async()=>{session.close();await server.close();});
  const results=await Promise.all(Array.from({length:20},()=>session.request('status')));assert.ok(results.every(r=>r.ok));assert.equal(opens,1);assert.equal(session.connected,true);
  const unknown=session.request('write',{}, {mutation:true}),rejected=assert.rejects(unknown,error=>(error as any).uncertain===true&&(error as any).code==='disconnected');await writing;await server.close();await rejected;
  server=await listenBroker(home,handler);assert.deepEqual(await session.request('status'),{ok:true});assert.equal(opens,2);assert.equal(writes,1);
});

test('关闭期间尚未完成的连接不会留下句柄，也不能再发请求',async()=>{
  let complete!:(rpc:RpcClient)=>void,closed=0;const session=new BrokerSession('/unused',()=>new Promise(resolve=>complete=resolve));
  const pending=session.connect(),rejected=assert.rejects(pending,{code:'disconnected'});session.close();complete(new RpcClient(()=>{},()=>closed++));await rejected;
  assert.equal(closed,1);await assert.rejects(session.request('status'),{code:'disconnected'});
});

test('协调器的大型 Unicode 历史回复不受请求帧上限截断，请求上限仍在入口生效',async t=>{
  const home=temporary(t);await ensureHome(home);
  const body='汉🙂'.repeat(750000);let requests=0;
  const server=await listenBroker(home,async method=>{requests++;return method==='history'?{body}:{ok:true};});
  const rpc=await connectBroker(home);t.after(async()=>{rpc.close();await server.close();});
  assert.equal((await rpc.request('history')).body,body);
  assert.deepEqual(await rpc.request('ping'),{ok:true});
  await assert.rejects(rpc.request('oversized',{body:'a'.repeat(2*1024*1024+1)}),{code:'disconnected'});
  assert.equal(requests,2,'超长请求不能进入业务处理');
});

test('长驻 MCP 的启动类请求超过十五秒仍可确认，调用方短预算仍生效',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const pending:any[]=[],rpc=new RpcClient(message=>pending.push(message),()=>{}),session=new BrokerSession('/unused',async()=>rpc);
  t.after(()=>session.close());await session.connect();
  for(const method of ['send','pair.selection.resolve','pair.selection.commit']){
    const response=session.request(method,{}, {mutation:true});await Promise.resolve();await Promise.resolve();t.mock.timers.tick(16000);
    rpc.receive({id:pending.at(-1).id,result:{confirmed:true}});assert.deepEqual(await response,{confirmed:true});
  }
  const short=session.request('pair.selection.resolve',{}, {mutation:true,timeout:100}),rejected=assert.rejects(short,{code:'timeout',uncertain:true});
  await Promise.resolve();await Promise.resolve();t.mock.timers.tick(101);await rejected;
});

test('MCP 身份注册覆盖慢恢复，保留有界等待且不重放注册或业务写入',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const pending:any[]=[],rpc=new RpcClient(message=>pending.push(message),()=>{}),session=new BrokerSession('/unused',async()=>rpc);
  t.after(()=>session.close());await session.connect();
  for(const method of ['mcp.register','register'] as const){
    const count=pending.length,response=registerMcpIdentity(session,method,{});await Promise.resolve();await Promise.resolve();t.mock.timers.tick(16000);
    assert.equal(pending.length,count+1);rpc.receive({id:pending.at(-1).id,result:{id:'verified-member'}});assert.deepEqual(await response,{id:'verified-member'});
    const bounded=registerMcpIdentity(session,method,{}),expired=assert.rejects(bounded,{code:'timeout',uncertain:false});await Promise.resolve();await Promise.resolve();t.mock.timers.tick(45001);await expired;
    assert.equal(pending.length,count+2,'超时不能自行重发注册，更不能发送业务负载');
    const short=session.request(method,{}, {timeout:100}),shortExpired=assert.rejects(short,{code:'timeout'});await Promise.resolve();await Promise.resolve();t.mock.timers.tick(101);await shortExpired;
    const otherCaller=session.request(method),ordinaryExpired=assert.rejects(otherCaller,{code:'timeout'});await Promise.resolve();await Promise.resolve();t.mock.timers.tick(15001);await ordinaryExpired;
  }
  const ordinary=session.request('status'),expired=assert.rejects(ordinary,{code:'timeout'});await Promise.resolve();await Promise.resolve();t.mock.timers.tick(15001);await expired;
});
