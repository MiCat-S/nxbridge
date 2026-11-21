import {spawn,execFileSync} from 'node:child_process';
import {processIdentity} from '../process/process.js';
import {recordOwnedProcess} from '../process/owned-processes.js';
import {configurePosixCompletion,supervisePosixGroup} from '../process/posix/posix-supervisor.js';
import {psEnvironment} from '../process/posix/posix-process.js';
import {atomicJson} from '../shared/files.js';

const [home,ready,completionFile,launchId,executable,...args]=process.argv.slice(2);
                                             
const group=execFileSync('/bin/ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8',env:psEnvironment()}).trim();
if(group!==String(process.pid))throw Error('伪终端工作进程不是独立进程组的组长');
const supervisor=await supervisePosixGroup();
process.on('SIGHUP',()=>supervisor.stop());
try{
  const identity=await processIdentity(process.pid);
  const record=await recordOwnedProcess(home!,{role:'host-control',identity,parent:await processIdentity(identity.parentPid),posixGroup:true,completionFile,proof:{kind:'spawn',launchId}});
  configurePosixCompletion(record.completionFile!);
  atomicJson(ready!,record);
  const child=spawn(executable!,args,{stdio:'inherit'});
  child.once('error',error=>{process.stderr.write(String(error)+'\n');supervisor.stop();});
  child.once('exit',()=>supervisor.stop());
}catch(error){
  process.stderr.write(String(error)+'\n');supervisor.stop();
}
