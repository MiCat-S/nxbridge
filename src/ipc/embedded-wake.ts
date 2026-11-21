import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../storage/store.js';
import {isEmbeddedWake} from '../types.js';
import {describeError} from '../shared/errors.js';

interface NativeWake {id:string;clientId:string}
export type WakeQueue = {items:NativeWake[];error?:never}|{items?:never;error:string};
interface OutstandingWake {scope:string;at:number;nativeId?:string;clientId?:string}

                                                     
export function readWakeQueue(home:string,sessionId:string):WakeQueue{
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const file=path.join(home,'queue_1.sqlite');if(!existsSync(file))return{items:[]};
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(file,{readOnly:true});
    const rows=db.prepare('SELECT id,payload_json FROM queued_items WHERE thread_id=?').all(sessionId),items:NativeWake[]=[];
    for(const row of rows){
      const payload=JSON.parse(String(row.payload_json));
                                 
      if(!payload.UserInput)continue;
      const input=payload.UserInput;if(!Array.isArray(input.content)||typeof input.client_id!=='string')throw Error('原生 UserInput 队列协议尚未验收');
      if(input.content.length===1&&input.content[0]?.type==='text'&&isEmbeddedWake(input.content[0].text))items.push({id:String(row.id),clientId:input.client_id});
    }
    return{items};
  }catch(error){return{error:describeError(error)};}
  finally{db?.close();}
}

                                     
export class EmbeddedWakeSignals {
  private active=new Set<string>();
  constructor(private store:Store,private read=readWakeQueue){}
  consumed(peerId:string):void{this.store.setSetting('embeddedWake:'+peerId,null);}
  async signal(peerId:string,scope:string,home:string,sessionId:string,submit:()=>Promise<void>):Promise<string|null>{
    if(this.active.has(peerId))return null;
    this.active.add(peerId);
    try{
      const key='embeddedWake:'+peerId,previous=this.store.setting<OutstandingWake>(key),queue=this.read(home,sessionId),native=queue.items?.[0];
      if(native){this.store.setSetting(key,{scope,at:previous?.scope===scope?previous.at:Date.now(),nativeId:native.id,clientId:native.clientId});return null;}
                                                  
      const wait=queue.error?600000:30000;
      if(previous?.scope===scope&&Date.now()-previous.at<wait)return queue.error??null;
      const reservation:OutstandingWake={scope,at:Date.now()};this.store.setSetting(key,reservation);
      try{await submit();}
      catch(error){this.store.event('wake.unknown',{peerId,error:describeError(error)});return queue.error??'原生唤醒提交结果未知；保留预约，核对队列后再重试。';}
      const after=this.read(home,sessionId),item=after.items?.[0],current=this.store.setting<OutstandingWake>(key);
      if(item&&current?.scope===scope&&current.at===reservation.at)this.store.setSetting(key,{...reservation,nativeId:item.id,clientId:item.clientId});
      this.store.event('wake.queued',{peerId,sessionId,...(item?{nativeId:item.id,clientId:item.clientId}:{})});
      return after.error??queue.error??null;
    }finally{this.active.delete(peerId);}
  }
}
