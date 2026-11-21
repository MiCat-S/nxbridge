import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../storage/store.js';
import type { Peer } from '../../types.js';
import { SILENCE_MS, nativeToolIssue, currentHealthIssue, type TurnHealth } from './turn-health.js';
import type { SessionProfile } from '../../hosts/codex/codex-session-profile.js';

                                       
export const nativeHealthSchema=z.object({
  turnId:z.string().min(1).max(256),lastProgressAt:z.number().finite().nonnegative(),lastEventAt:z.number().finite().nonnegative(),
  state:z.enum(['running','networkRetrying','silent','waitingTool','needsHuman','ready','failed']),tools:z.array(z.string().max(256)).max(64),
  observedProgressAt:z.number().finite().nonnegative().optional(),completion:z.string().max(256).optional(),error:z.string().max(1200).optional(),
  retry:z.object({message:z.string().max(1200),since:z.number().finite().nonnegative(),attempt:z.number().optional(),max:z.number().optional()}).optional(),
  source:z.enum(['native-hook','native-mod']).optional(),
  humanRequests:z.array(z.object({id:z.string().max(256),method:z.string().max(256),itemId:z.string().max(256).optional()})).max(64).optional(),
  nativeIssue:z.object({kind:z.enum(['tool_failed','approval_denied','sandbox_denied']),turn_id:z.string().max(256),item_id:z.string().max(256).optional(),tool:z.string().max(256).optional(),exit_code:z.number().optional(),message:z.string().max(800).optional(),at:z.number().finite().nonnegative()}).optional(),
});
type NativeEvent='start'|'progress'|'tool_start'|'tool_end'|'human'|'ready'|'failed'|'paused';

                                         
export class ForegroundHealth {
  constructor(private store:Store){}
  reconcile(peer:Peer,profile:SessionProfile):'ready'|'paused'|undefined{
    const endpoint=this.store.endpoint(peer.id),value=this.get(peer),turn=profile.turn;
    if(peer.host!=='codex'||!value||!endpoint||!profile.verified||!profile.complete||!turn||turn.state==='running'||turn.at<value.lastEventAt||['ready','failed'].includes(value.state))return;
    this.store.saveEndpoint({...endpoint,nativeHealth:{...value,state:'ready',completion:turn.state==='paused'?'interrupted':'native-rollout',lastEventAt:turn.at,tools:[],retry:undefined,humanRequests:undefined}});
    if(peer.state!=='paused')this.store.updatePeer(peer.id,{state:turn.state==='paused'?'paused':'ready'});
    return turn.state;
  }
  get(peer:Peer):TurnHealth|undefined{
    const endpoint=this.store.endpoint(peer.id),binding=this.store.bindings.current(peer.id);
    if(!endpoint?.active||endpoint.mode==='app-server'||binding&&(!binding.active||binding.transitioning||binding.epoch!==endpoint.bindingEpoch))return;
    const value=endpoint.nativeHealth;if(!value)return;
    return currentHealthIssue({...value,tools:[...value.tools],state:['ready','failed','needsHuman'].includes(value.state)?value.state:value.retry?'networkRetrying':value.tools.length?'waitingTool':Date.now()-value.lastProgressAt>=SILENCE_MS?'silent':'running'});
  }
  observe(peer:Peer,kind:NativeEvent,turnId?:string,toolId?:string,progress=true,toolResult?:any,toolName?:string):void{
    const endpoint=this.store.endpoint(peer.id),binding=this.store.bindings.current(peer.id);
    if(!endpoint?.active||endpoint.mode==='app-server'||!['root','fork'].includes(peer.kind)||binding?.transitioning)return;
    const now=Date.now(),previous=this.get(peer);
                                
    if(previous&&turnId&&previous.turnId!==turnId&&kind!=='start')return;
    const value:TurnHealth=kind==='start'||!previous?{turnId:turnId??randomUUID(),lastProgressAt:now,lastEventAt:now,state:'running',tools:[],source:'native-hook'}:{...previous,tools:[...previous.tools],lastEventAt:now};
    if(kind==='tool_start'&&toolId)value.tools=[...new Set([...value.tools,toolId])];
    if(kind==='tool_end'&&toolId)value.tools=value.tools.filter(id=>id!==toolId);
    if(['ready','paused','failed'].includes(kind)){value.state=kind==='failed'?'failed':'ready';value.completion=kind==='paused'?'interrupted':kind;value.tools=[];delete value.retry;delete value.humanRequests;}
    else if(kind==='human'){
      const itemId=toolId??(value.tools.length===1?value.tools[0]:undefined),id=itemId??randomUUID();
      value.humanRequests=[...(value.humanRequests??[]).filter(row=>row.id!==id),{id,method:'PermissionRequest',...(itemId?{itemId}:{})}].slice(-64);value.state='needsHuman';
    }else{
      if(kind==='tool_end'&&toolId)value.humanRequests=value.humanRequests?.filter(request=>!request.itemId||request.itemId!==toolId);
      if(kind==='tool_end'&&toolResult&&typeof toolResult==='object'){
        const issue=nativeToolIssue({id:toolId,type:toolName,exitCode:toolResult.exit_code??toolResult.exitCode,error:toolResult.error,status:toolResult.isError===true||toolResult.is_error===true?'failed':toolResult.status},value.turnId,now);
        if(issue)value.nativeIssue=issue;else if(value.nativeIssue?.item_id===toolId)delete value.nativeIssue;
      }
      if(progress){value.lastProgressAt=now;value.observedProgressAt=now;if(value.state!=='needsHuman'||value.humanRequests?.length===0)value.state=value.humanRequests?.length?'needsHuman':'running';delete value.retry;}
      else if(value.state==='needsHuman'&&value.humanRequests?.length===0)value.state='running';
    }
    this.store.saveEndpoint({...endpoint,nativeHealth:value});
    const current=this.store.peer(peer.id);
    if(current.state!=='paused'&&(kind==='human'||current.state==='needsHuman'&&kind==='tool_end'&&value.humanRequests?.length===0||kind==='ready'||kind==='failed'))this.store.updatePeer(peer.id,{state:value.state==='needsHuman'?'needsHuman':['ready','failed'].includes(value.state)?'ready':'busy'});
  }
}
