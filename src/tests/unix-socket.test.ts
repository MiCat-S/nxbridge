import test from 'node:test';
import assert from 'node:assert/strict';
import {codexSocketTarget,proveUnixCodexSocket,linuxSocketListener,type UnixSocketIo} from '../ipc/unix-socket.js';
import {symlinkSync,lstatSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {ensureHome,removeDanglingCodexSockets,removeOwnedSocket} from '../ipc/home.js';
import { temporary } from './support/temporary.js';

const filename='/var/bridge/run/cx-own.sock',native={pid:42,parentPid:1,name:'codex',image:'/Applications/ChatGPT.app/codex',startedAt:'Thu Nov 12 02:11:01 2026'};
function fixture(){
  const stat=(kind:'link'|'socket'|'directory',ino:number,mode:number)=>({dev:1,ino,uid:501,mode,isSocket:()=>kind==='socket',isDirectory:()=>kind==='directory',isSymbolicLink:()=>kind==='link'});
  const io:UnixSocketIo={uid:501,realpath:file=>file==='/tmp'?'/private/tmp':file==='/var/bridge/run'?'/private/var/bridge/run':file===filename?target:file,readlink:()=>target,lstat:file=>file===filename?entry:file===target?socket:directory,identity:async()=>({...native}),listener:async(file,pid)=>file===target&&pid===native.pid};
  const target=codexSocketTarget(filename,io),entry=stat('link',1,0o777),socket=stat('socket',2,0o600),directory=stat('directory',3,0o700);
  return{io,target,entry,socket,directory};
}
test('Codex Unix 确定性链接在当前监听进程和代次证明下可回收，父目录别名不误判',async()=>{
  const f=fixture(),proof=await proveUnixCodexSocket(filename,native,f.io);
  assert.equal(proof.kind,'codex-alias');assert.equal(proof.resolved,f.target);assert.match(f.target,/^\/private\/tmp\/codex-daemon-501\/[a-f0-9]{64}$/);
  assert.equal(codexSocketTarget('/private/var/bridge/run/cx-own.sock',f.io),f.target);
});
test('链接指向其他端点、监听由其他 PID 持有、进程切代和端点替换均拒绝',async()=>{
  for(const change of ['target','listener','generation','entry'] as const){
    const f=fixture();
    if(change==='target')f.io.readlink=()=>f.target+'-foreign';
    if(change==='listener')f.io.listener=async()=>false;
    if(change==='generation')f.io.listener=async()=>{f.io.identity=async()=>({...native,startedAt:'后继进程'});return true;};
    if(change==='entry')f.io.listener=async()=>{f.entry.ino++;return true;};
    await assert.rejects(proveUnixCodexSocket(filename,native,f.io),(error:any)=>error.code==='shared_backend'&&error.message.includes('expectedPid')&&error.socketProof.expectedGeneration===native.startedAt,change);
  }
});
test('原生 socket 权限变化不推翻监听归属，非 socket 仍然拒绝',async()=>{
  const f=fixture();f.socket.uid=502;f.socket.mode=0o666;f.directory.mode=0o755;
  assert.equal((await proveUnixCodexSocket(filename,native,f.io)).pid,native.pid);
  f.socket.isSocket=()=>false;
  await assert.rejects(proveUnixCodexSocket(filename,native,f.io),{code:'shared_backend'});
});
test('旧版直接监听 socket 仍需监听归属，不能只凭命令行认领被替换的端点',async()=>{
  const f=fixture();f.io.lstat=file=>file===filename?f.socket:f.directory;f.io.realpath=file=>file;f.io.listener=async(file,pid)=>file===filename&&pid===42;
  assert.equal((await proveUnixCodexSocket(filename,native,f.io)).kind,'direct');f.io.listener=async()=>false;await assert.rejects(proveUnixCodexSocket(filename,native,f.io),{code:'shared_backend'});
});
test('Linux 监听证明连接 inode 与当前进程 FD；客户端、别的 inode 和路径均不算',()=>{
  const row='00000000: 00000002 00000000 00010000 0001 01 12345 /private/tmp/own socket\n',canonical=(file:string)=>file;
  assert.equal(linuxSocketListener(row,['socket:[12345]'],'/private/tmp/own socket',canonical),true);
  assert.equal(linuxSocketListener(row,['socket:[67890]'],'/private/tmp/own socket',canonical),false);
  assert.equal(linuxSocketListener(row.replace('00010000','00000000'),['socket:[12345]'],'/private/tmp/own socket',canonical),false);
  assert.equal(linuxSocketListener(row,['socket:[12345]'],'/private/tmp/foreign',canonical),false);
});
test('自有目录清理原生死链，保留任意目标链接和被替换的普通文件',{skip:process.platform==='win32'},async t=>{
  const home=temporary(t);await ensureHome(home);
  const own=path.join(home,'run','cx-0123456789abcdef.sock'),foreign=path.join(home,'run','cx-fedcba9876543210.sock'),file=path.join(home,'run','cx-1123456789abcdef.sock');
  symlinkSync(codexSocketTarget(own),own);symlinkSync('/tmp/unrelated-user-socket',foreign);writeFileSync(file,'不属于 socket 的用户文件','utf8');
  assert.deepEqual(removeDanglingCodexSockets(home),[own]);assert.throws(()=>lstatSync(own),{code:'ENOENT'});assert.equal(lstatSync(foreign).isSymbolicLink(),true);
  await assert.rejects(removeOwnedSocket(home,'unix://'+foreign),{code:'shared_backend'});await assert.rejects(removeOwnedSocket(home,'unix://'+file),{code:'socket_type_changed'});
});
