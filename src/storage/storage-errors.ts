import {BridgeError,DeliveryError,describeError} from '../shared/errors.js';
import { setTimeout as delay } from 'node:timers/promises';

export type StoragePhase='prepare'|'enqueue';
export class StorageBusyError extends BridgeError {
  constructor(public operation:string,public phase?:StoragePhase,public sqliteCode?:number,public uncertain?:boolean){
    super('storage_busy','nxbridge 数据库暂时繁忙，请稍后重试。');
    if(uncertain===undefined&&phase!==undefined)this.uncertain=false;
  }
}
                                                 
export function storageError(error:unknown,operation:string,phase?:StoragePhase):unknown{
  const detail=error as {errcode?:unknown;code?:unknown;sqliteCode?:number;phase?:StoragePhase;operation?:string;uncertain?:boolean};
  const numeric=typeof detail?.errcode==='number'?detail.errcode:undefined;
  if(error instanceof StorageBusyError||detail?.code==='storage_busy'||numeric!==undefined&&[5,6].includes(numeric&255)){
    return new StorageBusyError(detail.operation??operation,detail.phase??(detail.uncertain===true?undefined:phase),numeric??detail.sqliteCode,detail.uncertain);
  }
  return error;
}

                                         
export function preSubmitError(error:unknown,operation:string,phase:StoragePhase):unknown{
  const typed=storageError(error,operation,phase);
  if(typed instanceof StorageBusyError)return typed;
  const detail=typed as {uncertain?:boolean;phase?:StoragePhase};
  if(detail?.uncertain===true||detail?.phase)return typed;
  return Object.assign(typed instanceof Error?typed:new DeliveryError('notice_prepare',describeError(typed)),{uncertain:false,phase,operation});
}

                                     
export async function retryStorageReceipt(work:(remaining:()=>number)=>void,timeoutMs=3000):Promise<void>{
  const deadline=performance.now()+Math.max(0,timeoutMs),remaining=()=>Math.max(0,Math.min(1000,Math.floor(deadline-performance.now())));
  for(let attempt=0;;attempt++){
    try{work(remaining);return;}
    catch(error){const typed=storageError(error,'receipt');if(!(typed instanceof StorageBusyError)||attempt>=2||performance.now()>=deadline)throw typed;await delay(Math.min(50*(attempt+1),Math.max(0,deadline-performance.now())));}
  }
}
