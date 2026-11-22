import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {processIdentity,probeProcesses,liveProcess} from '../process/process.js';
import {ownedProcessState,stopOwnedProcess} from '../process/process-stop.js';
import {deliverClaudeInbox} from '../hosts/claude/claude-inbox.js';
import {probePeerRuntime} from '../broker/health/probe.js';
import {registration} from './support/registration.js';
import {temporary} from './support/temporary.js';
import {delay} from '../shared/time.js';
import type {Peer,Endpoint,Message} from '../types.js';

test('Claude 已退出但父进程尚未回收时，不向仍可连接的旧 inbox 提交消息',{skip:process.platform!=='linux',timeout:15000},async t=>{
  const directory=temporary(t),configHome=path.join(directory,'claude'),address=path.join(directory,'inbox.sock');
  mkdirSync(path.join(configHome,'sessions'),{recursive:true});
                                              
  const parent=spawn(process.execPath,['-e',`const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.send(child.pid));process.on('message',()=>{child.kill();process.exit();});`],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(parent.exitCode===null&&parent.signalCode===null){const exit=once(parent,'exit');parent.kill('SIGCONT');parent.send('stop');await exit;}});
  const [pid]=await once(parent,'message'),native=await processIdentity(pid);
  const peer={id:'claude-exit',host:'claude',sessionId:'same-session',cwd:directory,name:'Claude',owner:'nxbridge',state:'ready',permission:'bypass',kind:'root',parentId:null,updatedAt:Date.now()} satisfies Peer;
  const endpoint={...registration('claude',peer.sessionId).endpoint,peerId:peer.id,pid:native.pid,procStart:native.startedAt,address,configHome,active:true,seenAt:Date.now()} satisfies Endpoint;
  writeFileSync(path.join(configHome,'sessions',pid+'.json'),JSON.stringify({sessionId:peer.sessionId,cwd:directory,procStart:native.startedAt}),'utf8');
  let bytes=0,connections=0;const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{connections++;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.on('data',chunk=>{bytes+=chunk.length;});});
  await new Promise<void>(resolve=>server.listen(address,resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  assert.deepEqual(await probeProcesses([{pid,procStart:native.startedAt}]),['alive']);
  assert.equal((await probePeerRuntime(peer,endpoint)).state,'reachable');
  parent.kill('SIGSTOP');
  const stoppedEnd=Date.now()+3000;while((await processIdentity(parent.pid!)).state!=='T'){assert.ok(Date.now()<stoppedEnd,'包装器未暂停');await delay(10);}
  await stopOwnedProcess(native,{force:true});
  assert.equal(liveProcess(pid),true);assert.equal((await processIdentity(pid)).state,'Z');
  assert.equal(await ownedProcessState(native),'dead');
  assert.deepEqual(await probeProcesses([{pid,procStart:native.startedAt}]),['dead']);
  const availability=await probePeerRuntime(peer,endpoint);assert.equal(availability.state,'blocked');assert.equal(availability.nativeState,'dead');
  const before=connections;
  const message:Message={id:'unsent',pairId:'pair',from:peer.id,to:peer.id,body:'保留待发正文',inReplyTo:null,via:null,callId:'exit',state:'accepted',createdAt:Date.now(),updatedAt:Date.now(),evidence:null,error:null,attempts:0};
  await assert.rejects(deliverClaudeInbox(peer,endpoint,message,peer,()=>configHome),{code:'offline',uncertain:false});
  assert.equal(connections,before);assert.equal(bytes,0);
});
