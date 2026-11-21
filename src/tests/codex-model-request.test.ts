import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexModelRequests, modelRequestLog, providerBlocked, withModelRequest } from '../hosts/codex/codex-model-request.js';
import { temporary } from './support/temporary.js';
import { fixture } from './support/broker-fixture.js';
import { pairIssues } from '../broker/pairing/pair-anomalies.js';
import { VERSION } from '../version.js';
import { MOD_REVISION } from '../mod-revision.js';

const row=(code=503,turn='turn',pid=42)=>({ts:1000,ts_nanos:125000000,target:'codex_http_client::client',process_uuid:`pid:${pid}:instance`,feedback_log_body:`turn{turn.id=${turn}}:model_client.stream_responses_api{api.path="/responses"}: Request completed method=POST url=https://secret.example/responses status=${code} Service headers={Authorization:secret} body=private`});
const terminal=(status:unknown=400,turn='turn',pid=42)=>({...row(200,turn,pid),target:'codex_core::session::turn',feedback_log_body:`turn{turn.id=${turn}}:session_task.run:run_turn: Turn error: ${JSON.stringify({type:'error',status,error:{type:'invalid_request_error',message:'private upstream response'}})}`});
test('HTTP 诊断仅认模型请求的同进程同轮次，输出不含地址、请求头或正文',()=>{
  const value=modelRequestLog(row(),'turn',42)!;
  assert.deepEqual(value,{state:'retrying',kind:'http',statusCode:503,at:1000125,source:'native-log'});
  assert.equal(modelRequestLog(row(),'other',42),undefined);assert.equal(modelRequestLog(row(),'turn',43),undefined);
  assert.equal(modelRequestLog({...row(),feedback_log_body:row().feedback_log_body.replace('/responses','/models')},'turn',42),undefined);
  assert.doesNotMatch(JSON.stringify(value),/secret|private|Authorization/);
  assert.equal(modelRequestLog(row(429),'turn',42)?.kind,'quota');assert.equal(modelRequestLog(row(401),'turn',42)?.kind,'auth');
});
test('诊断数据库只读兼容；新的成功请求、实际进展和正常结束解除故障归因',t=>{
  const home=temporary(t),db=new DatabaseSync(path.join(home,'logs_2.sqlite'));
  db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,thread_id TEXT,target TEXT,ts INTEGER,ts_nanos INTEGER,process_uuid TEXT,feedback_log_body TEXT); CREATE INDEX another_native_index ON logs(thread_id,ts DESC,ts_nanos DESC,id DESC)');
  const insert=db.prepare('INSERT INTO logs(thread_id,target,ts,ts_nanos,process_uuid,feedback_log_body) VALUES(?,?,?,?,?,?)');
  for(const [session,code] of [['other',200],['session',503]] as const){const r=row(code);insert.run(session,'codex_http_client::client',r.ts,r.ts_nanos,r.process_uuid,r.feedback_log_body);}
  const request=new CodexModelRequests().read(home,'session','turn',42)!;assert.equal(request.statusCode,503);
  const health={turnId:'turn',state:'silent' as const,lastProgressAt:1000000,lastEventAt:1100000,tools:[]};
  assert.ok(providerBlocked(withModelRequest(health,request)));
  assert.equal(providerBlocked(withModelRequest({...health,lastProgressAt:1100000},request)),false);
  assert.equal(providerBlocked(withModelRequest({...health,state:'ready'},request)),false);
  assert.equal(providerBlocked(withModelRequest({...health,state:'failed'},request)),false,'失败轮次不能永久屏蔽其他告警');
  const success=row(200);insert.run('session','codex_http_client::client',success.ts+1,0,success.process_uuid,success.feedback_log_body);
  assert.equal(providerBlocked(withModelRequest(health,new CodexModelRequests().read(home,'session','turn',42))),false);
  db.close();assert.equal(new CodexModelRequests().read(temporary(t),'session','turn',42),undefined);
});

test('未细分的原生请求失败仍覆盖旧 HTTP 结果，不泄漏原始错误',()=>{
  const value=modelRequestLog({...row(),feedback_log_body:row().feedback_log_body.replace(/Request completed.*/, 'Request failed is_timeout=false is_connect=false error=private')},'turn',42);
  assert.equal(value?.kind,'request');assert.equal(value?.state,'retrying');assert.doesNotMatch(JSON.stringify(value),/private/);
});

test('原生结构化终止错误只取可信目标、进程与轮次，不复制错误正文',()=>{
  for(const status of [400,401,403,429,503]){
    const value=modelRequestLog(terminal(status),'turn',42);
    assert.deepEqual(value,{state:'failed',kind:[401,403].includes(status)?'auth':status===429?'quota':'http',statusCode:status,at:1000125,source:'native-log'});
    assert.doesNotMatch(JSON.stringify(value),/private|upstream|invalid_request_error/);
  }
  assert.equal(modelRequestLog(terminal(),'other',42),undefined);
  assert.equal(modelRequestLog(terminal(),'turn',43),undefined);
  assert.equal(modelRequestLog({...terminal(),target:'codex_core::tools'},'turn',42),undefined);
  assert.equal(modelRequestLog({...terminal(),feedback_log_body:terminal().feedback_log_body.replace('turn.id=turn','turn.id=other')},'turn',42),undefined);
  for(const status of [200,399,600,'400',null])assert.equal(modelRequestLog(terminal(status),'turn',42),undefined);
  for(const text of ['Turn error: {invalid','Turn error: {"type":"message","status":400,"error":{}}','Turn error: {"type":"error","status":400}','tool output: {"type":"error","status":400,"error":{}}']){
    assert.equal(modelRequestLog({...terminal(),feedback_log_body:`turn{turn.id=turn}: ${text}`},'turn',42),undefined);
  }
});

test('流式请求的终止失败覆盖旧 HTTP 200，排除其他目标或轮次，后续成功仍可恢复',t=>{
  const home=temporary(t),db=new DatabaseSync(path.join(home,'logs_2.sqlite'));
  try{
    db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,thread_id TEXT,target TEXT,ts INTEGER,ts_nanos INTEGER,process_uuid TEXT,feedback_log_body TEXT)');
    const insert=db.prepare('INSERT INTO logs(thread_id,target,ts,ts_nanos,process_uuid,feedback_log_body) VALUES(?,?,?,?,?,?)');
    const add=(value:ReturnType<typeof row>,ts:number,session='session')=>insert.run(session,value.target,ts,value.ts_nanos,value.process_uuid,value.feedback_log_body);
    add(row(200),1000);add(terminal(),1100);
    add(terminal(429,'other'),1101);add(terminal(503,'turn',43),1102);add({...terminal(401),target:'codex_core::tools'},1103);add(terminal(403),1104,'other');
    const request=new CodexModelRequests().read(home,'session','turn',42)!;
    assert.equal(request.state,'failed');assert.equal(request.statusCode,400);assert.equal(request.at,1100125);
    for(const state of ['running','ready','failed'] as const){
      const health=withModelRequest({turnId:'turn',state,lastProgressAt:1000000,lastEventAt:1200000,tools:[]},request);
      assert.equal(health.modelRequest?.state,'failed','确定的原生终止错误不能变回重试中');
      assert.equal(providerBlocked(health),false);
    }
    add(row(200),1200);
    assert.equal(new CodexModelRequests().read(home,'session','turn',42)?.state,'succeeded');
    add(row(200,'next'),1201);
    assert.equal(new CodexModelRequests().read(home,'session','next',42)?.statusCode,200,'新轮次不继承旧轮次错误');
  }finally{db.close();}
});
test('供应商故障聚合派生告警，只保留具体原因且不唤醒或附加恢复指令',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id),health=withModelRequest({turnId:'turn',state:'silent',lastProgressAt:1,lastEventAt:1000125,tools:[]},modelRequestLog(row(),'turn',42));
  const issues=pairIssues({pair,peer:{...x,state:'busy'},endpoint:store.endpoint(x.id),now:2000000,health,version:VERSION,modRevision:MOD_REVISION,integration:{scope:'scope',since:1,turnsWithoutHook:3,lastTurnAt:1},messages:[{...store.accept(pair,c,'任务','call'),updatedAt:1}],replyContractActive:false,transitioning:false,questionPending:false});
  assert.deepEqual(issues.map(issue=>issue.kind),['provider_retry']);assert.match(issues[0]!.message,/503/);assert.doesNotMatch(issues[0]!.message,/recover|resume|hook|doctor|status|继续指令/);
});
