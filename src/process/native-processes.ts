import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ownedProcesses } from './owned-processes.js';
import { codexIsManagedDaemon, probeProcesses, processIdentity } from './process.js';
import { normalizedHome } from '../integration/hooks/session-bindings.js';
import {BridgeError} from '../shared/errors.js';
import {type Endpoint,type SessionBinding} from '../types.js';

export interface KnownNativeProcess {pid:number;startedAt:string;configHome?:string}

                                        
export async function knownNativeProcesses(home:string,host:'codex'|'claude',configHome?:string):Promise<KnownNativeProcess[]>{
  const candidates:KnownNativeProcess[]=[],database=path.join(home,'nxbridge.db');
  const add=(pid:number|null|undefined,startedAt:string|null|undefined,observedHome?:string)=>{
    if(pid&&startedAt&&(!configHome||!observedHome||normalizedHome(configHome)===normalizedHome(observedHome)))candidates.push({pid,startedAt,...(observedHome?{configHome:observedHome}:{})});
  };
  const ownership=ownedProcesses(home);
  for(const record of ownership.records)if((host==='codex'?['codex-runtime']:['claude-native','claude-child','claude-worker']).includes(record.role))add(record.identity.pid,record.identity.startedAt,record.configHome);
  if(existsSync(database)){
    const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(database,{readOnly:true});
    try{
      db.exec('PRAGMA busy_timeout=3000');
      for(const row of db.prepare('SELECT endpoints.data FROM endpoints JOIN peers ON peers.id=endpoints.peer_id WHERE peers.host=?').all(host)){
        const endpoint=JSON.parse(String(row.data)) as Endpoint;
        add(endpoint.pid,endpoint.procStart,endpoint.configHome);add(endpoint.native?.pid,endpoint.native?.procStart,endpoint.configHome);
      }
      for(const row of db.prepare('SELECT data FROM window_bindings').all()){
        const binding=JSON.parse(String(row.data)) as SessionBinding;if(binding.host===host)add(binding.pid,binding.procStart,binding.configHome);
      }
    }finally{db.close();}
  }
  if(host==='codex'&&configHome){
    let pid:number|undefined;
    try{pid=JSON.parse(readFileSync(path.join(configHome,'app-server-daemon','daemon.pid'),'utf8')).pid;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(pid)try{const identity=await processIdentity(pid);if(await codexIsManagedDaemon(identity))add(pid,identity.startedAt,configHome);}
    catch(error){if((error as BridgeError).code!=='process_missing')throw error;}
  }
  const unique=[...new Map(candidates.map(value=>[value.pid+':'+value.startedAt,value])).values()];
  const states=await probeProcesses(unique.map(value=>({pid:value.pid,procStart:value.startedAt})),10000);
  if(states.includes('unknown'))throw new BridgeError('process_identity_unknown','已登记宿主的进程代次尚无法核验。');
  return unique.filter((_value,index)=>states[index]==='alive');
}
