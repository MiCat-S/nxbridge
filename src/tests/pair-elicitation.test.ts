import test from 'node:test';
import assert from 'node:assert/strict';
import { elicitPartner } from '../broker/pairing/pair-elicitation.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';

for(const action of ['cancel','decline','invalid','error','unsupported'] as const)test('未呈现的原生配对表单保留草稿并转对话确认：'+action,async t=>{
  const f=fixture(t,{compatibilityWake:'strict'}),actor={host:'codex' as const,sessionId:f.x.sessionId!,callId:'auto-'+action};
  const initial=await f.broker.dispatch('send',{actor,message:'保留此草稿'}) as any,calls:string[]=[];
  const server={getClientCapabilities:()=>action==='unsupported'?{}:{elicitation:{form:{}}},elicitInput:async()=>{if(action==='error')throw Error('host unavailable');return action==='invalid'?{action:'accept' as const,content:{choice:'unknown'}}:{action:action==='cancel'?'cancel' as const:'decline' as const};}};
  const result=await elicitPartner(server,initial,async(method,params)=>{calls.push(method);return f.broker.dispatch(method,{actor,...params});}) as any;
  assert.equal(result.status,'pick_in_chat');assert.equal(result.selection_id,initial.selection_id);assert.equal(calls.includes('pair.selection.commit'),false);assert.equal(f.store.pairs().length,0);assert.equal(f.store.messages().length,0);
  const choice=result.candidates[0];const committed=await f.broker.dispatch('pair.selection.commit',{actor,selection_id:result.selection_id,key:choice.key}) as any;
  assert.equal(f.store.message(committed.message_id).body,'保留此草稿');assert.equal(f.store.messages().length,1);
});

test('明确接受暂不配对选项才取消草稿',async t=>{
  const f=fixture(t,{compatibilityWake:'strict'}),actor={host:'codex' as const,sessionId:f.x.sessionId!,callId:'cancel-choice'},initial=await f.broker.dispatch('send',{actor,message:'明确取消'}) as any;
  const result=await elicitPartner({getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:async()=>({action:'accept' as const,content:{choice:'cancel'}})},initial,(method,params)=>f.broker.dispatch(method,{actor,...params})) as any;
  assert.equal(result.status,'selection_declined');assert.equal(f.store.messages().length,0);
});

test('多个窗口原生表单只选类别，保留草稿等待用户在对话中明确选定',async t=>{
  const f=fixture(t,{compatibilityWake:'strict'}),next=f.store.register(registration('codex','second-window'));
  const actor={host:'claude' as const,sessionId:f.c.sessionId!,callId:'category-picker'},intent={actor,message:'待用户选窗口的正文'};
  const initial=await f.broker.dispatch('send',intent) as any,calls:string[]=[];
  const server={getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:async(request:any)=>{
    const choices=request.requestedSchema.properties.choice.oneOf;
    assert.ok(choices.some((value:any)=>value.const==='existing'));assert.ok(choices.length<=4);
    assert.ok(initial.candidates.every((candidate:any)=>!choices.some((value:any)=>value.const===candidate.key)));
    return{action:'accept' as const,content:{choice:'existing'}};
  }};
  const view=await elicitPartner(server,initial,async(method,params)=>{calls.push(method);return f.broker.dispatch(method,{actor,...params});}) as any;
  assert.equal(view.status,'pick_in_chat');assert.equal(view.selection_id,initial.selection_id);assert.equal(view.candidates.length,2);
  assert.deepEqual(calls,['pair.selection.resolve','pair.selection.get']);assert.equal(f.store.pairs().length,0);assert.equal(f.store.messages().length,0);
  const selected=view.candidates.find((candidate:any)=>candidate.member_id===next.id),choice={actor,selection_id:view.selection_id,key:selected.key};
  const receipt=await f.broker.dispatch('pair.selection.commit',choice) as any;
  assert.equal(f.store.message(receipt.message_id).body,intent.message);assert.equal(f.store.message(receipt.message_id).to,next.id);
  assert.deepEqual(await f.broker.dispatch('pair.selection.commit',choice),receipt);assert.equal(f.store.messages().length,1);
});

test('已配对时类别表单保留当前搭档标题、解除和保持；单候选直接提交用户选择',async t=>{
  const f=fixture(t,{compatibilityWake:'strict'}),old=f.store.pair(f.c.id,f.x.id),next=f.store.register(registration('codex','replacement'));
  const actor={host:'claude' as const,sessionId:f.c.sessionId!,callId:'change-category'},initial=await f.broker.dispatch('pair.code',{actor}) as any;
  const result=await elicitPartner({getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:async(request:any)=>{
    assert.ok(request.message.includes(f.x.name));const choices=request.requestedSchema.properties.choice.oneOf;
    assert.ok(choices.some((value:any)=>value.const==='unpair'));assert.ok(choices.some((value:any)=>value.const==='cancel'));
    assert.equal(f.store.pairFor(f.c.id)?.id,old.id);return{action:'accept' as const,content:{choice:initial.candidates[0].key}};
  }},initial,async(method,params)=>f.broker.dispatch(method,{actor,...params})) as any;
  assert.equal(result.status,'paired');assert.equal(result.partner_name,next.name);assert.equal(f.store.pairFor(f.c.id)?.codex,next.id);
  assert.equal(f.store.pairFor(f.x.id),undefined);assert.equal(f.store.messages().length,0);
});

for(const mode of ['previous','merged','single'] as const)test('历史后台选择保持类别规则和四项上限：'+mode,async()=>{
  const previous=[{key:'old-a',member_id:'old-a',owner:'nxbridge',former_partner:true,label:'之前甲',description:'原项目'},{key:'old-b',member_id:'old-b',owner:'nxbridge',former_partner:true,label:'之前乙',description:'原项目'}];
  const candidates=mode==='single'?previous.slice(0,1):mode==='merged'?[{key:'live',member_id:'live',owner:'user',label:'运行窗口'},...previous]:previous;
  const view={status:'selection_required',selection_id:'history-form',host:'claude',expires_at:Date.now()+60000,candidates,allowed_actions:mode==='merged'?['choose','create','unpair','cancel']:['choose','create','cancel'],...(mode==='merged'?{mode:'change',current_partner:{name:'当前'}}:{})},calls:{method:string;params:any}[]=[];
  const result=await elicitPartner({getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:async(request:any)=>{
    const choices=request.requestedSchema.properties.choice.oneOf;assert.ok(choices.length<=4);
    const option=choices.find((value:any)=>value.const===(mode==='merged'?'existing_or_previous':mode==='single'?'old-a':'previous'));
    assert.ok(option);assert.match(option.title,/之前的后台/);
    if(mode!=='single')assert.ok(!choices.some((value:any)=>value.const==='old-a'));
    return{action:'accept',content:{choice:option.const}};
  }},view,async(method,params)=>{calls.push({method,params});return method==='pair.selection.commit'?{status:'paired'}:method==='pair.selection.get'?{status:'pending'}:view;}) as any;
  if(mode==='single')assert.equal(calls.at(-1)?.params.key,'old-a');
  else{assert.equal(result.status,'pick_in_chat');assert.deepEqual(result.candidates,candidates);assert.ok(!calls.some(value=>value.method==='pair.selection.commit'));}
});
