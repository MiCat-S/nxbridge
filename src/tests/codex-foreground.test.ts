import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../storage/store.js';
import { CodexForegroundWindows } from '../hosts/codex/codex-foreground.js';

test('窗口记录跨实例保留，未知代次不关闭，已退出代次按独立会话清理',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const ended:string[]=[],states=new Map<number,'alive'|'dead'|'unknown'>([[1,'unknown'],[2,'alive']]);
  const create=()=>new CodexForegroundWindows(store,async window=>{ended.push(window.sessionId!);},async records=>records.map(record=>states.get(record.pid)!));
  let windows=create();windows.register({endpoint:'shared',sessionId:'first',foreground:{pid:1,procStart:'one'}});windows.register({endpoint:'shared',sessionId:'second',foreground:{pid:2,procStart:'two'}});
  windows=create();await windows.sweep();assert.deepEqual(ended,[]);states.set(1,'dead');await windows.sweep();assert.deepEqual(ended,['first']);
  await windows.sweep();assert.deepEqual(ended,['first']);assert.equal(store.setting<any[]>('codexForegroundWindows')?.length,1);
});

for(const state of ['alive','unknown'] as const)test('同 UUID 的其他窗口代次为 '+state+' 时不设置退出屏障',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());let sibling:'alive'|'dead'|'unknown'=state,ended=0;
  const windows=new CodexForegroundWindows(store,async()=>{ended++;},async records=>records.map(record=>record.pid===1?'dead':sibling));
  windows.register({endpoint:'shared',sessionId:'same',foreground:{pid:1,procStart:'one'}});windows.register({endpoint:'shared',sessionId:'same',foreground:{pid:2,procStart:'two'}});
  await windows.sweep();assert.equal(ended,0);sibling='dead';await windows.sweep();assert.ok(ended>0);assert.deepEqual(store.setting('codexForegroundWindows'),[]);
});
