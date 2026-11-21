import type { Endpoint, Peer } from '../../types.js';

                                                    
export function codexParent(thread:{parentThreadId?:string|null;source?:any}):string|undefined{
  const value=thread.parentThreadId??thread.source?.subAgent?.spawn?.parentThreadId??thread.source?.subAgent?.thread_spawn?.parent_thread_id;
  return typeof value==='string'&&value.length?value:undefined;
}
export function codexSubagent(thread:{parentThreadId?:string|null;source?:any;threadSource?:string}):boolean{
  return !!codexParent(thread)||thread.threadSource==='subagent'||!!thread.source?.subAgent;
}

                                              
export function codexUserWindow(peer:{host:string;owner:string;kind:string}):boolean{
  return peer.host==='codex'&&peer.owner==='user'&&['root','fork'].includes(peer.kind);
}
                                         
export function codexRuntimeChild(root:Peer,child:Peer,runtime:Endpoint,peers:Peer[],endpoints:Endpoint[]):boolean{
  const same=(peer:Peer)=>endpoints.some(ep=>ep.peerId===peer.id&&codexRuntimeEndpoint(ep,runtime));
  const seen=new Set<string>();let current=child;
  while(current.kind==='subagent'&&current.host==='codex'&&same(current)&&!seen.has(current.id)){
    if(current.rootPeerId&&current.rootPeerId!==root.id)return false;
    seen.add(current.id);
    if(current.parentId===root.sessionId)return true;
    const parents=peers.filter(peer=>peer.host==='codex'&&peer.sessionId===current.parentId&&same(peer));
    if(parents.length!==1)return false;current=parents[0]!;
  }
  return false;
}

export function codexRuntimeEndpoint(endpoint:Endpoint,runtime:Pick<Endpoint,'address'|'pid'|'procStart'|'runtimeId'>):boolean{
  return endpoint.mode==='app-server'&&endpoint.address===runtime.address&&
    !(endpoint.pid&&runtime.pid&&endpoint.pid!==runtime.pid)&&
    !(endpoint.procStart&&runtime.procStart&&endpoint.procStart!==runtime.procStart)&&
    !(endpoint.runtimeId&&runtime.runtimeId&&endpoint.runtimeId!==runtime.runtimeId);
}
