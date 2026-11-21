import { normalizedHome } from '../../integration/hooks/session-bindings.js';
import type { Store } from '../../storage/store.js';
import type { Endpoint, Pair, Peer } from '../../types.js';

type ContextPeer=Pick<Peer,'sessionId'|'cwd'>;
type ContextEndpoint=Pick<Endpoint,'configHome'|'pid'|'procStart'>;
interface NativeContext {sessionId:string;revision:number}
const contextKey=(peer:ContextPeer,endpoint:ContextEndpoint)=>endpoint.configHome&&endpoint.pid&&endpoint.procStart?'daemonNativeContext:'+JSON.stringify([normalizedHome(endpoint.configHome),endpoint.pid,endpoint.procStart,normalizedHome(peer.cwd)]):undefined;

                                                  
export function observeDaemonContext(store:Store,peer:ContextPeer,endpoint:ContextEndpoint):void{
  const key=contextKey(peer,endpoint);if(!key||!peer.sessionId)return;
  const previous=store.setting<NativeContext>(key);if(previous?.sessionId===peer.sessionId)return;
  store.setSetting(key,{sessionId:peer.sessionId,revision:(previous?.revision??0)+1});
}
export function daemonContextChanged(store:Store,peer:Peer,endpoint:Endpoint|undefined):boolean{
  if(!endpoint?.daemon)return false;const pair=store.pairFor(peer.id),key=contextKey(peer,endpoint);if(!pair||!key)return false;
  const current=store.setting<NativeContext>(key),consent=store.setting<{contextRevision?:number}>('daemonWakeConsent:'+pair.id);
  return !!current&&current.sessionId!==peer.sessionId&&current.revision>(consent?.contextRevision??0);
}

                                  
export function authorizeDaemonWake(store:Store,pair:Pair,source:'selection'|'code'|'terminal'):void{
  const peer=store.peer(pair.codex),endpoint=store.endpoint(peer.id),key=endpoint?contextKey(peer,endpoint):undefined;
  store.setSetting('daemonWakeConsent:'+pair.id,{source,at:Date.now(),contextRevision:key?store.setting<NativeContext>(key)?.revision??0:0});
}
export function daemonWakeAuthorized(store:Store,pair:Pair):boolean{
  return !!store.setting('daemonWakeConsent:'+pair.id);
}
