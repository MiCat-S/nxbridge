import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish as setup } from './publish-fixture.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { processIdentity } from '../process/process.js';
import {resolveCli} from '../process/host-command.js';
import { NativeTerminal } from './terminal-fixture.js';

                                               
test('实际 Claude 原生升级表单：保留多题、描述与用户答案',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex');
  for(const d of [home,claudehome,codexhome])mkdirSync(d,{recursive:true});
  let requestId='',terminal:NativeTerminal|undefined;const requests:any[]=[],errors:string[]=[];
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const c of req)raw+=c;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push(body);const main=body.tools?.some((v:any)=>v.name==='ListAgents'),results=(body.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]);
    const ask=main&&!!requestId&&!results.some((v:any)=>v.type==='tool_result'&&v.tool_use_id==='native-form-answer'),input={request_id:requestId,action:'ask_user'},text=main?'NATIVE_FORM_DONE':'{"state":"done"}',content=ask?{type:'tool_use',id:'native-form-answer',name:'mcp__nxbridge__answer_question',input}:{type:'text',text};
    const response={id:'form-'+requests.length,type:'message',role:'assistant',model:body.model,content:[content],stop_reason:ask?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const e of [{type:'message_start',message:{...response,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:ask?{...content,input:{}}:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:ask?{type:'input_json_delta',partial_json:JSON.stringify(input)}:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:response.stop_reason,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'native-form-local-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{try{await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',claudeHome:claudehome,codexHome:codexhome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',autoUpdatesChannel:'stable',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  await setup();const marketplace=path.join(home,'marketplace');(await ensureBroker(home)).close();const cli=resolveCli('claude');
  terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--plugin-dir',path.join(marketplace,'plugins/claude'),'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const status=()=>brokerCall<any>('status',{}, {home}),wait=(check:()=>boolean|Promise<boolean>,reason:string)=>terminal!.wait(check,reason+'；'+errors.join(';'),30000);
  await terminal.prompt('初始化原生多题验收');await wait(async()=>(await status()).peers.some((p:any)=>p.host==='claude'&&p.context),'原生 Mod 未登记窗口');
  await wait(async()=>terminal!.output.includes('NATIVE_FORM_DONE')&&(await status()).peers.some((p:any)=>p.host==='claude'&&p.state==='ready'),'初始化原生轮次未结束');
  let s=await status();const c=s.peers.find((p:any)=>p.host==='claude'&&p.context),identity=await processIdentity(process.pid),x=await brokerCall<any>('register',{host:'codex',sessionId:'native-form-counterpart',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'form-counterpart',pid:process.pid,procStart:identity.startedAt}},{home});
  await brokerCall('pair',{claude:c.id,codex:x.id},{home});await wait(async()=>(await status()).endpoints.some((e:any)=>e.peerId===c.id&&e.active&&e.questionSupport),'Mod 未发布问答能力');
  const questions=[{id:'first',header:'第一题',question:'原生表单第一题？',options:[{label:'甲',description:'NATIVE_FORM_DESCRIPTION'},{label:'乙',description:'另一选择'}]},{id:'second',header:'第二题',question:'原生表单第二题？',options:[{label:'确认',description:'保留第二题'},{label:'取消',description:'另一选择'}]}];
  const offset=terminal.output.length;
  requestId=(await brokerCall<any>('question.create',{actor:{host:'codex',sessionId:x.sessionId,callId:'multi-form'},questions},{home})).request_id;
  await wait(()=>{const shown=stripVTControlCharacters(terminal!.output.slice(offset)).replace(/\s+/gu,'');return shown.includes('NATIVE_FORM_DESCRIPTION')&&shown.includes('Entertoselect');},'未绘制完整原生第一题');
                                            
  const first=terminal.output.length;await terminal.prompt('');await wait(()=>stripVTControlCharacters(terminal!.output.slice(first)).replace(/\s+/gu,'').includes('保留第二题'),'未绘制原生第二题');
  await terminal.prompt('');await terminal.prompt('');
  await wait(async()=>{s=await status();return s.questions.find((q:any)=>q.id===requestId)?.status==='answered';},'原生多题答案未回填');
  const answered=s.questions.find((q:any)=>q.id===requestId);assert.equal(answered.source.kind,'user_via_claude');assert.deepEqual(answered.answers,{first:{answers:['甲']},second:{answers:['确认']}});
  await wait(()=>requests.some(r=>JSON.stringify(r.messages).includes('user_answers')&&JSON.stringify(r.messages).includes('原生表单第二题？')),'原生答案未返回模型');assert.equal(errors.length,0);
  t.diagnostic(JSON.stringify({nativePid:terminal.identity.pid,requestId,multiQuestion:true,realModelCalls:0}));
});
