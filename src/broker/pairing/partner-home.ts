import type { Store } from '../../storage/store.js';
import type { Peer } from '../../types.js';
import { sessionHistoryKey } from '../recovery/session-history.js';

                             
export function partnerConfigHome(store:Store,peer:Peer,fallback?:string):string|undefined{
  const launch=store.setting<{sessionId:string;configHome?:string}>('managedLaunchProof:'+peer.id);
  const endpoint=store.endpoints(peer.id).filter(value=>value.configHome).sort((a,b)=>b.seenAt-a.seenAt)[0];
  const history=store.setting<{sessionId:string;configHome:string}>(sessionHistoryKey(peer.id));
  return(launch?.sessionId===peer.sessionId?launch.configHome:undefined)??endpoint?.configHome??(history?.sessionId===peer.sessionId?history.configHome:undefined)??fallback;
}
