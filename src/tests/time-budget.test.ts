import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerCall, listenBroker } from '../ipc/ipc.js';
import {delay} from '../shared/time.js';
import {ensureHome} from '../ipc/home.js';
import { temporary } from './support/temporary.js';
import { remainingTime } from '../shared/time-budget.js';

test('同一截止点贯穿连接和后续 RPC，先前等待不会重置总预算',async t=>{
  const home=temporary(t);await ensureHome(home);const server=await listenBroker(home,async()=>{await delay(80);return{};});t.after(()=>server.close());
  const deadline=performance.now()+130;await brokerCall('first',{}, {home,start:false,deadline});
  await assert.rejects(brokerCall('second',{}, {home,start:false,deadline}),{code:'timeout'});
  assert.throws(()=>remainingTime(performance.now()-1,2000),{code:'timeout'});
});
