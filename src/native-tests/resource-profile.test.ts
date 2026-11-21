import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {windowsPowerShell} from '../shared/windows-tools.js';

                                           
const preload=`import cp from 'node:child_process';import{channel}from'node:diagnostics_channel';import{syncBuiltinESMExports}from'node:module';import{appendFileSync}from'node:fs';import path from'node:path';
const root=process.env.NXBRIDGE_PROFILE_DIR,file=path.join(root,process.pid+'.jsonl'),record=value=>appendFileSync(file,JSON.stringify({...value,pid:process.pid,at:Date.now()})+'\\n');
record({type:'boot',parent:process.ppid,args:process.argv});
channel('child_process').subscribe(event=>record({type:'spawn',method:'async',child:event.process.pid,command:event.process.spawnfile}));
for(const name of ['spawnSync','execFileSync','execSync']){const original=cp[name];cp[name]=function(...args){record({type:'spawn',method:name,command:String(args[0])});return Reflect.apply(original,this,args);};}syncBuiltinESMExports();`;

for(const count of [0,1,12])test('隔离资源测量：'+count+' 个协议前端，前后各空闲 60 秒',{skip:!process.env.NXBRIDGE_PROFILE_BASELINE||!['win32','linux'].includes(process.platform),timeout:170000},async t=>{
  const temp=temporaryDirectory(),results:any[]=[];t.after(temp.cleanup);
  const versions:[string,string][]=[['baseline',process.env.NXBRIDGE_PROFILE_BASELINE!],['candidate',path.join(PACKAGE_ROOT,'publish')]];
  for(const [label,publish] of versions){
    const root=path.join(temp.directory,label),home=path.join(root,'bridge'),metrics=path.join(root,'metrics'),plugin=path.join(root,'plugin');
    for(const d of [root,home,metrics,plugin])mkdirSync(d,{recursive:true});
    const entry=path.join(publish,'nxbridge.mjs'),probe=path.join(root,'profile.mjs');writeFileSync(probe,preload,'utf8');
    writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',codexHome:path.join(root,'codex'),claudeHome:path.join(root,'claude')}),'utf8');
    writeFileSync(path.join(plugin,'bridge.cjs'),readFileSync(path.join(publish,'plugins/codex/bridge.cjs')));
    writeFileSync(path.join(plugin,'runtime.json'),JSON.stringify({node:process.execPath,entry,home}),'utf8');
    const env={...process.env,NXBRIDGE_HOME:home,CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),NXBRIDGE_PROFILE_DIR:metrics,NODE_OPTIONS:'--import '+JSON.stringify(pathToFileURL(probe).href)};
    const children:{child:ChildProcess;closed:Promise<void>}[]=[],errors:string[]=[];
    const launch=(args:string[])=>{const child=spawn(process.execPath,args,{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr!.on('data',c=>errors.push(String(c)));const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));children.push({child,closed});return child;};
    const finish=async()=>{for(const {child}of children.slice(1))child.stdin?.end();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}
      await Promise.all(children.map(async({child,closed})=>{let timer:NodeJS.Timeout|undefined;try{await Promise.race([closed,new Promise<void>(resolve=>{timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();resolve();},5000);})]);await closed;}finally{clearTimeout(timer);}}));};
    try{
      launch([entry,'service']);let ready=false;for(let i=0;i<100;i++){try{await brokerCall('ping',{}, {home,start:false,timeout:1000});ready=true;break;}catch{await delay(100);}}
      assert.ok(ready,errors.join(''));
      const frontends=await Promise.all(Array.from({length:count},async()=>{const child=launch([path.join(plugin,'bridge.cjs'),'mcp','--host','claude']);let output='';child.stdout!.on('data',c=>output+=c);child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-resource-profile',version:'1'}}})+'\n');
        for(let i=0;i<150&&!output.includes('"id":1');i++)await delay(100);assert.ok(output.includes('"id":1'),errors.join(''));child.stdin!.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return child;}));
      await delay(3000);
      const rows=()=>readdirSync(metrics).filter(f=>f.endsWith('.jsonl')).flatMap(f=>readFileSync(path.join(metrics,f),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)));
      const beforeRows=rows(),pids=beforeRows.filter(r=>r.type==='boot').map(r=>r.pid);assert.equal(new Set(pids).size,pids.length);
      const ticks=process.platform==='linux'?Number((await promisify(execFile)('getconf',['CLK_TCK'])).stdout):0;
      const snapshot=async():Promise<any[]>=>{
        if(process.platform==='win32'){
          const script='$rows=@(); foreach($profileId in @('+pids.join(',')+')){ $p=Get-Process -Id $profileId -ErrorAction Stop; $rows+=@{pid=$p.Id;generation=$p.StartTime.ToFileTimeUtc().ToString();privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds} }; ConvertTo-Json -InputObject @($rows) -Compress';
          return JSON.parse((await promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000})).stdout);
        }
        return pids.map(pid=>{const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/),status=readFileSync('/proc/'+pid+'/smaps_rollup','utf8'),kb=(key:string)=>Number(new RegExp('^'+key+':\\s+(\\d+)','m').exec(status)?.[1]??0)*1024;
          return{pid,generation:fields[19],privateBytes:kb('Private_Clean')+kb('Private_Dirty'),workingSetBytes:kb('Rss'),pssBytes:kb('Pss'),cpuMs:(Number(fields[11])+Number(fields[12]))*1000/ticks};});
      };
      const osBefore=await snapshot(),start=Date.now();await delay(60000);const osAfter=await snapshot(),afterRows=rows();
      for(const row of osBefore)assert.equal(osAfter.find(r=>r.pid===row.pid)?.generation,row.generation,'测量期间不能替换代次');
      const result={label,count,build:JSON.parse(readFileSync(path.join(publish,'publish.json'),'utf8')).buildId,processes:pids.length,elapsedMs:Date.now()-start,cpuMs:osAfter.reduce((s,r)=>s+r.cpuMs-osBefore.find(v=>v.pid===r.pid)!.cpuMs,0),privateBytes:osAfter.reduce((s,r)=>s+r.privateBytes,0),workingSetBytes:osAfter.reduce((s,r)=>s+r.workingSetBytes,0),pssBytes:process.platform==='linux'?osAfter.reduce((s,r)=>s+r.pssBytes,0):undefined,startupSpawnRequests:beforeRows.filter(r=>r.type==='spawn').length,idleSpawnRequests:afterRows.filter(r=>r.type==='spawn'&&r.at>=start).length,scope:'broker + protocol-only frontends; no native model hosts; external OS counters, no per-process measurement timer; Node async diagnostic channel and sync creation requests',frontends:frontends.length};
      results.push(result);t.diagnostic(JSON.stringify(result));
    }finally{await finish();}
  }
  assert.equal(results.length,2);assert.ok(results[1].processes<=results[0].processes);
});
