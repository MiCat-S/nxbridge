import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { temporary } from './support/temporary.js';
import { claudeLaunchArgs } from '../broker/profiles/profile-arguments.js';
import { ownedClaudeArgs } from '../hosts/owned-launch-policy.js';

test('自定义 JSON 设置与后台参数只形成一层，模型覆盖但其他用户设置不丢失',()=>{
  const user={env:{CUSTOM:'保留'},permissions:{allow:['Read']},hooks:{Stop:[{hooks:[]}]},model:'旧模型'};
  const argv=claudeLaunchArgs(['wrapper.js','--settings',JSON.stringify(user)],['--bg',...ownedClaudeArgs('prompting',{model:'chosen',effort:'high'})],process.cwd());
  assert.equal(argv.filter(value=>value==='--settings').length,1);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings')+1]!),{...user,model:'chosen',effortLevel:'high',crossSessionInbound:'accept'});
  assert.equal(argv[0],'wrapper.js');assert.ok(argv.includes('--bg'));
});

test('自定义设置支持相对 JSON 文件和等号参数，文件保持原样',t=>{
  const home=temporary(t),filename=path.join(home,'用户设置.json'),content='\uFEFF'+JSON.stringify({env:{CUSTOM:'保留'},effortLevel:'low'});writeFileSync(filename,content,'utf8');
  const argv=claudeLaunchArgs(['--settings=用户设置.json'],['--resume','session','--settings',JSON.stringify({model:'pinned',effortLevel:'medium'})],home);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings')+1]!),{env:{CUSTOM:'保留'},model:'pinned',effortLevel:'medium'});
  assert.deepEqual(argv.slice(0,2),['--resume','session']);
  assert.equal(readFileSync(filename,'utf8'),content);
  writeFileSync(filename,' \n','utf8');assert.deepEqual(JSON.parse(claudeLaunchArgs(['--settings',filename],['--settings','{"model":"chosen"}'],home).at(-1)!),{model:'chosen'});
});

test('未附加设置时不解析用户设置，也不解析 -- 后的普通参数',()=>{
  assert.deepEqual(claudeLaunchArgs(['--settings','不存在.json'],['--version'],process.cwd()),['--settings','不存在.json','--version']);
  assert.deepEqual(claudeLaunchArgs(['--settings','{}'],['--','--settings','正文'],process.cwd()),['--settings','{}','--','--settings','正文']);
});

test('损坏或非对象的自定义设置拒绝合并，不静默丢失用户设置',()=>{
  for(const settings of ['不存在.json','{损坏}'])assert.throws(()=>claudeLaunchArgs(['--settings',settings],['--settings','{"model":"chosen"}'],process.cwd()),{code:'invalid_config'});
});
