import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { spawnSync } from 'node:child_process';
import { RUNTIME_NOTICE_SUMMARY } from '../broker/health/runtime-notice-delivery.js';
import { fixture } from './support/broker-fixture.js';

async function harness(options:{deferPrompts?:boolean;noticeTurnId?:string;noticeBody?:string}={}){
  let lastSelection:any;const timeouts=new Map<string,number|undefined>();
  const handlers:{event:string;filter:any;run:Function;recover?:Function}[]=[],checks:any[]=[],calls:any[]=[],nativeCalls:any[]=[],statuses:(string|undefined)[]=[],toasts:string[]=[],ticks:Function[]=[],prompts:any[]=[],appends:any[]=[];
  const mod=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/register.js')).href);
  const control=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-control.js')).href);
  mod.register((event:string,filter:unknown,run?:Function)=>{const handler={event,filter:run?filter:undefined,run:run??filter as Function,recover:undefined as Function|undefined};assert.ok(handler.filter||!handlers.some(h=>h.event===event&&!h.filter),'原生 Mod 不允许重复的通用事件钩子');handlers.push(handler);return{catch:(recover:Function)=>{handler.recover=recover;}};});
  let failure:string|undefined,waitResult:any={status:'needs_user'},nativeResult:any={result:{answers:{问题:'用户'}}},sessionId='session',uiFailure:Error|undefined;
  const responses:Record<string,unknown>={},errors:Record<string,string>={};
  const queuedPrompts:any[]=[],commandRuns:any[]=[],deferred:Function[]=[];
  const consumePrompt=(input:any)=>input.skipHooks?(prompts.push(input),Promise.resolve({text:input.text})):run('prompt.submit',{...input,origin:input.origin??{kind:'plugin',name:'nxbridge'}},async(e:any)=>{const stored=input.isMeta&&!input.turnId?{...e,text:input.text}:e;prompts.push(stored);return responses.prompt??{text:stored.text,context:stored.context,origin:stored.origin};});
  const $={
    settings:{read:async(args:any)=>{const all=(responses.settings??{}) as Record<string,any>;if(args?.source)return all[args.source]??{};if(args?.key)return all.merged?.[args.key];return all.merged??{};}},
    session:{id:async()=>sessionId,model:async()=>{const model=(responses as any)['session-model'];if(model instanceof Error)throw model;return model;},cwd:async()=>'/project',surfaces:async()=>(responses.surfaces as string[]|undefined)??[],usage:async()=>{const usage=(responses as any)['session-usage'];if(usage instanceof Error)throw usage;return usage??{context:{window:1000000}};},messages:async()=>responses.messages??[],append:async(input:unknown)=>{appends.push(input);return{};}},env:{get:async(name?:string)=>name==='CLAUDE_CODE_EFFORT_LEVEL'?(responses as any)['effort-env']:'/tmp/inbox'},plugin:{root:'/plugin'},
    fs:{read:async(file:string)=>{const files=responses.files as Record<string,string>|undefined;if(files&&file in files)return files[file];throw Error('missing '+file);}},agent:{list:async()=>[{id:'child'}]},
                                                 
    prompt:{submit:async(input:any)=>{const pending={...input,skipHooks:true};if(options.deferPrompts){queuedPrompts.push(pending);return{};}return consumePrompt(pending);}},
    tool:{check:async(args:any)=>{checks.push(args);const verdict=(responses as any)['tool-check'];if(verdict instanceof Error)throw verdict;return verdict??{decision:'ask'};},register:async(spec:{name:string})=>({tool:'mcp__nxbridge__'+spec.name}),call:async()=>{throw Error('原生表单必须使用 ui.ask');}},command:{register:async()=>{},run:async(input:any)=>{commandRuns.push(input);return input.command==='effort'?(responses['effort-current']??{text:''}):{text:'Reloaded'};}},ui:{status:(text:string|undefined)=>statuses.push(text),toast:(text:string)=>toasts.push(text),ask:async(question:string,options:any)=>{
      const result=await run('tool.call',{tool:'AskUserQuestion',questions:[{question,header:options.header,options:options.options?.map((label:string)=>({label,description:''})),multiSelect:options.multiSelect===true}]},async(input:unknown)=>{nativeCalls.push(input);if(nativeResult instanceof Error)throw nativeResult;return typeof nativeResult==='function'?nativeResult(input):nativeResult;});
      if(uiFailure)throw uiFailure;
      if(result.deny)throw Error(result.deny);
      return result.result?.answers?.[question]??'';
    }},clock:{every:(_ms:number,fn:Function)=>ticks.push(fn),after:(_ms:number,fn:Function)=>{deferred.push(fn);return{cancel:()=>{const index=deferred.indexOf(fn);if(index>=0)deferred.splice(index,1);}};}},
    process:{run:async(args:string[],processOptions?:{stdin?:string;timeoutMs?:number})=>{
      const input=JSON.parse(processOptions?.stdin??args.at(-1)!);calls.push(input);timeouts.set(input.operation,processOptions?.timeoutMs);
      const stderr=errors[input.operation]??failure;
      let response=responses[input.operation]??(input.operation==='selection-resolve'?lastSelection:input.operation==='monitor-prepare'?{notices:((responses.monitor as any)?.notices??[]).filter((n:any)=>n.id===input.notice_id)}:undefined);
      if(!stderr&&input.operation==='monitor-enqueue'&&response===undefined){
        const pending={text:`<cross-session-message from-name="nxbridge runtime monitor (nxbridge:claude)">\n[nxbridge system_notice source=runtime_monitor notice_id=${input.notice_id}]\n${options.noticeBody??RUNTIME_NOTICE_SUMMARY}\n</cross-session-message>`,origin:{kind:'peer'},isMeta:true,...(options.noticeTurnId?{turnId:options.noticeTurnId}:{})};
        if(options.deferPrompts)queuedPrompts.push(pending);else await consumePrompt(pending);response={queued:true};
      }
      const value=stderr?undefined:typeof response==='function'?await response(input):response??{message_id:'saved-message',paired:true,partner:{state:'ready'}};
                                                
      if(value?.status==='selection_required')lastSelection=value;
      return stderr?{exitCode:1,stderr}:{exitCode:0,stdout:JSON.stringify(value)};
    },spawn:async function*(){yield{stream:'stdout',text:JSON.stringify(waitResult)};}},
  };
  const run=(event:string,e:any,next:Function=event==='prompt.submit'?async(input:any)=>({text:input.text??'',origin:input.origin}):async()=>({}))=>{
    const matching=handlers.filter(h=>h.event===event&&(!h.filter||Object.entries(h.filter).every(([k,v])=>e[k]===v)));
    const signal=new AbortController().signal;
    const invoke=(index:number,input:any):any=>{
      if(index===matching.length)return next(input);
      const h=matching[index]!,wrapped=Object.assign((changed:any)=>{wrapped.called=true;return invoke(index+1,changed);},{signal,called:false});
      const result=h.run($,input,wrapped);
      return h.recover?Promise.resolve(result).catch(error=>h.recover!($,input,Object.assign(wrapped,{error}))):result;
    };
    return invoke(0,e);
  };
  const runningTicks=new Set<Function>();
                                       
  return{snapshot:(operation='status')=>control.call($,operation),timeouts,checks,calls,nativeCalls,statuses,toasts,prompts,appends,commandRuns,flush:async()=>{for(const fn of deferred.splice(0))await fn();},consumePrompt:async()=>{assert.ok(queuedPrompts.length,'没有待消费的原生提示');return consumePrompt(queuedPrompts.shift());},session:(id:string)=>{sessionId=id;},tick:async()=>{for(const fn of ticks){if(runningTicks.has(fn))continue;runningTicks.add(fn);try{await fn();}finally{runningTicks.delete(fn);}}},run,fail:(detail?:unknown)=>{failure=detail?JSON.stringify(detail):'断连';},error:(operation:string,detail:unknown)=>{errors[operation]=JSON.stringify(detail);},nativeResult:(value:unknown)=>{nativeResult=value;},uiFailure:(value:Error)=>{uiFailure=value;},response:(operation:string,value:unknown)=>{responses[operation]=value;},waitResult:(value:unknown)=>{waitResult=value;}};
}

test('Mod 原生轮次和工具提供进展快照，状态心跳不产生新进展，旧轮次不改写新轮',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'current'});
  assert.equal(h.calls.at(-1).nativeHealth.turnId,'current');assert.equal(h.calls.at(-1).nativeHealth.source,'native-mod');
  t.mock.timers.tick(1000);
  await h.run('tool.call',{tool:'Bash',tool_use_id:'native-tool'},async()=>{
    await h.snapshot();
    assert.deepEqual(h.calls.at(-1).nativeHealth.tools,['native-tool']);return{result:'工具完成'};
  });
  await h.snapshot();const at=h.calls.at(-1).nativeHealth.lastProgressAt;
  t.mock.timers.tick(1000);await h.snapshot();assert.equal(h.calls.at(-1).nativeHealth.lastProgressAt,at);
  await h.run('turn.start',{turnId:'next'});await h.run('turn.complete',{turnId:'current'});
  await h.snapshot();assert.equal(h.calls.at(-1).nativeHealth.turnId,'next');assert.equal(h.calls.at(-1).nativeHealth.state,'running');
});

test('Mod 模型增量是真实进展，重试和心跳不刷新进展，原生失败原样传递',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'stream'});
  const nativeError=new Error('原生请求失败');
  const step=h.run('turn.step',{model:'native'},async function*(){
    t.mock.timers.tick(1000);yield{kind:'text',index:0,text:'真实增量'};
    t.mock.timers.tick(1000);yield{type:'system',subtype:'api_retry'};
  });
  for await(const _ of step){}
  await h.snapshot();let snapshot=h.calls.at(-1).nativeHealth;
  assert.equal(snapshot.lastProgressAt,2001000);assert.equal(snapshot.lastEventAt,2002000);assert.equal(snapshot.state,'networkRetrying');
  const failing=h.run('turn.step',{model:'native'},async function*(){throw nativeError;});
  await assert.rejects(async()=>{for await(const _ of failing){}},error=>error===nativeError);
  await h.run('turn.complete',{turnId:'stream'});await h.snapshot();snapshot=h.calls.at(-1).nativeHealth;
  assert.equal(snapshot.state,'failed');assert.match(snapshot.error,/原生请求失败/);
});

test('Mod 原生审核决定恢复仍在执行的工具，迟到决定不能修改下一轮',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'permission'});
  const snapshot=async()=>{await h.tick();return h.calls.findLast(c=>c.operation==='status').nativeHealth;};
  await h.run('tool.call',{tool:'Bash',tool_use_id:'approval-tool'},async()=>{
    const states=()=>h.calls.filter(c=>c.operation==='state').map(c=>c.state);
    await h.run('classic.PermissionRequest',{session_id:'session',tool_name:'Bash'});
    assert.equal((await snapshot()).state,'needsHuman');
                                   
    assert.equal(states().at(-1),'needsHuman');
    t.mock.timers.tick(1000);
    await h.run('telemetry.log',{to:'collector',event:'tool_decision',attributes:{tool_use_id:'other',decision:'accept'}});
    assert.equal((await snapshot()).state,'needsHuman');assert.equal(states().at(-1),'needsHuman');
    await h.run('telemetry.log',{to:'collector',event:'tool_decision',attributes:{tool_use_id:'approval-tool',decision:'accept',source:'user_temporary'}});
    const running=await snapshot();assert.equal(running.state,'running');assert.deepEqual(running.tools,['approval-tool']);
                             
    const answered=states().length;assert.equal(states().at(-1),'busy');
    await h.run('telemetry.log',{to:'collector',event:'tool_decision',attributes:{tool_use_id:'approval-tool',decision:'accept',source:'user_temporary'}});assert.equal(states().length,answered);
    assert.equal(running.lastProgressAt,2001000,'批准后执行的工具必须恢复实际进展');
    await h.run('turn.start',{turnId:'next-permission'});t.mock.timers.tick(1000);
    await h.run('telemetry.log',{to:'collector',event:'tool_decision',attributes:{tool_use_id:'approval-tool',decision:'reject'}});
    assert.equal((await snapshot()).lastProgressAt,2001000);
                                                
    await h.run('classic.PermissionRequest',{session_id:'session',tool_name:'Bash'});const waiting=states().length;assert.equal(states().at(-1),'needsHuman');
    await h.run('telemetry.log',{to:'collector',event:'tool_decision',attributes:{tool_use_id:'approval-tool',decision:'accept',source:'user_temporary'}});assert.equal(states().length,waiting);
    return{result:'执行完成'};
  });
  assert.equal((await snapshot()).turnId,'next-permission');
});

test('Mod 只把当前等待的 Agent 及嵌套代理的真实输出计入根进展',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'delegate-root'});
  const snapshot=async()=>{await h.snapshot();return h.calls.at(-1).nativeHealth;};
  const childStep=async(agentId:string)=>{for await(const _ of h.run('turn.step',{agentId,turnId:'child-turn',model:'native'},async function*(){yield{kind:'thinking',index:0,text:'真实子代理输出'};})){};};
  await h.run('tool.call',{tool:'Agent',tool_use_id:'root-delegation',prompt:'执行任务'},async()=>{
    await h.run('agent.spawn',{tool_use_id:'root-delegation',prompt:'执行任务'},async()=>({agentId:'working-child'}));
    t.mock.timers.tick(1000);await childStep('unrelated-child');assert.equal((await snapshot()).lastProgressAt,2000000);
    await childStep('working-child');assert.equal((await snapshot()).lastProgressAt,2001000);
    assert.deepEqual((await snapshot()).tools,['root-delegation']);
    await h.run('tool.call',{agentId:'working-child',tool:'Agent',tool_use_id:'nested-delegation',prompt:'嵌套任务'},async()=>{
      await h.run('agent.spawn',{parentAgentId:'working-child',tool_use_id:'nested-delegation',prompt:'嵌套任务'},async()=>({agentId:'nested-child'}));
      t.mock.timers.tick(1000);await childStep('nested-child');assert.equal((await snapshot()).lastProgressAt,2002000);return{result:'嵌套完成'};
    });
    return{result:'根委派完成'};
  });
  t.mock.timers.tick(1000);await childStep('working-child');assert.equal((await snapshot()).lastProgressAt,2002000,'已不等待的后台代理不计入根进展');
  await h.run('turn.start',{turnId:'new-root'});t.mock.timers.tick(1000);await childStep('nested-child');assert.equal((await snapshot()).lastProgressAt,2003000,'新轮次隔离旧代理');
  h.session('other-session');await h.run('turn.start',{turnId:'other-root'});t.mock.timers.tick(1000);await childStep('working-child');assert.equal((await snapshot()).lastProgressAt,2004000,'新对话隔离旧代理');
});

test('只有原生用户来源记录新输入，通知及子代理输入不重新开启空闲工作阶段',async()=>{
  const h=await harness();await h.run('session.start',{});h.calls.length=0;
  for(const origin of ['peer','peer-send-message','plugin'])await h.run('prompt.submit',{origin:{kind:origin},text:'[nxbridge system_notice source=idle_unanswered notice_id=notice]\n系统事实'},async(e:any)=>e);
  await h.run('prompt.submit',{origin:{kind:'composer'},agentId:'child',text:'子代理输入'},async(e:any)=>e);
  assert.equal(h.calls.filter(c=>c.operation==='prompt').length,0);
                               
  await h.run('prompt.submit',{origin:{kind:'sdk'},text:'脚本输入'},async(e:any)=>e);await h.run('turn.start',{turnId:'script',text:'脚本输入'});
  assert.equal(h.calls.filter(c=>c.operation==='prompt').length,0);
  for(const origin of ['composer','bridge']){
    await h.run('prompt.submit',{origin:{kind:origin},text:'真正的用户输入'},async(e:any)=>e);
    await h.run('turn.start',{turnId:origin,text:'真正的用户输入'});
  }
                                                  
  h.response('surfaces',['desktop']);
  await h.run('prompt.submit',{origin:{kind:'sdk'},text:'桌面端用户输入'},async(e:any)=>e);
  await h.run('turn.start',{turnId:'desktop',text:'桌面端用户输入'});
  assert.equal(h.calls.filter(c=>c.operation==='prompt').length,3);
});

test('Mod 忙时提交等实际新轮次开始才恢复，旧中断不能把完整新轮次留在暂停',async t=>{
  const {store,broker,c}=fixture(t),h=await harness();h.session(c.sessionId!);await h.run('session.start',{});
  const actor={host:'claude',sessionId:c.sessionId!,callId:'native-lifecycle'};
  h.response('state',(input:any)=>broker.dispatch('peer.state',{actor,state:input.state}));
  h.response('prompt',()=>broker.dispatch('peer.prompt',{actor}));
  await h.run('turn.start',{turnId:'old',text:'旧任务'});
  await h.run('prompt.submit',{origin:{kind:'composer'},turnId:'old',text:'新任务'});
  assert.equal(h.calls.filter(call=>call.operation==='prompt').length,0,'排队提交不能提前恢复');
  await h.run('turn.complete',{turnId:'old',isAborted:true});assert.equal(store.peer(c.id).state,'paused');
  await h.run('classic.Stop',{session_id:c.sessionId,background_tasks:[],session_crons:[]});
  await h.run('turn.start',{turnId:'new',text:'新任务'});assert.equal(store.peer(c.id).state,'busy');
  await h.run('turn.complete',{turnId:'new',isAborted:false});assert.equal(store.peer(c.id).state,'ready');
                                
  await h.run('turn.complete',{turnId:'old',isAborted:true});assert.equal(store.peer(c.id).state,'ready');
  assert.equal(h.calls.filter(call=>call.operation==='prompt').length,1);
});

test('Mod 拒收或失败的用户提交不留下恢复资格，搭档及子代理不能借后续轮次恢复',async()=>{
  for(const rejected of ['drop','throw']){
    const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'old'});
    const submission=()=>h.run('prompt.submit',{origin:{kind:'composer'},turnId:'old',text:'未进入的任务'},async()=>{if(rejected==='throw')throw Error('原生拒绝');return{drop:'已消费，未开始任务'};});
    if(rejected==='throw')await assert.rejects(submission(),/原生拒绝/);else await submission();
    await h.run('turn.complete',{turnId:'old',isAborted:true});
    for(const input of [{origin:{kind:'peer'},text:'未进入的任务'},{origin:{kind:'composer'},agentId:'child',text:'未进入的任务'}])await h.run('prompt.submit',input);
    await h.run('turn.start',{turnId:'partner',text:'未进入的任务'});
    assert.equal(h.calls.filter(call=>call.operation==='prompt').length,0);
  }
});

test('Mod 使用原生接收后的改写文本匹配排队输入，多个输入及上下文边界彼此独立',async()=>{
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'old'});
  await h.run('prompt.submit',{origin:{kind:'composer'},turnId:'old',text:'原文'},async()=>({text:'原生改写'}));
  await h.run('prompt.submit',{origin:{kind:'bridge'},turnId:'old',text:'第二条'});
  await h.run('turn.complete',{turnId:'old',isAborted:true});
  await h.run('turn.start',{agentId:'child',turnId:'child-turn',text:'原生改写'});
  await h.run('turn.start',{turnId:'partner',text:'搭档消息'});assert.equal(h.calls.filter(call=>call.operation==='prompt').length,0);
  await h.run('turn.start',{turnId:'first',text:'原生改写'});await h.run('turn.complete',{turnId:'first',isAborted:true});
  await h.run('turn.start',{turnId:'second',text:'第二条'});assert.equal(h.calls.filter(call=>call.operation==='prompt').length,2);
  await h.run('prompt.submit',{origin:{kind:'composer'},turnId:'second',text:'清除前的任务'});
  await h.run('session.end',{reason:'clear'});h.session('new-session');await h.run('turn.start',{turnId:'other',text:'清除前的任务'});
  assert.equal(h.calls.filter(call=>call.operation==='prompt').length,2);
});

test('Mod 原生新轮次先于提交回调返回时，按最新完成或中断状态结算恢复',async()=>{
  for(const isAborted of [false,true]){
    const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'old'});
    await h.run('prompt.submit',{origin:{kind:'composer'},turnId:'old',text:'原文'},async()=>{
      await h.run('turn.complete',{turnId:'old',isAborted:true});
      await h.run('turn.start',{turnId:'new',text:'原生改写'});
      await h.run('turn.complete',{turnId:'new',isAborted});
      return{text:'原生改写'};
    });
    assert.equal(h.calls.filter(call=>call.operation==='prompt').length,1);
    assert.equal(h.calls.findLast(call=>call.operation==='state').state,isAborted?'paused':'ready');
  }
});

test('Mod 原生合并排队输入后结算同批资格，命令封套匹配已接收的用户命令',async()=>{
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'old'});
  for(const text of ['第一条','第二条'])await h.run('prompt.submit',{origin:{kind:'composer'},turnId:'old',text});
  await h.run('turn.complete',{turnId:'old',isAborted:true});
  await h.run('turn.start',{turnId:'batch',text:'第二条'});await h.run('turn.complete',{turnId:'batch',isAborted:true});
  await h.run('prompt.submit',{origin:{kind:'peer'},text:'第一条'});await h.run('turn.start',{turnId:'partner',text:'第一条'});
  assert.equal(h.calls.filter(call=>call.operation==='prompt').length,1,'已被合并消费的输入不能给搭档轮次留下恢复资格');
  await h.run('prompt.submit',{origin:{kind:'composer'},command:{name:'plugin:command'},text:'/plugin:command'});
  await h.run('turn.complete',{turnId:'partner',isAborted:true});
  await h.run('turn.start',{turnId:'command',text:'<command-message>plugin:command</command-message>\n<command-name>/plugin:command</command-name>'});
  assert.equal(h.calls.filter(call=>call.operation==='prompt').length,2);
});

test('Mod 已开始的旧状态回执先于用户恢复发送，失败也不阻断恢复',async()=>{
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'old'});
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  h.response('state',async(input:any)=>{if(input.state==='paused'){entered();await blocked;throw Error('旧回执断线');}return{};});
  const old=h.run('turn.complete',{turnId:'old',isAborted:true});await started;
  const user=h.run('prompt.submit',{origin:{kind:'composer'},text:'新输入'},async(e:any)=>{void h.run('turn.start',{turnId:'new',text:e.text});return{text:e.text};});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.some(call=>call.operation==='prompt'),false,'旧回执仍未结束，恢复不能越过它');
  release();await Promise.all([old,user]);assert.equal(h.calls.filter(call=>call.operation==='prompt').length,1);
});

test('Mod 空闲提交先返回时不借上一轮的中断状态重新暂停',async()=>{
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'previous'});
  await h.run('turn.complete',{turnId:'previous',isAborted:true});
  h.calls.length=0;
  await h.run('prompt.submit',{origin:{kind:'composer'},text:'下一轮'});
  assert.equal(h.calls.some(call=>call.operation==='prompt'),false);
  assert.equal(h.calls.some(call=>call.operation==='state'&&call.state==='paused'),false);
  await h.run('turn.start',{turnId:'next',text:'下一轮'});await h.run('turn.complete',{turnId:'next'});
  assert.equal(h.calls.at(-1).state,'ready');
});

test('Mod 压缩保留调用方说明、原生句柄与计费信息，只对已安装的当前根追加一次事实',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('recovery',{text:'nxbridge recovery facts rev 2 approved facts',sessionId:'session'});
  const original={messages:[{role:'assistant',text:'原生摘要',toolUses:[],handle:'native'},{role:'user',text:'nxbridge recovery facts rev 1 old',toolUses:[]},{role:'user',text:'〔nxbridge 压缩后自动附上的恢复信息，供 AI 接续工作，你无需处理〕\nnxbridge recovery facts rev 1 newer',toolUses:[]}],tokensBefore:200,tokensAfter:20,usage:{input_tokens:10,output_tokens:2}};
  let input:any;
  const result=await h.run('session.compact',{trigger:'auto',instructions:'调用方说明',messages:[]},async(e:any)=>{input=e;return original;});
  assert.match(input.instructions,/^调用方说明\n\nnxbridge: keep codex partner tasks\/decisions/);
  assert.equal(result.messages.length,2);assert.equal(result.messages[0],original.messages[0]);assert.equal(result.messages[1].role,'user');assert.match(result.messages[1].text,/^〔nxbridge 压缩后自动附上的恢复信息，供 AI 接续工作，你无需处理〕\nnxbridge recovery facts rev 2 /);
  assert.equal(result.usage,original.usage);assert.equal(result.tokensAfter,20);assert.equal(h.prompts.length+h.appends.length,0);
  const before=h.calls.filter(c=>c.operation==='recovery').length;
  for(const event of [{trigger:'precompute'},{trigger:'auto',agentId:'child'}])assert.equal(await h.run('session.compact',{...event,messages:[]},async()=>original),original);
  const skipped={skip:'原生拒绝'};assert.equal(await h.run('session.compact',{trigger:'manual',messages:[]},async()=>skipped),skipped);
  assert.equal(h.calls.filter(c=>c.operation==='recovery').length,before);
  assert.equal(await h.run('session.compact',{trigger:'auto',messages:[]},async()=>{h.session('new');return original;}),original);
  assert.equal(h.calls.filter(c=>c.operation==='recovery').length,before);
});

test('Mod 通知队列只含信号，条件在最终消费前恢复时不进入历史也不唤醒模型',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'resolved',wake:true,source:'pair_anomaly'}]});h.response('monitor-prepare',{notices:[]});
  await h.tick();assert.equal(h.prompts.length,0);assert.equal(h.appends.length,0);
  assert.equal(h.calls.filter(c=>c.operation==='monitor-prepare').length,1);assert.equal(h.calls.filter(c=>c.operation==='monitor-ack').length,0);
});

test('同一空闲提醒在消费前因临时门槛撤销，恢复后沿用原编号且提交后不重排',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'temporarily-cancelled',wake:true,source:'idle_unanswered'}]});h.response('monitor-prepare',{notices:[]});
  await h.tick();assert.equal((await h.consumePrompt()).drop,'nxbridge：这条提醒送达前问题已消失，已自动丢弃，无需处理');assert.equal(h.prompts.length,0);
  h.response('monitor',{notices:[]});await h.tick();assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
  h.response('monitor',{notices:[{id:'temporarily-cancelled',wake:true,source:'idle_unanswered'}]});h.response('monitor-prepare',{notices:[{id:'temporarily-cancelled',wake:true,source:'idle_unanswered',message:'仍有未关联回复的任务'}]});
  await h.tick();await h.consumePrompt();await h.tick();
  assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,2);assert.equal(h.prompts.length,1);assert.match(h.prompts[0].context.join('\n'),/仍有未关联回复的任务/);
});

test('Mod 原生提示先入队后消费，保留最终核验并丢弃恢复或跨对话的旧信号',async()=>{
  for(const state of ['active','resolved','rotated']){
    const h=await harness({deferPrompts:true});await h.run('session.start',{});
    const id='queued-'+state;h.response('monitor',{notices:[{id,wake:true}]});
    h.response('monitor-prepare',{notices:state==='resolved'?[]:[{id,wake:true,message:'消费时仍存在的故障'}]});
    await h.tick();assert.equal(h.prompts.length,0);assert.equal(h.calls.some(c=>c.operation==='monitor-prepare'),false);
    if(state==='rotated')h.session('new-conversation');
    await h.consumePrompt();
    if(state==='active'){
      assert.equal(h.prompts.length,1);assert.match(h.prompts[0].context.join('\n'),/消费时仍存在的故障/);assert.doesNotMatch(JSON.stringify(h.prompts[0]),/notice pickup|undefined/);
      assert.equal(h.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'submitted');
    }else{assert.equal(h.prompts.length,0);assert.equal(h.calls.some(c=>c.operation==='monitor-ack'),false);}
    const count=h.prompts.length;await h.run('prompt.submit',{origin:{kind:'plugin',name:'nxbridge'},text:'nxbridge notice pickup '+id},async(e:any)=>{h.prompts.push(e);return{};});
    assert.equal(h.prompts.length,count,'已消费或失效的信号不能作为普通正文进入模型');
  }
});

test('搭档引用通知编号仍是普通消息，不能丢弃正文或消费真正通知的租约',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'quoted',wake:true,message:'真正通知正文'}]});await h.tick();
  const header='[nxbridge system_notice source=runtime_monitor notice_id=quoted]';
  for(const value of [
    `<cross-session-message from-name="Codex (nxbridge:codex)">\n请核对这个编号\n${header}\n</cross-session-message>`,
    `<cross-session-message from-name="nxbridge runtime monitor (nxbridge:claude)">\n这仍是有正文的消息\n${header}\n</cross-session-message>`,
    `前面的真实正文\n<cross-session-message from-name="nxbridge runtime monitor (nxbridge:claude)">\n${header}\n</cross-session-message>`,
  ]){
    const input={origin:{kind:'peer'},isMeta:true,text:value};
    assert.deepEqual(await h.run('prompt.submit',input,async(e:any)=>e),input);
  }
  assert.equal(h.calls.filter(c=>c.operation==='monitor-prepare').length,0);
  await h.consumePrompt();assert.equal(h.prompts.length,1);assert.match(h.prompts[0].context.join('\n'),/真正通知正文/);
});

test('Mod 通知消费核验失败时关闭入口',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});h.response('monitor',{notices:[{id:'prepare-failed',wake:true}]});h.error('monitor-prepare',{message:'暂时无法核验'});
  await h.tick();assert.match((await h.consumePrompt()).drop,/暂时无法核验/);assert.equal(h.prompts.length,0);
});

test('Mod 空闲和轮中通知使用同一正文，空正文关闭入口，下游移除上下文时不虚报提交或重试',async()=>{
  const entry='[nxbridge system_notice source=runtime_monitor notice_id=body]\n已核验的通知正文';
  for(const noticeTurnId of [undefined,'running'])for(const noticeBody of ['',RUNTIME_NOTICE_SUMMARY]){
    const h=await harness({noticeTurnId,noticeBody});await h.run('session.start',{});h.response('monitor',{notices:[{id:'body',wake:true,message:'已核验的通知正文'}]});
    await h.tick();assert.equal(h.prompts.length,1);assert.equal(noticeTurnId?h.prompts[0].text:h.prompts[0].context.at(-1),entry);
    if(!noticeTurnId&&noticeBody)assert.ok(h.prompts[0].text.includes(RUNTIME_NOTICE_SUMMARY),'空闲原生界面保留中文说明');
  }
  const empty=await harness({deferPrompts:true});await empty.run('session.start',{});empty.response('monitor',{notices:[{id:'empty',wake:true,message:'  '}]});await empty.tick();
  assert.match((await empty.consumePrompt()).drop,/暂时无法核验/);assert.equal(empty.prompts.length,0);assert.equal(empty.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'unknown');
  const missing=await harness();await missing.run('session.start',{});missing.response('monitor',{notices:[{id:'missing',wake:true,message:'实际正文'}]});missing.response('prompt',{text:'下游未返回附加上下文'});
  await missing.tick();await missing.tick();assert.equal(missing.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'unknown');assert.match(missing.statuses.at(-1)!,/通知未确认.*上下文回执/);assert.equal(missing.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
});

test('Mod 原生经典事件只观察本根实际权限，缺失和轮转不沿用旧模式；只在模式变化时登记一次，不额外启动进程',async()=>{
  const h=await harness();await h.run('session.start',{});const before=h.calls.length;
  const native={session_id:'session',permission_mode:'default'};
                                                
  assert.deepEqual(await h.run('classic.UserPromptSubmit',native,async(e:any)=>e),native);assert.ok(h.calls.length-before<=1);assert.ok(h.calls.slice(before).every(c=>c.operation==='register'));
  const settled=h.calls.length;await h.run('classic.UserPromptSubmit',native,async(e:any)=>e);assert.equal(h.calls.length,settled);
  await h.snapshot();assert.equal(h.calls.at(-1).nativePermission.mode,'default');assert.ok(h.calls.at(-1).nativePermission.observedAt>0);
  await h.run('classic.PreToolUse',{session_id:'old',permission_mode:'bypassPermissions'});
  await h.run('classic.PreToolUse',{...native,agent_id:'child',permission_mode:'bypassPermissions'});
  await h.snapshot();assert.equal(h.calls.at(-1).nativePermission.mode,'default');
  await h.run('classic.Stop',{session_id:'session',permission_mode:'bypassPermissions'});
  await h.snapshot();assert.equal(h.calls.at(-1).nativePermission.mode,'bypassPermissions');
  await h.run('classic.PreToolUse',{session_id:'session'});await h.snapshot();assert.equal(h.calls.at(-1).nativePermission.mode,'unknown');
  h.session('new');await h.snapshot();assert.equal(h.calls.at(-1).nativePermission,undefined);
});

test('Mod 原生历史路径与界面观察只绑定当前根会话，未知不能当无人值守',async()=>{
  const h=await harness();h.session('session-facts');await h.run('session.start',{isInteractive:true});
  await h.run('classic.SessionStart',{session_id:'session-facts',transcript_path:'/native/session-facts.jsonl'});
  await h.snapshot();
  assert.deepEqual(h.calls.at(-1).nativeSession,{interactive:true,transcriptPath:'/native/session-facts.jsonl'});
  await h.run('classic.PreToolUse',{session_id:'session-facts',agent_id:'child',transcript_path:'/native/child.jsonl'});
  await h.snapshot();assert.equal(h.calls.at(-1).nativeSession.transcriptPath,'/native/session-facts.jsonl');
  h.session('fresh-facts');await h.snapshot();assert.equal(h.calls.at(-1).nativeSession,undefined);
  await h.run('session.start',{isInteractive:false});assert.equal(h.calls.at(-1).nativeSession,undefined);
  await h.run('session.start',{});assert.equal(h.calls.at(-1).nativeSession,undefined);
});

test('Mod 运行时监测标识不能作为收件人，不转交原生发信或创建配对',async()=>{
  const h=await harness();let native=0;
  for(const to of ['nxbridge runtime monitor','nxbridge runtime monitor (nxbridge:claude)','nxbridge:claude']){
    const result=await h.run('tool.call',{tool:'SendMessage',to,message:'不要回信'},async()=>{native++;return{};});
    assert.equal(result.result.success,false);assert.match(result.result.message,/not a recipient/);
  }
  assert.equal(native,0);assert.equal(h.calls.some(c=>['send','selection-get','selection-commit'].includes(c.operation)),false);
});

test('Mod 拦下 nxbridge: 开头的笔误地址并给出正确地址，大小写和空格差异按搭档地址处理，其他地址交回原生',async()=>{
  const h=await harness();let native=0;const passthrough=async()=>{native++;return{};};
  for(const to of ['nxbridge:colex','NXBRIDGE:codexx','nxbridge :codex2']){
    const result=await h.run('tool.call',{tool:'SendMessage',to,message:'正文'},passthrough);
    assert.equal(result.result.success,false);assert.match(result.result.message,/partner address is nxbridge:codex/);assert.match(result.result.display,/nxbridge:codex/);
  }
  assert.equal(native,0);assert.equal(h.calls.some(c=>c.operation==='send'),false);
  await h.run('tool.call',{tool:'SendMessage',to:' NXBridge:Codex ',message:'正文',tool_use_id:'case-send'},passthrough);
  assert.equal(native,0);assert.equal(h.calls.filter(c=>c.operation==='send').length,1);
  await h.run('tool.call',{tool:'SendMessage',to:'researcher',message:'正文'},passthrough);assert.equal(native,1);
});

test('Mod 状态查询等待交接时，独立通知继续且状态查询不重复启动',async()=>{
  const h=await harness();await h.run('session.start',{});
  let entered!:()=>void,finish!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  h.response('status',async()=>{entered();await gate;return{paired:true,partner:{state:'ready'}};});
  const pending=h.tick();await ready;
  try{
    h.response('monitor',{notices:[{id:'independent',wake:true,source:'runtime_monitor',message:'broker endpoint unavailable'}]});
    await h.tick();await h.tick();
    assert.equal(h.prompts.length,1);assert.match(h.prompts[0].context.join('\n'),/broker endpoint unavailable/);
    assert.equal(h.calls.filter(c=>c.operation==='status').length,1);
    assert.equal(h.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'submitted');
  }finally{finish();await pending;}
});

test('Mod 同步建议只进入当前根工具结果，保留原结果和上下文且不唤醒',async t=>{
  let now=1000000;t.mock.method(Date,'now',()=>now);
  const h=await harness();await h.run('session.start',{});h.response('tip-sync',{tip:'同步提示'});
  const result=await h.run('tool.call',{tool:'Bash'},async()=>{now+=31*60000;return{result:'原结果',context:['原上下文']};});
  assert.deepEqual(result,{result:'原结果',context:['原上下文','同步提示']});
  const count=h.calls.filter(c=>c.operation==='tip-sync').length;
  await h.run('tool.call',{tool:'Bash'},async()=>({result:'继续'}));assert.equal(h.calls.filter(c=>c.operation==='tip-sync').length,count);
  now+=60000;await h.run('tool.call',{tool:'Bash',agentId:'child'},async()=>({result:'子代理'}));
  await h.run('tool.call',{tool:'Bash'},async()=>({deny:'拒绝'}));assert.equal(h.calls.filter(c=>c.operation==='tip-sync').length,count);
  await h.run('tool.call',{tool:'Bash'},async()=>{h.session('fresh');await h.run('tool.call',{tool:'Bash'},async()=>({result:'新对话'}));return{result:'迟到旧结果'};});
  assert.equal(h.calls.filter(c=>c.operation==='tip-sync').length,count);assert.equal(h.prompts.length,0);assert.equal(h.appends.length,0);
});

test('Mod 旧轮完成保留原上下文，新轮状态和发送轮次不被旧回调覆盖',async()=>{
  const h=await harness();await h.run('session.start',{});await h.run('turn.start',{turnId:'old'});
  h.session('new-context');await h.run('turn.start',{turnId:'new'});h.calls.length=0;
  await h.run('turn.complete',{turnId:'old',isAborted:true});
  assert.equal(h.calls.find(c=>c.operation==='state').sessionId,'session');assert.equal(h.calls.find(c=>c.operation==='cancel_turn').sessionId,'session');
  await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'新任务',tool_use_id:'new-send'});
  assert.equal(h.calls.at(-1).sessionId,'new-context');assert.equal(h.calls.at(-1).turnId,'new');
  const count=h.calls.length;await h.run('turn.complete',{turnId:'unknown-old',isAborted:true});assert.equal(h.calls.length,count);
});

test('Mod 未收到子代理开始事件时，完成仍沿用其原始启动上下文',async()=>{
  const h=await harness();await h.run('session.start',{});
  await h.run('agent.spawn',{prompt:'子任务',tool_use_id:'spawn'},async()=>({agentId:'child'}));
  h.session('new-context');await h.run('turn.start',{turnId:'new'});h.calls.length=0;
  await h.run('turn.complete',{agentId:'child',turnId:'nested-unseen',answer:'子任务完成',isAborted:false});
  const captured=h.calls.find(c=>c.operation==='ref-capture');assert.ok(captured);assert.equal(captured.sessionId,'session');assert.equal(captured.text,'子任务完成');
                                   
  h.calls.length=0;await h.run('turn.complete',{agentId:'child',turnId:'continued-unseen',answer:'继续后的答案',isAborted:false});
  const again=h.calls.find(c=>c.operation==='ref-capture');assert.ok(again);assert.equal(again.sessionId,'session');assert.equal(again.text,'继续后的答案');
});

test('Mod 回答表单异步完成沿用原窗口租约和表单租约，不借新上下文提交',async()=>{
  const h=await harness();await h.run('session.start',{});
  let entered!:()=>void,answer!: (value:any)=>void;const started=new Promise<void>(resolve=>entered=resolve),pending=new Promise(resolve=>answer=resolve);
  h.response('answer',{status:'awaiting_user',questions:[{question:'问题',header:'选择'}],form_lease:'old-form'});
  h.nativeResult(()=>{entered();return pending;});
  const work=h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'q',action:'ask_user',tool_use_id:'old-answer'});
  await started;h.session('new-context');await h.snapshot();
  answer({result:{answers:{问题:'原生答案'}}});await work;
  const submitted=h.calls.find(c=>c.operation==='answer_user');assert.equal(submitted.sessionId,'session');assert.equal(submitted.form_lease,'old-form');
  assert.equal(h.calls.filter(c=>c.operation==='state').at(-1).sessionId,'session');
});

test('Mod 对话切换通知不唤醒、绝不直接写入对话：留到根会话下一个工具结果边界随上下文附上，回执去重',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'rotation',source:'context_rotation',wake:false,message:'partner context changed'}]});
  await h.tick();await h.tick();assert.equal(h.prompts.length,0);assert.equal(h.appends.length,0);
  assert.equal(h.calls.some(c=>c.operation==='monitor-prepare'||c.operation==='monitor-ack'),false,'留在插件里时不取正文、不回报');
                     
  const child=await h.run('tool.call',{tool:'Bash',tool_use_id:'c1',agentId:'child'},async()=>({result:{}}));assert.equal(child.context,undefined);
  const result=await h.run('tool.call',{tool:'Bash',tool_use_id:'t1'},async()=>({result:{}}));
  assert.match(result.context.join('\n'),/source=context_rotation[\s\S]*partner context changed/);
  assert.equal(h.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'submitted');
  await h.tick();const again=await h.run('tool.call',{tool:'Bash',tool_use_id:'t2'},async()=>({result:{}}));assert.equal(again.context,undefined,'同一提醒只附上一次');
  assert.equal(h.appends.length,0);
});

test('Mod 留在插件里的提醒随下一次输入提交附上；输入被丢弃时放回，已解决的不附',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'info',source:'pair_anomaly',wake:false,message:'info for next prompt'}]});await h.tick();
  const echo=async(input:any)=>({text:input.text,context:input.context,origin:input.origin});
  const dropped=await h.run('prompt.submit',{origin:{kind:'composer'},text:'hi'},async()=>({drop:'host refused'}));assert.equal(dropped.drop,'host refused');
  assert.equal(h.calls.some(c=>c.operation==='monitor-ack'),false,'被丢弃的输入不算送达');
  const submitted=await h.run('prompt.submit',{origin:{kind:'composer'},text:'hi again'},echo);
  assert.match(submitted.context.join('\n'),/info for next prompt/);assert.equal(h.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'submitted');
                                          
  assert.equal(h.calls.filter(c=>c.operation==='monitor-prepare').length,1);
  const r=await harness();await r.run('session.start',{});
  r.response('monitor',{notices:[{id:'gone',source:'pair_anomaly',wake:false,message:'stale'}]});await r.tick();r.response('monitor-prepare',{notices:[]});
  const plain=await r.run('prompt.submit',{origin:{kind:'peer'},text:'partner msg'},echo);assert.equal(plain.context,undefined);
  assert.equal(r.calls.some(c=>c.operation==='monitor-ack'),false);assert.equal(r.appends.length,0);
});

test('Mod 协调器断线：本地监测给出的 broker_outage 唤醒走原生 inbox，未获准入的窗口只附加不唤醒',async()=>{
  const w=await harness({deferPrompts:true});await w.run('session.start',{});
  w.response('monitor',{notices:[{id:'outage-1',source:'broker_outage',kind:'broker_outage',epoch:'e1',incidentId:'e1',since:1,wake:true,message:'coordinator unreachable; run nxbridge doctor once'}]});
  await w.tick();assert.equal(w.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
  await w.consumePrompt();assert.equal(w.prompts.length,1);assert.match(w.prompts[0].context.join('\n'),/source=broker_outage[\s\S]*nxbridge doctor/);
  const p=await harness();await p.run('session.start',{});
  p.response('monitor',{notices:[{id:'outage-2',source:'broker_outage',kind:'broker_outage',epoch:'e1',wake:false,message:'coordinator unreachable; another window handles it'}]});
  await p.tick();assert.equal(p.calls.some(c=>c.operation==='monitor-enqueue'),false);assert.equal(p.prompts.length,0);assert.equal(p.appends.length,0);
  assert.match((await p.run('tool.call',{tool:'Bash',tool_use_id:'p1'},async()=>({result:{}}))).context.join('\n'),/another window handles it/);
                                                  
  const r=await harness();await r.run('session.start',{});
  assert.equal((await r.run('prompt.submit',{origin:{kind:'plugin',name:'nxbridge'},text:'nxbridge notice pickup broker-outage:e2'})).drop,'nxbridge：这条提醒送达前问题已消失，已自动丢弃，无需处理');
  const ack=r.calls.filter(c=>c.operation==='monitor-ack').at(-1);assert.equal(ack.notice_id,'broker-outage:e2');assert.equal(ack.state,'denied');assert.equal(ack.error,'outage_definitive_not_delivered');
                                                    
  const c=await harness({deferPrompts:true});await c.run('session.start',{});
  const sig=(at:number)=>({notices:[{id:'broker-outage:e4',source:'broker_outage',kind:'broker_outage',epoch:'e4',wake:true,claimedBy:{at},message:'task'}]});
  c.response('monitor',sig(1));await c.tick();c.response('monitor',sig(1));await c.tick();
  assert.equal(c.calls.filter(x=>x.operation==='monitor-enqueue').length,1);
  c.response('monitor',sig(2));await c.tick();assert.equal(c.calls.filter(x=>x.operation==='monitor-enqueue').length,2);
                                                  
  const q=await harness({deferPrompts:true});await q.run('session.start',{});
  q.response('monitor',{notices:[{id:'broker-outage:e3',source:'broker_outage',kind:'broker_outage',epoch:'e3',wake:true,message:'task'}]});
  await q.tick();q.response('monitor-prepare',{notices:[]});
  assert.equal((await q.consumePrompt()).drop,'nxbridge：这条提醒送达前问题已消失，已自动丢弃，无需处理');
  const qa=q.calls.filter(c=>c.operation==='monitor-ack').at(-1);assert.equal(qa.notice_id,'broker-outage:e3');assert.equal(qa.error,'outage_definitive_not_delivered');
  const before=r.calls.filter(c=>c.operation==='monitor-ack').length;await r.run('prompt.submit',{origin:{kind:'plugin',name:'nxbridge'},text:'nxbridge notice pickup plain-1'});assert.equal(r.calls.filter(c=>c.operation==='monitor-ack').length,before);
});

test('Mod 提醒缺省不唤醒：留到安全边界附上不开回合；排队唤醒在消费时已降为告知也不开回合；仍需处理才唤醒',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'info',source:'pair_anomaly',message:'broker restarted; 2 unknown kept'}]});
  await h.tick();assert.equal(h.prompts.length,0);assert.equal(h.calls.some(c=>c.operation==='monitor-enqueue'),false);
  assert.equal(h.appends.length,0);assert.match((await h.run('tool.call',{tool:'Bash',tool_use_id:'h1'},async()=>({result:{}}))).context.join('\n'),/broker restarted/);
  const d=await harness({deferPrompts:true});await d.run('session.start',{});
  d.response('monitor',{notices:[{id:'mixed',source:'pair_anomaly',wake:true,message:'reply owed + info'}]});
  await d.tick();assert.equal(d.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
  d.response('monitor-prepare',{notices:[{id:'mixed',source:'pair_anomaly',wake:false,message:'info only now'}]});
  assert.equal((await d.consumePrompt()).drop,'nxbridge：这条提醒只需告知，会在下次对话时附上，未打扰 AI');
  assert.equal(d.prompts.length,0);assert.equal(d.appends.length,0);
  assert.match((await d.run('tool.call',{tool:'Bash',tool_use_id:'d1'},async()=>({result:{}}))).context.join('\n'),/info only now/);
  assert.equal(d.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'submitted');
  assert.equal(d.calls.filter(c=>c.operation==='monitor-prepare').length,1,'降为告知时已领取的正文留着直接附上，不再领取');
  const w=await harness({deferPrompts:true});await w.run('session.start',{});
  w.response('monitor',{notices:[{id:'act',source:'pair_anomaly',wake:true,message:'reply owed'}]});
  await w.tick();await w.consumePrompt();assert.equal(w.prompts.length,1);assert.equal(w.appends.length,0);assert.match(w.prompts[0].context.join('\n'),/reply owed/);
});

test('Mod 原生结束事件的清空和恢复原因跨越即时或延迟的会话 ID 切换',async()=>{
  for(const reason of ['clear','resume'])for(const delayed of [false,true]){
    const h=await harness(),old='old-'+reason+'-'+delayed,fresh='new-'+reason+'-'+delayed;
    await h.run('session.start',{});h.session(old);await h.snapshot('register');h.calls.length=0;
    await h.run('session.end',{sessionId:old,reason},async()=>{if(!delayed)h.session(fresh);return{sessionId:old};});
    assert.equal(h.calls.find(c=>c.operation==='context-end').reason,reason==='clear'?'reset':'switch');
    if(delayed){h.session(fresh);await h.snapshot('register');}
    const registration=h.calls.find(c=>c.sessionId===fresh&&['register','context-start'].includes(c.operation));
    assert.ok(registration);assert.equal(registration.contextReason,reason==='clear'?'reset':'switch');
  }
});

test('Mod 迟到的旧结束事件不关闭新上下文，也不污染其后的未知轮转原因',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.session('current-context');await h.snapshot('register');h.calls.length=0;
  await h.run('session.end',{sessionId:'session',reason:'clear'},async()=>{h.session('later-context');return{};});
  assert.equal(h.calls.some(c=>c.operation==='context-end'),false);
  assert.equal(h.calls.some(c=>c.operation==='context-start'),false);
  await h.snapshot('register');
  assert.equal(h.calls.find(c=>c.operation==='register').contextReason,undefined);
});

test('Mod 结束调用延迟时先保留原生原因，新上下文登记失败后仍能重试',async()=>{
  const h=await harness();await h.run('session.start',{});
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),pending=new Promise<void>(resolve=>release=resolve);
  h.response('context-end',async()=>{entered();await pending;return{};});
  const work=h.run('session.end',{sessionId:'session',reason:'resume'});await started;
  h.session('delayed-new-context');h.error('register',{code:'disconnected',message:'暂时断连'});
  await assert.rejects(h.snapshot('register'),{code:'disconnected'});
  h.error('register',undefined);await h.snapshot('register');
  const registrations=h.calls.filter(c=>c.operation==='register'&&c.sessionId==='delayed-new-context');
  assert.equal(registrations.length,2);assert.ok(registrations.every(c=>c.contextReason==='switch'&&c.contextStart));
  release();await work;
  h.session('another-context');await h.snapshot('register');
  assert.equal(h.calls.filter(c=>c.operation==='register').at(-1).contextReason,undefined);
});

test('Mod 原生选择完成保留原发送，配对码已提交时不再提交选择或询问搭档',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  h.response('send',{status:'selection_required',selection_id:'choice',pairing_code:'1234',expires_at:Date.now()+600000,candidates:[{key:'a',label:'窗口甲',description:'空闲'},{key:'b',label:'窗口乙',description:'忙碌'}],allowed_actions:['choose','create','cancel']});
  h.nativeResult((input:any)=>({result:{answers:{[input.questions[0].question]:'窗口甲'}}}));
  h.response('selection-get',{status:'paired',message_id:'original',message:'paired via code in target window'});
  const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'原始正文',tool_use_id:'draft'});
  assert.equal(result.result.success,true);assert.match(result.result.message,/via code/);assert.equal(h.nativeCalls.length,1);
  assert.equal(h.calls.filter(c=>c.operation==='send').length,1);assert.equal(h.calls.some(c=>['selection-commit','create'].includes(c.operation)),false);
});

test('配对时两边权限模式不同：选择框、配对码和换绑结果都当场说明 Codex 回信会被拦下，并让 Claude 转告',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  const guide={state:'class_mismatch',receiver_class:'prompting',sender_class:'bypass'};
  h.response('send',{status:'selection_required',selection_id:'one',expires_at:Date.now()+600000,candidates:[{key:'a',label:'窗口甲',description:'空闲'}],allowed_actions:['choose','create','cancel']});
  h.nativeResult((input:any)=>({result:{answers:{[input.questions[0].question]:'现有窗口「窗口甲」'}}}));
  h.response('selection-get',{status:'pending'});h.response('selection-commit',{status:'paired',partner_name:'窗口甲',message_id:'m1',message:'saved; queued',permission_guidance:guide});
  const sent=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'p1'});
  assert.match(sent.result.message,/tell user now: Codex replies to this window are held for user approval.*expire, never delivered.*run Codex without full-access mode/);
  assert.match(sent.result.display,/注意：Codex 是全部放行模式、本窗口不是，Codex 的消息会被拦下等你审核/);
  assert.match(h.toasts.at(-1)!,/^注意：Codex 是全部放行模式/);
  h.response('surfaces',['desktop']);h.response('pair-code-commit',{requester_name:'窗口乙',permission_guidance:{...guide,receiver_class:'bypass'}});
  assert.match((await h.run('command.run',{command:'nxbridge',args:'pair 1234',origin:{kind:'sdk'}})).text,/^已与 Codex 窗口「窗口乙」配对。注意：本窗口是全部放行类.*Shift\+Tab/);
  h.nativeResult((input:any)=>({result:{answers:{[input.questions[0].question]:'现有窗口「窗口甲」'}}}));
  h.response('pair-code',{status:'selection_required',selection_id:'c',expires_at:Date.now()+600000,candidates:[{key:'a',label:'窗口甲',description:'空闲'}],allowed_actions:['choose','create','cancel']});
  h.response('selection-commit',{status:'paired',partner_name:'窗口甲',permission_guidance:{state:'refused'}});
  assert.match((await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}})).text,/^已与 Codex「窗口甲」配对。注意：本窗口设置为拒收其他会话的消息.*在 \/config 里修改接收设置/);
                                             
  h.response('selection-commit',{status:'paired',partner_name:'窗口甲',permission_guidance:{state:'refused',policy_source:'policy'}});
  assert.match((await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}})).text,/拒收其他会话的消息.*组织的托管策略，只有管理员能改/);
  h.response('selection-commit',{status:'paired',partner_name:'窗口甲',permission_guidance:{state:'refused',policy_source:'project'}});
  assert.match((await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}})).text,/\.claude\/settings\.json.*crossSessionInbound/);
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__choose_partner',input:{}})).result,/paired with "窗口甲"; tell user now: Codex replies to this window are refused/);
                    
  h.response('selection-commit',{status:'paired',partner_name:'窗口甲'});
  assert.equal((await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}})).text,'已与 Codex「窗口甲」配对。');
});

test('状态栏按 delivery_admission 说明被拦下和已作废的消息：作废只在最近一次后 30 分钟内显示',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10_000_000});
  const h=await harness();await h.run('session.start',{});
  const base={paired:true,self:{id:'me',state:'ready'},partner:{state:'ready'},integrationIssues:[],permission_guidance:{state:'class_mismatch',receiver_class:'prompting'}};
  h.response('status',{...base,delivery_admission:{inbound:{held:2,expired:0,refused:0,unknown:0},outbound:{held:0,expired:0,refused:0,unknown:0},approval_required:true}});
  await h.tick();assert.equal(h.statuses.at(-1),'Codex 发来的 2 条消息在等你审核：在审核框里放行，约 5 分钟不处理会作废。以后不想被拦下：让 Codex 不用全部放行模式运行');
  h.response('status',{...base,delivery_admission:{inbound:{held:0,expired:3,refused:0,unknown:2,latest_at:Date.now()-60_000},outbound:{held:0,expired:0,refused:0,unknown:0},approval_required:true}});
  await h.tick();assert.match(h.statuses.at(-1)!,/^Codex 发来的 3 条消息没被放行，已作废、没有送达（已告诉 Codex）。以后不想被拦下/);
  t.mock.timers.tick(30*60_000);await h.tick();
  assert.match(h.statuses.at(-1)!,/^Codex 是全部放行模式、本窗口不是/,'超过 30 分钟只留一般的权限提醒');
  h.response('status',{...base,permission_guidance:undefined,delivery_admission:{inbound:{held:0,expired:0,refused:0,unknown:0},outbound:{held:0,expired:1,refused:0,unknown:0,latest_at:Date.now()},approval_required:false}});
  await h.tick();assert.equal(h.statuses.at(-1),'你发给 Codex 的 1 条消息被拒收或过期，没有送达');
});

test('Mod 唯一已打开候选也先问：点名该窗口，可新建或暂不配对，选择后才提交',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  h.response('send',{status:'selection_required',selection_id:'one',expires_at:Date.now()+600000,candidates:[{key:'a',label:'窗口甲',description:'空闲'}],allowed_actions:['choose','create','cancel']});
  let asked:any;h.nativeResult((input:any)=>{asked=input.questions[0];return{result:{answers:{[asked.question]:'暂不配对'}}};});
  h.response('selection-get',{status:'pending'});h.response('selection-commit',{status:'selection_declined',message:'nothing sent'});
  await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'one-send'});
  assert.match(asked.question,/已经开着一个还没配对的 Codex 窗口（窗口甲），要和它配对吗/);
  assert.deepEqual(asked.options.map((o:any)=>o.label),['现有窗口「窗口甲」','新建后台 Codex','暂不配对']);
  assert.equal(h.calls.find(c=>c.operation==='selection-commit')?.action,'cancel');
});

test('Mod 选择框只选大类：多个现有窗口交给 AI 在对话里问用户，消息暂存不提交',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  h.response('send',{status:'selection_required',selection_id:'many',pairing_code:'4321',expires_at:Date.now()+600000,candidates:[{key:'a',label:'窗口甲',description:'空闲'},{key:'b',label:'窗口乙',description:'忙碌'}],allowed_actions:['choose','create','cancel']});
  let asked:any;h.nativeResult((input:any)=>{asked=input.questions[0];return{result:{answers:{[asked.question]:'现有窗口（2 个）'}}};});
  h.response('selection-get',{status:'pending'});
  const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'many-send'});
  assert.deepEqual(asked.options.map((o:any)=>o.label),['现有窗口（2 个）','新建后台 Codex','暂不配对']);assert.doesNotMatch(JSON.stringify(asked.options),/窗口甲/);assert.match(asked.question,/2 个还没配对.*也可以在要配对的那个 Codex 窗口里输入 nxbridge pair 4321（10 分钟内有效）/);
  assert.equal(result.result.success,false);assert.match(result.result.message,/ask user which one.*select_partner.*selection_id=many.*never pick yourself.*nxbridge pair 4321.*"key":"a","name":"窗口甲"/);
  assert.equal(result.result.display,'等你告诉 Claude 要配哪个 Codex 窗口');assert.equal(h.calls.some(c=>c.operation==='selection-commit'),false);
});

test('Mod 没有可选搭档且禁止新建时，命令和工具都跳过表单并保留配对码',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  h.response('pair-code',{status:'selection_required',selection_id:'code-only',pairing_code:'4321',expires_at:Date.now()+600000,candidates:[],allowed_actions:['choose','cancel']});
  const human=await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}});
  assert.match(human.text,/没有可以配对的 Codex 窗口，当前配置也禁止新建后台搭档。.*nxbridge pair 4321/);
  const tool=await h.run('tool.call',{tool:'mcp__nxbridge__choose_partner',input:{}});
  assert.match(tool.result,/no selectable Codex partner.*current configuration disables creating a background partner.*nxbridge pair 4321/);
  assert.equal(h.nativeCalls.length,0);
  assert.ok(!h.calls.some(c=>['selection-commit','state'].includes(c.operation)));
});

test('Mod 没有可选搭档也没有配对码时结束选择，并说明如何继续',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  h.response('pair-code',{status:'selection_required',selection_id:'no-code',expires_at:Date.now()+600000,candidates:[],allowed_actions:['choose','cancel']});
  h.response('selection-commit',{status:'selection_declined'});
  const human=await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}});
  assert.match(human.text,/没有可以配对的 Codex 窗口，当前配置也禁止新建后台搭档。.*打开要配对的 Codex 窗口/);
  assert.equal(h.nativeCalls.length,0);
  assert.deepEqual(h.calls.filter(c=>c.operation==='selection-commit').map(c=>[c.selection_id,c.action]),[['no-code','cancel']]);
});

test('Mod 发信无候选且只能用配对码时保留原始草稿',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  h.response('send',{status:'selection_required',selection_id:'draft-code',pairing_code:'4321',expires_at:Date.now()+600000,candidates:[],allowed_actions:['choose','cancel']});
  const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'原始正文',tool_use_id:'draft-code'});
  assert.equal(result.result.success,false);
  assert.match(result.result.message,/not sent.*current configuration disables creating a background partner.*nxbridge pair 4321.*original message.*do not resend/);
  assert.match(result.result.display,/没有可以配对的 Codex 窗口，当前配置也禁止新建后台搭档。.*nxbridge pair 4321/);
  assert.deepEqual(h.calls.filter(c=>c.operation==='send').map(c=>c.message),['原始正文']);
  assert.equal(h.nativeCalls.length,0);
  assert.ok(!h.calls.some(c=>['selection-commit','state'].includes(c.operation)));
});

test('Mod /nxbridge pair 与 choose_partner：已配对时可换绑、解除或保持，结果分开说明作废和可能已读的旧消息',async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  const change={status:'selection_required',mode:'change',selection_id:'chg',expires_at:Date.now()+600000,current_partner:{name:'旧会话',owner:'user',state:'ready'},candidates:[{key:'a',label:'窗口甲',description:'空闲'}],allowed_actions:['choose','create','unpair','cancel']};
  h.response('pair-code',change);h.response('selection-get',{status:'pending'});
  let asked:any;h.nativeResult((input:any)=>{asked=input.questions[0];return{result:{answers:{[asked.question]:'解除配对'}}};});
  h.response('selection-commit',{status:'unpaired',cancelled_message_ids:['m1'],uncertain_message_ids:['m2','m3']});
  const text=(await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}})).text;
  assert.match(asked.question,/当前搭档：Codex「旧会话」（你开的窗口·空闲）/);
  assert.deepEqual(asked.options.map((o:any)=>o.label),['现有窗口「窗口甲」','新建后台 Codex','解除配对','保持不变']);
  assert.equal(h.calls.find(c=>c.operation==='selection-commit').action,'unpair');
  assert.equal(text,'已解除配对，之后再发信时会再问你。有 1 条消息还没送到旧搭档，已作废，需要时 Claude 会重发给新搭档。另有 2 条可能已被旧搭档看到，不会重发。');
  assert.equal(h.calls.some(c=>c.operation==='state'),false);
  h.nativeResult((input:any)=>({result:{answers:{[input.questions[0].question]:'现有窗口「窗口甲」'}}}));
  h.response('selection-commit',{status:'paired',partner_name:'窗口甲',cancelled_message_ids:['m1']});
  const tool=await h.run('tool.call',{tool:'mcp__nxbridge__choose_partner',input:{}});
  assert.match(tool.result,/paired with "窗口甲"; cancelled_message_ids=m1 \(never delivered/);
  assert.equal(h.calls.filter(c=>c.operation==='selection-commit').at(-1).key,'a');
                                                         
  assert.match((await h.run('command.run',{command:'nxbridge',args:'pair 1234',origin:{kind:'sdk'}})).text,/你本人在这个 Claude 窗口的输入框里提交/);
  assert.deepEqual([h.calls.at(-1).operation,h.calls.at(-1).command,h.calls.at(-1).origin],['human-refused','pair','sdk']);assert.ok(!JSON.stringify(h.calls.at(-1)).includes('1234'));
  h.response('surfaces',['desktop']);h.response('pair-code-commit',{requester_name:'窗口乙'});
  assert.equal((await h.run('command.run',{command:'nxbridge',args:'pair 1234',origin:{kind:'sdk'}})).text,'已与 Codex 窗口「窗口乙」配对。');
  assert.deepEqual([h.calls.at(-1).operation,h.calls.at(-1).code,h.calls.at(-1).origin],['pair-code-commit','1234','composer']);
  h.response('surfaces',[]);
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__choose_partner',input:{},agentId:'sub'})).deny,/root session only/);
});

for(const restored of [false,true])test('Mod 换绑已提交但后台启动待确认时向模型和用户如实报告：'+restored,async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  h.response('pair-code',{status:'selection_required',mode:'change',selection_id:'pending-start',expires_at:Date.now()+600000,current_partner:{name:'旧搭档'},candidates:[{key:'target',label:'原会话',...(restored?{owner:'nxbridge',former_partner:true}:{})}],allowed_actions:['choose','cancel']});
  h.response('selection-get',{status:'pending'});
  h.nativeResult((input:any)=>({result:{answers:{[input.questions[0].question]:input.questions[0].options[0].label}}}));
  h.response('selection-commit',{status:'launch_precondition',pair_id:'new-pair',partner_name:'原会话',...(restored?{restored_previous_partner:true}:{}),launch_precondition:{code:'plugin_unavailable',message:'等待原会话登记。'}});
  const human=(await h.run('command.run',{command:'nxbridge',args:'pair',origin:{kind:'composer'}})).text;
  assert.match(human,restored?/已接回之前的后台 Codex「原会话」/:/已与 Codex「原会话」配对/);
  assert.match(human,/等待原会话登记。配对已保留，不用重新选择/);assert.doesNotMatch(human,/配对没有改变/);
  const model=(await h.run('tool.call',{tool:'mcp__nxbridge__choose_partner',input:{}})).result;
  assert.match(model,/paired with "原会话"; bg start pending: 等待原会话登记; pairing kept, do not re-pick/);assert.doesNotMatch(model,/unchanged/);
});

for(const mode of ['previous','merged','lost'] as const)test('Mod 历史后台候选按类别确认，丢失记录不混淆原搭档：'+mode,async()=>{
  const h=await harness();await h.run('session.start',{isInteractive:true});
  const history=[{key:'history-a',member_id:'history-a',owner:'nxbridge',former_partner:true,label:'历史甲'},{key:'history-b',member_id:'history-b',owner:'nxbridge',former_partner:true,label:'历史乙'}];
  const candidates=mode==='previous'?history:mode==='merged'?[{key:'live',member_id:'live',label:'运行窗口'},...history]:[...history,{key:'lost',member_id:'actual-lost',label:'丢失搭档',former_partner:true,restore_state:'resumable'}];
  h.response('send',{status:'selection_required',selection_id:'history',expires_at:Date.now()+600000,candidates,allowed_actions:['choose','create','unpair','cancel'],...(mode==='merged'?{mode:'change',current_partner:{name:'当前'}}:{}),...(mode==='lost'?{reason:'pair_lost',pair_lost:{partner_id:'actual-lost',partner_name:'丢失搭档',restore_state:'resumable'}}:{})});
  let asked:any;h.nativeResult((input:any)=>{asked=input.questions[0];assert.ok(asked.options.length<=4);if(mode==='lost')assert.equal(asked.options[0].label,'恢复原搭档「丢失搭档」');const selected=asked.options.find((option:any)=>option.label.includes('之前的后台'));assert.ok(selected);return{result:{answers:{[asked.question]:selected.label}}};});
  h.response('selection-get',{status:'pending'});
  const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'保留草稿',tool_use_id:'history-send'});
  assert.ok(!h.calls.some(call=>call.operation==='selection-commit'));assert.match(result.result.message,/"key":"history-a".*"prev":true/);assert.match(result.result.message,/"key":"history-b"/);
  if(mode==='merged')assert.match(result.result.message,/"key":"live"/);
  if(mode==='lost')assert.doesNotMatch(result.result.message,/"key":"lost"/);
});

test('Mod 非全部放行模式：权限提醒按两端类别给一步操作，等审批点出 nxbridge open codex，新窗口提示先输入一句',async()=>{
  const h=await harness();await h.run('session.start',{});
  const guide={state:'class_mismatch',sender_class:'prompting',receiver_class:'bypass',receiver_host:'claude',message:'native will hold: classes differ'};
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},permission_guidance:guide,integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/本窗口是全部放行类.*Codex 是需确认类.*审核框放行.*Shift\+Tab/);
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},permission_guidance:{...guide,sender_class:'bypass',receiver_class:'prompting'},integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/Codex 是全部放行模式、本窗口不是/);
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},permission_guidance:{...guide,state:'held'},integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/被本窗口拦下等你审核.*约 5 分钟.*确认作废后会告诉 Codex，不会自动重发/);
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},integrationIssues:[]});await h.tick();
  assert.equal(h.statuses.at(-1),undefined);
  const human={state:'needs_human',reason:'native_approval',host:'codex',member_id:'m',session_id:'t',name:'后台搭档',pending:1,open_command:'nxbridge open codex --member m',message:'x'};
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'needsHuman',delivery_wait:human},integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/Codex「后台搭档」在等你批准操作.*nxbridge open codex --member m.*不会自动批准/);
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'needsHuman',delivery_wait:{...human,reason:'native_input'}},integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/Codex「后台搭档」在等你回答问题.*nxbridge open codex --member m/);
  const first={...human,state:'waiting_native_input',reason:'awaiting_first_prompt',name:'新窗口',open_command:undefined};
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready',delivery_wait:first},integrationIssues:[]});await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 窗口「新窗口」还没开始对话，有 1 条消息在等：先在那个窗口输入一句，消息随后送达');
  h.response('send',{status:'waiting_native_input',message_id:'p1',message:'saved',delivery_wait:first});
  const fresh=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'p1'});
  assert.equal(fresh.result.success,true);assert.match(fresh.result.message,/no conversation yet.*type once.*not a permission issue.*do not resend.*p1/);
  assert.equal(fresh.result.display,'消息已保存：Codex 窗口「新窗口」还没开始对话，先在那个窗口输入一句后送达');
  h.response('send',{status:'queued',message_id:'p1q',message:'saved',delivery_wait:first});
  const freshQueued=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'p1q'});
  assert.equal(freshQueued.result.display,'消息已保存：Codex 窗口「新窗口」还没开始对话，先在那个窗口输入一句后送达');
  h.response('send',{status:'paused',delivery_state:'accepted',message_id:'p2',message:'saved',delivery_wait:human});
  const wait=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'p2'});
  assert.equal(wait.result.success,false);assert.match(wait.result.message,/waits for user approval.*nxbridge open codex.*--member m.*never auto-approved.*do not resend.*p2/);
  assert.equal(wait.result.display,'消息已保存：Codex「后台搭档」在等你批准操作，在项目目录终端运行 nxbridge open codex --member m 处理');
                                
  h.response('send',{status:'paused',delivery_state:'accepted',message_id:'p3',message:'saved',delivery_wait:{...human,reason:'native_input'}});
  const asked=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'p3'});
  assert.match(asked.result.message,/waits for user answer to its question.*nxbridge open codex --member m/);assert.equal(asked.result.display,'消息已保存：Codex「后台搭档」在等你回答问题，在项目目录终端运行 nxbridge open codex --member m 处理');
  h.response('send',{status:'queued',message_id:'p3',message:'saved',permission_guidance:guide,native_issue:{kind:'sandbox_denied',turn_id:'u',tool:'shell',exit_code:1,message:'write blocked',at:1}});
  const queued=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'p3'});
  assert.equal(queued.result.success,true);assert.equal(queued.result.message,'saved; message_id=p3\npermission: class_mismatch - native will hold: classes differ\ncodex native issue: sandbox_denied tool=shell - write blocked');
                                                         
  h.response('send',{status:'queued',message_id:'p4',message:'saved',native_issue:{kind:'tool_failed',turn_id:'u',tool:'commandExecution',exit_code:1,at:1},notes:[{incidentId:'i1',text:'delivery to codex retrying 3min'},{text:''},{text:'b'},{text:'c'},{text:'d'}]});
  const plain=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'p4'});
  assert.equal(plain.result.message,'saved; message_id=p4\ndelivery to codex retrying 3min\nb\nc');
});

test('Mod 发信以 [reply] 开头：去掉标记并登记需要回复；不写不登记；只有标记时不发送',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('send',{status:'queued',message_id:'r1',message:'saved'});
  await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'  [Reply]  请检查 X 并回复',tool_use_id:'r1'});
  let sent=h.calls.filter(c=>c.operation==='send').at(-1);assert.equal(sent.message,'请检查 X 并回复');assert.equal(sent.reply_expected,true);
  await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'完成汇报 [reply] 不在开头',tool_use_id:'r2'});
  sent=h.calls.filter(c=>c.operation==='send').at(-1);assert.equal(sent.message,'完成汇报 [reply] 不在开头');assert.equal('reply_expected' in sent,false);
  const before=h.calls.filter(c=>c.operation==='send').length;
  const empty=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'[reply] ',tool_use_id:'r3'});
  assert.equal(empty.result.success,false);assert.equal(h.calls.filter(c=>c.operation==='send').length,before);
});

test('Mod 状态栏显示后台归并的事故说明（用户动手的优先）；第 0–2 档提醒不进模型',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},integrationIssues:[],incidents:[
    {id:'a',state:'observing',attempts:3,userText:'发给 Codex 的消息暂时送不出去，正在自动重试'},
    {id:'b',state:'blocked',attempts:1,userText:'Codex 需要你重新信任 hooks：在 Codex 窗口输入 /hooks',action:{owner:'user',text:'/hooks'}}]});
  await h.tick();assert.equal(h.statuses.at(-1),'Codex 需要你重新信任 hooks：在 Codex 窗口输入 /hooks');
                      
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},integrationIssues:[],incidents:[{id:'c',state:'blocked',attempts:1,userText:'原生宿主需要用户确认信任或权限。',action:{owner:'user',text:'在原生窗口完成当前信任或权限提示。'}}]});
  await h.tick();assert.equal(h.statuses.at(-1),'原生宿主需要用户确认信任或权限；你需要：在原生窗口完成当前信任或权限提示。');
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},integrationIssues:[],incidents:[{id:'a',state:'observing',attempts:3,userText:'发给 Codex 的消息暂时送不出去，正在自动重试'}]});
  await h.tick();assert.equal(h.statuses.at(-1),'发给 Codex 的消息暂时送不出去，正在自动重试（已重试 3 次）');
  const m=await harness({deferPrompts:true});await m.run('session.start',{});
  m.response('monitor',{notices:[{id:'t1',tier:1,wake:false,message:'ui only'},{id:'t2',tier:2,wake:true,message:'pull only'}]});
  await m.tick();await m.run('tool.call',{tool:'Bash',tool_use_id:'x'},async()=>({result:{}}));
  assert.equal(m.calls.some(c=>['monitor-enqueue','monitor-prepare','monitor-ack'].includes(c.operation)),false);
});

test('Mod 后台下发自动重新加载：先报告这次尝试再交给宿主，同一尝试只执行一次；报告失败不重载',async()=>{
  const h=await harness();await h.run('session.start',{});
  const action={kind:'reload_plugins',targetRevision:'rev2',attemptId:'att-1'};
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},integrationIssues:[],integrationAction:action});
  await h.tick();await h.tick();
  const reported=h.calls.filter(c=>c.operation==='reload-attempt');assert.equal(reported.length,1);assert.equal(reported[0].attempt_id,'att-1');assert.equal(reported[0].target_revision,'rev2');
  assert.deepEqual(h.commandRuns,[{command:'reload-plugins'}]);
  const f=await harness();await f.run('session.start',{});f.error('reload-attempt',{message:'broker busy'});
  f.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready'},integrationIssues:[],integrationAction:{...action,attemptId:'att-2'}});
  await f.tick();assert.equal(f.commandRuns.length,0,'后台不知道这次尝试就不重载，避免重载后反复重载');
});

test('共用 daemon 的窗口可能已关：取件提示带上重新打开同一会话的命令，等待人工也不指向 nxbridge open codex',async()=>{
  const h=await harness();await h.run('session.start',{});
  const wait={state:'waiting_native_input',host:'codex',member_id:'x',session_id:'thread-1',name:'旧会话',pending:1,resume_command:'codex resume thread-1',message:'saved'};
  h.response('send',{status:'waiting_native_input',message_id:'m1',message:'saved',delivery_wait:wait});
  const sent=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'r1'});
  assert.match(sent.result.message,/nxbridge pickup.*if that window is closed, user first runs "codex resume thread-1".*do not resend/);
  assert.equal(sent.result.display,'消息已保存但未送达：到 Codex 窗口「旧会话」输入 nxbridge pickup 即可取件（窗口已关的话，先在项目目录的终端运行 codex resume thread-1 重新打开）');
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready',delivery_mode:'daemon-pull',delivery_wait:wait},integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/nxbridge pickup 即可取件（窗口已关的话，先在项目目录的终端运行 codex resume thread-1 重新打开）$/);
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'needsHuman',delivery_mode:'daemon-pull',delivery_wait:{...wait,state:'needs_human'}},integrationIssues:[]});await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 窗口「旧会话」在等你处理（如需批准操作；窗口已关的话在项目目录的终端运行 codex resume thread-1 重新打开那个会话，不会自动批准）');
  assert.doesNotMatch(h.statuses.at(-1)!,/nxbridge open codex/);
});

test('Mod 共用 daemon 只拉不推：发送结果和状态栏点名窗口、明说未送达，忙时说明下次交互取件',async()=>{
  const h=await harness();await h.run('session.start',{});
  const wait={state:'waiting_native_input',host:'codex',member_id:'x',session_id:'thread-1',name:'旧会话',pending:2,message:'not delivered'};
  h.response('send',{status:'waiting_native_input',delivery_state:'accepted',read_confirmed:false,message_id:'m1',message:'saved',delivery_wait:wait});
  const idle=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'d1'});
  assert.equal(idle.result.success,true);assert.match(idle.result.message,/NOT delivered.*"旧会话".*thread-1.*user types.*tell user.*nxbridge pickup.*do not resend.*m1/);
  assert.equal(idle.result.display,'消息已保存但未送达：到 Codex 窗口「旧会话」输入 nxbridge pickup 即可取件');
  h.response('send',{status:'waiting_native_interaction',message_id:'m2',delivery_wait:{...wait,state:'waiting_native_interaction'}});
  const busy=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'d2'});
  assert.match(busy.result.display,/等 Codex 窗口「旧会话」下一次交互时取件/);
                                                                                                       
  h.response('send',{status:'queued',message_id:'m3',message:'saved',delivery_wait:{...wait,state:'context_changing',reason:'native_context_changed',pending:1}});
  const changed=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'d3'});
  assert.equal(changed.result.success,true);assert.match(changed.result.message,/NOT delivered.*newer conversation.*"旧会话".*thread-1.*nxbridge pair.*do not resend.*m3/);
  assert.equal(changed.result.display,'消息已保存但未送达：这个项目开了新的 Codex 对话，原会话「旧会话」暂不唤醒');
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready',delivery_mode:'daemon-pull',delivery_wait:{...wait,state:'context_changing',reason:'native_context_changed',pending:1}},integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/有 1 条消息还没送到 Codex 会话「旧会话」.*新的 Codex 对话.*nxbridge pair/);
                                       
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready',delivery_mode:'daemon-pull',delivery_wait:{...wait,state:'context_changing',pending:1}},integrationIssues:[]});await h.tick();
  assert.equal(h.statuses.at(-1),'有 1 条消息在等 Codex 会话「旧会话」完成上下文核验后取件');
  h.response('send',{status:'queued',message_id:'m4',message:'saved',delivery_wait:{...wait,state:'context_changing',pending:1}});
  const verifying=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'d4'});
  assert.doesNotMatch(verifying.result.display,/新的 Codex 对话/);
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready',delivery_mode:'daemon-pull',delivery_wait:wait},integrationIssues:[{code:'contract_inactive',peerId:'x'}]});await h.tick();
  assert.equal(h.statuses.at(-1),'有 2 条消息还没送到 Codex 窗口「旧会话」：这个会话现在不能自动唤醒，到那个窗口输入 nxbridge pickup 即可取件');
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'ready',delivery_mode:'daemon-pull',delivery_wait:{...wait,pending:0}},integrationIssues:[]});await h.tick();
  assert.equal(h.statuses.at(-1),undefined);
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'needsHuman',delivery_wait:{...wait,state:'needs_human',pending:0}},integrationIssues:[]});await h.tick();
  assert.match(h.statuses.at(-1)!,/Codex 窗口「旧会话」在等你处理.*重新打开那个会话.*不会自动批准/);
});

test('Mod 时钟独立通知空闲根，保留系统标签，去重重试回执并诚实显示宿主拒绝',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'notice-1',wake:true,message:'broker endpoint unavailable'}]});await h.tick();
  assert.equal(h.prompts.length,0);await h.consumePrompt();
  assert.equal(h.prompts.length,1);assert.match(h.prompts[0].text,/system_notice source=runtime_monitor notice_id=notice-1/);assert.equal(h.prompts[0].agentId,undefined);
  assert.equal(h.calls.find(c=>c.operation==='monitor-ack').state,'submitted');
  await h.tick();assert.equal(h.prompts.length,1);
  h.response('monitor',{notices:[{id:'notice-2',wake:true,message:'new incident'}]});h.response('prompt',{drop:'policy denied'});await h.tick();
  await h.consumePrompt();
  assert.equal(h.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'denied');assert.match(h.statuses.at(-1)!,/通知被宿主策略拒绝.*policy denied/);
  h.response('monitor',{notices:[]});await h.tick();assert.match(h.statuses.at(-1)!,/通知被宿主策略拒绝/);
});

test('Mod 重新加载后尚未观测到权限模式时，运行时通知等观测到模式再送，不报失败、不丢弃、不反复启动入队进程',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'notice-wait',wake:true,message:'broker endpoint unavailable'}]});
  h.error('monitor-enqueue',{code:'permission_unknown',message:'尚未获得发送方实际权限类别，不能猜测 Claude 入站权限。'});
  await h.tick();await h.tick();
  assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
  assert.ok(!h.statuses.some(text=>/运行时通知/.test(text??'')));
                                         
  await h.run('classic.UserPromptSubmit',{session_id:'session'},async(e:any)=>e);await h.tick();await h.tick();
  await h.run('classic.UserPromptSubmit',{session_id:'session',permission_mode:'futureMode'},async(e:any)=>e);await h.tick();
  assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
  h.error('monitor-enqueue',undefined);await new Promise(resolve=>setTimeout(resolve,2));await h.run('classic.UserPromptSubmit',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);
  await h.tick();assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,2);await h.consumePrompt();
  assert.match(h.prompts.at(-1).text,/notice_id=notice-wait/);assert.equal(h.calls.filter(c=>c.operation==='monitor-ack').at(-1).state,'submitted');
});

test('Mod 发信显示已持久化但投递受阻，unknown 不显示成功或引导重发',async()=>{
  const h=await harness();
  for(const status of ['blocked','unknown','unverified','paused','held','refused','expired']){
    h.response('send',{message_id:'saved',status,delivery_state:status==='blocked'?'accepted':status,message:status==='unknown'?'submission outcome unknown; NEVER automatically replayed':'saved; delivery '+status});
    const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'任务',tool_use_id:'send-'+status});
    assert.equal(result.result.success,false);assert.match(result.result.message,/persisted=true/);assert.match(result.result.message,/do not resend/);
  }
  for(const [status,message,display]of[['queued','handed to nxbridge; it delivers + reports problems itself (routine, not user news)','消息已保存并排队，未确认已读'],['observed','native context/reply evidence confirmed','已确认原生上下文或回信']]){
    h.response('send',{message_id:'saved',status,message});const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'任务',tool_use_id:'truth-'+status});
    assert.equal(result.result.success,true);assert.equal(result.result.message,message+'; message_id=saved');assert.equal(result.result.display,display);
  }
});

test('Mod 发信提示置于投递结果之后，Agent 提示只附结果上下文，传递原文和原生轮次',async()=>{
  const h=await harness();await h.run('turn.start',{turnId:'native-turn'});
  h.response('send',{message_id:'saved',status:'blocked',delivery_state:'accepted',message:'saved; delivery blocked',tip:'nxbridge tip: mechanical suspicion'});
  const body='正文'.repeat(1200),sent=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:body,tool_use_id:'long'});
  assert.match(sent.result.message,/^saved; delivery blocked[^\n]*\nnxbridge tip:/);assert.equal(sent.result.success,false);
  assert.equal(h.calls.at(-1).message,body);assert.equal(h.calls.at(-1).turnId,'native-turn');
  h.response('tip-agent',{tip:'nxbridge tip: nxref:agent:finished'});
  const native={ref:42,result:{agentId:'new'},context:['原生结果上下文']},original={tool:'Agent',prompt:body,model:'haiku',effort:'high',tool_use_id:'agent'};
  const result=await h.run('tool.call',original,async(input:any)=>{assert.deepEqual(input,original);return native;});
  assert.equal(result.ref,42);assert.equal(result.result,native.result);assert.deepEqual(result.context,['原生结果上下文','nxbridge tip: nxref:agent:finished']);
  assert.equal(h.calls.at(-1).text,body);assert.equal(h.calls.at(-1).turnId,'native-turn');
  h.error('tip-agent',{message:'建议不可用'});assert.equal(await h.run('tool.call',original,async()=>native),native);
});

test('Mod 只接管搭档发信，使用宿主 tool_use_id，失败不再执行原生发送',async()=>{
  const h=await harness();let native=0;const next=async()=>{native++;return{native:true};};
  assert.deepEqual(await h.run('tool.call',{tool:'SendMessage',to:'another',message:'A'},next),{native:true});
  const sent=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'B',tool_use_id:'call-42',agentId:'child'},next);
  assert.equal(sent.result.success,true);assert.equal(h.calls[0].callId,'call-42');assert.deepEqual(h.calls[0].agents,[{id:'child'}]);
  assert.match(sent.result.message,/message_id=saved-message$/);assert.doesNotMatch(sent.result.message,/status=|undefined/);
  h.fail();const failed=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'C',tool_use_id:'call-43'},next);
  assert.equal(failed.result.success,false);assert.equal(native,1);
  assert.equal(failed.result.display,'发送结果未确认');
  h.fail({code:'ref_missing',model_message:'nxref not found'});
  assert.equal((await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'D'},next)).result.display,'未发送');
});

test('Mod 发信自动关联本对话最新进入上下文的搭档消息，子代理和新对话不沿用',async()=>{
  const h=await harness(),next=async()=>({native:true});
  await h.run('session.start',{});
  const append=(id:string)=>h.run('session.append',{origin:{kind:'peer'}},async()=>({message:{role:'user',content:[{type:'text',text:`[nxbridge message_id=${id}]正文`}]}}));
  const send=async(extra:any={})=>{await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'回复',tool_use_id:'s'+Math.random(),...extra},next);return h.calls.filter(c=>c.operation==='send').at(-1);};
  assert.equal((await send()).auto_reply_to,undefined);
  await append('aaaa-0001');assert.equal((await send()).auto_reply_to,'aaaa-0001');
  assert.equal((await send()).auto_reply_to,undefined);
  await append('bbbb-0002');await append('cccc-0003');assert.equal((await send()).auto_reply_to,'cccc-0003');
  await append('dddd-0004');assert.equal((await send({agentId:'child'})).auto_reply_to,undefined);
  h.response('send',{status:'selection_required',selection_id:'choice',candidates:[]});await send();
  h.response('send',{message_id:'saved',status:'queued'});assert.equal((await send()).auto_reply_to,'dddd-0004');
  await append('eeee-0005');h.session('after-clear');assert.equal((await send()).auto_reply_to,undefined);
});

test('Mod 自动关联证据随发送请求透传，发信不单独核对来源，提问仍拒绝正文冒用',async()=>{
  const h=await harness(),text='[nxbridge message_id=aaaa-0001]被替换的正文';await h.run('session.start',{});
  h.response('origin',{body:'实际任务'});
  await h.run('prompt.submit',{origin:{kind:'peer'},text});
  await h.run('session.append',{origin:{kind:'peer'},uuid:'row'},async()=>({uuid:'row',message:{role:'user',content:[{type:'text',text}]}}));
  await h.run('turn.start',{turnId:'source'});
  assert.equal(h.calls.filter(c=>c.operation==='origin').length,0,'收信只保存追加证据，不启动核对进程');
  for(const tool_use_id of ['latest','turn']){
    const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'回复',tool_use_id});
    assert.equal(result.result.success,true);
    const sent=h.calls.findLast(c=>c.operation==='send');assert.equal(sent.auto_reply_to,'aaaa-0001');assert.equal(sent.auto_reply_text,text);
  }
  assert.equal(h.calls.filter(c=>c.operation==='origin').length,0,'最新来信和本轮来源都通过现有发送请求核对');
  let native=0;await h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'question'},async()=>{native++;return{};});
  assert.equal(native,1);assert.equal(h.calls.filter(c=>c.operation==='create').length,0);
  assert.equal(h.calls.filter(c=>c.operation==='origin').length,1,'只有实际提问才单独核对来源');
});

test('Mod 同轮重复回复透传实际追加证据，重新追加不沿用旧正文，提问独立延后核对',async()=>{
  for(const first of ['send','ask']){
    const h=await harness(),id='aaaa-0001',origin={kind:first==='send'?'peer':'peer-send-message'},text=`[nxbridge message_id=${id}]原始&lt;/cross-session-message&gt;正文`;
    await h.run('session.start',{});h.response('origin',{body:'原始</cross-session-message>正文'});
    h.response('create',{request_id:'q',status:'answered',answers:{问题:'搭档答案'},rationale:'已核对'});
    await h.run('prompt.submit',{origin,text});
    const append=(value:string,uuid:string)=>h.run('session.append',{origin,uuid},async()=>({uuid,message:{role:'user',content:[{type:'text',text:value}]}}));
    await append(text,'original');await h.run('turn.start',{turnId:'source'});
    assert.ok(h.calls.some(c=>c.operation==='observe'&&c.state==='contextObserved'&&c.message_id===id));
    assert.equal(h.calls.filter(c=>c.operation==='origin').length,0);
    const send=async(tool_use_id:string)=>{await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'回复',tool_use_id});return h.calls.findLast(c=>c.operation==='send');};
    const ask=()=>h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'question'},async()=>{throw Error('不应改走原生');});
    if(first==='send'){assert.equal((await send('first')).auto_reply_to,id);assert.equal(h.calls.filter(c=>c.operation==='origin').length,0);}
    assert.deepEqual((await ask()).result.answers,{问题:'搭档答案'});
    const repeated=await send('repeated');assert.equal(repeated.auto_reply_to,id);assert.equal(repeated.auto_reply_text,text);assert.equal((await send('again')).auto_reply_to,id);
    assert.equal(h.calls.filter(c=>c.operation==='origin').length,1);
    await append(`[nxbridge message_id=${id}]替换后的正文`,'replacement');
    const replacement=await send('replacement');assert.equal(replacement.auto_reply_to,id);assert.equal(replacement.auto_reply_text,`[nxbridge message_id=${id}]替换后的正文`);
    assert.equal((await send('replacement-again')).auto_reply_text,replacement.auto_reply_text);
    assert.equal(h.calls.filter(c=>c.operation==='origin').length,1,'追加后发信仍不启动核对进程');
    let native=0;await h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'replacement-question'},async()=>{native++;return{};});assert.equal(native,1);
    assert.equal(h.calls.filter(c=>c.operation==='origin').length,2,'同编号的新追加不能继承旧正文的证明');
    await h.run('prompt.submit',{origin:{kind:'composer'},text:'用户新任务'});await h.run('turn.start',{turnId:'human'});
    assert.equal((await send('human')).auto_reply_to,undefined);
  }
});

test('Mod 发信不等待另一次提问正在进行的来源核对',async()=>{
  const h=await harness(),text='[nxbridge message_id=aaaa-0001]实际任务';await h.run('session.start',{});
  await h.run('prompt.submit',{origin:{kind:'peer'},text});
  await h.run('session.append',{origin:{kind:'peer'},uuid:'row'},async()=>({uuid:'row',message:{role:'user',content:[{type:'text',text}]}}));
  await h.run('turn.start',{turnId:'source'});
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  h.response('origin',async()=>{entered();await gate;return{body:'实际任务'};});
  h.response('create',{request_id:'q',status:'answered',answers:{问题:'搭档答案'},rationale:'已核对'});
  const asking=h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'ask'},async()=>{throw Error('不应改走原生');});
  await started;
  const sent=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'回复',tool_use_id:'send'});
  assert.equal(h.calls.filter(c=>c.operation==='origin').length,1);release();
  const asked=await asking;
  assert.equal(sent.result.success,true);assert.deepEqual(asked.result.answers,{问题:'搭档答案'});
  assert.equal(h.calls.findLast(c=>c.operation==='send').auto_reply_to,'aaaa-0001');
  assert.equal(h.calls.filter(c=>c.operation==='origin').length,1);
});

test('Mod 发送等待期间切换会话后不继续旧配对选择，新会话不继承来源',async()=>{
  for(const saved of [false,true]){
    const h=await harness(),text='[nxbridge message_id=aaaa-0001]实际任务';await h.run('session.start',{});
    await h.run('prompt.submit',{origin:{kind:'peer'},text});
    await h.run('session.append',{origin:{kind:'peer'},uuid:'row'},async()=>({uuid:'row',message:{role:'user',content:[{type:'text',text}]}}));
    await h.run('turn.start',{turnId:'source'});
    h.response('send',async()=>{h.session('fresh');return saved?{message_id:'old-saved'}:{status:'selection_required',selection_id:'old-choice',candidates:[]};});
    const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'旧回复',tool_use_id:'old'});
    assert.equal(result.result.success,saved);assert.match(result.result.message,/previous conversation/);
    assert.equal(h.calls.find(c=>c.operation==='send').sessionId,'session');assert.equal(h.calls.filter(c=>c.operation==='selection-resolve').length,0);
    h.response('send',{message_id:'new-saved'});await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'新消息',tool_use_id:'new'});
    const sent=h.calls.findLast(c=>c.operation==='send');assert.equal(sent.sessionId,'fresh');assert.equal(sent.auto_reply_to,undefined);
    assert.equal(h.calls.filter(c=>c.operation==='origin').length,0);
  }
});

test('Mod 发送等待期间进入的新来信仍关联下一次回复，并发完成顺序不回退关联进度',async()=>{
  for(const concurrent of [false,true]){
    const h=await harness();await h.run('session.start',{});
    const append=(id:string)=>h.run('session.append',{origin:{kind:'peer'}},async()=>({message:{role:'user',content:[{type:'text',text:`[nxbridge message_id=${id}]正文`}]}}));
    const send=(tool_use_id:string)=>h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'回复',tool_use_id});
    await append('aaaa-0001');
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    h.response('send',async(input:any)=>{if(input.callId==='first'){entered();await gate;}return{message_id:'saved-'+input.callId};});
    const first=send('first');await started;await append('bbbb-0002');
    if(concurrent)await send('second');release();await first;
    if(!concurrent)await send('second');
    assert.equal(h.calls.find(c=>c.operation==='send'&&c.callId==='first').auto_reply_to,'aaaa-0001');
    assert.equal(h.calls.find(c=>c.operation==='send'&&c.callId==='second').auto_reply_to,'bbbb-0002');
    await send('third');assert.equal(h.calls.findLast(c=>c.operation==='send').auto_reply_to,undefined);
    assert.equal(h.calls.filter(c=>c.operation==='origin').length,0);
  }
});

test('Mod 上报加载时的插件版本，状态栏按集成问题给出用户操作',async()=>{
  const h=await harness();h.response('files',{'/plugin/.claude-plugin/plugin.json':JSON.stringify({version:'9.9.9'})});
  await h.run('session.start',{});assert.ok(h.calls.length>0&&h.calls.every(c=>c.mod_version==='9.9.9'));
  h.response('files',{'/plugin/.claude-plugin/plugin.json':JSON.stringify({version:'10.0.0'})});h.calls.length=0;
  await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'磁盘已更新但未重新加载',tool_use_id:'v'},async()=>({}));
  assert.equal(h.calls.find(c=>c.operation==='send').mod_version,'9.9.9');
  const status=(issues:unknown[])=>({paired:true,paused:false,self:{state:'ready'},partner:{state:'busy'},integrationIssues:issues});
  h.response('status',status(['hooks_missing']));await h.tick();assert.match(h.statuses.at(-1)!,/hooks 似乎没有生效.*\/hooks/);
  h.response('status',status(['hooks_timeout']));await h.tick();assert.equal(h.statuses.at(-1),'Codex 的 nxbridge hook 多次超时（可能机器负载高），消息可能延迟');
  h.response('status',{...status([]),partner:{state:'paused'}});await h.tick();assert.equal(h.statuses.at(-1),'Codex 窗口被你中断了，消息在等待（在该窗口继续后送达）');
                                  
  h.response('status',{...status([]),partner:{state:'paused',owner:'nxbridge',pause_reason:'restart_incomplete'}});await h.tick();assert.match(h.statuses.at(-1)!,/后台 Codex 的重启没有完整完成.*nxbridge status/);
  h.response('status',{...status([]),partner:{state:'paused',owner:'nxbridge'}});await h.tick();assert.equal(h.statuses.at(-1),'后台 Codex 已暂停，消息已保留（运行 nxbridge status 查看原因）');
  h.response('status',{...status([]),partner:{state:'paused',owner:'user'}});await h.tick();assert.equal(h.statuses.at(-1),'Codex 窗口暂停了，消息在等待（在该窗口继续后送达）');
  h.response('status',{...status([]),partner:{state:'paused',owner:'user',pause_reason:'interrupted'}});await h.tick();assert.equal(h.statuses.at(-1),'Codex 窗口被你中断了，消息在等待（在该窗口继续后送达）');
  h.response('status',status([{code:'hooks_missing'},{code:'hooks_blocked'}]));await h.tick();assert.match(h.statuses.at(-1)!,/hook 执行失败.*doctor/);
  h.response('status',status([{code:'hooks_blocked'},{code:'hooks_trust_required'}]));await h.tick();assert.match(h.statuses.at(-1)!,/需要重新信任.*\/hooks/);
  h.response('status',status([{code:'hooks_blocked'},{code:'hooks_restart_required'}]));await h.tick();assert.match(h.statuses.at(-1)!,/已信任新版 hooks.*Claude.*空闲.*自动重启.*自己开的.*重新打开/);
                                   
  h.response('status',status([{code:'hooks_restart_required',peerId:'codex-peer',owner:'nxbridge'}]));await h.tick();
  assert.match(h.statuses.at(-1)!,/后台 Codex 会话还在用旧版：Claude 会在它空闲时自动重启/);assert.doesNotMatch(h.statuses.at(-1)!,/你开的|自己开的/);
  h.response('status',status([{code:'hooks_restart_required',peerId:'codex-peer',owner:'user'}]));await h.tick();
  assert.match(h.statuses.at(-1)!,/你开的这个 Codex 窗口还在用旧版.*按原会话 ID 恢复/);assert.doesNotMatch(h.statuses.at(-1)!,/Claude 会/);
  h.response('status',status([{code:'hooks_restart_required',peerId:'a',owner:'user'},{code:'hooks_restart_required',peerId:'b',owner:'nxbridge'}]));await h.tick();
  assert.match(h.statuses.at(-1)!,/nxbridge 后台的 Codex 会由 Claude.*自己开的/);
  h.response('status',status([{code:'hooks_blocked'},{code:'mod_missing',peerId:'self',message:'后台说明'}]));await h.tick();assert.match(h.statuses.at(-1)!,/插件未登记或无响应/);
  h.response('status',status([{code:'hooks_blocked'},{code:'mod_stale'}]));await h.tick();assert.match(h.statuses.at(-1)!,/\/reload-plugins/);
  h.response('status',{...status(['mod_stale']),partner:{state:'needsHuman'}});await h.tick();assert.match(h.statuses.at(-1)!,/等待人工处理/);
                                                            
  h.response('status',{...status([{code:'launch_failed',peerId:'codex-peer'}]),partner:{state:'needsHuman'}});await h.tick();assert.match(h.statuses.at(-1)!,/后台搭档启动失败.*\/nxbridge/);
  h.response('status',{...status(['launch_failed']),partner:{state:'offline'}});await h.tick();assert.match(h.statuses.at(-1)!,/后台搭档启动失败/);
                                     
  h.response('status',{...status([{code:'launch_failed',peerId:'c',message:'后台 codex 启动失败：项目目录没被信任；修复原因后运行 nxbridge open codex --member c 重试',retry_command:'nxbridge open codex --member c'}]),partner:{state:'offline'}});await h.tick();
  assert.equal(h.statuses.at(-1),'后台 codex 启动失败：项目目录没被信任；修复原因后运行 nxbridge open codex --member c 重试');
  h.response('status',{...status([{code:'launch_failed',peerId:'c',message:'x'.repeat(300),retry_command:'nxbridge open codex --member c'}]),partner:{state:'offline'}});await h.tick();
  assert.equal(h.statuses.at(-1),'后台搭档启动失败，消息已保留：修复原因后运行 nxbridge open codex --member c 重试（原因见 /nxbridge）');
  h.response('status',status([{code:'hooks_trust_required',peerId:'c',config_home:'D:\\codex-b'}]));await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 的 nxbridge hooks 需要重新信任（在使用配置目录 D:\\codex-b 的 Codex 窗口里打开 /hooks，信任 nxbridge）');
  h.response('status',status([{code:'unknown_future_issue'}]));await h.tick();assert.equal(h.statuses.at(-1),undefined);
  h.response('status',{...status([{code:'contract_inactive',peerId:'codex-peer'}]),self:{id:'me',state:'ready'}});await h.tick();assert.match(h.statuses.at(-1)!,/还没加载新版规则.*重启/);
  h.response('status',{...status([{code:'contract_inactive',peerId:'codex-peer',owner:'nxbridge'}]),self:{id:'me',state:'ready'}});await h.tick();
  assert.match(h.statuses.at(-1)!,/还没加载新版规则.*后台 Codex 会由 Claude 择机自动重启/);assert.doesNotMatch(h.statuses.at(-1)!,/你开的/);
  h.response('status',{...status([{code:'contract_inactive',peerId:'codex-peer',owner:'user'}]),self:{id:'me',state:'ready'}});await h.tick();
  assert.match(h.statuses.at(-1)!,/还没加载新版规则.*你开的这个 Codex 窗口.*按原会话 ID 恢复/);assert.doesNotMatch(h.statuses.at(-1)!,/Claude/);
                                                
  h.response('status',{...status([{code:'hooks_restart_required',peerId:'codex-peer',owner:'user',session_id:'s-1',name:'甲'}]),self:{id:'me',state:'ready'}});await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 已信任新版 hooks，但你开的这个 Codex 窗口「甲」还在用旧版：等它空闲后退出，再在项目目录的终端运行 codex resume s-1 恢复');
  h.response('status',{...status([{code:'contract_inactive',peerId:'codex-peer',owner:'user',name:'乙'}]),partner:{state:'busy',delivery_mode:'daemon-direct'},self:{id:'me',state:'ready'}});await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 还没加载新版规则，暂时检测不到“停下未回复”：在你开的那个 Codex 窗口「乙」里继续对话即可生效，不用重开或恢复');
  h.response('status',{...status([{code:'contract_inactive',peerId:'me'}]),self:{id:'me',state:'ready'}});await h.tick();assert.equal(h.statuses.at(-1),undefined);
                                         
  h.response('status',status([{code:'subagent_completion_held',peerId:'codex-peer',owner:'nxbridge'}]));await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 的子代理已做完，尚未确认后台 Codex 接着处理（运行 /nxbridge 查看原因）');
  h.response('status',status([{code:'subagent_completion_held',peerId:'codex-peer',owner:'user',session_id:'s-2',name:'丙'}]));await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 的子代理已做完，尚未确认你开的 Codex 窗口「丙」接着处理：到那个窗口看一眼，没动就说一句继续，不用重跑子代理');
  h.response('status',status([{code:'subagent_completion_held'}]));await h.tick();assert.match(h.statuses.at(-1)!,/尚未确认主线程接着处理/);
  const fresh=await harness();await fresh.run('session.start',{});assert.ok(fresh.calls.every(c=>c.mod_version===undefined));
});

test('Mod 托管后台掉线自动恢复：状态栏按阶段说明进度和一步操作，ListAgents 给模型结构化事实',async()=>{
  const h=await harness(),original={result:{listing:'原生列表'}};await h.run('session.start',{});
  const base={incident_id:'inc-1',attempts_max:3,held:2,uncertain:0};
  const show=async(recovery:any,self?:any)=>{h.response('status',{paired:true,self:{state:'ready',...(self?{recovery:self}:{})},partner:{state:'offline',recovery},integrationIssues:[{code:'launch_failed'}]});await h.tick();return h.statuses.at(-1);};
  assert.equal(await show({...base,state:'recovering',attempts_used:2}),'后台 Codex 掉线了，正在按原会话自动恢复（第 2/3 次），2 条消息在等');
  assert.equal(await show({...base,state:'blocked',attempts_used:0,precondition:'workspace_untrusted',user_step:'codex -C /work/sub2api'}),'后台 Codex 掉线了，暂时无法自动恢复：项目目录还没被信任（codex -C /work/sub2api）；条件满足后会自动接着恢复，消息已保留');
  assert.match(await show({...base,state:'blocked',precondition:'future_code'}) as string,/暂时无法自动恢复：启动条件不满足；/);
  assert.match(await show({...base,state:'blocked',precondition:'session_conflict'}) as string,/暂时无法自动恢复：同一会话正开在你的窗口里，需要先选用哪一个；/);
  assert.equal(await show({...base,state:'exhausted',attempts_used:3,uncertain:1}),'后台 Codex 自动恢复 3 次都没成功，消息已保留：运行 nxbridge status 查看原因（Claude 也可能写明理由再试一次）；1 条消息结果不明，不会自动重发');
  assert.equal(await show({...base,state:'exhausted',attempts_used:3,extra_used:true,user_step:'运行 nxbridge open codex'}),'后台 Codex 自动恢复 3 次都没成功，消息已保留：运行 nxbridge open codex');
  assert.match(await show({...base,state:'unknown'}) as string,/上一次恢复结果不明，正在核对；核对清楚前不会再启动，避免同一会话同时运行两份/);
  assert.equal(await show({...base,state:'ready',held:1}),'后台 Codex 已按原会话自动恢复，不用手动 resume，1 条待送消息会继续投递');
  assert.equal(await show({...base,state:'ready',adopted:true,held:0}),'已把你打开的 Codex 窗口接回原配对，同一会话继续；关掉这个窗口后自动交还后台（可用 /nxbridge pair 换绑或解除）');
                                   
  assert.equal(await show(undefined),'后台搭档启动失败，消息已保留（运行 /nxbridge 查看原因和重试命令）');
  h.response('status',{paired:true,self:{state:'ready',recovery:{...base,state:'ready',adopted:true}},partner:{state:'ready'},integrationIssues:[]});await h.tick();
  assert.equal(h.statuses.at(-1),'本窗口已接回原配对，同一会话继续（可用 /nxbridge pair 换绑或解除）');
  h.response('status',{paired:true,pair_id:'p',self:{state:'ready',member_id:'m',session_id:'s'},partner:{state:'offline',recovery:{...base,state:'exhausted',attempts_used:3,extra_used:true,precondition:'launch_proxy_unavailable',user_step:'nxbridge open codex'}},integrationIssues:[]});
  const listing=(await h.run('tool.call',{tool:'ListAgents'},async()=>original)).result.listing;
  assert.match(listing,/managed recovery exhausted 3\/3\+1 \(launch_proxy_unavailable\), user step `nxbridge open codex` incident inc-1\. send via SendMessage/);
});

test('Mod 配对被意外解除时状态栏和 ListAgents 陈述原因与恢复方式，不再声称首次发信自动配对',async()=>{
  const h=await harness(),original={result:{listing:'原生列表'}};
  const lost={pair_id:'old-pair',partner_id:'codex-1',partner_name:'后台 Codex',partner_host:'codex',reason:'broker_shutdown',actor:'test cleanup pid 7',at:Date.UTC(2026,10,3,8,29,11),restore_state:'resumable',restore_command:'nxbridge pair --restore old-pair'};
  await h.run('session.start',{});
  h.response('status',{paired:false,pair_lost:lost});await h.tick();
  assert.equal(h.statuses.at(-1),'与 Codex 的配对被意外解除（后台服务被关停），下次发信时可选择恢复原搭档');
  const listing=(await h.run('tool.call',{tool:'ListAgents'},async()=>original)).result.listing;
  assert.match(listing,/former pair old-pair \(后台 Codex\) ended involuntarily: broker_shutdown by test cleanup pid 7 at 2026-11-03T08:29:11\.000Z; restore resumable via `nxbridge pair --restore old-pair`/);
  assert.doesNotMatch(listing,/pairs on demand/);
  h.response('status',{paired:false,pair_lost:{...lost,reason:'future_reason',restore_state:'gone'}});await h.tick();
  assert.equal(h.statuses.at(-1),'与 Codex 的配对被意外解除（原因未知），原会话已不存在，下次发信可新建搭档');
                                        
  const deleted={...lost,reason:'session_deleted',restore_state:'gone'};
  h.response('status',{paired:false,pair_lost:{...deleted,held_message_ids:['a','b']}});await h.tick();
  assert.equal(h.statuses.at(-1),'与 Codex 的配对被意外解除（原搭档的会话记录已被删除），原会话记录不在了，下次发信可新建搭档；原搭档留下的 2 条未读消息已保留');
  h.response('status',{paired:false,pair_lost:{...deleted,replacement:{state:'uncertain',member_id:'n',next_at:0,error:'x'}}});await h.tick();
  assert.equal(h.statuses.at(-1),'与 Codex 的配对被意外解除（原搭档的会话记录已被删除），原会话记录不在了；自动新建的搭档结果不明，正在等它登记确认，不会再建第二个');
  h.response('status',{paired:false,pair_lost:{...deleted,replacement:{state:'failed',member_id:'n',next_at:Number.MAX_SAFE_INTEGER,error:'x',terminal:true}}});await h.tick();
  assert.match(h.statuses.at(-1)!,/下次发信可新建搭档；自动新建多次没成功，已停止$/);
  h.response('status',{paired:false,pair_lost:{...deleted,replacement_suppressed:true}});await h.tick();assert.match(h.statuses.at(-1)!,/；已按你的选择不自动新建$/);
  h.response('status',{paired:false,pair_lost:{...deleted,restore_state:'resumable'}});await h.tick();assert.match(h.statuses.at(-1)!,/原会话记录已找回，下次发信时可选择恢复$/);
  h.response('status',{paired:true,paused:false,self:{state:'ready'},partner:{state:'ready'}});await h.tick();assert.equal(h.statuses.at(-1),undefined);
  h.response('status',{paired:false});assert.match((await h.run('tool.call',{tool:'ListAgents'},async()=>original)).result.listing,/pairs on demand/);
});

test('Mod 意外断开后的选择：原搭档排第一可恢复，已不存在则不提供，新建说明没有原上下文，可暂不配对',async()=>{
  const lost={pair_id:'old-pair',partner_id:'original-codex',partner_name:'后台 Codex',reason:'identity_mismatch',restore_state:'resumable'};
  const selection=(former:any)=>({status:'selection_required',reason:'pair_lost',pair_lost:{...lost,restore_state:former.restore_state},selection_id:'lost',expires_at:Date.now()+600000,candidates:[{key:'other',member_id:'other-window',label:'窗口乙',description:'空闲'},{key:'former',member_id:lost.partner_id,label:'后台 Codex',former_partner:true,...former}],allowed_actions:['choose','create','cancel']});
  const pick=async(former:any,choose:(labels:string[])=>string)=>{
    const h=await harness();await h.run('session.start',{isInteractive:true});h.response('send',selection(former));
    let asked:any;h.nativeResult((input:any)=>{asked=input.questions[0];return{result:{answers:{[asked.question]:choose(asked.options.map((o:any)=>o.label))}}};});
    h.response('selection-get',{status:'pending'});h.response('selection-commit',{status:'queued',message_id:'m'});
    const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'lost-send'});
    return{asked,commit:h.calls.find(c=>c.operation==='selection-commit'),result};
  };
  const restored=await pick({restore_state:'resumable'},labels=>labels[0]!);
  assert.match(restored.asked.question,/与 Codex「后台 Codex」的配对被意外解除（会话身份与记录不符）。要怎么处理？/);
  assert.deepEqual(restored.asked.options.map((o:any)=>o.label),['恢复原搭档「后台 Codex」','其他现有窗口「窗口乙」','新建后台 Codex','暂不配对']);
  assert.match(restored.asked.options[2].description,/看不到原搭档之前的上下文/);
  assert.equal(restored.commit.action,'choose');assert.equal(restored.commit.key,'former');assert.equal(restored.result.result.success,true);
  const gone=await pick({restore_state:'gone'},labels=>labels.at(-1)!);
  assert.match(gone.asked.question,/原来的会话已不存在，无法恢复/);assert.ok(!gone.asked.options.some((o:any)=>/恢复原搭档/.test(o.label)));
  assert.equal(gone.commit.action,'cancel');assert.equal('key' in gone.commit,false);
  const created=await pick({restore_state:'unverified'},()=>'新建后台 Codex');
  assert.match(created.asked.options[0].description,/无法确认它是否还在/);assert.equal(created.commit.action,'create');
});

test('Mod 会话托管转移：窗口关闭时配对保留，四选一由用户决定，关掉选择框只是这次不选；状态栏和 ListAgents 说明阶段与收紧的权限',async()=>{
  const hosting={preference:'user',phase:'window_closed',name:'长期会话',pair_id:'p',member_id:'cx',session_id:'01a1',cwd:'/work/app',wake_capable:false,held_unsent:2,uncertain:0};
  const selection={status:'selection_required',reason:'hosting',selection_id:'host',message_id:'m-1',expires_at:Date.now()+600000,current_pair_id:'p',hosting,candidates:[],allowed_actions:['adopt','wait','create','unpair','cancel']};
  const pick=async(choose:(labels:string[])=>string|undefined,commit:any)=>{
    const h=await harness();await h.run('session.start',{isInteractive:true});h.response('send',selection);
    let asked:any;h.nativeResult((input:any)=>{asked=input.questions[0];const label=choose(asked.options.map((o:any)=>o.label));return{result:{answers:label?{[asked.question]:label}:{}}};});
    h.response('selection-get',{status:'pending'});h.response('selection-commit',commit);
    const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'host-send'});
    return{asked,commit:h.calls.find(c=>c.operation==='selection-commit'),result};
  };
  const adopted=await pick(labels=>labels[0],{status:'paired',message_id:'m-1',hosting:{...hosting,preference:'bg',phase:'adopting'}});
  assert.equal(adopted.asked.question,'Codex 会话「长期会话」的窗口已关闭，有 2 条消息在等它。要怎么处理？');
  assert.deepEqual(adopted.asked.options.map((o:any)=>o.label),['在后台继续原会话','等我重新打开窗口','新建后台 Codex','解除配对']);
  assert.match(adopted.asked.options[0].description,/保留上下文和配对；以后关掉窗口也自动转到后台/);
  assert.equal(adopted.commit.action,'adopt');
  assert.equal(adopted.result.result.success,true);assert.match(adopted.result.result.display,/正在把 Codex 会话「长期会话」转到后台（同一会话、同一配对），2 条消息在等/);
  assert.match(adopted.result.result.message,/NOT delivered: hosting pref=bg phase=adopting/);assert.match(adopted.result.result.message,/message_id=m-1/);
                                               
  const waited=await pick(()=>undefined,{status:'held',message_id:'m-1',hosting});
  assert.equal(waited.commit.action,'cancel');
  const chosen=await pick(labels=>labels[1],{status:'held',message_id:'m-1',hosting});assert.equal(chosen.commit.action,'wait');assert.match(waited.result.result.display,/窗口已关闭，2 条消息在等：重新打开这个会话后送达/);
                          
  const h=await harness(),original={result:{listing:'原生列表'}};await h.run('session.start',{});h.response('send',selection);
  const plain=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'正文',tool_use_id:'host-plain'});
  assert.match(plain.result.message,/ask user: continue original session in bg \/ wait for window \/ new partner \/ unpair; commit user's answer via select_partner selection_id=host action=adopt\|wait\|create\|unpair; never choose yourself/);
  assert.ok(!h.calls.some(c=>c.operation==='selection-commit'));
  const show=async(value:any)=>{h.response('status',{paired:true,self:{state:'ready'},partner:{state:value.phase==='background'?'ready':'offline',hosting:value},integrationIssues:[]});await h.tick();return h.statuses.at(-1);};
  assert.equal(await show({...hosting,phase:'awaiting_window',user_step:'codex resume 01a1'}),'后台已停，等你在自己的窗口打开 Codex 会话「长期会话」，2 条消息在等（codex resume 01a1）；打开后要在窗口里有操作才会取消息');
  assert.equal(await show({...hosting,preference:'bg',phase:'verifying',held_unsent:1}),'后台 Codex 会话「长期会话」刚重新拉起，正在核对权限，核对完再投递，1 条消息在等');
  assert.equal(await show({...hosting,preference:'bg',phase:'background',verifying:true,held_unsent:0}),'后台 Codex 会话「长期会话」刚重新拉起，正在核对权限，核对完再投递');
  assert.equal(await show({...hosting,phase:'blocked',reason:'policy_verification_failed'}),'Codex 会话「长期会话」暂时转不过去：恢复后的权限核对没通过；消息已保留');
  assert.equal(await show({...hosting,phase:'blocked',reason:'future_code',holder:{mode:'app-server',pid:42}}),'Codex 会话「长期会话」暂时转不过去：条件不满足（占着它的是 app-server 42）；消息已保留');
  assert.equal(await show({...hosting,preference:'bg',phase:'background',held_unsent:0,policy:{source:'conservative',unknown:['filesystem','network']}}),'读不到这个会话原来的权限，后台先不给文件和网络权限；要放宽请按 Codex 正常方式设置');
  assert.equal(await show({...hosting,preference:'bg',phase:'background',held_unsent:0,policy:{source:'persisted',unknown:[],narrowed:[{rule:'a'},{rule:'b'}]}}),'后台 Codex 的权限比原会话更严：2 条权限规则没法原样恢复，已改成更严格的；要放宽请按 Codex 正常方式设置');
  assert.equal(await show({...hosting,preference:'bg',phase:'background',held_unsent:0,policy:{source:'persisted'}}),undefined);
  assert.equal(await show({...hosting,preference:'bg',phase:'foreground',reason:'holder_active',held_unsent:0}),'已记下：关掉 Codex 窗口后，会话「长期会话」在后台接着跑');
  h.response('status',{paired:true,self:{state:'ready'},partner:{state:'offline',hosting},integrationIssues:[]});
  const listing=(await h.run('tool.call',{tool:'ListAgents'},async()=>original)).result.listing;
  assert.match(listing,/hosting pref=user phase=window_closed, session 01a1, cwd \/work\/app, no wake \(picks up only on user input in that window\), 2 held, next send asks user: continue in bg \/ wait for window \/ new \/ unpair \(never adopt yourself\)/);
});

test('Mod 只凭原生审核结论记下“自动模式不可用”的事实和相关设置，随回执上报，不看工具文字也不改决定',async()=>{
  const h=await harness();await h.run('session.start',{});
  const denial='Auto mode is unavailable: its safety check does not run for this session, so Agent was not run.';
  const lastFacts=async()=>{await h.snapshot();return h.calls.at(-1).nativeAutoMode;};
                  
  const decision=(attributes:any)=>h.run('telemetry.log',{to:'collector',event:'tool_decision',attributes:{decision:'reject',source:'config',tool_name:'Agent',tool_use_id:'t3',tool_source:'builtin',classifier_verdict:'unavailable',permission_mode:'auto','session.id':'session',...attributes}},async(e:any)=>e);
                   
  assert.equal(await lastFacts(),undefined);
                                     
  await h.run('classic.PreToolUse',{session_id:'session',permission_mode:'auto'});
  const native={ref:1,result:'Error: '+denial,text:denial,isError:true};
  assert.deepEqual(await h.run('tool.call',{tool:'Agent',tool_use_id:'t0'},async()=>native),native);
  await h.run('tool.call',{tool:'Bash',tool_use_id:'t1'},async()=>({deny:denial}));
                            
  await decision({classifier_verdict:'block'});await decision({decision:'accept'});await decision({permission_mode:'default'});await decision({'session.id':'other'});await decision({classifier_verdict:undefined});
  assert.equal(await lastFacts(),undefined);
  await decision({});await decision({tool_name:'Bash',tool_use_id:'t4',agent_id:'child'});
                           
  const busy=h.calls.filter(c=>c.operation==='state'&&c.state==='busy');
  assert.equal(busy.length,1);assert.equal(busy[0].nativeAutoMode.unavailable.toolUseId,'t3');
  const facts=await lastFacts();
  assert.deepEqual(facts,{unavailable:{at:facts.unavailable.at,tool:'Agent',toolUseId:'t3'},observedAt:facts.unavailable.at});assert.ok(facts.observedAt>0);
                                                
  await h.run('turn.start',{turnId:'turn-1'});
  await h.run('classic.Stop',{session_id:'session',permission_mode:'auto',agent_id:'child',background_tasks:[{id:'x'},{id:'y'},{id:'z'}]});
  await h.run('classic.Stop',{session_id:'session',permission_mode:'auto',background_tasks:[{id:'b1',type:'shell',status:'running',description:'build'}],session_crons:[]});
  await h.run('turn.complete',{turnId:'turn-1'});
  const ready=h.calls.filter(c=>c.operation==='state').at(-1);
  assert.equal(ready.state,'ready');assert.equal(ready.nativeAutoMode.unavailable.toolUseId,'t3');assert.equal(ready.nativeBackground.tasks,1);assert.equal(ready.nativeBackground.crons,0);
  assert.ok(!JSON.stringify(ready.nativeBackground).includes('build'));
                                           
  const states=()=>h.calls.filter(c=>c.operation==='state');
  await h.run('turn.start',{turnId:'turn-2'});const before=states().length;
                               
  const busy2=states().at(-1);assert.equal(busy2.state,'busy');assert.deepEqual(Object.keys(busy2.nativeBackground),['observedAt']);assert.ok(busy2.nativeBackground.observedAt>=ready.nativeBackground.observedAt);
  await h.run('classic.Stop',{session_id:'session',permission_mode:'auto',background_tasks:[],session_crons:[]});assert.equal(states().length,before);
  await h.run('turn.complete',{turnId:'turn-2'});assert.equal(states().length,before+1);assert.equal(states().at(-1).nativeBackground.tasks,0);
  await h.run('classic.Stop',{session_id:'session',permission_mode:'auto',background_tasks:[{id:'late'},{id:'late2'}],session_crons:[{id:'c'}]});
  assert.equal(states().length,before+2);assert.equal(states().at(-1).state,'ready');assert.equal(states().at(-1).nativeBackground.tasks,2);assert.equal(states().at(-1).nativeBackground.crons,1);
                                   
  const show=async(value:any)=>{h.response('status',{paired:true,self:{state:'ready',claude_auto_mode:value},partner:{state:'ready'},integrationIssues:[]});await h.tick();return h.statuses.at(-1);};
  assert.equal(await show({phase:'pending',session_id:'session'}),'自动模式在这个会话里用不了（安全检查过不去）：等这一轮和后台任务都结束，nxbridge 会换成手动模式的副本接着跑（保留对话历史，配对不变）');
  for(const phase of ['stopping','launching','binding'])assert.equal(await show({phase}),'正在换成手动模式的副本接着跑（保留对话历史，配对不变），换好后这个会话不再收消息');
  assert.equal(await show({phase:'unknown',error:'副本没登记上'}),'换成手动模式的副本结果不明（副本没登记上），不会自动重试；消息已保留，可运行 nxbridge open claude 在前台处理');
  assert.equal(await show({phase:'blocked',error:'有定时任务在跑'}),'自动模式在这个会话里用不了，nxbridge 没有自动换成手动模式（有定时任务在跑）；消息照常投递，需要安全检查的操作仍会被拒，可运行 nxbridge open claude 处理');
  assert.equal(await show({phase:'ready',old_session_id:'session',session_id:'copy'}),undefined);
  h.session('new');assert.equal((await lastFacts()),undefined);
                    
  const child=await harness();await child.run('session.start',{});
  await child.run('telemetry.log',{to:'collector',event:'tool_decision',attributes:{decision:'reject',tool_name:'Bash',tool_use_id:'c1',agent_id:'child',classifier_verdict:'unavailable',permission_mode:'auto','session.id':'session'}},async(e:any)=>e);
  await child.snapshot();
  const childFacts=child.calls.at(-1).nativeAutoMode;assert.equal(childFacts.unavailable.agent,true);assert.ok(childFacts.observedAt>0);
});

test('Mod 按官方优先级计算跨会话接收设置：managed 优先，project/local 只能更严格，无法识别的取值至少扣下',async()=>{
  const {effectiveInbound}=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-control.js')).href);
  assert.equal(effectiveInbound({}),'default');
  assert.equal(effectiveInbound({user:'accept'}),'accept');
  assert.equal(effectiveInbound({user:'accept',project:'hold'}),'hold');
  assert.equal(effectiveInbound({user:'refuse',local:'accept'}),'refuse');
  assert.equal(effectiveInbound({flag:'accept',user:'refuse'}),'accept');
  assert.equal(effectiveInbound({policy:'accept',user:'refuse'}),'accept');
  assert.equal(effectiveInbound({policy:'bogus'}),'refuse');
  assert.equal(effectiveInbound({user:'bogus'}),'hold');
  assert.equal(effectiveInbound({user:'accept',local:'bogus'}),'hold');
  assert.equal(effectiveInbound({project:'accept'}),'default');
  assert.equal(effectiveInbound({project:'hold'}),'hold');
});

test('Mod 跨会话接收设置带出决定来源，用于解释启动时的 accept 为什么没生效',async()=>{
  const {inboundDecision}=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-control.js')).href);
  assert.deepEqual(inboundDecision({}),{policy:'default',source:'default'});
  assert.deepEqual(inboundDecision({flag:'accept',user:'hold'}),{policy:'accept',source:'flag'});
  assert.deepEqual(inboundDecision({flag:'accept',project:'hold'}),{policy:'hold',source:'project'});
  assert.deepEqual(inboundDecision({policy:'hold',flag:'accept'}),{policy:'hold',source:'policy'});
  assert.deepEqual(inboundDecision({flag:'accept',local:'refuse'}),{policy:'refuse',source:'local'});
  assert.deepEqual(inboundDecision({flag:'accept',user:'bogus'}),{policy:'hold',source:'invalid'});
  assert.deepEqual(inboundDecision({flag:'accept',project:'bogus'}),{policy:'hold',source:'invalid'});
  assert.deepEqual(inboundDecision({policy:'bogus'}),{policy:'refuse',source:'invalid'});
});

test('Mod 收到搭档来信时按实际模式和接收设置如实上报“需要用户审核”，不当作已进入上下文',async()=>{
  const run=async(settings:any,mode:string,fromMode:string)=>{
    const h=await harness();h.response('settings',settings);await h.run('session.start',{});
    await h.run('classic.UserPromptSubmit',{session_id:'session',permission_mode:mode},async(e:any)=>e);
    await h.run('session.receive',{origin:{kind:'peer'},text:`<cross-session-message from-name="nxbridge:codex" from-mode="${fromMode}">\n[nxbridge message_id=aaaa-0001]\n正文\n</cross-session-message>`},async(e:any)=>e);
    const observe=h.calls.find(c=>c.operation==='observe');
    return{observe,inbound:observe.nativeInbound};
  };
  const held=await run({},'auto','bypass');
  assert.equal(held.observe.state,'observed');assert.equal(held.observe.admission,'approval_required');assert.equal(held.inbound.policy,'default');
  assert.equal((await run({},'bypassPermissions','bypass')).observe.admission,undefined);
  assert.equal((await run({},'plan','bypass')).observe.admission,undefined);
  assert.equal((await run({},'bypassPermissions','prompting')).observe.admission,'approval_required');
  assert.equal((await run({user:{crossSessionInbound:'accept'}},'auto','bypass')).observe.admission,undefined);
  const explicit=await run({user:{crossSessionInbound:'hold'}},'bypassPermissions','bypass');assert.equal(explicit.observe.admission,'approval_required');assert.equal(explicit.inbound.policy,'hold');
});

test('Mod 回执失败不再静默：连续三次提示用户，最近错误随下一次调用报给后台，送达后不再重复',async()=>{
  const h=await harness();await h.run('session.start',{});
  const receive=(id:string)=>h.run('session.receive',{origin:{kind:'peer'},text:`[nxbridge message_id=${id}]正文`},async(e:any)=>e);
  const observes=()=>h.calls.filter(c=>c.operation==='observe');
  h.error('observe',{code:'stale_context',message:'窗口绑定已变化'});
  await receive('aaaa-0001');await receive('aaaa-0002');
  assert.ok(!h.statuses.some(text=>/回执连续失败/.test(text??'')));
  assert.equal(observes()[0].mod_diagnostics,undefined);assert.equal(observes()[1].mod_diagnostics.consecutive,1);
  await receive('aaaa-0003');assert.match(h.statuses.at(-1)!,/消息回执连续失败.*\/reload-plugins/);
                                                     
  assert.equal((await h.run('tool.call',{tool:'Read',agentId:'child'},async()=>({result:'ok'}))).context,undefined);
  const told=await h.run('tool.call',{tool:'Read'},async()=>({result:'ok'}));assert.match(told.context.join('\n'),/receipts failed 3\+ times.*reload_plugins once/);
  assert.ok(!(await h.run('tool.call',{tool:'Read'},async()=>({result:'ok'}))).context?.some((t:string)=>/receipts failed/.test(t)));
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__reload_plugins'})).result,/^scheduled/);
                                         
  const before=h.calls.length;h.response('status',{paired:true,paused:false,self:{state:'ready'},partner:{state:'ready'}});await h.tick();assert.match(h.statuses.at(-1)!,/回执连续失败/);
  const carried=h.calls.slice(before).filter(c=>c.mod_diagnostics);assert.equal(carried.length,1);
  assert.equal(carried[0].mod_diagnostics.consecutive,3);assert.equal(carried[0].mod_diagnostics.last_error.op,'observe');assert.equal(carried[0].mod_diagnostics.last_error.code,'stale_context');assert.equal(typeof carried[0].mod_diagnostics.last_error.at,'number');
  h.error('observe',undefined);await receive('aaaa-0004');assert.equal(observes()[3].mod_diagnostics,undefined);
  await h.tick();assert.equal(h.statuses.at(-1),undefined);
});

test('宿主程序运行中被更新（host_update_unverified）：首次失败即提示重开窗口，告诉模型一次，不登记 reload_plugins',async()=>{
  const h=await harness();await h.run('session.start',{});
  const receive=(id:string)=>h.run('session.receive',{origin:{kind:'peer'},text:`[nxbridge message_id=${id}]正文`},async(e:any)=>e);
  h.error('observe',{code:'host_update_unverified',message:'宿主已更新'});
  await receive('bbbb-0001');assert.match(h.statuses.at(-1)!,/运行期间已更新.*重新打开本窗口.*\/resume.*重新加载插件无效/);
  const told=await h.run('tool.call',{tool:'Read'},async()=>({result:'ok'}));assert.match(told.context.join('\n'),/updated while this window ran.*don't call reload_plugins.*reopen/);
  assert.ok(!(await h.run('tool.call',{tool:'Read'},async()=>({result:'ok'}))).context?.some((t:string)=>/updated while/.test(t)));
  await receive('bbbb-0002');await receive('bbbb-0003');
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__reload_plugins'})).result,/^not scheduled: Claude app was updated/);
  await h.run('turn.complete',{});assert.equal(h.commandRuns.length,0);
  h.error('observe',undefined);await receive('bbbb-0004');
  h.response('status',{paired:true,paused:false,self:{state:'ready'},partner:{state:'ready'}});await h.tick();assert.equal(h.statuses.at(-1),undefined);
});

test('reload_plugins 只在本窗口 Mod 过期时登记，本轮正常结束后执行一次，中断轮次和子代理不执行',async()=>{
  const h=await harness();await h.run('session.start',{});
  const tool=(e:any={})=>h.run('tool.call',{tool:'mcp__nxbridge__reload_plugins',...e});
  h.response('status',{paired:true,self:{id:'me'},integrationIssues:[{peerId:'codex',code:'mod_stale'}]});
  assert.match((await tool()).result,/^not needed/);
  assert.match((await tool({agentId:'child'})).deny,/root session only/);
  h.response('status',{paired:true,self:{id:'me'},integrationIssues:[{peerId:'me',code:'mod_stale'}]});
  assert.match((await tool()).result,/^scheduled/);assert.match((await tool()).result,/^already scheduled/);
  assert.equal(h.commandRuns.length,0,'工具调用中不能直接重新加载');
  await h.run('turn.complete',{agentId:'child',turnId:'c'});await h.run('turn.complete',{isAborted:true});
  assert.equal(h.commandRuns.length,0);
  await h.run('turn.complete',{});await h.run('turn.complete',{});
  assert.deepEqual(h.commandRuns,[{command:'reload-plugins'}]);
                                
  assert.match((await tool()).result,/^scheduled/);h.response('status',{paired:true,self:{id:'me'},integrationIssues:[]});
  await h.run('turn.complete',{});assert.equal(h.commandRuns.length,1);
});

test('重新加载执行后插件仍过期（远程连接下宿主不执行）：状态栏和 reload_plugins 说明原因与做法，不再重复登记',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const h=await harness();await h.run('session.start',{});
  const stale={paired:true,self:{id:'me',state:'ready'},partner:{state:'ready'},integrationIssues:[{peerId:'me',code:'mod_stale'}]};
  h.response('status',stale);
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__reload_plugins'})).result,/^scheduled/);
  await h.run('turn.complete',{});assert.equal(h.commandRuns.length,1);
                              
  await h.tick();assert.match(h.statuses.at(-1)!,/空闲时会自动重新加载/);
  t.mock.timers.tick(6000);await h.tick();
  assert.match(h.statuses.at(-1)!,/没能自动重新加载插件（Claude 返回：Reloaded）.*远程连接.*回到电脑上.*\/reload-plugins.*\/resume/);
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__reload_plugins'})).result,/^not scheduled: reload already ran.*Claude said: Reloaded.*remote/);
  await h.run('turn.complete',{});assert.equal(h.commandRuns.length,1,'不在每轮结束时反复重新加载');
                                        
  h.response('status',{...stale,integrationIssues:[]});await h.tick();assert.doesNotMatch(String(h.statuses.at(-1)),/重新加载/);
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__reload_plugins'})).result,/^not needed/);
});

test('Mod 压缩后按编号重读配对消息：只读转发给后台，仅限根会话，失败如实拒绝',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('read-messages',{messages:[{message_id:'a',from:'codex',text:'任务'}],unavailable:['b']});
  const result=await h.run('tool.call',{tool:'mcp__nxbridge__read_messages',message_ids:['a','b'],tool_use_id:'reread'});
  assert.deepEqual(JSON.parse(result.result),{messages:[{message_id:'a',from:'codex',text:'任务'}],unavailable:['b']});
  const sent=h.calls.find(c=>c.operation==='read-messages');assert.deepEqual(sent.message_ids,['a','b']);assert.equal(sent.callId,'reread');
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__read_messages',message_ids:['a'],agentId:'child'})).deny,/root session only/);
  h.error('read-messages',{code:'ref_missing',model_message:'msg not in your pairs'});
  assert.equal((await h.run('tool.call',{tool:'mcp__nxbridge__read_messages',message_ids:['x']})).deny,'msg not in your pairs');
  assert.equal(h.calls.filter(c=>c.operation==='read-messages').length,2);
});

test('Mod ListAgents 保留原列表并让宿主重绘增加的搭档',async()=>{
  const h=await harness(),original={ref:17,text:'原生列表',result:{listing:'原生列表'},context:['原生上下文']};
  const result=await h.run('tool.call',{tool:'ListAgents'},async()=>original);
  assert.match(result.result.listing,/^原生列表\ncodex peer:/);assert.equal(result.ref,undefined);assert.deepEqual(result.context,original.context);
  h.response('status',{paired:true,paused:true,partner:{state:'ready'}});assert.match((await h.run('tool.call',{tool:'ListAgents'},async()=>original)).result.listing,/, pair paused/);
  h.fail();assert.equal(await h.run('tool.call',{tool:'ListAgents'},async()=>original),original);
});

test('Mod 不把 held 的 receive 观察当成已读，只对实际入库内容报告上下文',async()=>{
  const h=await harness(),text='[nxbridge message_id=1234-abcd]正文';
  await h.run('session.receive',{origin:{kind:'peer'},text},async()=>({consumed:'held'}));
  assert.equal(h.calls[0].state,'observed');
  await h.run('session.append',{origin:{kind:'peer'},message:{role:'user',content:[{type:'text',text}]}},async()=>({message:{role:'user',content:[]}}));assert.equal(h.calls.length,1);
  await h.run('session.append',{origin:{kind:'peer'}},async()=>({message:{role:'user',content:[{type:'text',text}]}}));assert.equal(h.calls[1].state,'contextObserved');
});

test('Mod 在系统提示末尾追加中间进度的简短转述提醒，保留原有段落',async()=>{
  const h=await harness(),original=[{id:'intro',text:'原生',scope:'shared'}];
  const before=h.calls.length;
  const result=await h.run('prompt.compose',{model:'m'},async()=>({sections:original}));
  assert.equal(h.calls.length,before,'模型组装提示不登记身份或启动环境');
  assert.deepEqual(result.sections.slice(0,1),original);
  assert.deepEqual(result.sections.slice(1).map((s:any)=>s.id),['nxbridge:task-routing','nxbridge:questions','nxbridge:partner-progress']);assert.match(result.sections[1].text,/if owner=codex, hand off ALL/);
  assert.equal(result.sections.at(-1).id,'nxbridge:partner-progress');assert.equal(result.sections.at(-1).scope,'session');assert.match(result.sections.at(-1).text,/1-3 short plain sentences.*no lists\/headings\/internals/);
  assert.doesNotMatch(result.sections.slice(1).map((s:any)=>s.text).join('\n'),/\p{Script=Han}/u);
});

test('Mod 主线程中断标暂停，子代理结束不改变主线程状态',async()=>{
  const h=await harness();await h.run('turn.complete',{isAborted:true});assert.equal(h.calls.find(c=>c.operation==='state').state,'paused');assert.ok(h.calls.some(c=>c.operation==='cancel_turn'));
  const count=h.calls.length;await h.run('turn.complete',{isAborted:false,agentId:'child'});assert.equal(h.calls.length,count);
});

test('Mod 仅本窗口真实用户提交恢复暂停，状态栏区分本地和配对暂停',async()=>{
  const h=await harness();await h.run('session.start',{});h.calls.length=0;
  for(const e of [{origin:{kind:'peer'}},{origin:{kind:'peer-send-message'}},{origin:{kind:'composer'},agentId:'child'},{origin:{kind:'unknown'}}])await h.run('prompt.submit',e);
  assert.equal(h.calls.some(c=>c.operation==='prompt'),false);
  await h.run('prompt.submit',{origin:{kind:'composer'},turnId:'previous',text:'用户新任务'});assert.equal(h.calls.some(c=>c.operation==='prompt'),false);
  await h.run('turn.start',{turnId:'new-user',text:'用户新任务'});assert.equal(h.calls.filter(c=>c.operation==='prompt').length,1);
  await h.run('prompt.submit',{origin:{kind:'bridge'},text:'桥接输入'});await h.run('turn.start',{turnId:'bridge-user',text:'桥接输入'});assert.equal(h.calls.filter(c=>c.operation==='prompt').length,2);
  h.response('status',{paired:true,paused:false,self:{state:'paused'},partner:{state:'ready'}});await h.tick();assert.equal(h.statuses.at(-1),'本窗口已暂停（中断后，发消息即恢复）');
  h.response('status',{paired:true,paused:true,self:{state:'paused'},partner:{state:'ready'}});await h.tick();assert.match(h.statuses.at(-1)!,/配对已暂停.*nxbridge resume/);
                                           
  h.response('status',{paired:true,paused:false,self:{state:'ready'},partner:{state:'busy'}});await h.tick();assert.equal(h.statuses.at(-1),undefined);
  h.response('status',{paired:true,paused:false,self:{state:'ready'},partner:{state:'needsHuman'}});await h.tick();assert.equal(h.statuses.at(-1),'Codex 等待人工处理（到 Codex 窗口查看）');
  h.response('status',{paired:true,paused:false,self:{state:'ready'},partner:{state:'offline'}});
  for(let i=0;i<7;i++){await h.tick();assert.equal(h.statuses.at(-1),undefined);}
  await h.tick();assert.match(h.statuses.at(-1)!,/Codex 离线超过 2 分钟/);
  h.response('status',{paired:false});await h.tick();assert.equal(h.statuses.at(-1),undefined);
  h.fail();await h.tick();assert.equal(h.statuses.at(-1),undefined);await h.tick();assert.match(h.statuses.at(-1)!,/获取不到 nxbridge 状态，后台服务可能停了：持续 2 分钟会自动请一个 AI 处理/);
  assert.ok(h.statuses.every(s=>s===undefined||!s.startsWith('nxbridge · ')));
});

test('SDK 提示按当前配置恢复暂停，不能扩大配置、开关或配对命令的人工权限',async()=>{
  const h=await harness();await h.run('session.start',{});h.calls.length=0;
  const submit=async(text:string)=>{await h.run('prompt.submit',{origin:{kind:'sdk'},text});await h.run('turn.start',{turnId:text,text});};
  h.response('config-model',{value:false});await submit('默认关闭');assert.equal(h.calls.filter(c=>c.operation==='prompt').length,0);
  h.response('config-model',{value:true});await submit('SDK 界面任务');assert.equal(h.calls.filter(c=>c.operation==='prompt').length,1);
  const queries=h.calls.filter(c=>c.operation==='config-model');assert.ok(queries.every(c=>c.input.action==='get'&&c.input.key==='hosts.claude.sdk_user_prompt'));
  h.response('config-model',{value:false});await submit('关闭后输入');assert.equal(h.calls.filter(c=>c.operation==='prompt').length,1,'不沿用此前开启的缓存');
  h.response('config-model',{value:true});h.calls.length=0;
  for(const event of [{origin:{kind:'sdk'},agentId:'child'},{origin:{kind:'peer'}},{origin:{kind:'plugin'}},{origin:{kind:'model'}},{}])await h.run('prompt.submit',{...event,text:'不能恢复'});
  await h.run('turn.start',{turnId:'ignored',text:'不能恢复'});assert.equal(h.calls.some(c=>['prompt','config-model'].includes(c.operation)),false);
  h.calls.length=0;
  for(const args of ['config confirm 0123456789abcdef','on codex','pair 1234'])assert.match((await h.run('command.run',{command:'nxbridge',args,origin:{kind:'sdk'}})).text,/第三方界面.*sdk_user_prompt 只放开普通输入/);
  assert.deepEqual(h.calls.map(c=>[c.operation,c.command]),[['human-refused','config'],['human-refused','switch'],['human-refused','pair']]);
});

test('SDK 策略读取失败、类型不符或读取期间换对话均不恢复暂停',async()=>{
  for(const mode of ['failure','type','session']){
    const h=await harness();await h.run('session.start',{});h.calls.length=0;
    if(mode==='failure')h.error('config-model',{message:'读取失败'});
    else h.response('config-model',()=>{if(mode==='session')h.session('new-session');return{value:mode==='type'?'true':true};});
    await h.run('prompt.submit',{origin:{kind:'sdk'},text:'旧输入'});await h.run('turn.start',{turnId:'new-turn',text:'旧输入'});
    assert.equal(h.calls.some(c=>c.operation==='prompt'),false,mode);
  }
});

test('Mod 配置命令只接受根输入框来源，模型接口不提供确认',async()=>{
  const h=await harness();await h.run('session.start',{});h.calls.length=0;
                                                          
  const refused=[{origin:{kind:'model'}},{origin:{kind:'bridge'}},{origin:{kind:'peer'}},{origin:{kind:'plugin'}},{origin:{kind:'composer'},agentId:'child'},{origin:{kind:'sdk'}},{origin:{kind:'sdk'},surfaces:['mobile']},{origin:{kind:'sdk'},surfaces:['desktop'],agentId:'child'},{}];
  for(const {surfaces,...event} of refused as any[]){
    h.response('surfaces',surfaces??[]);
    const result=await h.run('command.run',{command:'nxbridge',args:'config confirm 0123456789abcdef',...event});assert.match(result.text,/你本人在这个 Claude 窗口的输入框里提交.*系统终端/);
  }
  assert.ok(h.calls.every(c=>c.operation==='human-refused'&&c.command==='config'&&!JSON.stringify(c).includes('0123456789abcdef')));
  assert.deepEqual(h.calls.map(c=>[c.origin,c.surfaces]),[['model',[]],['bridge',[]],['peer',[]],['plugin',[]],['composer',[]],['sdk',[]],['sdk',['mobile']],['sdk',['desktop']],['none',[]]]);
                   
  h.calls.length=0;h.error('human-refused','broker down');assert.match((await h.run('command.run',{command:'nxbridge',args:'config pending',origin:{kind:'peer'}})).text,/输入框里提交/);
                                                    
  for(const surface of ['desktop','vscode']){
    h.response('surfaces',[surface]);h.response('config',{proposal_id:'p'});
    assert.match((await h.run('command.run',{command:'nxbridge',args:'config pending',origin:{kind:'sdk'}})).text,/proposal_id/);assert.deepEqual([h.calls.at(-1).operation,h.calls.at(-1).origin,h.calls.at(-1).args],['config','composer','pending']);
  }
  h.response('surfaces',[]);
  h.response('config',{changed:true});assert.match((await h.run('command.run',{command:'nxbridge',args:'config set collaboration.implicit never',origin:{kind:'composer'}})).text,/changed/);assert.equal(h.calls.at(-1).origin,'composer');assert.equal(h.calls.at(-1).args,'set collaboration.implicit never');
  await h.run('tool.call',{tool:'mcp__nxbridge__config',action:'set',key:'collaboration.implicit',value:'never',tool_use_id:'proposal'});assert.equal(h.calls.at(-1).operation,'config-model');assert.deepEqual(h.calls.at(-1).input,{action:'set',key:'collaboration.implicit',value:'never'});
  const before=h.calls.length;assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__config',action:'list',agentId:'child'})).deny,/root session/);assert.equal(h.calls.length,before);
});

test('Mod 接管 Codex 来源问题，返回原生答案和来源；needs_user 回原生且状态真实',async()=>{
  const h=await harness(),id='1234-abcd',text='[nxbridge message_id='+id+']正文';
  h.response('origin',{body:'正文'});h.response('create',{request_id:'q-test',status:'pending'});
  await h.run('prompt.submit',{origin:{kind:'peer'},text});await h.run('session.append',{origin:{kind:'peer'},uuid:'row'},async()=>({uuid:'row',message:{role:'user',content:[{type:'text',text}]}}));await h.run('turn.start',{turnId:'turn'});
  h.waitResult({request_id:'q-test',status:'answered',answers:{问题:'答案'},rationale:'理由'});
  let native=0;const next=async()=>{native++;return{ref:9,result:{answers:{问题:'用户'}}};};
  const result=await h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'call'},next);
  assert.equal(native,0);assert.deepEqual(result.result.answers,{问题:'答案'});assert.match(result.context[0],/answered by codex partner, not user.*rationale/);
  h.waitResult({status:'needs_user'});const fallback=await h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'next'},next);
  assert.equal(native,1);assert.equal(fallback.ref,9);assert.deepEqual(h.calls.filter(c=>c.operation==='state').slice(-2).map(c=>c.state),['needsHuman','busy']);
  assert.equal(h.calls.filter(c=>c.operation==='origin').length,1,'同轮来源只在实际提问时核对一次');
});

test('Mod 延后核对仍拒绝正文冒用，来源核对期间换对话、轮次或追加正文时不弹出旧问题',async()=>{
  for(const change of ['body','session','turn','append']){
    const h=await harness(),text='[nxbridge message_id=1234-abcd]实际正文';await h.run('session.start',{});
    await h.run('prompt.submit',{origin:{kind:'peer'},text});
    await h.run('session.append',{origin:{kind:'peer'},uuid:'row'},async()=>({uuid:'row',message:{role:'user',content:[{type:'text',text}]}}));
    await h.run('turn.start',{turnId:'original'});
    assert.equal(h.calls.some(c=>c.operation==='origin'),false);
    h.response('origin',async()=>{
      if(change==='session')h.session('fresh');
      if(change==='turn')await h.run('turn.start',{turnId:'fresh'});
      if(change==='append')await h.run('session.append',{origin:{kind:'peer'},uuid:'replacement'},async()=>({uuid:'replacement',message:{role:'user',content:[{type:'text',text:'[nxbridge message_id=1234-abcd]改写后的正文'}]}}));
      return{body:change==='body'?'另一个任务':'实际正文'};
    });
    let native=0;const result=await h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'source'},async()=>{native++;return{result:{answers:{问题:'用户'}}};});
    assert.equal(h.calls.some(c=>c.operation==='create'),false);
    if(change==='body')assert.equal(native,1);
    else{assert.equal(native,0);assert.match(result.deny,/origin context changed/);}
  }
});

test('Mod 用户或子代理提问原生，不会创建搭档问题；答题注册保留原生 schema',async()=>{
  const h=await harness();await h.run('session.start',{});
  await h.run('prompt.submit',{origin:{kind:'composer'},text:'用户任务'});await h.run('turn.start',{turnId:'human'});
  let native=0;await h.run('tool.call',{tool:'AskUserQuestion',questions:[]},async()=>{native++;return{result:{answers:{问题:'用户'}}};});
  await h.run('tool.call',{tool:'AskUserQuestion',agentId:'child',questions:[]},async()=>{native++;return{};});
  assert.equal(native,2);assert.ok(!h.calls.some(c=>c.operation==='create'));assert.ok(!h.calls.some(c=>c.question_diagnostics),'用户自己的提问不上报来源诊断');
  h.response('answer',{request_id:'q',status:'answered'});
  const answered=await h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'q',answers:{问题:'答案'},rationale:'理由',tool_use_id:'answer'});
  assert.equal(JSON.parse(answered.result).status,'answered');assert.equal(h.calls.at(-1).callId,'answer');
});

test('Mod 升级用保存的问题原生提问，经内部入口回填，重试不再弹表单',async()=>{
  const h=await harness();await h.run('session.start',{});
  const original=[{question:'问题',header:'决定',options:[{label:'甲',description:'一'},{label:'乙',description:'二'}],multiSelect:false}];
  h.response('answer',{request_id:'q',status:'awaiting_user',questions:original});h.response('answer_user',{request_id:'q',status:'answered'});
  const result=await h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'q',action:'ask_user',tool_use_id:'upgrade'});
  assert.equal(JSON.parse(result.result).status,'answered');assert.deepEqual(JSON.parse(result.result).user_answers,{问题:'用户'});assert.deepEqual(h.nativeCalls,[{tool:'AskUserQuestion',questions:original}]);assert.equal(h.calls.at(-1).operation,'answer_user');assert.equal(h.calls.at(-1).callId,'upgrade:user');
  h.response('answer',{request_id:'q',status:'awaiting_user',replayed:true});await h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'q',action:'ask_user',tool_use_id:'upgrade'});assert.equal(h.nativeCalls.length,1);
});

test('Mod 展开子代理 prompt，保留 model/effort，失败拒绝启动',async()=>{
  const h=await harness(),input={prompt:'任务 nxref:msg:source',model:'haiku',effort:0,tool_use_id:'spawn',parentAgentId:'child'};
  h.response('ref-expand',{text:'任务 完整正文'});let received:any,count=0;
  await h.run('agent.spawn',input,async(e:any)=>{count++;received=e;return{agentId:'new'};});
  assert.deepEqual(received,{...input,prompt:'任务 完整正文'});assert.equal(h.calls.at(-1).operation,'ref-expand');
  h.fail();assert.match((await h.run('agent.spawn',input,async()=>{count++;})).deny,/^nxref not expanded: .*; fix ref or inline text$/);assert.equal(count,1);
});

test('Mod 原生表单保留多题、预览和批注，ui.ask 字符串解析失败不丢失已提交答案',async()=>{
  const h=await harness();await h.run('session.start',{});
  const questions=[{question:'多选？',header:'选择',multiSelect:true,options:[{label:'甲',description:'说明甲',preview:'原始预览'},{label:'乙',description:'说明乙'}]},{question:'补充？',header:'补充',multiSelect:false,options:[{label:'是',description:'确认'},{label:'否',description:'拒绝'}]}];
  const native={answers:{'多选？':'甲, 乙','补充？':'是'},annotations:{'多选？':{notes:'原生批注'}}};
  h.response('answer',{request_id:'multi',status:'awaiting_user',questions});h.response('answer_user',{request_id:'multi',status:'answered'});h.nativeResult({result:native});h.uiFailure(Error('宿主字符串解析失败'));
  const result=await h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'multi',action:'ask_user',tool_use_id:'multi-answer'});
  assert.deepEqual(h.nativeCalls,[{tool:'AskUserQuestion',questions}]);
  assert.deepEqual(JSON.parse(result.result).user_answers,native.answers);assert.deepEqual(JSON.parse(result.result).user_annotations,native.annotations);
  assert.equal(h.calls.some(call=>call.operation==='create'),false);
});

test('Mod 表单失败释放升级，提交失败保留用户答案，已提交但回执丢失返回终态',async()=>{
  for(const scenario of ['incomplete','incomplete-cancel-failed','throw','submit-failed','ack-lost','upgrade-ack-lost']){
    const h=await harness();await h.run('session.start',{});
    h.response('answer',{request_id:'q',status:'awaiting_user',questions:[{question:'问题',header:'决定',options:[{label:'甲',description:'一'},{label:'乙',description:'二'}],multiSelect:false}]});h.response('cancel',{request_id:'q',status:'cancelled'});
    const native={result:{answers:{问题:'用户完整答案'},annotations:{问题:{备注:'原文'}}}};
    h.nativeResult(scenario.startsWith('incomplete')?{result:{}}:scenario==='throw'?Error('表单失败'):native);
    if(scenario==='incomplete-cancel-failed')h.error('cancel',{code:'disconnected',message:'connection lost',uncertain:true});
    if(['submit-failed','ack-lost'].includes(scenario))h.error('answer_user',{code:'timeout',message:'confirmation timeout',uncertain:true});
    if(scenario==='ack-lost')h.response('cancel',{request_id:'q',status:'answered',answers:{q:{answers:['用户完整答案']}},source:{kind:'user_via_claude'}});
    if(scenario==='upgrade-ack-lost')h.error('answer',{code:'timeout',message:'confirmation timeout',uncertain:true});
    const result=await h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'q',action:'ask_user',tool_use_id:'upgrade'});
    assert.equal(h.calls.at(-1).operation,'cancel');
    if(scenario==='ack-lost'){
      const receipt=JSON.parse(result.result);assert.equal(receipt.status,'answered');assert.deepEqual(receipt.user_answers,native.result.answers);assert.deepEqual(receipt.user_annotations,native.result.annotations);
    }else{
      assert.match(result.deny,/not completed/);
      if(scenario==='incomplete-cancel-failed'){assert.match(result.deny,/native form returned no full answers/);assert.doesNotMatch(result.deny,/q cancelled/);}
      if(scenario==='submit-failed'){assert.match(result.deny,/用户完整答案/);assert.match(result.deny,/原文/);assert.match(result.deny,/request_id/);}
    }
    if(scenario==='upgrade-ack-lost')assert.equal(h.nativeCalls.length,0);
  }
  const h=await harness();await h.run('session.start',{});h.error('answer',{code:'awaiting_user',message:'native user answer pending'});
  await h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'q',action:'ask_user',tool_use_id:'other'});
  assert.equal(h.calls.some(c=>c.operation==='cancel'),false,'确定拒绝的重复升级不能取消正在进行的表单');
});

test('Mod 状态命令只返回简短人类文本，共用模型兜底',async()=>{
  const h=await harness();h.response('status-human',{text:'nxbridge：已配对\n搭档：就绪'});
  assert.deepEqual(await h.run('command.run',{command:'nxbridge'}),{text:'nxbridge：已配对\n搭档：就绪'});assert.equal(h.calls.at(-1).operation,'status-human');
  const errors=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/errors.js')).href);
  const {MODEL_ERROR_FALLBACK,referenceDeny}=await import('../integration/mcp/model-output.js');
  assert.equal(errors.modelMessage(Error('未映射错误')),MODEL_ERROR_FALLBACK);assert.equal(errors.referenceDeny('reason'),referenceDeny('reason'));
});

test('真实问答控制入口显式输出模型错误字段，Mod 保留原因而不读取人类 message',async()=>{
  const child=spawnSync(process.execPath,['--no-warnings',path.join(PACKAGE_ROOT,'dist','question-control.js')],{input:JSON.stringify({operation:'invalid'}),encoding:'utf8',windowsHide:true});
  assert.equal(child.status,1);const detail=JSON.parse(child.stderr.trim());assert.equal(detail.code,'invalid_arguments');assert.equal(detail.model_message,detail.message);assert.match(detail.model_message,/operation:/);assert.doesNotMatch(detail.model_message,/\p{Script=Han}/u);
  const h=await harness();await h.run('session.start',{});h.error('answer',{...detail,message:'不能将人类中文错误作为模型提示'});
  const result=await h.run('tool.call',{tool:'mcp__nxbridge__answer_question',request_id:'q',answers:{问题:'答案'},rationale:'理由',tool_use_id:'answer'});
  assert.ok(result.deny.endsWith(detail.model_message));assert.doesNotMatch(result.deny,/不能将人类中文错误/);
});

test('Mod 根模型状态去重，数字零保留，子代理 step 不污染；只捕获完成的最终答案',async()=>{
  const h=await harness();await h.run('session.start',{});h.calls.length=0;
  const drain=async(e:any)=>{for await(const _ of h.run('turn.step',e,async function*(){yield{type:'test'};})){};};
  await drain({model:'opus',effort:0});await drain({model:'opus',effort:0});await drain({model:'haiku',agentId:'child',effort:'low'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].effort,0);
  await drain({model:'opus-next'});assert.equal(h.calls.at(-1).effort,null);
  h.response('messages',[{role:'assistant',text:'中间',toolUses:[{}]},{role:'assistant',text:'最终答案',toolUses:[]}]);
  await h.run('turn.complete',{agentId:'child',isAborted:false});assert.equal(h.calls.at(-1).operation,'ref-capture');assert.equal(h.calls.at(-1).text,'最终答案');
  const count=h.calls.length;await h.run('turn.complete',{agentId:'child',isAborted:true});assert.equal(h.calls.length,count);
});

test('Mod 开关：本窗口关闭后不登记、不注入、不发信，只保留开关和状态；开启只接受用户输入框',async()=>{
  const h=await harness();await h.run('session.start',{});
                      
  let count=h.calls.length;
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__set_enabled',target:'partner',enabled:true,user_requested:true})).result,/needs the user.*\/nxbridge on codex/);assert.equal(h.calls.length,count);
  for(const input of [{target:'partner',enabled:false},{target:'partner',enabled:false,user_requested:false},{target:'other',enabled:false,user_requested:true},{target:'partner',enabled:'false',user_requested:true}])assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__set_enabled',...input})).deny,/need target/);
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__set_enabled',target:'partner',enabled:false,user_requested:true,agentId:'child'})).deny,/root session/);assert.equal(h.calls.length,count);
  h.response('switch',{member_id:'codex-peer',enabled:false,message:'已关闭'});
  assert.equal((await h.run('tool.call',{tool:'mcp__nxbridge__set_enabled',target:'partner',enabled:false,user_requested:true})).result,'已关闭');
  assert.deepEqual([h.calls.at(-1).operation,h.calls.at(-1).target,h.calls.at(-1).enabled,h.calls.at(-1).origin],['switch','partner',false,undefined]);
                       
  h.response('status',{paired:true,paused:false,self:{state:'ready'},partner:{state:'ready',enabled:false}});await h.tick();assert.match(h.statuses.at(-1)!,/Codex 的 nxbridge 已关闭.*\/nxbridge on codex/);
                                             
  assert.match((await h.run('command.run',{command:'nxbridge',args:'on codex'})).text,/你本人在这个 Claude 窗口的输入框里提交.*nxbridge on codex/);
  assert.deepEqual([h.calls.at(-1).operation,h.calls.at(-1).command,h.calls.at(-1).origin],['human-refused','switch','none']);
  h.response('switch',{member_id:'codex-peer',enabled:true,message:'已开启'});
  assert.equal((await h.run('command.run',{command:'nxbridge',args:'on codex',origin:{kind:'composer'}})).text,'已开启');
  assert.deepEqual([h.calls.at(-1).operation,h.calls.at(-1).target,h.calls.at(-1).enabled,h.calls.at(-1).origin],['switch','partner',true,'composer']);
                                                     
  h.response('surfaces',['vscode']);
  assert.equal((await h.run('command.run',{command:'nxbridge',args:'on codex',origin:{kind:'sdk'}})).text,'已开启');
  assert.deepEqual([h.calls.at(-1).operation,h.calls.at(-1).origin],['switch','composer']);
  h.response('surfaces',[]);
                                   
  h.response('switch',{member_id:'self',enabled:false,message:'本窗口已关闭'});
  await h.run('command.run',{command:'nxbridge',args:'off',origin:{kind:'composer'}});
  count=h.calls.length;
  const sent=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'任务',tool_use_id:'off'});assert.equal(sent.result.success,false);assert.match(sent.result.display,/已关闭/);
  const composed=await h.run('prompt.compose',{},async()=>({sections:[]}));assert.deepEqual(composed.sections,[]);
  await h.run('turn.start',{turnId:'off-turn'});await h.run('turn.complete',{turnId:'off-turn',isAborted:false});
  assert.equal(h.calls.length,count);
  h.response('status',{paired:true,disabled:true,code:'member_disabled',enabled:false});await h.tick();assert.match(h.statuses.at(-1)!,/本窗口的 nxbridge 已关闭.*\/nxbridge on/);
                        
  h.response('switch',{member_id:'self',enabled:true,message:'本窗口已开启'});
  assert.equal((await h.run('command.run',{command:'nxbridge',args:'on',origin:{kind:'composer'}})).text,'本窗口已开启');
  count=h.calls.length;const enabled=await h.run('prompt.compose',{},async()=>({sections:[]}));assert.ok(enabled.sections.length);assert.equal(h.calls.length,count);
});

test('Mod 状态栏：模型服务挡住 Codex 时只说原因和最近一次时间，先于派生的等待和集成提示，不给中断或恢复命令',async()=>{
  const h=await harness();await h.run('session.start',{});
  const at=Date.parse('2026-11-09T07:28:00Z'),clock=new Date(at).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'});
  const health=(modelRequest:any)=>({paired:true,self:{state:'ready'},partner:{state:'busy',health:{state:'silent',turnId:'t',lastProgressAt:at-60000,tools:[],modelRequest},delivery_wait:{state:'waiting_native_interaction',message:'等待'}},integrationIssues:['hooks_missing']});
  h.response('status',health({state:'retrying',kind:'http',statusCode:503,at,source:'native-log',blocking:true}));await h.tick();
  const line=h.statuses.at(-1)!;assert.match(line,/模型服务暂时不可用（返回 503）.*正在自动重试.*最近一次/);assert.ok(line.includes(clock));assert.doesNotMatch(line,/recover|中断|nxbridge status|原因未知/);
  h.response('status',health({state:'retrying',kind:'auth',statusCode:401,at,source:'native-log',blocking:true}));await h.tick();assert.match(h.statuses.at(-1)!,/拒绝了登录凭据.*检查 Codex 的登录或密钥/);
  h.response('status',health({state:'failed',kind:'quota',statusCode:429,at,source:'native-log',blocking:true}));await h.tick();assert.match(h.statuses.at(-1)!,/这一轮已停止：模型服务限流或额度不足/);
                     
  h.response('status',health({state:'failed',kind:'http',statusCode:503,at,source:'native-log',blocking:false}));await h.tick();assert.doesNotMatch(h.statuses.at(-1)??'',/模型服务/);
});

test('Mod 状态栏：Codex 这一轮失败时写出模型服务给的原因，原生重试用尽时说明已重试到上限',async()=>{
  const h=await harness();await h.run('session.start',{});
  const at=Date.parse('2026-11-10T08:53:38Z'),failed=(health:object)=>({paired:true,self:{state:'ready'},partner:{state:'ready',health:{state:'failed',turnId:'t',lastProgressAt:at-1000,tools:[],...health}}});
  h.response('status',failed({error:'exceeded retry limit, last status: 429 Too Many Requests',modelRequest:{state:'failed',kind:'quota',statusCode:429,at,source:'native-log',blocking:false}}));await h.tick();
  assert.match(h.statuses.at(-1)!,/^Codex 这一轮失败：模型服务限流或额度不足（返回 429），已重试到上限，最近一次 .*（运行 nxbridge status 查看）$/);
  h.response('status',failed({error:'context window exceeded'}));await h.tick();assert.equal(h.statuses.at(-1),'Codex 这一轮执行失败（运行 nxbridge status 查看）');
                                                                                         
  const rejected=JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message:"The 'gpt-6.1-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}});
  for(const modelRequest of [{state:'succeeded',kind:'http',statusCode:200,at,source:'native-log'},{state:'failed',kind:'http',statusCode:400,at,source:'native-log'}]){
    h.response('status',failed({error:rejected,modelRequest}));await h.tick();
    assert.equal(h.statuses.at(-1),'Codex 这一轮失败：模型服务返回 400，说当前模型要求更新版本的 Codex；持续出现就需要升级 Codex 或换用其他模型（运行 nxbridge status 查看）');
  }
  h.response('status',failed({error:JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message:'bad field'}})}));await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 这一轮失败：模型服务拒绝了请求（返回 400）（运行 nxbridge status 查看）');
});

                                                                  
function noticeLedger(h:Awaited<ReturnType<typeof harness>>){
  const notices:any[]=[],pending=()=>notices.filter(n=>!n.admitted&&n.eligible!==false);
  h.response('monitor',()=>{const list=pending();return{notices:list.length?[{id:list[0].id,source:list[0].source,tier:list.some(n=>n.wake)?4:3,wake:list.some(n=>n.wake===true)}]:[]};});
  h.response('monitor-prepare',(input:any)=>{
    const anchor=pending().find(n=>n.id===input.notice_id);if(!anchor)return{notices:[]};
    const batch=[anchor,...pending().filter(n=>n!==anchor)];for(const n of batch)Object.assign(n,{admitted:true,batch:anchor.id,state:'unknown'});
    return{notices:[{id:anchor.id,source:anchor.source,wake:batch.some(n=>n.wake===true),message:batch.map(n=>n.message).join('\n'),componentIds:batch.map(n=>n.id)}]};
  });
  h.response('monitor-ack',(input:any)=>{const batch=notices.find(n=>n.id===input.notice_id)?.batch;for(const n of notices)if(batch&&n.batch===batch)n.state=input.state;return{};});
  return{notices,add:(notice:any)=>{notices.push(notice);return notice;}};
}

test('Mod 唤醒先领取：留在插件里的告知不会把排队唤醒的正文领走，两条在同一次唤醒里送达（agscan 实测丢失）',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});const ledger=noticeLedger(h);
                                                       
  const failed=ledger.add({id:'turn-failed',source:'pair_anomaly',wake:true,eligible:false,message:'partner turn failed; decide whether to send one short resume msg'});
  const idle=ledger.add({id:'idle',source:'idle_unanswered',wake:false,message:'Expected reply still pending'});
  await h.tick();assert.equal(h.calls.some(c=>['monitor-enqueue','monitor-prepare'].includes(c.operation)),false,'告知留在插件里，不领取');
  failed.eligible=true;await h.tick();assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
  const result=await h.consumePrompt();
  assert.equal(result.drop,undefined,'唤醒不能被当成已消失丢弃');assert.equal(h.prompts.length,1);
  assert.match(h.prompts[0].context.join('\n'),/partner turn failed[\s\S]*Expected reply still pending/);
  assert.deepEqual(h.calls.filter(c=>c.operation==='monitor-prepare').map(c=>c.notice_id),['turn-failed'],'先领唤醒；留下的告知已在同一批里，不再单独领取');
  assert.deepEqual([failed.state,idle.state],['submitted','submitted']);
});

test('Mod 留在插件里的告知编号后来带上唤醒（合并进需要处理的新提醒）：改走唤醒，不等下次对话',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});const ledger=noticeLedger(h);
  const idle=ledger.add({id:'idle',source:'idle_unanswered',wake:false,message:'Expected reply still pending'});
  await h.tick();assert.equal(h.calls.some(c=>c.operation==='monitor-enqueue'),false);
                                                     
  const failed=ledger.add({id:'turn-failed',source:'pair_anomaly',wake:true,message:'partner turn failed; decide whether to send one short resume msg'});
  await h.tick();assert.deepEqual(h.calls.filter(c=>c.operation==='monitor-enqueue').map(c=>c.notice_id),['idle']);
  await h.consumePrompt();assert.equal(h.prompts.length,1);assert.match(h.prompts[0].context.join('\n'),/Expected reply still pending[\s\S]*partner turn failed/);
  assert.deepEqual([idle.state,failed.state],['submitted','submitted']);
  await h.tick();assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,1,'送达后不再入队');
});

test('Mod 唤醒正文已随前面的工具结果附上：唤醒标记晚到时如实说明、不再开回合',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});const ledger=noticeLedger(h);
  const failed=ledger.add({id:'turn-failed',source:'pair_anomaly',wake:true,eligible:false,message:'partner turn failed'});
  ledger.add({id:'idle',source:'idle_unanswered',wake:false,message:'Expected reply still pending'});
  await h.tick();failed.eligible=true;await h.tick();assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,1);
                                            
  const tool=await h.run('tool.call',{tool:'Bash',tool_use_id:'t1'},async()=>({result:{}}));
  assert.match(tool.context.join('\n'),/Expected reply still pending[\s\S]*partner turn failed/);assert.equal(failed.state,'submitted');
  const late=await h.consumePrompt();assert.equal(late.drop,'nxbridge：这条提醒已随前面的对话附上，无需处理');assert.equal(h.prompts.length,0);
});

test('Mod 观测到启动时的实际权限模式和接收设置后主动登记一次，不等第一份任务；未变化不重复，变化后再登记',async()=>{
                                                      
  for(const early of [false,true]){
    const h=await harness();h.response('settings',{flag:{crossSessionInbound:'accept'}});
    const sessionStart=()=>h.run('classic.SessionStart',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);
    if(early)await sessionStart();
    await h.run('session.start',{});
    if(!early)await sessionStart();
    const started=h.calls.findIndex(c=>c.operation==='context-start'),registers=()=>h.calls.filter((c,i)=>c.operation==='register'&&i>started);
    assert.ok(started>=0);assert.equal(registers().length,1,early?'先观测模式':'后观测模式');
    const sent=registers()[0];assert.equal(sent.nativePermission.mode,'bypassPermissions');assert.equal(sent.nativeInbound.policy,'accept');assert.equal(sent.nativeInbound.source,'flag');
    await h.run('classic.PreToolUse',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);assert.equal(registers().length,1);
    await h.run('classic.UserPromptSubmit',{session_id:'session',permission_mode:'default'},async(e:any)=>e);assert.equal(registers().length,2);assert.equal(registers()[1].nativePermission.mode,'default');
  }
});

test('Mod 的 partner_profile 和 select_partner 新建参数原样转给后台，子代理不能修改搭档模型',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('partner-profile' as any,{member_id:'m',host:'codex',status:'pending',delivery_held:true});
  const set=await h.run('tool.call',{tool:'mcp__nxbridge__partner_profile',action:'set',model:'gpt-x',effort:'high',tool_use_id:'t1'});
  assert.equal(JSON.parse(set.result).status,'pending');
  const sent=h.calls.filter(c=>c.operation==='partner-profile').at(-1);
  assert.deepEqual({action:sent.action,model:sent.model,effort:sent.effort},{action:'set',model:'gpt-x',effort:'high'});
  await h.run('tool.call',{tool:'mcp__nxbridge__partner_profile',tool_use_id:'t2'});
  const read=h.calls.filter(c=>c.operation==='partner-profile').at(-1);assert.equal(read.action,'get');assert.equal('model' in read,false);
  assert.match((await h.run('tool.call',{tool:'mcp__nxbridge__partner_profile',action:'set',model:'x',agentId:'sub'})).deny,/root session only/);
  h.response('selection-commit',{status:'paired',partner_name:'新后台'});
  await h.run('tool.call',{tool:'mcp__nxbridge__select_partner',selection_id:'s1',action:'create',model:'gpt-x',effort:'low',tool_use_id:'t3'});
  const commit=h.calls.filter(c=>c.operation==='selection-commit').at(-1);
  assert.deepEqual({action:commit.action,model:commit.model,effort:commit.effort},{action:'create',model:'gpt-x',effort:'low'});
  await h.run('tool.call',{tool:'mcp__nxbridge__select_partner',selection_id:'s2',key:'k',tool_use_id:'t4'});
  const choose=h.calls.filter(c=>c.operation==='selection-commit').at(-1);assert.equal('model' in choose,false);assert.equal('effort' in choose,false);
});

test('Mod 登记本会话实际模型和推理强度的原值供后台核对，只读，读不到的项不发送',async()=>{
  const {modContextSchema}=await import('../integration/mod/mod-protocol.js');
  const h=await harness();
  h.response('settings',{flag:{crossSessionInbound:'accept',model:'opus',effortLevel:'high'},merged:{model:'opus',effortLevel:'high'}});
  h.response('session-model' as any,'claude-opus-5-5');h.response('effort-env' as any,'low');
  await h.run('session.start',{});
  await h.run('classic.SessionStart',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);
  const started=h.calls.findIndex(c=>c.operation==='context-start'),sent=h.calls.filter((c,i)=>c.operation==='register'&&i>started).at(-1);
  assert.ok(sent,'必须在第一份工作前登记');
  assert.deepEqual({...sent.nativeProfile,observedAt:0},{model:'claude-opus-5-5',flag:{model:'opus',effort:'high'},effective:{model:'opus',effort:'high'},effortOverride:'low',observedAt:0});
  assert.equal(modContextSchema.shape.nativeProfile.safeParse(sent.nativeProfile).success,true);
                     
  assert.ok(h.commandRuns.every((run:any)=>!['model','effort'].includes(run?.command)));
                                      
  const bare=await harness();
  bare.response('settings',{flag:{crossSessionInbound:'accept'}});bare.response('session-model' as any,new Error('unsupported'));
  await bare.run('session.start',{});
  await bare.run('classic.SessionStart',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);
  const begin=bare.calls.findIndex(c=>c.operation==='context-start'),plain=bare.calls.filter((c,i)=>c.operation==='register'&&i>begin).at(-1);
  assert.ok(plain);assert.deepEqual(Object.keys(plain.nativeProfile),['observedAt']);
  assert.equal(modContextSchema.shape.nativeProfile.safeParse(plain.nativeProfile).success,true);
});

test('Mod 只读取用户 effort 命令的原生确认，覆盖固定层、别名、上限、选择器和 auto，不执行隐藏命令',async()=>{
  const h=await harness();h.response('settings',{flag:{crossSessionInbound:'accept',model:'opus',effortLevel:'high'},merged:{model:'opus',effortLevel:'high'}});h.response('session-model','claude-opus-current');
  h.response('context-start',{registered:true,owner:'nxbridge'});h.response('register',{registered:true,owner:'nxbridge'});
  await h.run('session.start',{});await h.run('classic.SessionStart',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);
  const latest=()=>h.calls.filter(call=>call.operation==='register').at(-1)?.nativeProfile;
  const apply=async(args:string,stdout:string)=>{
    await h.run('command.run',{command:'effort',args},async()=>({ref:1}));
    for(const text of [`<command-name>/effort</command-name>\n<command-args>${args}</command-args>`,`<local-command-stdout>${stdout}</local-command-stdout>`])await h.run('session.append',{door:'command'},async()=>({uuid:'native',message:{type:'user',role:'user',content:[{type:'text',text}]}}));
    await h.flush();
  };
  await apply('med','Set effort level to medium (saved as your default for new sessions): Balanced');
  assert.equal(latest()?.runtimeEffort,'medium');assert.equal(latest()?.effective.effort,'high');
  await apply('max',"Effort 'max' exceeds the cap for model set by your settings or organization; set to 'high' instead: capped");assert.equal(latest()?.runtimeEffort,'high');
  await apply('invalid','Invalid argument: invalid. Valid options are: low, medium, high');assert.equal(latest()?.runtimeEffort,'high');
  await apply('','Set effort level to xhigh (this session only): Extended');assert.equal(latest()?.runtimeEffort,'xhigh');
  await apply('auto','Effort level set to auto');assert.equal(latest()?.runtimeEffort,null);
  await apply('','Cancelled');assert.equal(latest()?.runtimeEffort,null);
  await apply('new-level','Future native confirmation');assert.equal(latest()?.effortUnverified,true);
  const {nativeProfileEffort,nativeProfileSchema}=await import('../integration/mod/mod-protocol.js');
  assert.equal(nativeProfileEffort(nativeProfileSchema.parse(latest())),undefined);
  h.response('effort-env','high');await apply('auto','Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=high still controls this session');
  assert.equal(nativeProfileEffort(nativeProfileSchema.parse(latest())),'high');assert.equal(latest()?.effortUnverified,undefined);
  assert.deepEqual(h.commandRuns,[]);assert.deepEqual(h.appends,[]);
});

test('effort 选择器晚于静态读取结束时仍由原生事件确认，不依赖历史窗口',async()=>{
  const h=await harness(),rows=Array.from({length:4096},(_,index)=>({role:'user',text:'旧消息 '+index}));h.response('messages',rows);
  h.response('session-model','model');h.response('context-start',{registered:true,owner:'nxbridge'});h.response('register',{registered:true,owner:'nxbridge'});
  await h.run('session.start',{});await h.run('classic.SessionStart',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);
  await h.run('command.run',{command:'effort',args:'medium'},async()=>({ref:1}));
  await h.flush();
  for(const text of ['<command-name>/effort</command-name>\n<command-args>medium</command-args>','<local-command-stdout>Set effort level to medium (this session only): Balanced</local-command-stdout>'])await h.run('session.append',{door:'command'},async()=>({uuid:'native',message:{type:'user',role:'user',content:[{type:'text',text}]}}));
  await h.flush();assert.equal(h.calls.filter(call=>call.operation==='register').at(-1)?.nativeProfile.runtimeEffort,'medium');assert.deepEqual(h.commandRuns,[]);
});

test('用户自有窗口及未知归属不安排原生 effort 查询，切换会话后不沿用后台权限',async()=>{
  const h=await harness();h.response('context-start',{registered:true,owner:'user'});h.response('register',{registered:true,owner:'user'});
  await h.run('session.start',{});await h.flush();await h.run('command.run',{command:'effort',args:'medium'},async()=>({text:'已采用'}));await h.flush();assert.deepEqual(h.commandRuns,[]);
  const before=h.calls.length;
  for(const text of ['<command-name>/effort</command-name>\n<command-args>medium</command-args>','<local-command-stdout>Set effort level to medium (this session only): Balanced</local-command-stdout>']){
    const result={uuid:'unchanged',message:{type:'user',role:'user',content:[{type:'text',text}]}};
    assert.equal(await h.run('session.append',{door:'command'},async()=>result),result);
  }
  await h.flush();assert.equal(h.calls.length,before);
  h.response('context-start',{registered:true,owner:'nxbridge'});h.response('register',{registered:true,owner:'nxbridge'});
  await h.run('session.start',{});h.session('new-user-session');await h.snapshot();await h.flush();assert.deepEqual(h.commandRuns,[]);
});

test('Mod 原生 SessionStart 不带模式时用引擎判定核对实际效果并登记，不推断模式名、不运行工具',async()=>{
  const h=await harness();h.response('settings',{flag:{crossSessionInbound:'accept'}});h.response('tool-check' as any,{decision:'allow'});
  await h.run('session.start',{});
  await h.run('classic.SessionStart',{session_id:'session'},async(e:any)=>e);
  const started=h.calls.findIndex(c=>c.operation==='context-start'),registers=h.calls.filter((c,i)=>c.operation==='register'&&i>started);
                                              
  assert.ok(registers.length>=1);const sent=registers.at(-1);
  assert.deepEqual({bash:sent.nativeDecision.bash,rule:sent.nativeDecision.rule},{bash:'allow',rule:undefined});assert.equal(sent.nativePermission.mode,'unknown');assert.equal(sent.nativeInbound.policy,'accept');
  assert.ok(h.checks.length>=1);assert.ok(h.checks.every((c:any)=>c.tool==='Bash'&&/^nxbridge-permission-probe/.test(c.input.command)));
                                   
  h.response('tool-check' as any,{decision:'ask'});
  await h.run('classic.UserPromptSubmit',{session_id:'session',permission_mode:'default'},async(e:any)=>e);
  const after=h.calls.filter((c,i)=>c.operation==='register'&&i>started);assert.equal(after.length,registers.length+1);assert.equal(after.at(-1).nativeDecision.bash,'ask');
  await h.run('classic.PreToolUse',{session_id:'session',permission_mode:'default'},async(e:any)=>e);assert.equal(h.calls.filter((c,i)=>c.operation==='register'&&i>started).length,after.length);
});

test('Mod 来源核对失败时 AskUserQuestion 走原生，并把各阶段诊断（不含正文）随登记报给后台',async()=>{
  const h=await harness(),id='9999-abcd',text='[nxbridge message_id='+id+']机密正文';await h.run('session.start',{});
  h.error('origin',{code:'unknown_turn_source',message:'不是本会话的任务'});
  await h.run('prompt.submit',{origin:{kind:'peer'},text});await h.run('session.append',{origin:{kind:'peer'},uuid:'row'},async()=>({uuid:'row',message:{role:'user',content:[{type:'text',text}]}}));await h.run('turn.start',{turnId:'turn'});
  let native=0;await h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'call'},async()=>{native++;return{result:{answers:{问题:'用户'}}};});
  assert.equal(native,1);assert.ok(!h.calls.some(c=>c.operation==='create'));
  const report=h.calls.filter(c=>c.operation==='register'&&c.question_diagnostics).at(-1);assert.ok(report,'没有上报诊断');
  const phases=report.question_diagnostics.map((d:any)=>d.p);
  assert.ok(phases.includes('submit')&&phases.includes('start')&&phases.at(-1)==='ask');
  assert.ok(report.question_diagnostics.some((d:any)=>d.p==='append'&&d.r==='origin_error'&&d.code==='unknown_turn_source'&&d.id===id));
  assert.ok(!JSON.stringify(report.question_diagnostics).includes('机密正文'));
});

test('Mod 主动登记事实后，问答入口发给后台的上下文仍只含协议字段（严格校验不报错）',async()=>{
  const {modContextSchema}=await import('../integration/mod/mod-protocol.js');const {z}=await import('zod');
  const h=await harness(),id='7777-abcd',text='[nxbridge message_id='+id+']正文';
  h.response('settings',{flag:{crossSessionInbound:'accept'}});h.response('tool-check' as any,{decision:'allow'});h.response('origin',{body:'正文'});
  await h.run('session.start',{});await h.run('classic.SessionStart',{session_id:'session',permission_mode:'bypassPermissions'},async(e:any)=>e);
  assert.ok(h.calls.some(c=>c.operation==='register'),'启动事实应已主动登记');
  await h.run('prompt.submit',{origin:{kind:'peer'},text});await h.run('session.append',{origin:{kind:'peer'},uuid:'row'},async()=>({uuid:'row',message:{role:'user',content:[{type:'text',text}]}}));
  assert.equal(h.calls.some(c=>c.operation==='origin'),false,'普通搭档来信不启动来源核对进程');
  await h.run('turn.start',{turnId:'source-fields'});
  await h.run('tool.call',{tool:'AskUserQuestion',questions:[],tool_use_id:'source-check'},async()=>({result:{answers:{问题:'用户'}}}));
  const origin=h.calls.find(c=>c.operation==='origin');assert.ok(origin);
  const strict=modContextSchema.extend({operation:z.string(),message_id:z.string()}).strict().safeParse(origin);
  assert.ok(strict.success,JSON.stringify(strict.success?'':strict.error.issues));
  assert.equal(origin.nativeDecision.bash,'allow');assert.equal(origin.nativeInbound.source,'flag');
});

test('Mod 发信遇到选择时先请后台重新核对候选：没有可选窗口就直接返回新建后的发送结果，不弹选择框；主动换绑不走这一步',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('send',{status:'selection_required',selection_id:'stale',expires_at:Date.now()+600000,candidates:[],allowed_actions:['create','cancel']});
  h.response('selection-resolve',{status:'starting',message:'正在启动后台搭档',message_id:'orig-1'});
  const result=await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'任务',tool_use_id:'auto'});
  assert.equal(h.nativeCalls.length,0,'不应弹出选择框');assert.match(result.result.message,/orig-1/);
  assert.deepEqual(h.calls.filter(c=>c.operation==='selection-resolve').map(c=>c.selection_id),['stale']);
  assert.ok(!h.calls.some(c=>c.operation==='selection-commit'));
});

test('Mod 发信、选择核对与提交给宿主进程留足时间（超过后台 120 秒上限），其他调用用默认超时',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('send',{status:'selection_required',selection_id:'s',expires_at:Date.now()+600000,candidates:[],allowed_actions:['create','cancel']});
  h.response('selection-resolve',{status:'starting',message:'启动中',message_id:'m'});
  await h.run('tool.call',{tool:'SendMessage',to:'nxbridge:codex',message:'任务',tool_use_id:'t'});
  assert.equal(h.timeouts.get('send'),135000);assert.equal(h.timeouts.get('selection-resolve'),135000);assert.equal(h.timeouts.get('context-start'),undefined);
});

test('Mod 协作提醒查询带上根会话上下文用量和最近一次确认的压缩；读不到用量时不猜',async()=>{
  const h=await harness();await h.run('session.start',{});
  await h.run('turn.start',{turnId:'t1'});
  const tick=async(id:string)=>{await h.run('tool.call',{tool:'Read',tool_use_id:id},async()=>({result:'ok'}));};
  await tick('a');
                    
  const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
  try{
    h.response('session-usage' as any,{context:{tokens:612345,window:1000000,percent:61}});offset+=61000;await tick('b');
    let sync=h.calls.filter(c=>c.operation==='tip-sync').at(-1);assert.ok(sync);assert.equal(sync.usage.tokens,612345);assert.ok(sync.usage.observedAt>0);assert.equal(sync.compaction,undefined);
    await h.run('session.compact',{trigger:'auto'},async()=>({messages:[]}));
    h.response('session-usage' as any,{context:{window:1000000}});offset+=61000;await tick('c');
    sync=h.calls.filter(c=>c.operation==='tip-sync').at(-1);assert.equal(sync.usage,undefined,'压缩后到下一次响应前没有用量');assert.ok(sync.compaction?.id);
    const first=sync.compaction.id;h.response('session-usage' as any,new Error('boom'));offset+=61000;await tick('d');
    sync=h.calls.filter(c=>c.operation==='tip-sync').at(-1);assert.equal(sync.usage,undefined);assert.equal(sync.compaction.id,first);
    await h.run('session.compact',{trigger:'auto',agentId:'child'},async()=>({messages:[]}));offset+=61000;await tick('e');
    assert.equal(h.calls.filter(c=>c.operation==='tip-sync').at(-1).compaction.id,first,'子代理压缩不算');
  }finally{Date.now=realNow;}
});

test('Mod 运行时通知遇到数据库繁忙且能证明尚未提交：静默重试，最多 4 次才提示；通知消失后提示清除，结果不明仍说未确认',async()=>{
  const h=await harness();await h.run('session.start',{});
  const busy={code:'storage_busy',uncertain:false,phase:'prepare',message:'database is locked'};
  h.response('monitor',{notices:[{id:'busy-1',wake:false}]});h.error('monitor-prepare',busy);
  const noticeStatus=()=>h.statuses.filter(s=>/运行时通知/.test(s??'')).at(-1);
                                             
  let n=0;const cycle=async()=>{await h.tick();await h.run('tool.call',{tool:'Bash',tool_use_id:'b'+(n++)},async()=>({result:{}}));};
  for(let i=0;i<3;i++){await cycle();assert.equal(noticeStatus(),undefined,'重试期间不提示');}
  assert.equal(h.calls.filter(c=>c.operation==='monitor-prepare').length,3,'每次边界都重新尝试');
  await cycle();assert.match(noticeStatus()!,/运行时通知暂未送达：数据库繁忙（会自动重试）/);
                                     
  const tried=h.calls.filter(c=>c.operation==='monitor-prepare').length;await cycle();assert.equal(h.calls.filter(c=>c.operation==='monitor-prepare').length,tried);
  const realNow=Date.now;try{Date.now=()=>realNow()+61_000;await cycle();}finally{Date.now=realNow;}
  assert.equal(h.calls.filter(c=>c.operation==='monitor-prepare').length,tried+1,'过了退避间隔继续重试');
  h.response('monitor',{notices:[]});h.error('monitor-prepare',undefined);await h.tick();
  const latest=h.statuses.at(-1)??'';assert.doesNotMatch(latest,/运行时通知/,'通知已不在待处理列表，提示清除');
                       
  h.response('monitor',{notices:[{id:'uncertain-1',wake:false}]});h.error('monitor-prepare',{code:'storage_busy',uncertain:true,phase:'submit',message:'locked'});
  await cycle();assert.match(noticeStatus()!,/运行时通知未确认/);const prepared=h.calls.filter(c=>c.operation==='monitor-prepare').length;
  await cycle();assert.equal(h.calls.filter(c=>c.operation==='monitor-prepare').length,prepared,'结果不明不重试');
});

test('Mod 唤醒入队在提交前遇到数据库繁忙：释放租约，下次监测重新入队',async()=>{
  const h=await harness({deferPrompts:true});await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'wake-busy',wake:true}]});h.error('monitor-enqueue',{code:'storage_busy',uncertain:false,phase:'enqueue',message:'database is locked'});
  await h.tick();await h.tick();
  assert.equal(h.calls.filter(c=>c.operation==='monitor-enqueue').length,2,'第二次监测重新入队');
  assert.ok(!h.statuses.some(s=>/运行时通知/.test(s??'')),'重试期间不提示');
});

test('Mod 运行时通知：其他能证明尚未提交的失败也静默重试；另一条通知送达不清除本条的提示',async()=>{
  const h=await harness();await h.run('session.start',{});
  h.response('monitor',{notices:[{id:'timeout-1',wake:false},{id:'ok-1',wake:false}]});
  h.error('monitor-prepare',{code:'inbox_timeout',uncertain:false,phase:'enqueue',message:'写入前超时'});
  const noticeStatus=()=>h.statuses.filter(s=>/运行时通知/.test(s??'')).at(-1);
  let n=0;const cycle=async()=>{await h.tick();await h.run('tool.call',{tool:'Bash',tool_use_id:'b'+(n++)},async()=>({result:{}}));};
  for(let i=0;i<3;i++)await cycle();assert.equal(noticeStatus(),undefined);
  await cycle();assert.match(noticeStatus()!,/运行时通知暂未送达：写入前超时（会自动重试）/);
  assert.ok(!h.statuses.some(s=>/未确认/.test(s??'')),'能证明尚未提交的不说未确认');
});

test('Mod 状态栏：读不到 Codex 最新一步时只说进度暂时无法观测，不说没有进展',async()=>{
  const h=await harness();await h.run('session.start',{});
  const status=(health:any)=>({paired:true,self:{state:'ready'},partner:{state:'busy',health},integrationIssues:[]});
  h.response('status',status({state:'silent',turnId:'t',lastProgressAt:1,tools:[]}));await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 长时间没有进展，原因未知（运行 nxbridge status 查看）');
  h.response('status',status({state:'silent',turnId:'t',lastProgressAt:1,tools:[],progressEvidence:false}));await h.tick();
  assert.equal(h.statuses.at(-1),'Codex 的进度暂时无法观测，不代表卡住（运行 nxbridge status 查看）');
});
