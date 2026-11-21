import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { listenBroker, connectBroker, brokerCall } from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';
import { codexIdentity } from '../integration/mcp/server.js';
import { modelError, MODEL_ERROR_FALLBACK } from '../integration/mcp/model-output.js';
import {BridgeError,DeliveryError} from '../shared/errors.js';
import { RpcClient } from '../ipc/rpc.js';
import { temporary } from './support/temporary.js';

test('Zod 直接与 IPC 往返保留字段路径，身份缺失不归类为用户参数错误',async t=>{
  const schema=z.object({questions:z.array(z.object({id:z.string()}))}),input={questions:[{id:1}]};
  const checked=schema.safeParse(input);assert.equal(checked.success,false);if(checked.success)return;
  const direct=modelError(checked.error);assert.equal(direct.code,'invalid_arguments');assert.match(direct.message,/questions\.0\.id:/);assert.doesNotMatch(direct.message,/\n/);
  const home=temporary(t);await ensureHome(home);
  const server=await listenBroker(home,async()=>schema.parse(input));
  const client=await connectBroker(home);
  try{
    await assert.rejects(client.request('validate'),error=>{
      const remote=modelError(error);assert.equal(remote.code,direct.code);assert.equal(remote.message,direct.message);assert.equal(remote.uncertain,false);return true;
    });
  }finally{client.close();await server.close();}
  for(const meta of [{},{threadId:''},{threadId:1}])assert.throws(()=>codexIdentity(meta),error=>error instanceof BridgeError&&error.code==='unverified_identity');
});

test('RPC 断连、同步写失败和超时保留写入不确定性，已关闭连接可安全重试',async()=>{
  for(const mode of ['disconnect','throw','timeout'] as const){
    const rpc=new RpcClient(()=>{if(mode==='throw')throw Error('写入失败');},()=>{});
    const write=rpc.request('send',{}, {mutation:true,timeout:5}),read=rpc.request('status',{}, {timeout:5});
    if(mode==='disconnect')rpc.disconnected();
    await Promise.all([assert.rejects(write,error=>error instanceof DeliveryError&&error.uncertain),assert.rejects(read,error=>error instanceof DeliveryError&&!error.uncertain)]);rpc.close();
    await assert.rejects(rpc.request('send',{}, {mutation:true}),error=>error instanceof DeliveryError&&!error.uncertain);
  }
  for(const code of ['timeout','disconnected']){
    assert.match(modelError(new DeliveryError(code,'原文',true)).message,/outcome unknown.*resend may duplicate/);
    assert.match(modelError(new DeliveryError(code,'原文',false)).message,/no unconfirmed write; retry ok/);
  }
  assert.equal(modelError(new Error('原始错误')).message,MODEL_ERROR_FALLBACK);
  assert.equal(modelError(new BridgeError('unmapped','原始错误')).message,MODEL_ERROR_FALLBACK);
});

test('成员关闭错误在直接与 IPC 路径均保留确切人工开启命令，模型提示保持英文',async t=>{
  const enable_command='nxbridge on codex --member disabled-member',error=Object.assign(new BridgeError('member_disabled','成员已关闭；用户可亲自执行 '+enable_command),{enable_command});
  const direct=modelError(error);assert.equal(direct.enable_command,enable_command);assert.ok(direct.message.includes(enable_command));assert.doesNotMatch(direct.message,/[\u4e00-\u9fff]|<host>|<id>/);
  const home=temporary(t);await ensureHome(home);const server=await listenBroker(home,async()=>{throw error;}),client=await connectBroker(home);
  try{await assert.rejects(client.request('send'),remote=>{const output=modelError(remote);assert.equal(output.message,direct.message);assert.equal(output.enable_command,enable_command);return true;});}
  finally{client.close();await server.close();}
});

test('hook 启动入口的 ping 共享总截止，不在已用完的预算后启动协调器',async t=>{
  const home=temporary(t);await ensureHome(home);const server=await listenBroker(home,async()=>new Promise(()=>{}));
  try{const began=performance.now();await assert.rejects(brokerCall('ping',{}, {home,deadline:performance.now()+100}),{code:'timeout'});assert.ok(performance.now()-began<1000);}finally{await server.close();}
});
