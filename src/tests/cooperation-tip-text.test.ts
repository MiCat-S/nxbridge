import test from 'node:test';
import assert from 'node:assert/strict';
import { cooperationTipText } from '../broker/delivery/cooperation-tip-text.js';

const base={unpaired:false,elapsedMinutes:20,intervalMinutes:20};
const words=(text:string)=>text.split(/\s+/).length;

test('协作提醒只写关键原因和可做的事，允许独自完成，不断言忘了协作，不带数字明细',()=>{
  const first=cooperationTipText({...base,partnerIdleMinutes:18,silence:{ordinal:1}});
  assert.equal(first,"nxbridge tip: partner idle 18m, no contact 20m; recheck split per nxbridge routing + any extra user rules: hand off partner-fit work or brief sync; solo ok if right");
  assert.doesNotMatch(first,/forg[eo]t/i);assert.ok(words(first)<=30,first);
});

test('重复提醒注明次数，第 3 次说明是本段最后一次',()=>{
  assert.match(cooperationTipText({...base,silence:{ordinal:2}}),/tip 2\/3: recheck split/);
  assert.match(cooperationTipText({...base,silence:{ordinal:3}}),/tip 3\/3, last this stretch: recheck split/);
});

test('未配对、长上下文、欠回复与对方空闲可以合成一条，编号最多列 3 条，上下文不写数字',()=>{
  assert.match(cooperationTipText({...base,unpaired:true,silence:{ordinal:1}}),/^nxbridge tip: no partner yet, solo 20m; first partner msg pairs on demand; recheck split/);
  const context=cooperationTipText({...base,context:{tokens:612345,threshold:600000}});
  assert.match(context,/no contact 20m, long context; recheck pending partner tasks \+ CURRENT; recheck split/);assert.doesNotMatch(context,/\d+k/);
  const owed=cooperationTipText({...base,owedMessageIds:['a','b','c','d','e']});
  assert.match(owed,/partner msgs since your last send: a, b, c \+2 more -> reply\/brief update if needed/);
  assert.doesNotMatch(owed,/recheck split/,'只欠回复时不额外要求重新分工');
  const idle=cooperationTipText({...base,partnerIdleMinutes:5,idleMessageIds:['m1']});
  assert.match(idle,/expected reply still pending: m1 -> check if it still blocks you/);
  const combined=cooperationTipText({...base,partnerIdleMinutes:12,silence:{ordinal:2},context:{tokens:400100,threshold:400000},idleMessageIds:['m1']});
  assert.equal((combined.match(/nxbridge tip:/g)??[]).length,1);assert.ok(words(combined)<=55,combined);
});
