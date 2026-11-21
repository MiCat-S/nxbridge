import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKGROUND_RETRY_DELAY_MS, backgroundRetryContext, deferBackgroundRetry, recordBackgroundState, requireBackgroundRetry } from '../hosts/background-state.js';
import {ensureHome} from '../ipc/home.js';
import { temporary } from './support/temporary.js';

test('失败诊断持久保存，但不同调用进程可立即重试，不继承全局否定缓存',async t=>{
  const home=temporary(t);await ensureHome(home);recordBackgroundState(home,'当前环境无法脱离 Job');
  assert.throws(()=>requireBackgroundRetry(home),{code:'bootstrap_required'});
  const before=readFileSync(path.join(home,'run','background-state.json'));
  const script=`import{requireBackgroundRetry}from${JSON.stringify(new URL('../hosts/background-state.js',import.meta.url).href)};requireBackgroundRetry(process.argv[1]);`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script,home],{windowsHide:true,timeout:10000});
  assert.deepEqual(readFileSync(path.join(home,'run','background-state.json')),before);
});

test('当前进程失败退避三十秒，到期或成功后恢复，纯预检失败不落盘',async t=>{
  const home=temporary(t);await ensureHome(home);let now=100;
  t.mock.method(performance,'now',()=>now);deferBackgroundRetry(home,'探针拒绝');
  assert.equal(existsSync(path.join(home,'run','background-state.json')),false);
  assert.throws(()=>requireBackgroundRetry(home),{code:'bootstrap_required'});requireBackgroundRetry(home,true);
  now+=BACKGROUND_RETRY_DELAY_MS-1;assert.throws(()=>requireBackgroundRetry(home),{code:'bootstrap_required'});
  now++;requireBackgroundRetry(home);
  deferBackgroundRetry(home,'启动失败');recordBackgroundState(home);requireBackgroundRetry(home);
});

test('短命 hook 只共享同一原生宿主代次的短退避，干净终端、其他宿主和后续代次不受影响',async t=>{
  const home=temporary(t);await ensureHome(home);
  const origin=[{pid:1,startedAt:'1',name:'node.exe'},{pid:2,startedAt:'2',name:'codex.exe.old.123'}],context=backgroundRetryContext(origin)!;
  assert.equal(context,'2:2');assert.equal(backgroundRetryContext([{pid:1,startedAt:'1',name:'powershell.exe'}]),undefined);
  recordBackgroundState(home,'受限宿主的失败',context);
  const script=`import{requireBackgroundRetry}from${JSON.stringify(new URL('../hosts/background-state.js',import.meta.url).href)};const home=process.argv[1];let denied=false;try{requireBackgroundRetry(home,false,'2:2');}catch(error){if(error.code!=='bootstrap_required')throw error;denied=true;}if(!denied)throw Error('相同宿主未退避');requireBackgroundRetry(home);requireBackgroundRetry(home,false,'2:3');requireBackgroundRetry(home,false,'3:2');requireBackgroundRetry(home,true,'2:2');`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script,home],{windowsHide:true,timeout:10000});
  let now=Date.now()+BACKGROUND_RETRY_DELAY_MS;t.mock.method(Date,'now',()=>now);t.mock.method(performance,'now',()=>Number.MAX_SAFE_INTEGER);requireBackgroundRetry(home,false,context);
});
