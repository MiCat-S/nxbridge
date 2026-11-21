import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { processIdentity } from '../process/process.js';
import {resolveCli} from '../process/host-command.js';
import { NativeTerminal } from './terminal-fixture.js';

test('实际 Claude Mod：清空、压缩和恢复保留成员，待投递正文及回答方问题沿袭', {skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex');
  for(const d of [home,claudehome,codexhome])mkdirSync(d,{recursive:true});let phase=0;
  const requests:any[]=[],errors:string[]=[];const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const c of req)raw+=c;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push(body);const text='CLAUDE_LINEAGE_DONE_'+phase,n=requests.length;
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'msg-'+n,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});for(const e of [{type:'message_start',message:{id:'msg-'+n,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');res.end();
  }catch(e){errors.push(String(e));res.writeHead(500);res.end(String(e));}});
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'nxbridge-local-lineage-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  let terminal:NativeTerminal|undefined;
  t.after(async()=>{try{await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',autoUpdatesChannel:'stable',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  const marketplace=await preparePlugins(home);(await ensureBroker(home)).close();const exe=resolveCli('claude');
  terminal=await NativeTerminal.start(root,home,exe.command,[...exe.prefix,'--plugin-dir',path.join(marketplace,'plugins/claude'),'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const status=()=>brokerCall<any>('status',{}, {home}),wait=(check:()=>boolean|Promise<boolean>,reason:string)=>terminal!.wait(check,reason+'；'+errors.join(';'),25000);
  const turn=async(text:string)=>{const offset=terminal!.output.length;await terminal!.prompt(text);await wait(()=>terminal!.output.slice(offset).includes('CLAUDE_LINEAGE_DONE_'+phase),'Claude 原生轮次未完成');};
  await turn('初始化原生沿袭验收');await wait(async()=>(await status()).peers.some((p:any)=>p.host==='claude'&&p.context),'Mod 未登记真实窗口');let s=await status(),c=s.peers.find((p:any)=>p.host==='claude'&&p.context);const original=c.sessionId,member=c.id,native=terminal.identity;
  const actor=(p:any)=>{const b=s.bindings.find((b:any)=>b.peerId===p.id&&b.active);return{host:p.host,memberId:p.id,sessionId:p.sessionId,callId:'lineage-'+phase,...(b?{binding:{key:b.key,epoch:b.epoch}}:{})};};
  const identity=await processIdentity(process.pid),x=await brokerCall<any>('register',{host:'codex',sessionId:'claude-lineage-counterpart',cwd:root,name:'沿袭 Codex 搭档',kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'counterpart',pid:process.pid,procStart:identity.startedAt}},{home}),xa=actor(x);
  await wait(async()=>(await status()).endpoints.some((e:any)=>e.peerId===member&&e.active&&e.questionSupport===true),'原生 Mod 未声明问答能力');
  const pair=await brokerCall<any>('pair',{claude:member,codex:x.id},{home}),old=actor(c);
  await brokerCall('peer.state',{actor:old,state:'needsHuman'},{home});
  const q=await brokerCall<any>('question.create',{actor:xa,questions:[{id:'q',header:'沿袭',question:'原生沿袭验证？',options:[{label:'甲',description:'甲'},{label:'乙',description:'乙'}]}]},{home});
  const accepted=await brokerCall<any>('send',{actor:xa,message:'CLAUDE_PENDING_RESET_BODY'},{home});assert.equal((await status()).messages.find((m:any)=>m.id===accepted.message_id).state,'accepted');
  await terminal.prompt('/clear');await wait(async()=>((await status()).peers.find((p:any)=>p.id===member)?.sessionId)!==original,'清空未更新当前窗口身份');phase++;await turn('清空后继续处理来信');s=await status();c=s.peers.find((p:any)=>p.id===member);const fresh=c.sessionId;
  assert.equal(s.pair.id,pair.id);assert.equal(c.context.lineage.at(-1).reason,'reset');const reoffered=s.questions.find((v:any)=>v.id===q.request_id);assert.equal(reoffered.status,'pending');assert.equal(reoffered.expiresAt,Date.parse(q.expires_at));
  await assert.rejects(brokerCall('question.answer',{actor:old,input:{request_id:q.request_id,answers:{'原生沿袭验证？':'甲'},rationale:'旧上下文'}},{home}),{code:'stale_context'});
  await brokerCall('question.answer',{actor:actor(c),input:{request_id:q.request_id,answers:{'原生沿袭验证？':'甲'},rationale:'当前上下文'}},{home});
  await wait(()=>requests.some(r=>JSON.stringify(r.messages).includes('CLAUDE_PENDING_RESET_BODY')),'待投递正文未进入新模型上下文');assert.equal((await status()).messages.filter((m:any)=>m.id===accepted.message_id).length,1);
  const before=requests.length;await terminal.prompt('/compact');await wait(()=>requests.length>before,'未执行实际压缩');phase++;await turn('压缩后继续');s=await status();assert.equal(s.peers.find((p:any)=>p.id===member).sessionId,fresh);assert.equal(s.pair.id,pair.id);
  await terminal.prompt('/resume '+original);await wait(async()=>((await status()).peers.find((p:any)=>p.id===member)?.sessionId)===original,'原生恢复未更新窗口身份');phase++;await turn('恢复旧对话后继续');s=await status();assert.equal(s.pair.id,pair.id);assert.equal(s.peers.find((p:any)=>p.id===member).context.lineage.at(-1).reason,'switch');assert.equal(terminal.identity.pid,native.pid);assert.equal(errors.length,0);
  t.diagnostic(JSON.stringify({member,pair:pair.id,lineage:s.peers.find((p:any)=>p.id===member).context.lineage,requests:requests.length,realModelCalls:0}));
});
