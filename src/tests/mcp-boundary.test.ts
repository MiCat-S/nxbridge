import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serveMcp } from '../integration/mcp/server.js';
import { BrokerSession } from '../ipc/ipc.js';
import { RpcClient } from '../ipc/rpc.js';
import {atomicJson} from '../shared/files.js';
import type { Peer } from '../types.js';
import { temporary } from './support/temporary.js';

async function mcp(t:TestContext,kind:Peer['kind'],options:{disabled?:boolean;enabled?:boolean;hookReceipt?:boolean}={}){
  const home=temporary(t),before={NXBRIDGE_HOME:process.env.NXBRIDGE_HOME,CODEX_HOME:process.env.CODEX_HOME};
  process.env.NXBRIDGE_HOME=home;process.env.CODEX_HOME=path.join(home,'codex');
  t.after(()=>{for(const [key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const runtime={pid:process.pid,procStart:'boundary-native',appServer:true,managedDaemon:false};
  if(options.disabled)atomicJson(path.join(home,'member-control.json'),{members:[{peerId:'root-member',host:'codex',sessionId:'root',windows:[{pid:runtime.pid,procStart:runtime.procStart,threadScoped:false}]}]});
  const calls:{method:string;params:any}[]=[],connection=new BrokerSession(home),rpc=new RpcClient(()=>{},()=>{});
  t.mock.method(connection,'connect',async()=>rpc);
  t.mock.method(connection,'request',async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==='mcp.register')return{id:'registered-member',kind,enabled:options.enabled??true};
    if(method==='hook.client.mcp')return{output:{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'隐藏 hook 输出'}},...(options.hookReceipt?{receipt:'receipt-after-send'}:{})};
    return{ok:true};
  });
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=await serveMcp('codex',{connection,transport:serverTransport,codexRuntime:Promise.resolve(runtime)}),client=new Client({name:'boundary-test',version:'1'});
  t.after(async()=>{await client.close();await server.close();rpc.close();});
  await client.connect(clientTransport);
  return{client,calls};
}

for(const scenario of [
  {name:'已核验子线程',kind:'subagent',meta:{threadId:'child',sessionId:'child'},code:'subagent_denied'},
  {name:'已关闭的已核验子线程',kind:'subagent',meta:{threadId:'child',sessionId:'child'},enabled:false,code:'subagent_denied'},
  {name:'原生发现之前的子线程',kind:'unknown',meta:{threadId:'child',sessionId:'root'},code:'subagent_denied'},
  {name:'缺少原生 sessionId',kind:'unknown',meta:{threadId:'unknown'},code:'unverified_identity'},
] as const)test('实际 MCP 所有工具拒绝'+scenario.name,async t=>{
  const {client,calls}=await mcp(t,scenario.kind,'enabled'in scenario?{enabled:scenario.enabled}:{}),tools=await client.listTools();
  for(const tool of tools.tools){
    const result=await client.callTool({name:tool.name,arguments:{},_meta:scenario.meta}) as {isError?:boolean;content:{text:string}[]};
    assert.equal(result.isError,true,tool.name);assert.equal(JSON.parse(result.content[0]!.text).code,scenario.code,tool.name);
  }
  assert.equal(calls.filter(call=>call.method!=='mcp.register').length,0);
});

test('关闭成员的 MCP 状态入口也拒绝共用进程中的子线程',async t=>{
  const {client,calls}=await mcp(t,'root',{disabled:true});
  const result=await client.callTool({name:'status',arguments:{},_meta:{threadId:'child',sessionId:'root'}}) as {isError?:boolean;content:{text:string}[]};
  assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0]!.text).code,'subagent_denied');assert.deepEqual(calls,[]);
});

test('已核验独立 fork 的 MCP 业务仍使用自己的成员且剔除 via 提示',async t=>{
  const {client,calls}=await mcp(t,'fork');
  const result=await client.callTool({name:'send_message',arguments:{message:'来自独立 fork'},_meta:{threadId:'fork',sessionId:'metadata-parent'}}) as {isError?:boolean};
  assert.notEqual(result.isError,true);
  const sent=calls.find(call=>call.method==='send');assert.ok(sent);assert.equal(sent.params.actor.memberId,'registered-member');assert.equal(sent.params.actor.sessionId,'fork');assert.equal(sent.params.actor.via,undefined);
});

test('隐藏 hook 不出现在模型清单，输出写出后才确认回执且不走模型身份注册',async t=>{
  const {client,calls}=await mcp(t,'root',{hookReceipt:true});
  assert.equal((await client.listTools()).tools.some(tool=>tool.name==='nxbridge_hook'),false);
  const result=await client.callTool({name:'nxbridge_hook',arguments:{session_id:'root',hook_event_name:'PostToolUse'},_meta:{threadId:'root'}}) as {isError?:boolean;content:{text:string}[]};
  assert.notEqual(result.isError,true);assert.equal(JSON.parse(result.content[0]!.text).hookSpecificOutput.additionalContext,'隐藏 hook 输出');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(call=>call.method),['hook.client.mcp','hook.client.ack']);
});
