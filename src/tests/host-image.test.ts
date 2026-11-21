import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { temporaryAlias } from './support/temporary.js';
import { relaunchHostImage, updatedHostEntry } from '../hosts/host-image.js';

test('原安装自更新后只追随同渠道稳定入口，不借用 PATH、其他安装或越界链接',t=>{
  const root=temporaryAlias(t),old=path.join(root,'Cellar','codex','0.164.0','bin','codex'),current=path.join(root,'Cellar','codex','0.166.0'),opt=path.join(root,'opt');mkdirSync(path.join(current,'bin'),{recursive:true});mkdirSync(opt);writeFileSync(path.join(current,'bin','codex'),'原生入口','utf8');symlinkSync(current,path.join(opt,'codex'),process.platform==='win32'?'junction':'dir');
  assert.equal(updatedHostEntry(old,'codex'),path.join(opt,'codex','bin','codex'));assert.equal(relaunchHostImage(old,'codex','darwin'),path.join(opt,'codex','bin','codex'));assert.equal(updatedHostEntry(old,'claude'),undefined);
  const other=path.join(root,'Caskroom','codex','0.164.0','codex-aarch64-apple-darwin'),bin=path.join(root,'bin');mkdirSync(bin);symlinkSync(path.join(current,'bin','codex'),path.join(bin,'codex'));assert.equal(updatedHostEntry(other,'codex'),undefined);
});

test('Claude 官方原生版本目录接续自身入口，任意自定义版本目录不猜测',t=>{
  const root=temporaryAlias(t),versions=path.join(root,'.local','share','claude','versions'),bin=path.join(root,'.local','bin');mkdirSync(versions,{recursive:true});mkdirSync(bin);const current=path.join(versions,'2.1.34');writeFileSync(current,'原生入口','utf8');symlinkSync(current,path.join(bin,'claude'));
  assert.equal(updatedHostEntry(path.join(versions,'2.1.30'),'claude'),path.join(bin,'claude'));assert.equal(updatedHostEntry(path.join(root,'custom','2.1.30'),'claude'),undefined);
  assert.equal(relaunchHostImage('C:\\tools\\codex.exe.old.123','codex','win32'),'C:\\tools\\codex.exe');
});

test('daemon 接续自身 current，VS Code 只认正式安装清单',t=>{
  const root=temporaryAlias(t),daemon=path.join(root,'packages','app-server-daemon'),release=path.join(daemon,'releases','0.168.0','bin');mkdirSync(release,{recursive:true});writeFileSync(path.join(release,'codex'),'入口','utf8');symlinkSync(path.dirname(release),path.join(daemon,'current'),process.platform==='win32'?'junction':'dir');
  assert.equal(updatedHostEntry(path.join(daemon,'releases','0.167.1','bin','codex'),'codex'),path.join(daemon,'current','bin','codex'));
  const extensions=path.join(root,'extensions'),active=path.join(extensions,'openai.chatgpt-2.0','bin');mkdirSync(active,{recursive:true});writeFileSync(path.join(active,'codex'),'入口','utf8');
  const old=path.join(extensions,'openai.chatgpt-1.0','bin','codex');assert.equal(updatedHostEntry(old,'codex'),undefined);
  const activate=(relativeLocation:string)=>writeFileSync(path.join(extensions,'extensions.json'),JSON.stringify([{identifier:{id:'openai.chatgpt'},relativeLocation}]),'utf8');
  activate('openai.chatgpt-2.0');assert.equal(updatedHostEntry(old,'codex'),path.join(active,'codex'));
  const foreign=path.join(path.dirname(root),'foreign','openai.chatgpt-3.0','bin');mkdirSync(foreign,{recursive:true});writeFileSync(path.join(foreign,'codex'),'其他安装','utf8');
  symlinkSync(path.dirname(foreign),path.join(extensions,'openai.chatgpt-3.0'),process.platform==='win32'?'junction':'dir');
  activate('openai.chatgpt-3.0');assert.equal(updatedHostEntry(old,'codex'),undefined,'正式清单不能让入口越出原安装渠道');
});
