import type { Store } from '../../storage/store.js';
import {describeError} from '../../shared/errors.js';

export const CODEX_WAKE_RETRY_MS=30000,CODEX_WAKE_MAX_ATTEMPTS=3;
interface WakeReservation {scope:string;anchor:string;attempts:number;at:number;error?:string;exhausted?:boolean}

                                    
export class CodexWakeSignals {
  private active=new Set<string>();
  constructor(private store:Store,private now=Date.now){}
  status(peerId:string):WakeReservation|undefined{return this.store.setting<WakeReservation>('codexWake:'+peerId);}
  clear(peerId:string):void{if(this.status(peerId))this.store.setSetting('codexWake:'+peerId,null);}
  async signal(peerId:string,scope:string,anchor:string,submit:()=>Promise<void|false>):Promise<void>{
    if(this.active.has(peerId))return;
    this.active.add(peerId);
    try{
      const previous=this.status(peerId),same=previous?.scope===scope&&previous.anchor===anchor;
      if(same&&this.now()-previous.at<CODEX_WAKE_RETRY_MS)return;
      if(same&&previous.attempts>=CODEX_WAKE_MAX_ATTEMPTS){
        if(!previous.exhausted){this.store.setSetting('codexWake:'+peerId,{...previous,exhausted:true});this.store.event('wake.exhausted',{peerId,attempts:previous.attempts});}
        return;
      }
      const reservation:WakeReservation={scope,anchor,attempts:same?previous.attempts+1:1,at:this.now()};
      this.store.setSetting('codexWake:'+peerId,reservation);
      try{if(await submit()===false&&this.status(peerId)?.at===reservation.at)this.store.setSetting('codexWake:'+peerId,previous??null);}
      catch(error){if(this.status(peerId)?.at===reservation.at)this.store.setSetting('codexWake:'+peerId,{...reservation,error:describeError(error).slice(0,1200)});this.store.event('wake.unknown',{peerId,error:describeError(error).slice(0,1200)});}
    }finally{this.active.delete(peerId);}
  }
}
