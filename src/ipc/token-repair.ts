import {randomBytes} from 'node:crypto';
import {readdirSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {StartupReservation} from '../broker/broker-startup.js';
import {ownedProcesses,ownedRecordPredatesBoot} from '../process/owned-processes.js';
import {ownedProcessState,stopOwnedProcess} from '../process/process-stop.js';
import {BridgeError} from '../shared/errors.js';
import {ipcAddress,ownedSocketDirectory} from '../shared/local-paths.js';
import {atomicWriteText} from '../storage/atomic-file.js';
import {ipcToken,ipcTokenFile} from './token.js';

function invalidToken(home:string):boolean{
  try{ipcToken(home);return false;}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='ENOENT')return false;
    if(code==='ipc_token_invalid')return true;
    throw error;
  }
}

                                   
function listening(address:string):Promise<boolean>{
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(address);
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',(error:NodeJS.ErrnoException)=>{if(['ENOENT','ECONNREFUSED'].includes(error.code??''))resolve(false);else reject(error);});
    socket.setTimeout(1000,()=>{
      socket.destroy();reject(new BridgeError('ipc_token_repair_blocked','无法确认旧的 nxbridge 后台是否已经退出。请重启电脑后，再运行同样的命令。'));
    });
  });
}

async function assertNoClaudeWorker(home:string):Promise<void>{
  if(process.platform!=='linux')return;
  const blocked=()=>new BridgeError('ipc_token_repair_blocked','本地 IPC 令牌已损坏，仍有后台 Claude 在使用旧连接。请重启电脑，或等后台 Claude 退出后，再运行同样的安装命令。');
  for(const record of ownedProcesses(home).records.filter(value=>value.role==='claude-worker'&&!ownedRecordPredatesBoot(value))){
    if(await ownedProcessState(record.identity)!=='dead')throw blocked();
  }
                                     
  const directory=ownedSocketDirectory(home);let names:string[];
  try{names=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  for(const name of names.filter(value=>/^cc-[a-f0-9]{16}\.sock$/.test(value))){
    if(await listening(path.join(directory,name)))throw blocked();
  }
}

async function repairableBroker(home:string):Promise<{pid:number;startedAt:string}|undefined>{
  const blocked=()=>new BridgeError('ipc_token_repair_blocked','本地 IPC 令牌已损坏，无法核验旧协调器的归属。请重启电脑后，再运行同样的命令。');
  const candidates=new Map<string,{pid:number;startedAt:string}>();
  for(const record of ownedProcesses(home).records.filter(value=>value.role==='broker'&&(process.platform!=='linux'||!ownedRecordPredatesBoot(value)))){
    const state=await ownedProcessState(record.identity);
    if(state==='dead')continue;
    if(state==='unknown'||record.releasedToUser)throw blocked();
    const {pid,startedAt}=record.identity;candidates.set(pid+':'+startedAt,{pid,startedAt});
  }
  if(candidates.size>1||!candidates.size&&await listening(ipcAddress(home)))throw blocked();
  return candidates.values().next().value;
}

                                    
export async function preflightIpcTokenRepair(home:string):Promise<boolean>{
  if(!invalidToken(home))return false;
  await assertNoClaudeWorker(home);
  await repairableBroker(home);
  return true;
}

                                      
export async function repairIpcToken(home:string,startup:StartupReservation):Promise<boolean>{
  if(!invalidToken(home))return false;
  await assertNoClaudeWorker(home);
  const broker=await repairableBroker(home);
  await startup.assertCurrent();
  if(broker)await stopOwnedProcess(broker,{timeout:15000});
  if(await listening(ipcAddress(home)))throw new BridgeError('ipc_token_repair_blocked','旧协调器仍在监听，本地 IPC 令牌没有更换。请重启电脑后，再运行同样的命令。');
  await startup.assertCurrent();
                                                    
  await assertNoClaudeWorker(home);
  if(!invalidToken(home))return false;
  atomicWriteText(ipcTokenFile(home),randomBytes(32).toString('hex'));
  return true;
}
