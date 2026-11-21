import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { temporary } from './support/temporary.js';
import { desktopHostImages, relaunchHostImage, updatedHostEntry, verifyHostImage } from '../hosts/host-image.js';
import type { Host } from '../types.js';

function macImage(root:string,version:string,hash:string):string{return path.join(root,'Library','Application Support','Claude','claude-code',version,hash,'claude.app','Contents','MacOS','claude');}
function winImage(root:string,version:string):string{return path.join(root,'AppData','Roaming','Claude','claude-code',version,'claude.exe');}
function mach(cpu=0x0100000c):Buffer{
  const header=Buffer.alloc(32);header.writeUInt32LE(0xfeedfacf,0);header.writeUInt32LE(cpu,4);header.writeUInt32LE(2,12);return header;
}
function pe(cpu=0x8664):Buffer{
  const header=Buffer.alloc(128);header.writeUInt16LE(0x5a4d,0);header.writeUInt32LE(64,60);header.writeUInt32LE(0x4550,64);header.writeUInt16LE(cpu,68);header.writeUInt16LE(2,86);return header;
}
function universal(cpus:number[],wide=false,little=false):Buffer{
  const bytes=Buffer.alloc(512),integer=(value:number,offset:number)=>little?bytes.writeUInt32LE(value,offset):bytes.writeUInt32BE(value,offset);
  bytes.writeUInt32BE(wide?(little?0xbfbafeca:0xcafebabf):(little?0xbebafeca:0xcafebabe),0);integer(cpus.length,4);
  cpus.forEach((cpu,index)=>{
    const position=8+index*(wide?32:20),offset=128+index*64;integer(cpu,position);
    if(wide){if(little)bytes.writeBigUInt64LE(BigInt(offset),position+8);else bytes.writeBigUInt64BE(BigInt(offset),position+8);}
    else integer(offset,position+8);
    mach(cpu).copy(bytes,offset);
  });return bytes;
}
function image(file:string,bytes:Buffer):string{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,bytes);chmodSync(file,0o755);return file;}
function verified(file:string):void{writeFileSync(path.join(path.dirname(file),'.verified'),'宿主验证标记','utf8');}
function selected(image:string,host:Host='claude'){
  const candidates=desktopHostImages(image,host);return candidates?{version:candidates.version,images:candidates.images}:undefined;
}
function verify(image:string,probe:(image:string)=>Promise<string>){return verifyHostImage(desktopHostImages(image,'claude')!,probe);}

test('Windows Desktop 只选择同根目录内已完成验证的最新原生入口',async t=>{
  const root=temporary(t),old=winImage(root,'2.1.30'),current=image(winImage(root,'2.1.31'),pe());verified(current);
  image(winImage(root,'2.1.32'),pe());
  image(winImage(root,'2.1.33'),Buffer.from('下载未完成'));
  const directory=path.dirname(winImage(root,'2.1.34'));mkdirSync(path.join(directory,'claude.exe'),{recursive:true});writeFileSync(path.join(directory,'.verified'),'完成','utf8');
  assert.deepEqual(selected(old),{version:'2.1.31',images:[current]});
  assert.equal(updatedHostEntry(old,'claude'),current);assert.equal(relaunchHostImage(old,'claude','win32'),current);
  const calls:string[]=[];
  assert.deepEqual(await verify(old,async file=>{calls.push(file);return'2.1.31 (Claude Code)\r\n';}),{image:current,version:'2.1.31'});
  assert.deepEqual(calls,[current]);assert.equal(desktopHostImages(old,'codex'),undefined);
  assert.equal(desktopHostImages(old.replace('AppData','OtherData'),'claude'),undefined);
});

test('Windows 下载完整性以 Desktop 的完成标记为准，原生头只提供架构信息',async t=>{
  const root=temporary(t),old=winImage(root,'2.1.30'),current=image(winImage(root,'2.1.31'),Buffer.from('由 Desktop 完成验证的内容'));verified(current);
  assert.deepEqual(selected(old),{version:'2.1.31',images:[current]});
  assert.equal(desktopHostImages(old,'claude')?.architecture,undefined);
  assert.deepEqual(await verify(old,async()=> '2.1.31 (Claude Code)'),{image:current,version:'2.1.31'});
});

test('macOS Desktop 可接续已删除的旧 hash 目录，并跳过不完整或外来格式',async t=>{
  const root=temporary(t),old=macImage(root,'2.1.30','91184d3d9ba3'),current=image(macImage(root,'2.1.31','e6736b2d954d'),mach());
  image(macImage(root,'2.1.32','ddbdf2b334e1'),Buffer.alloc(0));
  image(macImage(root,'2.1.33','abcdef'),pe());
  const wrong=path.join(root,'Library','Application Support','Claude','claude-code','2.1.34','claude');image(wrong,mach());verified(wrong);
  assert.deepEqual(selected(old),{version:'2.1.31',images:[current]});
  assert.equal(relaunchHostImage(old,'claude','darwin'),current);
  assert.deepEqual(await verify(old,async()=> '2.1.31 (Claude Code)'),{image:current,version:'2.1.31'});
  assert.equal(updatedHostEntry(wrong,'claude'),undefined);
  assert.equal(updatedHostEntry(macImage(root,'2.1.30','not-a-hash'),'claude'),undefined);
});

test('同版本多个 macOS hash 是正常安装形态，全部核验等价后按固定顺序选取',async t=>{
  const root=temporary(t),old=macImage(root,'2.1.30','91184d3d9ba3'),b=image(macImage(root,'2.1.31','e6736b2d954d'),mach()),a=image(macImage(root,'2.1.31','ddbdf2b334e1'),mach());
  image(macImage(root,'2.1.29','aaa'),mach());
  assert.deepEqual(selected(old),{version:'2.1.31',images:[a,b]});
  const calls:string[]=[];
  const result=await verify(old,async file=>{calls.push(file);return'2.1.31 (Claude Code)';});
  assert.deepEqual(result,{image:a,version:'2.1.31'});assert.deepEqual(calls,[a,b]);
  assert.deepEqual(selected(b),{version:'2.1.31',images:[b,a]});assert.equal(relaunchHostImage(b,'claude','darwin'),b);
  assert.deepEqual(await verify(b,async()=> '2.1.31 (Claude Code)'),{image:b,version:'2.1.31'});
});

test('同版本 hash 的版本冲突、非官方输出或架构冲突都不能猜测取舍',async t=>{
  const root=temporary(t),old=macImage(root,'2.1.30','91184d3d9ba3'),a=image(macImage(root,'2.1.31','aaa'),mach()),b=image(macImage(root,'2.1.31','bbb'),mach());
  const ambiguous={code:'launch_image_ambiguous'};
  for(const output of ['2.1.32 (Claude Code)','2.1.31','codex-cli 2.1.31'])await assert.rejects(verify(old,async file=>file===a?'2.1.31 (Claude Code)':output),ambiguous);
  image(b,mach(0x01000007));let probes=0;
  await assert.rejects(verify(old,async()=>{probes++;return'2.1.31 (Claude Code)';}),ambiguous);assert.equal(probes,0);
  image(b,mach(0x12345678));
  await assert.rejects(verify(old,async()=> '2.1.31 (Claude Code)'),ambiguous);
  image(b,mach());
  await assert.rejects(verify(old,async()=>{throw Object.assign(new Error('暂时不可用'),{code:'ETXTBSY'});}),{code:'launch_probe_unavailable'});
  assert.deepEqual(await verify(old,async()=> '2.1.31 (Claude Code)'),{image:a,version:'2.1.31'});
});

test('Desktop 不穿越同根目录中的链接或退回其他 home、渠道和旧版本',async t=>{
  const root=temporary(t),old=macImage(root,'2.1.31','aaa'),foreign=image(macImage(path.join(root,'other-home'),'2.1.32','bbb'),mach());
  image(macImage(root,'2.1.30','ccc'),mach());
  const escape=path.dirname(path.dirname(path.dirname(path.dirname(macImage(root,'2.1.32','bbb')))));
  mkdirSync(path.dirname(escape),{recursive:true});symlinkSync(path.dirname(path.dirname(path.dirname(path.dirname(foreign)))),escape,process.platform==='win32'?'junction':'dir');
  assert.equal(desktopHostImages(old,'claude'),undefined);assert.equal(relaunchHostImage(old,'claude','darwin'),old);
  const existing=image(old,mach());assert.equal(relaunchHostImage(existing,'claude','darwin'),existing);
  rmSync(escape);const inside=image(macImage(root,'2.1.32','ddd'),mach()),linked=macImage(root,'2.1.32','eee');mkdirSync(path.dirname(linked),{recursive:true});symlinkSync(inside,linked);
  assert.deepEqual(selected(old),{version:'2.1.32',images:[inside]});
  rmSync(inside);assert.equal(desktopHostImages(old,'claude')?.images[0],existing);
  assert.equal(desktopHostImages(path.join(root,'custom','claude'),'claude'),undefined);
});

test('通用 Mach-O 从架构表读取集合，不受切片顺序、位宽和字节序影响',async t=>{
  const root=temporary(t),old=macImage(root,'2.1.30','aaa'),a=image(macImage(root,'2.1.31','bbb'),universal([0x01000007,0x0100000c])),b=macImage(root,'2.1.31','ccc');
  for(const wide of [false,true])for(const little of [false,true]){
    image(b,universal([0x0100000c,0x01000007],wide,little));
    assert.equal(desktopHostImages(old,'claude')?.architecture,'arm64+x64');
    assert.deepEqual(await verify(old,async()=> '2.1.31 (Claude Code)'),{image:a,version:'2.1.31'});
  }
  image(b,mach());await assert.rejects(verify(old,async()=> '2.1.31 (Claude Code)'),{code:'launch_image_ambiguous'});
  const incomplete=universal([0x01000007,0x0100000c]);incomplete.writeUInt32BE(4096,16);image(b,incomplete);
  assert.deepEqual(selected(old),{version:'2.1.31',images:[a,b]});
  await assert.rejects(verify(old,async file=>{if(file===b)throw new Error('原生加载器拒绝不完整文件');return'2.1.31 (Claude Code)';}),{code:'launch_probe_unavailable'});
});

test('一次核验复用固定候选，下次边界读取新候选和架构变化',async t=>{
  const root=temporary(t),old=macImage(root,'2.1.30','aaa'),a=image(macImage(root,'2.1.31','bbb'),mach()),b=image(macImage(root,'2.1.31','ccc'),mach());
  const candidates=desktopHostImages(old,'claude')!;
  assert.deepEqual(await verifyHostImage(candidates,async file=>{
    if(file===b)image(macImage(root,'2.1.31','ddd'),mach());return'2.1.31 (Claude Code)';
  }),{image:a,version:'2.1.31'});
  assert.deepEqual(candidates.images,[a,b]);assert.equal(desktopHostImages(old,'claude')?.images.length,3);
  image(a,mach(0x01000007));
  await assert.rejects(verify(old,async()=> '2.1.31 (Claude Code)'),{code:'launch_image_ambiguous'});
});
