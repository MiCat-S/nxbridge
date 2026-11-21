import { liveProcess, probeProcesses, processAncestry, processIdentity, type ProcessIdentity, type ProcessAncestry } from './process.js';
import {delay} from '../shared/time.js';
import { stopWindowsProcess } from './windows/windows-hook-identity.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { psEnvironment } from './posix/posix-process.js';
import {BridgeError} from '../shared/errors.js';

export type OwnedIdentity=Pick<ProcessIdentity,'pid'|'startedAt'>;
export type ProcessState='alive'|'dead'|'unknown';

export async function ownedProcessState(identity:OwnedIdentity):Promise<ProcessState>{
  if(!Number.isSafeInteger(identity.pid)||identity.pid<=0||!identity.startedAt)return'unknown';
  if(!liveProcess(identity.pid))return'dead';
  if(process.platform==='win32'&&identity.pid!==process.pid)return(await probeProcesses([{pid:identity.pid,procStart:identity.startedAt}],10000))[0]!;
  try{const current=await processIdentity(identity.pid);return current.startedAt===identity.startedAt&&!['Z','X'].includes(current.state??'')?'alive':'dead';}
  catch(error){return(error as BridgeError).code==='process_missing'?'dead':'unknown';}
}

export function verifyStopAncestry(identity:OwnedIdentity,chain:ProcessAncestry):void{
  if(chain.ancestors.some(value=>value.pid===identity.pid&&value.startedAt===identity.startedAt))throw new BridgeError('process_is_caller','要停止的是当前命令自身或它的上级进程，未停止。请在外部终端重新执行。');
  if(chain.complete)return;
                                              
  const oldest=chain.ancestors.at(-1)?.startedAt;
  const newer=oldest&&(/^\d+$/.test(oldest)&&/^\d+$/.test(identity.startedAt)?BigInt(identity.startedAt)>BigInt(oldest):Date.parse(identity.startedAt+' UTC')>Date.parse(oldest+' UTC'));
  if(!newer)throw new BridgeError('process_identity_unknown','调用者的祖先链尚不可完整核验，保留进程及归属记录。');
}
export async function stopOwnedProcess(identity:OwnedIdentity,options:{timeout?:number;force?:boolean}={}):Promise<void>{
  if(!Number.isSafeInteger(identity.pid)||identity.pid<=0||!identity.startedAt)throw new BridgeError('process_identity_unknown','无法核验自有进程代次，保留进程及归属记录。');
  verifyStopAncestry(identity,await processAncestry(process.pid,64));
  if(process.platform==='win32'){
                                                   
    if(!/^\d+$/.test(identity.startedAt))return;
    await stopWindowsProcess(identity,options.timeout??5000);return;
  }else{
                                      
    const current=await ownedProcessState(identity);if(current==='dead')return;
    if(current==='unknown')throw new BridgeError('process_identity_unknown','发出信号前无法核验自有进程代次，保留归属记录。');
    try{process.kill(identity.pid,options.force?'SIGKILL':'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  }
  const end=Date.now()+(options.timeout??5000);
  for(;;){
    const current=await ownedProcessState(identity);if(current==='dead')return;
    if(current==='unknown')throw new BridgeError('process_identity_unknown','停止后无法核验进程状态，保留归属记录。');
    if(Date.now()>=end)throw new BridgeError('process_stop_pending','自有进程尚未退出，保留归属记录，稍后可重试。');
    await delay(50);
  }
}

async function groupRunning(pid:number):Promise<boolean>{
  try{
    const selection=process.platform==='darwin'?['-p',(await promisify(execFile)('/usr/bin/pgrep',['-g',String(pid)],{env:psEnvironment(),timeout:2000})).stdout.trim().split(/\s+/).join(',')]:['-s',String(pid)];
    const {stdout}=await promisify(execFile)(process.platform==='darwin'?'/bin/ps':'ps',[...selection,'-o','pgid=,stat='],{env:psEnvironment(),timeout:2000});
    return stdout.split('\n').some(line=>{const value=/^\s*(\d+)\s+(\S+)/.exec(line);return value&&Number(value[1])===pid&&!/^[ZX]/.test(value[2]!);});
  }catch(error){if((error as {code?:number}).code===1)return false;throw error;}
}

export async function ownedGroupState(identity:OwnedIdentity):Promise<ProcessState>{
  try{
    try{
      const leader=await processIdentity(identity.pid);
      if(leader.startedAt!==identity.startedAt)return'dead';
      if(!['Z','X'].includes(leader.state??''))return'alive';
    }catch(error){if((error as BridgeError).code!=='process_missing')throw error;}
                                            
    return await groupRunning(identity.pid)?'unknown':'dead';
  }catch{return'unknown';}
}

                                        
export async function stopOwnedGroup(identity:OwnedIdentity,timeout=5000):Promise<void>{
  await stopOwnedProcess(identity,{timeout});
  if(await ownedGroupState(identity)!=='dead')throw new BridgeError('process_identity_unknown','监督进程已退出，但组内仍可能有未确认的后代；数字组号不能授权停止，保留记录。');
}
