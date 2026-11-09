// 只读采集；不启动宿主、不附加终端，不输出环境正文或配置正文。
import {execFileSync,spawn} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const args=process.argv.slice(2);
const usage='用法：node tools/collect-macos-evidence.mjs --pid PID [--socket SOCKET] [--home CODEX_HOME] [--session ID [--endpoint unix://SOCKET|ws://ADDRESS]]；隔离验收：--validate-transfer';
if(args.includes('--help')){console.log(usage);process.exit(0);}
if(process.platform!=='darwin'){console.error('此采集器仅适用于 macOS。');process.exit(1);}
if(args.length===1&&args[0]==='--validate-transfer'){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const child=spawn(process.execPath,['tools/run-tests.mjs','--test','--test-concurrency=1','--test-timeout=180000','dist/native-tests/session-hosting.test.js'],{cwd:root,env:process.env,stdio:'inherit'});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code??1;});
  await new Promise(resolve=>child.once('close',resolve));process.exit(process.exitCode??0);
}
const options={};
for(let i=0;i<args.length;i+=2){
  if(!['--pid','--socket','--home','--session','--endpoint'].includes(args[i])||!args[i+1]||options[args[i]]!==undefined)throw Error(usage);
  options[args[i]]=args[i+1];
}
if(!/^[1-9]\d*$/.test(options['--pid']??'')||!Number.isSafeInteger(Number(options['--pid'])))throw Error(usage);
if(options['--session']&&!/^[a-f0-9-]{36}$/i.test(options['--session'])||options['--endpoint']&&(!options['--session']||!/^unix:\/\/|^wss?:\/\//.test(options['--endpoint'])))throw Error(usage);
const pid=options['--pid'],read=(binary,values)=>{
  try{return{ok:true,text:execFileSync(binary,values,{encoding:'utf8',timeout:3000,maxBuffer:128*1024,stdio:['ignore','pipe','pipe']}).trim()};}
  catch(error){return{ok:false,code:error.code??error.status??'unknown'};}
};
const identity=()=>read('/bin/ps',['-p',pid,'-o','pid=,uid=,lstart=,stat=,tty=,comm=']);
const before=identity(),files=read('/usr/sbin/lsof',['-a','-p',pid,'-d','0,1,cwd,txt','-F','fnt']);
// BSD ps 把参数与环境展平，不能作为 CODEX_HOME 的归属证明；只保留明确标注的诊断提示。
const observedEnvironment=read('/bin/ps',['-Eww','-p',pid,'-o','command=']);
const homeHints=observedEnvironment.ok?[...observedEnvironment.text.matchAll(/(?:^|\s)CODEX_HOME=(\/[^\s]+)/g)].map(match=>match[1]):[];
const environmentHint={readable:observedEnvironment.ok,verified:false,...(homeHints.length===1?{homeHint:homeHints[0]}:{})};
let sessionHold;
if(options['--session']){
  sessionHold={sessionId:options['--session'],state:'unobservable',checkedAt:new Date().toISOString(),reason:'未提供可观察的原生端点；应用进程存活或历史文件安静均不能证明线程卸载。'};
  if(options['--endpoint']){
    let rpc;
    try{
      const [{connectAppServer},{DEFAULT_CONFIG}]=await Promise.all([import('../dist/adapters/codex.js'),import('../dist/types.js')]);
      rpc=await connectAppServer(options['--endpoint'],DEFAULT_CONFIG,undefined,path.join(tmpdir(),'nxbridge-macos-readonly-no-home'),{readOnly:true});
      const deadline=Date.now()+5000;let cursor,loaded=false;
      do{
        if(Date.now()>=deadline)throw Error('observation_timeout');
        const page=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})},{timeout:Math.max(1,deadline-Date.now())});
        if(!Array.isArray(page.data))throw Error('invalid_loaded_list');
        loaded=page.data.some(row=>(typeof row==='string'?row:row.id)===options['--session']);cursor=page.nextCursor??undefined;
      }while(cursor&&!loaded);
      sessionHold={sessionId:options['--session'],state:loaded?'loaded':'not_loaded',checkedAt:new Date().toISOString(),endpoint:options['--endpoint']};
    }catch(error){sessionHold.reason=error.code??'observation_failed';}
    finally{await rpc?.close();}
  }
}
const after=identity();
const metadata=value=>{
  try{const stat=lstatSync(value);return{path:path.resolve(value),resolved:realpathSync(value),symlink:stat.isSymbolicLink(),socket:stat.isSocket(),device:stat.dev,inode:stat.ino};}
  catch(error){return{path:path.resolve(value),error:error.code??'unknown'};}
};
console.log(JSON.stringify({
  collectedAt:new Date().toISOString(),platform:read('/usr/bin/sw_vers',[]),pid:Number(pid),
  before,files,after,secondResolutionIdentityUnchanged:before.ok&&after.ok&&before.text===after.text,
  environmentHint,...(sessionHold?{sessionHold}:{}),
  ...(options['--socket']?{endpoint:metadata(options['--socket'])}:{}),
  ...(options['--home']?{userSuppliedHome:metadata(options['--home'])}:{}),
  automaticWakeEligible:false,
  limitations:['ps 的秒级时间和 lsof 是分离快照，不能证明持有同一个进程代次。',
    '用户提供的 home 和 cwd 不能证明目标进程的 CODEX_HOME。',
    'ps -E 的配置目录提示未经核验，可能受空格或参数内容影响，不能用来排除持有者。',
    'loaded/list 仅描述指定端点；无端点、无法认证或只读源模块不可用时不能判断线程是否卸载。',
    '本报告供隔离验证使用，不构成启用直接唤醒或终止后台的授权。']
},null,2));
