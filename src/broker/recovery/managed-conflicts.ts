import type {Store} from '../../storage/store.js';

interface ConflictThread {runtimeId:string;sessionId:string;at:number}
                                                
export interface ManagedConflict extends ConflictThread {pending?:ConflictThread[];overflowRuntimeIds?:string[]}
const key=(peerId:string)=>'managedRuntimeConflict:'+peerId;

                                         
export function addManagedConflict(store:Store,peerId:string,runtimeId:string,sessionId:string):void{
  const current=store.setting<ManagedConflict>(key(peerId)),next={runtimeId,sessionId,at:Date.now()};
  if(!current){store.setSetting(key(peerId),next);return;}
  if([current,...current.pending??[]].some(row=>row.runtimeId===runtimeId&&row.sessionId===sessionId))return;
  store.setSetting(key(peerId),{...current,pending:[...current.pending??[],next]});
}

                                    
export function clearManagedConflict(store:Store,peerId:string,runtimeId:string,sessionId:string,checked?:ManagedConflict):boolean{
  const current=store.setting<ManagedConflict>(key(peerId));if(!current||checked&&JSON.stringify(current)!==JSON.stringify(checked))return false;
  const rows=[{runtimeId:current.runtimeId,sessionId:current.sessionId,at:current.at},...current.pending??[]],remaining=rows.filter(row=>row.runtimeId!==runtimeId||row.sessionId!==sessionId);
  if(remaining.length===rows.length)return false;
                                       
  if(!remaining.length&&current.overflowRuntimeIds?.length)return false;
  const [first,...pending]=remaining;store.setSetting(key(peerId),first?{...first,...(pending.length?{pending}:{}),...(current.overflowRuntimeIds?.length?{overflowRuntimeIds:current.overflowRuntimeIds}:{})}:null);return true;
}

export function clearManagedRuntimeConflict(store:Store,peerId:string,runtimeId:string,checked:ManagedConflict):void{
  if(JSON.stringify(store.setting(key(peerId)))!==JSON.stringify(checked))return;
  const rows=[{runtimeId:checked.runtimeId,sessionId:checked.sessionId,at:checked.at},...checked.pending??[]].filter(row=>row.runtimeId!==runtimeId),overflowRuntimeIds=checked.overflowRuntimeIds?.filter(id=>id!==runtimeId),[first,...pending]=rows;
  if(first)store.setSetting(key(peerId),{...first,...(pending.length?{pending}:{}),...(overflowRuntimeIds?.length?{overflowRuntimeIds}:{})});
  else if(!overflowRuntimeIds?.length)store.setSetting(key(peerId),null);
  else store.setSetting(key(peerId),{runtimeId:overflowRuntimeIds[0]!,sessionId:'',at:checked.at,overflowRuntimeIds});
}
