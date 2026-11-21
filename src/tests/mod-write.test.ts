import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {ModReadServer} from '../integration/mod/mod-read-server.js';
import {temporaryDirectory} from './support/temporary.js';
import {BridgeError} from '../shared/errors.js';
import {randomBytes,createHmac} from 'node:crypto';

test('Mod 签名准入失败安全回退；提交后断线不重放，业务错误保留准确语义',async t=>{
  const read=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-read.js')).href),write=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-write.js')).href);
  const temp=temporaryDirectory();let writes=0,kind='ok';
  const server=new ModReadServer(temp.directory,async()=>({}),async(_input,_actor,_receipt,_epoch,admit)=>{
    if(kind==='identity')throw new BridgeError('session_changed','已换会话');
    admit();writes++;if(kind==='business')throw new BridgeError('invalid_reply','无效回复');return{saved:true};
  });
  t.after(async()=>{await server.close();await temp.cleanup();});
  for(kind of ['ok','preflight-offline','policy','identity','business','disconnect','forged-ready','forged-result']){
    const context={sessionId:'session',contextStart:false,binding:{key:'window',epoch:'epoch'}};
    const transport=await server.open({} as any,{host:'claude',sessionId:'session',callId:'call',binding:context.binding},'epoch');
    let requests=0;const before=writes;
    const sdk={env:{get:async()=>undefined},clock:{sleep:(ms:number,options:{signal:AbortSignal})=>sleep(ms,undefined,options)},http:{fetch:async(url:string,options:RequestInit)=>{
      requests++;assert.ok(!String((options.headers as Record<string,string>).Authorization).includes(transport.write!.secret),'签名密钥不能通过 HTTP 发出');
      if(kind==='preflight-offline'||kind==='policy')throw Error('网络不可用或被策略拒绝');
      const response=await fetch(url,options),text=await response.text();
      if(kind==='disconnect'&&requests===2)throw Error('响应途中断连');
      return{status:response.status,text:kind==='forged-ready'&&requests===1||kind==='forged-result'&&requests===2?'{}':text};
    }}};
    await read.prepareRead(sdk,context,async()=>({credential:{id:'e'.repeat(64),secret:'f'.repeat(64)}}));read.attachRead(context,transport);
    const execute=()=>write.smallWrite(sdk,context,{...context,operation:'state',state:'ready'});
    if(kind==='ok')assert.deepEqual(await execute(),{handled:true,value:{saved:true}});
    else if(['preflight-offline','policy','identity','forged-ready'].includes(kind))assert.deepEqual(await execute(),{handled:false});
    else if(kind==='business')await assert.rejects(execute(),(error:any)=>error.code==='invalid_reply'&&!error.uncertain&&error.model_message.includes('in_reply_to'));
    else await assert.rejects(execute(),{uncertain:true});
    assert.equal(writes-before,['ok','business','disconnect','forged-result'].includes(kind)?1:0,kind);
    assert.equal(requests,['preflight-offline','policy','forged-ready'].includes(kind)?1:2,kind);
    if(['disconnect','forged-result'].includes(kind)){assert.deepEqual(await execute(),{handled:false});assert.equal(writes-before,1,'未知提交不能重放');}
  }
});

test('Mod 服务端票据拒绝重放，签名绑定阶段，过长正文在准入前回退',async t=>{
  const read=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-read.js')).href),write=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-write.js')).href);
  const temp=temporaryDirectory();let writes=0;
  const server=new ModReadServer(temp.directory,async()=>({}),async(_input,_actor,_receipt,_epoch,admit)=>{admit();writes++;return{ok:true,text:'中文😀'};});
  t.after(async()=>{await server.close();await temp.cleanup();});
  const context={sessionId:'session',contextStart:false,binding:{key:'key',epoch:'epoch'}},transport=await server.open({} as any,{host:'claude',sessionId:'session',callId:'call',binding:context.binding},'epoch'),token=transport.write!;
  const nonce=randomBytes(32).toString('hex'),post=async(body:unknown)=>{const text=JSON.stringify(body),response=await fetch(token.url,{method:'POST',headers:{'Content-Type':'application/json','X-Nxbridge-Id':token.id,Authorization:'HMAC '+createHmac('sha256',Buffer.from(token.secret,'hex')).update(text).digest('hex')},body:text});const envelope=await response.json();assert.doesNotMatch(envelope.body,/[^\x00-\x7f]/);return{status:response.status,...JSON.parse(envelope.body)};};
  const prepare={phase:'prepare',nonce,operation:'state',bytes:20},ready=await post(prepare),commit={phase:'commit',nonce,ticket:ready.ticket,input:{operation:'state'}};
  assert.deepEqual((await post(commit)).value,{ok:true,text:'中文😀'});assert.equal(writes,1);
  assert.equal((await post(commit)).error.uncertain,true);assert.equal(writes,1);
  assert.notEqual((await post(prepare)).ticket,ready.ticket);
  assert.equal((await post(commit)).error.uncertain,true);assert.equal(writes,1);
  assert.equal((await post({...prepare,operation:'unknown'})).admitted,false);
  assert.equal((await post({...prepare,bytes:2*1024*1024})).admitted,false);
  const expired=await post(prepare);
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(6000);
  await post(prepare);assert.equal((await post({...commit,ticket:expired.ticket})).admitted,false,'新的准备不能丢掉旧票据从未准入的证据');assert.equal(writes,1);t.mock.timers.reset();
  let requests=0,readyResponse:unknown;
  const sdk={env:{get:async()=>undefined},clock:{sleep:(ms:number,options:{signal:AbortSignal})=>sleep(ms,undefined,options)},http:{fetch:async(url:string,options:RequestInit)=>{requests++;const response=await fetch(url,options),value={status:response.status,text:await response.text()};if(requests===1)readyResponse=value;return requests===2?readyResponse:value;}}};
  await read.prepareRead(sdk,context,async()=>({credential:{id:'a'.repeat(64),secret:'b'.repeat(64)}}));read.attachRead(context,transport);
  assert.deepEqual(await write.smallWrite(sdk,context,{operation:'state',text:'中'.repeat(400000)}),{handled:false});assert.equal(requests,0);
  await assert.rejects(write.smallWrite(sdk,context,{operation:'state',text:'中文😀'}),{uncertain:true});assert.equal(writes,2,'响应阶段替换不能报告成功或自动重放');
});

test('代理环境只在明确绕过目标回环地址时允许 HTTP',async()=>{
  const {loopbackAllowed}=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-proxy.js')).href),url='http://127.0.0.1:1234/mod-read';
  assert.equal(loopbackAllowed({},url),true);
  for(const key of ['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy']){
    for(const bypass of ['', 'localhost','.127.0.0.1','example.test','127.0.0.1:4321'])assert.equal(loopbackAllowed({[key]:'http://proxy',NO_PROXY:bypass},url),false);
    for(const bypass of ['127.0.0.1','127.0.0.1:1234','*','example.test,127.0.0.1'])assert.equal(loopbackAllowed({[key]:'http://proxy',no_proxy:bypass},url),true);
  }
  assert.equal(loopbackAllowed({HTTP_PROXY:'http://proxy',no_proxy:'',NO_PROXY:'127.0.0.1'},url),false);
});
