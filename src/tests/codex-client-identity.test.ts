import test from 'node:test';
import assert from 'node:assert/strict';
import { backendCodexClient, officialCodexClient, codexServerVersion } from '../hosts/codex/codex-client-identity.js';
import { RpcClient, type RpcMessage } from '../ipc/rpc.js';

function fixture(versions:(string|undefined)[],originator='codex-tui'){
  const wires:{messages:RpcMessage[];closed:boolean}[]=[];
  const open=async()=>{
    const version=versions.shift(),wire={messages:[] as RpcMessage[],closed:false};wires.push(wire);
    const rpc=new RpcClient(message=>{
      wire.messages.push(message);
      if(message.id!==undefined)queueMicrotask(()=>rpc.receive({id:message.id,result:version?{userAgent:message.params?.clientInfo?.name==='codex-tui'?originator+'/'+version+' (test; test) test (codex-tui; '+message.params.clientInfo.version+')':'codex_cli_rs/'+version+' (test; test) test'}:{}}));
    },()=>{wire.closed=true;});
    return rpc;
  };
  return{wires,open};
}

test('每次连接从远端原生 UA 发现当前版本，探测不携带猜测值且正式连接严格使用官方身份',async()=>{
  const f=fixture(['0.164.0','0.164.0','0.166.0','0.166.0','0.167.0-alpha.1+build.2','0.167.0-alpha.1+build.2']);
  for(const version of ['0.164.0','0.166.0','0.167.0-alpha.1+build.2']){
    const rpc=await officialCodexClient(f.open),[probe,live]=f.wires.slice(-2);
    assert.equal(codexServerVersion(rpc),version);
    assert.deepEqual(probe!.messages.map(m=>m.method),['initialize','initialized']);assert.equal(probe!.closed,true);
    assert.deepEqual(probe!.messages[0]!.params,{clientInfo:{name:'codex-backend',title:null,version:''}});
    assert.deepEqual(live!.messages[0]!.params,{clientInfo:{name:'codex-tui',title:null,version},capabilities:{experimentalApi:true}});
    assert.equal(live!.closed,false);await rpc.close();assert.equal(live!.closed,true);
  }
});

test('安装和共享 daemon 控制连接只使用单次非发起握手，不提交官方 TUI 全局身份',async()=>{
  const f=fixture(['0.166.0']),rpc=await backendCodexClient(f.open);
  assert.equal(codexServerVersion(rpc),'0.166.0');
  assert.equal(f.wires.length,1);
  assert.deepEqual(f.wires[0]!.messages.map(m=>m.method),['initialize','initialized']);
  assert.deepEqual(f.wires[0]!.messages[0]!.params,{clientInfo:{name:'codex-backend',title:null,version:''},capabilities:{experimentalApi:true}});
  await rpc.close();assert.equal(f.wires[0]!.closed,true);
});

test('只读客户端不依赖原生 UA 的版本格式，未知版本仍可查询并正常关闭',async()=>{
  for(const version of [undefined,'development-build']){
    const f=fixture([version]),rpc=await backendCodexClient(f.open);
    try{
      assert.equal(codexServerVersion(rpc),undefined);assert.equal(f.wires.length,1);
      assert.deepEqual(f.wires[0]!.messages.map(m=>m.method),['initialize','initialized']);
      await rpc.request('thread/list');assert.equal(f.wires[0]!.messages.at(-1)!.method,'thread/list');
    }finally{await rpc.close();}
    assert.equal(f.wires[0]!.closed,true);
  }
});

test('两次握手间原生升级时关闭过期连接，重新发现版本后才允许业务请求',async()=>{
  const f=fixture(['0.164.0','0.166.0','0.166.0','0.166.0']),rpc=await officialCodexClient(f.open);
  assert.equal(f.wires.length,4);assert.equal(f.wires[1]!.closed,true);
  assert.deepEqual(f.wires[1]!.messages.map(m=>m.method),['initialize']);
  await rpc.request('thread/read');assert.equal(f.wires[3]!.messages.at(-1)!.method,'thread/read');await rpc.close();
});

test('发现失败时关闭通道且明确报错，协议不允许省略身份时不猜测版本',async()=>{
  const f=fixture([undefined]);
  await assert.rejects(officialCodexClient(f.open),{code:'codex_identity_unknown'});
  assert.equal(f.wires.length,1);assert.equal(f.wires[0]!.closed,true);
});

test('连续切换运行版本时有界失败，所有连接均关闭且没有业务请求',async()=>{
  const f=fixture(['0.164.0','0.166.0','0.164.0','0.166.0','0.164.0','0.166.0']);
  await assert.rejects(officialCodexClient(f.open),{code:'codex_identity_changed'});
  assert.equal(f.wires.length,6);assert.ok(f.wires.every(w=>w.closed&&w.messages.every(m=>m.method==='initialize'||m.method==='initialized')));
});

test('旧服务器已锁定其他 originator 时明确提示重启，不能静默带旧身份继续请求',async()=>{
  const f=fixture(['0.166.0','0.166.0'],'nxbridge');
  await assert.rejects(officialCodexClient(f.open),{code:'codex_identity_conflict'});
  assert.equal(f.wires.length,2);assert.ok(f.wires.every(w=>w.closed));
  assert.deepEqual(f.wires[1]!.messages.map(m=>m.method),['initialize']);
});
