import { randomUUID } from 'node:crypto';
import {BridgeError} from '../../shared/errors.js';
import {type Peer} from '../../types.js';

                                                                   
                                                               
                                                                      
                                                                       
                                             
export const MOD_RELOAD_STABLE_MS=20_000;
export const MOD_RELOAD_ATTEMPT_MS=30_000;
export const MOD_STALE_NOTICE_MS=180_000;
export const MOD_RELOAD_SETTLE_MS=120_000;

interface SettingStore {setting<T>(key:string):T|undefined;setSetting(key:string,value:unknown):void}
interface ModReloadRecord {targetRevision:string;attemptId:string;offeredAt:number;attemptedAt?:number}
export interface ReloadAction {kind:'reload_plugins';targetRevision:string;attemptId:string}
const key=(peerId:string)=>'modReload:'+peerId;

                                     
export function reloadAction(store:SettingStore,peerId:string,staleSince:number|undefined,targetRevision:string|undefined,now=Date.now()):ReloadAction|undefined{
  if(staleSince===undefined||!targetRevision||now-staleSince<MOD_RELOAD_STABLE_MS)return;
  let record=store.setting<ModReloadRecord>(key(peerId));
  if(record?.targetRevision!==targetRevision){record={targetRevision,attemptId:randomUUID(),offeredAt:now};store.setSetting(key(peerId),record);}
  return record.attemptedAt===undefined?{kind:'reload_plugins',targetRevision,attemptId:record.attemptId}:undefined;
}

                                                 
export function recordReloadAttempt(store:SettingStore,peerId:string,attemptId:string,targetRevision:string,now=Date.now()):{recorded:true}{
  const record=store.setting<ModReloadRecord>(key(peerId));
  if(!record||record.attemptId!==attemptId||record.targetRevision!==targetRevision)throw new BridgeError('reload_attempt_stale','自动重新加载的请求已过期，未执行。');
  if(record.attemptedAt===undefined)store.setSetting(key(peerId),{...record,attemptedAt:now});
  return{recorded:true};
}

   
                        
                                                                       
                                                                 
                                       
   
export function modStaleNotice(store:SettingStore,peer:Pick<Peer,'id'|'state'>,staleSince:number,targetRevision:string|undefined,now=Date.now()):{tier:3|4}|undefined{
  const record=store.setting<ModReloadRecord>(key(peer.id)),current=record&&record.targetRevision===targetRevision?record:undefined;
  if(!current)return now-staleSince>=MOD_STALE_NOTICE_MS?{tier:4}:undefined;
  if(current.attemptedAt===undefined)return now-current.offeredAt>=MOD_RELOAD_ATTEMPT_MS?{tier:4}:undefined;
  return peer.state!=='busy'&&now-current.attemptedAt>=MOD_RELOAD_SETTLE_MS?{tier:3}:undefined;
}
