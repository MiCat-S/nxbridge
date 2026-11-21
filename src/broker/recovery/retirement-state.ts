import {managedRuntimes} from '../../hosts/managed-runtimes.js';
import {nativeOwnershipRecords} from '../../process/owned-native.js';
import {ownedProcesses} from '../../process/owned-processes.js';
import {ownedProcessState,type OwnedIdentity,type ProcessState} from '../../process/process-stop.js';

export interface RetirementRecord {attempts:number;nextAt:number;error?:string}
                                        
export async function retirementViews(home:string,pending:Record<string,RetirementRecord>,inspect:(identity:OwnedIdentity)=>Promise<ProcessState>=ownedProcessState){
  const runtimes=managedRuntimes(home),nativeNotes=new Map<string,string>(),bindings=nativeOwnershipRecords(home,(peerId,note)=>nativeNotes.set(peerId,note)),owned=ownedProcesses(home),records=new Map(Object.entries(pending));
                                   
  for(const peerId of nativeNotes.keys())if(!records.has(peerId))records.set(peerId,{attempts:0,nextAt:0});
  return Promise.all([...records].map(async([peerId,{error,...value}])=>{
    const identities=new Map<string,OwnedIdentity>();let unsettled=false;
    const add=(pid:number|undefined,startedAt:string|undefined)=>{if(pid&&startedAt)identities.set(pid+':'+startedAt,{pid,startedAt});else if(pid)unsettled=true;};
    for(const {value:runtime}of runtimes.filter(record=>record.value.peerId===peerId)){
      add(runtime.pid,runtime.procStart);add(runtime.wrapperPid,runtime.wrapperProcStart);
      if(!runtime.launchSettled&&!runtime.pid)unsettled=true;
      for(const record of owned.records.filter(record=>record.proof.launchId===runtime.id))add(record.identity.pid,record.identity.startedAt);
    }
    for(const binding of bindings.filter(binding=>binding.peerId===peerId)){
      add(binding.native?.pid,binding.native?.startedAt);if(binding.phase==='intent')unsettled=true;
    }
    for(const record of owned.records.filter(record=>record.peerId===peerId))add(record.identity.pid,record.identity.startedAt);
    const processes=await Promise.all([...identities.values()].map(async identity=>({...identity,state:await inspect(identity)})));
    const note=nativeNotes.get(peerId),state=processes.some(process=>process.state==='alive')?'alive':note||owned.notes.length||processes.some(process=>process.state==='unknown')?'unknown':!processes.length?'record-only':unsettled?'unknown':'dead';
    const currentReason={alive:'记录的进程代次仍存活；回收时会重新核验独占归属。',dead:'记录的进程代次均已退出；回收仅需结算残留资源和记录。','record-only':'仅剩未结算记录；没有已登记的可核验进程，不代表未知启动已经退出。',unknown:'当前进程或启动结果无法核验；保留记录，未执行停止。'}[state];
    return{peerId,...value,state,currentReason,processes,...(note?{notes:[note]}:{}),...(error?{lastFailure:error}:{}),exhausted:value.attempts>=3||value.nextAt===Number.MAX_SAFE_INTEGER,action:'nxbridge retire --member '+peerId};
  }));
}
