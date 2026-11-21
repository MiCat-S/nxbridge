import test from 'node:test';
import assert from 'node:assert/strict';
import { processAncestry, processIdentity, type ProcessAncestry, type ProcessIdentity } from '../process/process.js';
import { externalTerminalOrigin, isExternalTerminal, requireExternalTerminal } from '../hosts/user-origin.js';
import { fixture } from './support/broker-fixture.js';

const caller:ProcessIdentity={pid:101,parentPid:102,name:'node.exe',startedAt:'100'};
const origin={pid:caller.pid,procStart:caller.startedAt,tty:true as const};
const ancestry=(names:string[],reason:string,complete=true):ProcessAncestry=>({ancestors:[caller,...names.map((name,index)=>({pid:102+index,parentPid:index===names.length-1?0:103+index,name,startedAt:String(99-index)}))],complete,reason});

test('终端调用方只采集输入终端和自身代次，非交互不查询，输出重定向不参与授权',async()=>{
  let queries=0;
  const identity=async(pid:number)=>{queries++;assert.equal(pid,process.pid);return{...caller,pid};};
  assert.equal(await externalTerminalOrigin({interactive:false,identity}),undefined);assert.equal(queries,0);
  assert.deepEqual(await externalTerminalOrigin({interactive:true,identity}),{pid:process.pid,procStart:caller.startedAt,tty:true});assert.equal(queries,1);
});

test('独立终端矩阵按实际父链和结束原因判定，不依赖 shell 名称或环境标记',async t=>{
  const cases=[
    {name:'Windows Terminal 从开始菜单或任务栏启动',evidence:ancestry(['pwsh.exe','WindowsTerminal.exe','explorer.exe'],'parent_missing'),allowed:true},
    {name:'VS Code 集成终端',evidence:ancestry(['powershell.exe','Code.exe','explorer.exe'],'parent_missing'),allowed:true},
    {name:'Win+R cmd 的旧父 PID 已复用',evidence:ancestry(['cmd.exe','explorer.exe'],'parent_reused'),allowed:true},
    {name:'tmux',evidence:ancestry(['ksh','tmux: server','systemd'],'root'),allowed:true},
    {name:'SSH 分配的交互终端',evidence:ancestry(['tcsh','sshd','systemd'],'root'),allowed:true},
    {name:'macOS Terminal.app',evidence:ancestry(['zsh','Terminal','launchd'],'root'),allowed:true},
    {name:'iTerm2 自定义 shell',evidence:ancestry(['xonsh','iTerm2','launchd'],'root'),allowed:true},
                                            
    {name:'start 另开终端且启动器已退出',evidence:ancestry(['cmd.exe'],'parent_missing'),allowed:true},
    {name:'Claude 直接工具调用',evidence:ancestry(['bash','claude','Terminal'],'root'),allowed:false},
    {name:'Codex 经自定义 shell 调用',evidence:ancestry(['xonsh','codex.exe','Code.exe'],'root'),allowed:false},
    {name:'start 启动器尚存且仍能观察到宿主',evidence:ancestry(['cmd.exe','cmd.exe','claude.exe'],'root'),allowed:false},
    {name:'父链权限不足',evidence:ancestry(['cmd.exe'],'access',false),allowed:false},
    {name:'父链查询失败',evidence:ancestry(['zsh'],'query',false),allowed:false},
    {name:'父链深度耗尽',evidence:ancestry(['ksh'],'depth',false),allowed:false},
    {name:'调用方已退出',evidence:{ancestors:[],complete:true,reason:'missing'},allowed:false},
    {name:'调用方 PID 被复用',evidence:{...ancestry(['bash'],'root'),ancestors:[{...caller,startedAt:'200'}]},allowed:false},
    {name:'调用方已成僵尸',evidence:{ancestors:[{...caller,state:'Z'}],complete:true,reason:'root'},allowed:false},
  ];
  const environment={CLAUDECODE:process.env.CLAUDECODE,CODEX_THREAD_ID:process.env.CODEX_THREAD_ID};
  process.env.CLAUDECODE='1';process.env.CODEX_THREAD_ID='继承的旧环境标记';
  try{
    for(const item of cases){
      let queries=0;
      const read=async(pid:number,depth?:number)=>{queries++;assert.equal(pid,origin.pid);assert.equal(depth,32);return item.evidence;};
      if(item.allowed)await requireExternalTerminal(origin,read);
      else await assert.rejects(requireExternalTerminal(origin,read),{code:'user_terminal_required'},item.name+' / '+item.evidence.reason);
      assert.equal(queries,1,item.name+' / '+item.evidence.reason);
    }
  }finally{for(const [key,value]of Object.entries(environment))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  t.diagnostic('覆盖 '+cases.length+' 种终端或来源状态；退出或复用父进程视为已观察父链的终点。');
});

test('缺少交互来源不查询父链，查询异常也不能授予用户写权限',async()=>{
  let queries=0;
  const read=async()=>{queries++;throw Error('定点查询失败');};
  await assert.rejects(requireExternalTerminal(undefined,read),{code:'user_terminal_required'});assert.equal(queries,0);
  await assert.rejects(requireExternalTerminal(origin,read),{code:'user_terminal_required'});assert.equal(queries,1);
});

test('可选终端能力对宿主调用或未知来源只返回否，不阻断普通操作也不授予人工恢复权限',async()=>{
  const hosted=ancestry(['bash','claude'],'root'),unknown=ancestry(['cmd.exe'],'access',false);
  for(const evidence of [hosted,unknown]){
    let queries=0;
    const allowed=await isExternalTerminal(origin,async()=>{queries++;return evidence;});
    assert.equal(allowed,false);assert.equal(queries,1);
  }
});

test('打开现有会话时无效的可选终端凭据不阻断普通打开，也不会解除人工恢复门禁',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);let grants=0;
  t.mock.method(f.broker.managedRecovery,'authorize',()=>{grants++;});
  const result=await f.broker.dispatch('open',{host:'codex',peer_id:f.x.id,terminal_origin:{pid:process.pid,procStart:'不匹配的代次',tty:true}}) as any;
  assert.equal(result.peer.id,f.x.id);assert.equal(grants,0);
});

test('当前平台原生定点父链核验调用方代次，并按同一规则决定终端来源',async t=>{
  const current=await processIdentity(process.pid),evidence=await processAncestry(process.pid,32);
  assert.equal(evidence.ancestors[0]?.pid,current.pid);assert.equal(evidence.ancestors[0]?.startedAt,current.startedAt);
  const request={pid:current.pid,procStart:current.startedAt,tty:true as const},allowed=evidence.complete&&!evidence.ancestors.some(row=>/^(?:claude|codex)(?:\.exe)?$/i.test(row.name));
                                 
  if(allowed)await requireExternalTerminal(request,async()=>evidence);
  else await assert.rejects(requireExternalTerminal(request,async()=>evidence),{code:'user_terminal_required'});
  t.diagnostic(JSON.stringify({terminalAncestry:{platform:process.platform,source:evidence.source,reason:evidence.reason,complete:evidence.complete,count:evidence.ancestors.length,allowed}}));
});
