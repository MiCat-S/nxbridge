import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcProcess, psEnvironment, readPosixAncestry } from '../process/posix/posix-process.js';
import { windowsAncestry, type ProcessAncestry } from '../process/process.js';
import { verifyStopAncestry } from '../process/process-stop.js';
import {BridgeError} from '../shared/errors.js';
import { windowsAncestryFailure } from '../process/windows/windows-hook-identity.js';

const stat=(pid:number,parent:number,generation:string,name='node',state='S')=>pid+' ('+name+') '+[state,parent,...Array(17).fill('0'),generation].join(' ');
const missing=()=>{throw Object.assign(Error('已退出'),{code:'ENOENT'});};
const row=(pid:number,parentPid:number,startedAt:string)=>({pid,parentPid,startedAt,name:'node'});
const verified:ProcessAncestry={ancestors:[row(30,20,'300'),row(20,10,'200')],complete:true,reason:'parent_missing',source:'native'};

test('Linux stat 的括号、换行、Unicode 和原生大整数代次均完整保留',()=>{
  const name='中文 ) (\n e\u0301 🚀',generation='9007199254740993',image='/opt/含 空格/'+name+'/codex';
  assert.deepEqual(parseProcProcess(8,stat(8,1,generation,name),image),{pid:8,parentPid:1,startedAt:generation,procStart:generation,name,state:'S',image});
  for(const value of [stat(9,1,'2'),stat(8,1,'1x'),'8 invalid'])assert.throws(()=>parseProcProcess(8,value),{code:'process_identity_invalid'});
});

test('Linux 父链区分 PID1 重挂、已退出父项、较新同 PID、同 tick 与查询中的代次改变',async()=>{
  let values=new Map([[8,stat(8,7,'9007199254740993')],[7,stat(7,1,'9007199254740992')],[1,stat(1,0,'1')]]);
  const io={platform:'linux' as const,ps:async()=>{throw Error('Linux 不得调用 ps');},stat:(pid:number)=>values.get(pid)??missing(),image:(pid:number)=>'/opt/'+pid+'/node'};
  const read=()=>readPosixAncestry(8,32,performance.now()+1000,io);
  assert.deepEqual((await read()).ancestors.map(r=>r.pid),[8,7,1]);
  values.delete(7);assert.equal((await read()).reason,'parent_missing');
  values.set(7,stat(7,1,'9007199254740994'));assert.equal((await read()).reason,'parent_reused');
  values.set(7,stat(7,1,'9007199254740993'));assert.deepEqual((await read()).ancestors.map(r=>r.pid),[8,7,1]);
  let count=0;const stable=io.stat;io.stat=pid=>pid===8&&count++?stat(8,7,'9007199254740994'):stable(pid);
  await assert.rejects(read(),{code:'process_identity_unknown'});
});

test('Linux 状态与祖先深度不伪造完整证明，拒绝循环与权限错误',async()=>{
  const values=new Map([[8,stat(8,7,'30')],[7,stat(7,1,'20','node','Z')]]),io={platform:'linux' as const,ps:async()=>({stdout:''}),stat:(pid:number)=>values.get(pid)??missing(),image:()=>'/node'};
  assert.equal((await readPosixAncestry(8,1,performance.now()+1000,io)).complete,false);
  assert.equal((await readPosixAncestry(8,10,performance.now()+1000,io)).reason,'parent_missing');
  values.set(8,stat(8,0,'30','node','Z'));assert.equal((await readPosixAncestry(8,1,performance.now()+1000,io)).ancestors[0]?.state,'Z');
  values.set(8,stat(8,8,'30'));await assert.rejects(readPosixAncestry(8,10,performance.now()+1000,io),{code:'process_identity_unknown'});
  io.stat=()=>{throw Object.assign(Error('拒绝'),{code:'EACCES'});};
  await assert.rejects(readPosixAncestry(8,10,performance.now()+1000,io),{code:'EACCES'});
});


test('Darwin 在 C、未设置或继承的字符 locale 中均固定 UTF-8，lstart 不受 LC_ALL 覆盖',()=>{
  const saved=Object.fromEntries(['LC_ALL','LC_TIME','LC_CTYPE','LANG'].map(key=>[key,process.env[key]]));
  try{for(const value of ['C',undefined,'en_US.UTF-8']){
    Object.assign(process.env,{LC_ALL:'zh_CN.UTF-8',LC_TIME:'zh_CN.UTF-8',LANG:'C'});if(value===undefined)delete process.env.LC_CTYPE;else process.env.LC_CTYPE=value;
    const env=psEnvironment('darwin');assert.equal(env.LC_ALL,undefined);assert.equal(env.LC_TIME,'C');assert.equal(env.LC_CTYPE,'UTF-8');
    assert.equal(psEnvironment('linux').LC_CTYPE,value,'Linux 的可信映像从 procfs 读取，不探测或强制不存在的 locale');
  }}
  finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

test('Darwin 后台标题改变后按内核名和同一进程的映射还原程序，不借用其他进程或同名库',async()=>{
  const timestamp='Sat Jan  3 12:00:00 2026',image='/opt/测试 工具/claude.exe',calls:{binary:string;args:string[]}[]=[];
  const row=(pid:number,parent:number,name:string)=>`${pid} ${parent} S ${timestamp} ${name}`;
  const io={platform:'darwin' as const,stat:missing,image:missing,ps:async(binary:string,args:string[])=>{
    calls.push({binary,args});
    if(binary==='/usr/sbin/lsof')return{stdout:`p8\0\nftxt\0tREG\0n${image}\0\nftxt\0tREG\0n/usr/lib/libSystem.B.dylib\0\np7\0\nftxt\0tREG\0n${image}\0\np99\0\nftxt\0tREG\0n/other/claude.exe\0\n`};
    const kernel=args.includes('pid=,ppid=,stat=,lstart=,ucomm=');
    return{stdout:[row(8,7,kernel?'claude.exe':'claude bg-spare'),row(7,1,kernel?'claude.exe':'claude supervisor')].join('\n')};
  }};
  const value=await readPosixAncestry(8,10,performance.now()+1000,io);
  assert.deepEqual(value.ancestors.map(({pid,name,image})=>({pid,name,image})),[{pid:8,name:'claude.exe',image},{pid:7,name:'claude.exe',image}]);
  assert.equal(calls.filter(call=>call.binary==='/usr/sbin/lsof').length,1);
  assert.ok(calls.every(call=>call.args.includes('-p')&&!call.args.includes('-axo')));
  assert.deepEqual(calls.find(call=>call.binary==='/usr/sbin/lsof')?.args,['-nP','-a','-p','8,7','-d','txt','-F0pftn']);
});

test('Darwin 已有完整路径不补读；缺少映像或出现同名歧义时不猜选其他文件',async()=>{
  const timestamp='Sat Jan  3 12:00:00 2026',row=(name:string)=>`8 1 S ${timestamp} ${name}`;
  for(const files of ['', 'p8\0\nftxt\0tREG\0n/other/node\0\n', 'p8\0\nftxt\0tREG\0n/first/claude.exe\0\nftxt\0tREG\0n/second/claude.exe\0\n']){
    const io={platform:'darwin' as const,stat:missing,image:missing,ps:async(binary:string,args:string[])=>({stdout:binary==='/usr/sbin/lsof'?files:row(args.includes('pid=,ppid=,stat=,lstart=,ucomm=')?'claude.exe':'后台 显示标题')})};
    const value=await readPosixAncestry(8,1,performance.now()+1000,io);assert.equal(value.ancestors[0]?.name,'claude.exe');assert.equal(value.ancestors[0]?.image,undefined);
  }
  let calls=0;
  const value=await readPosixAncestry(8,1,performance.now()+1000,{platform:'darwin',stat:missing,image:missing,ps:async(binary)=>{calls++;assert.equal(binary,'/bin/ps');return{stdout:row('/opt/claude')};}});
  assert.equal(value.ancestors[0]?.image,'/opt/claude');assert.equal(calls,1);
});

test('Darwin 脚本 CLI 的单词名称保留，真实映像仍指向解释器',async()=>{
  for(const name of ['codex','example-cli']){
    const io={platform:'darwin' as const,stat:missing,image:missing,ps:async(binary:string,args:string[])=>({stdout:binary==='/usr/sbin/lsof'?'p8\0\nftxt\0tREG\0n/opt/node\0\n':`8 1 S Sat Jan  3 12:00:00 2026 ${args.includes('pid=,ppid=,stat=,lstart=,ucomm=')?'node':name}`})};
    const value=await readPosixAncestry(8,1,performance.now()+1000,io);assert.equal(value.ancestors[0]?.name,name);assert.equal(value.ancestors[0]?.image,'/opt/node');
  }
});

test('Darwin 映像补读后仍核验代次，单个 PID 退出和超时都不能返回旧证明',async()=>{
  for(const mode of ['generation','exit','timeout'] as const){
    let reads=0;
    const io={platform:'darwin' as const,stat:missing,image:missing,ps:async(binary:string,args:string[])=>{
      if(binary==='/usr/sbin/lsof'){if(mode==='timeout')throw Object.assign(Error('超时'),{code:1,stdout:'旧输出',killed:true,signal:'SIGTERM'});return{stdout:'p8\0\nftxt\0tREG\0n/opt/claude.exe\0\n'};}
      if(++reads===3&&mode==='exit')return{stdout:''};
      return{stdout:`8 1 S Sat Jan  3 12:00:0${reads===3&&mode==='generation'?1:0} 2026 ${args.includes('pid=,ppid=,stat=,lstart=,ucomm=')?'claude.exe':'后台标题'}`};
    }};
    if(mode==='exit'){const value=await readPosixAncestry(8,1,performance.now()+1000,io);assert.equal(value.reason,'missing');assert.deepEqual(value.ancestors,[]);}
    else await assert.rejects(readPosixAncestry(8,1,performance.now()+1000,io),mode==='generation'?{code:'process_identity_unknown'}:{killed:true});
  }
});



test('停止保护拒绝当前祖先和未知负证明；完整断链与严格较新代次仍可正常回收',()=>{
  verifyStopAncestry({pid:99,startedAt:'100'},verified);
  assert.throws(()=>verifyStopAncestry({pid:20,startedAt:'200'},verified),{code:'process_is_caller'});
  const partial={...verified,complete:false,reason:'access'};
  for(const startedAt of ['100','200'])assert.throws(()=>verifyStopAncestry({pid:99,startedAt},partial),{code:'process_identity_unknown'});
  verifyStopAncestry({pid:99,startedAt:'201'},partial);
  assert.throws(()=>verifyStopAncestry({pid:99,startedAt:'201'},{...partial,ancestors:[]}),{code:'process_identity_unknown'});

});

test('Windows 只使用原生祖先查询，失败保留原始错误，不启动兼容回退',async()=>{
  assert.deepEqual(await windowsAncestry(30,32,100,async()=>verified),verified);
  for(const code of ['native_identity_unavailable','process_identity_unknown','uninstalled','timeout'])
    await assert.rejects(windowsAncestry(30,32,100,async()=>{throw new BridgeError(code,'原生查询失败');}),{code});
});

test('助手启动被系统阻止才回退，已经执行的超时、输出溢出与身份冲突不降级',()=>{
  for(const code of ['EPERM','EACCES','ENOENT','UNKNOWN'])assert.equal(windowsAncestryFailure({code,syscall:'spawn C:\\fixture\\identity.exe'}).code,'native_identity_unavailable');
  assert.equal(windowsAncestryFailure({code:1,stderr:'invalid ancestor pid\r\n'}).code,'native_identity_unavailable');
  for(const error of [{code:1,stderr:'native ancestry identity changed'},{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},{code:'ETIMEDOUT',signal:'SIGTERM'},{code:'EPIPE',syscall:'write'}])assert.equal(windowsAncestryFailure(error).code,'process_identity_unknown');
});

test('Linux 单行状态探测不二次读取，停止中的僵尸、回收及重挂不会误报 unknown',async()=>{
  for(const mode of ['zombie','reaped','reparent']){
    let reads=0;const io={platform:'linux' as const,ps:async()=>({stdout:''}),image:()=>'/node',stat:()=>{reads++;if(reads>1)return mode==='reaped'?missing():stat(8,mode==='reparent'?1:7,'30','node',mode==='zombie'?'Z':'S');return stat(8,7,'30');}};
    const value=await readPosixAncestry(8,1,performance.now()+1000,io);assert.equal(reads,1);assert.equal(value.ancestors[0]?.startedAt,'30');
  }
});

test('Linux 深链核验保留退出前缀、终止于僵尸或已回收父项，只验证存在的父子链接',async()=>{
  for(const mode of ['zombie','reaped','reparent','last-reparent']){
    const counts=new Map<number,number>(),io={platform:'linux' as const,ps:async()=>({stdout:''}),image:()=>'/node',stat:(pid:number)=>{
      const n=(counts.get(pid)??0)+1;counts.set(pid,n);
      if(pid===8)return stat(8,mode==='reparent'&&n>1?1:7,'30');
      if(pid===7){if(n>1&&mode==='reaped')return missing();return stat(7,mode==='last-reparent'&&n>1?123:0,'20','node',mode==='zombie'&&n>1?'Z':'S');}
      return missing();
    }};
    const value=await readPosixAncestry(8,10,performance.now()+1000,io);
    assert.equal(value.complete,true);assert.equal(value.ancestors.length,mode==='last-reparent'?2:1);
    if(mode==='reparent')assert.equal(value.ancestors[0]?.parentPid,1);
  }
});
