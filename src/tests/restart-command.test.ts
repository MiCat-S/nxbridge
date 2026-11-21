import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { restartCommand } from '../app/commands/restart-command.js';
import { listenBroker } from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';
import {ipcAddress} from '../shared/local-paths.js';
import { processIdentity } from '../process/process.js';
import { temporary } from './support/temporary.js';
import {BridgeError} from '../shared/errors.js';

for(const outcome of ['completed','failed'] as const)test(`单组重启回复断连后等待持久${outcome==='completed'?'完成':'失败'}结果，不重复执行或重建协调器`,async t=>{
  const home=temporary(t);await ensureHome(home);let restartCalls=0,resultCalls=0,saved:any;
  let completion:NodeJS.Timeout|undefined;t.after(()=>clearTimeout(completion));
  const server=net.createServer(socket=>{
    socket.on('error',()=>{});let buffered='';socket.setEncoding('utf8');
    socket.on('data',chunk=>{buffered+=chunk;let at:number;while((at=buffered.indexOf('\n'))>=0){
      const request=JSON.parse(buffered.slice(0,at));buffered=buffered.slice(at+1);let result:any;
      if(request.method==='ping')result={pid:process.pid,origin:[]};
      else if(request.method==='codex.restart.target')result={owner:'nxbridge',session_id:'chosen',broker:{pid:process.pid,generation:'broker-generation',windowsIndependent:true}};
      else if(request.method==='codex.restart'){
        assert.equal(request.params.session_id,'chosen');assert.equal(request.params.broker_generation,'broker-generation');
        restartCalls++;completion=setTimeout(()=>saved={requestId:request.params.request_id,text:'确认已完成的重启'},450);socket.destroy();continue;
      }else if(request.method==='codex.restart.result'){
        resultCalls++;
        if(!saved||outcome==='failed'){socket.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:saved?'restart_incomplete':'restart_result_missing',message:saved?'原 ID 未完整恢复':'结果尚未落盘'}})+'\n');continue;}
        assert.equal(request.params.request_id,saved.requestId);result={text:saved.text};
      }else throw Error('意外的方法 '+request.method);
      socket.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    }});
  });
  await new Promise<void>(resolve=>server.listen(ipcAddress(home),resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  if(outcome==='completed')assert.equal((await restartCommand({},home)).text,'确认已完成的重启');else await assert.rejects(restartCommand({},home),{code:'restart_incomplete',uncertain:false});
  assert.equal(restartCalls,1);assert.ok(resultCalls>=2);
});

test('独立协调器保留原身份，仅重启选中会话，不影响其他配对',async t=>{
  const home=temporary(t);await ensureHome(home);let restarts=0;
  const server=await listenBroker(home,async(method,params:any)=>{
    if(method==='ping')return{pid:process.pid};
    if(method==='codex.restart.target'){assert.equal(params.session_id,'project-a');return{owner:'nxbridge',session_id:'project-a',runtime:{pid:2147483647,procStart:'gone'},broker:{pid:process.pid,generation:'kept',windowsIndependent:true}};}
    assert.equal(method,'codex.restart');assert.equal(params.session_id,'project-a');assert.equal(params.broker_pid,process.pid);assert.equal(params.broker_generation,'kept');restarts++;return{text:'原会话已恢复'};
  });t.after(()=>server.close());
  assert.equal((await restartCommand({session_id:'project-a'},home)).text,'原会话已恢复');assert.equal(restarts,1);
});

test('重启调用属于目标宿主时先拒绝，不停止自身或其他会话',async t=>{
  const home=temporary(t);await ensureHome(home);const generation=(await processIdentity(process.pid)).startedAt;
  const server=await listenBroker(home,async method=>{if(method==='ping')return{pid:process.pid};assert.equal(method,'codex.restart.target');return{owner:'nxbridge',runtime:{pid:process.pid,procStart:generation},broker:{windowsIndependent:true}};});t.after(()=>server.close());
  await assert.rejects(restartCommand({},home),{code:'self_restart'});
});

test('Windows 旧协调器缺少独立性证据时只提示引导，不隐式重建或重启',{skip:process.platform!=='win32'},async t=>{
  const home=temporary(t);await ensureHome(home);
  const server=await listenBroker(home,async method=>{if(method==='ping')return{pid:process.pid};assert.equal(method,'codex.restart.target');return{owner:'nxbridge',broker:{pid:process.pid,windowsIndependent:false}};});t.after(()=>server.close());
  await assert.rejects(restartCommand({},home),{code:'bootstrap_required'});
});

test('用户窗口只返回原生恢复步骤，不进入后台引导或停止路径',async t=>{
  const home=temporary(t);await ensureHome(home);
  const server=await listenBroker(home,async method=>{if(method==='ping')return{pid:process.pid};assert.equal(method,'codex.restart.target');return{owner:'user',text:'请在对应原生窗口恢复'};});t.after(()=>server.close());
  assert.equal((await restartCommand({},home)).text,'请在对应原生窗口恢复');
});

test('搭档命令从预检到停止保留原生调用方及配对围栏，拒绝原因指明等待或停止',async t=>{
  const home=temporary(t);await ensureHome(home);const native={host:'claude' as const,pid:101,procStart:'caller'};let failure='';
  const server=await listenBroker(home,async(method,params:any)=>{
    if(method==='ping')return{pid:process.pid};
    assert.equal(params.partner,true);assert.deepEqual(params.native,native);
    if(method==='codex.restart.target')return{owner:'nxbridge',peer_id:'chosen',session_id:'same',pair_id:'pair',broker:{pid:process.pid,generation:'kept',windowsIndependent:true}};
    assert.equal(method,'codex.restart');assert.equal(params.peer_id,'chosen');assert.equal(params.pair_id,'pair');assert.equal(params.session_id,'same');
    if(failure)throw new BridgeError(failure,'拒绝原因');return{text:'原会话恢复'};
  });t.after(()=>server.close());
  assert.equal((await restartCommand({native,partner:true},home)).text,'原会话恢复');
  for(const code of ['session_busy','subagent_active','shared_runtime']){failure=code;await assert.rejects(restartCommand({native,partner:true},home),(error:any)=>{assert.equal(error.code,code);assert.match(error.message,code!=='shared_runtime'?/空闲后再尝试一次.*不要轮询/:/停止自动重试.*告知用户/);return true;});}
});
