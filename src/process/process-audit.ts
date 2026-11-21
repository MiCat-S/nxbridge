import { existsSync, readdirSync } from 'node:fs';
import { ownedProcesses, ownedRecordState, processRegistryDirectory, processRegistryRoot } from './owned-processes.js';
import { nativeOwnership } from './owned-native.js';
import {describeError} from '../shared/errors.js';

export function processOwnershipSummary(home:string){
  const {records,notes}=ownedProcesses(home),directory=processRegistryDirectory(home),pending:unknown[]=[];
  if(existsSync(directory))for(const name of readdirSync(directory).filter(value=>/^native-[a-f0-9-]{36}\.json$/.test(value)))try{
    const value=nativeOwnership(home,name.slice(7,-5));if(value)pending.push({peerId:value.peerId,sessionId:value.sessionId??null,phase:value.phase,releasedToUser:value.releasedToUser??false,...(value.phase==='intent'?{reason:'后台启动结果还没有确认；nxbridge 不会再次启动，也不会按名称停止同名会话。',action:'请在 Claude 的后台会话列表中核对，再用 nxbridge pair 指定要配对的会话。'}:{})});
  }catch(error){notes.push(describeError(error));}
  return{registry:processRegistryRoot(),records:records.map(value=>({pid:value.identity.pid,procStart:value.identity.startedAt,role:value.role,peerId:value.peerId??null,sessionId:value.sessionId??null,releasedToUser:value.releasedToUser??false})),native:pending,notes};
}
export async function auditOwnedProcesses(home:string){
  const summary=processOwnershipSummary(home),owned=ownedProcesses(home).records;
  const states=await Promise.all(owned.map(ownedRecordState));
  const records=owned.map((record,index)=>({pid:record.identity.pid,procStart:record.identity.startedAt,role:record.role,state:states[index],releasedToUser:record.releasedToUser??false}));
  return{...summary,records};
}
