import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/store.js';
import { windowKey } from '../integration/hooks/session-bindings.js';
import type { Endpoint, Peer, WindowIdentity } from '../types.js';

export interface PendingCodexWindow {window:WindowIdentity;cwd:string;sessionId?:string;bridge:{pid:number;procStart:string}}
                                         
export function registerPendingCodex(store:Store,input:PendingCodexWindow):Peer{
  return store.transaction(()=>{
    const key=windowKey(input.window),bound=store.bindings.get(key),record=store.setting<{peerId:string;confirmed?:boolean}>('pendingCodex:'+key);
    if(bound?.active)return store.peer(bound.peerId);
    if(record&&!record.confirmed){
      const peer=store.peer(record.peerId),endpoint=store.endpoints(peer.id).find(e=>e.active&&e.pendingContext);
      if(endpoint)return peer;
    }
    const peer:Peer=store.savePeer({id:randomUUID(),host:'codex',sessionId:input.sessionId??null,cwd:input.cwd,name:'Codex',kind:'root',parentId:null,owner:'user',state:'ready',permission:'unknown',updatedAt:Date.now()});
    const endpoint:Endpoint={peerId:peer.id,epoch:'pending:'+key,mode:'embedded',address:'',pid:input.window.pid,procStart:input.window.procStart,configHome:input.window.configHome,bridge:input.bridge,pendingContext:true,processKind:'foreground',active:true,seenAt:Date.now()};
    store.saveEndpoint(endpoint);
    store.setSetting('pendingCodex:'+key,{peerId:peer.id,...(input.sessionId?{proposedSessionId:input.sessionId}:{}),confirmed:false});
    store.event('peer.registered',{peerId:peer.id,host:'codex',name:peer.name,pendingContext:true});return peer;
  });
}
