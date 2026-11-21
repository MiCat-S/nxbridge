import path from 'node:path';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { Store } from '../storage/store.js';
import type { BridgeConfig } from '../types.js';
import { prepareOwnedLaunch, selectHostLaunch } from '../hosts/host-launch.js';
import { beginNativeLaunch, saveNativeOwnership, nativeLaunchHandle, bindNativeLaunch } from '../process/owned-native.js';
import {delay} from '../shared/time.js';
import {runCli} from '../process/host-command.js';
import {processIdentity,processAncestors} from '../process/process.js';
import {psEnvironment} from '../process/posix/posix-process.js';

                                            
export async function pairLegacyClaude(home:string,cwd:string,config:BridgeConfig,sourceId:string):Promise<void>{
  const store=new Store(path.join(home,'nxbridge.db')),adapter=new ClaudeAdapter(config,home),configHome=config.claudeHome!;
  try{
    const peer=store.placeholder('claude',cwd),launch=await prepareOwnedLaunch(selectHostLaunch('claude',config,{home,cwd}));
    let ownership=await beginNativeLaunch(home,peer,configHome);
    launch.env.NXBRIDGE_OWNED_LAUNCH='claude:'+ownership.id;launch.env.NXBRIDGE_MANAGED_PEER=peer.id;
    const output=await runCli('claude',['--bg','--name','legacy-messaging-'+peer.id],{home,config,cwd,launch,timeout:30000});
    ownership={...ownership,handle:nativeLaunchHandle(output)};saveNativeOwnership(ownership);
    const until=Date.now()+15000;
    while(!ownership.sessionId){
      const agent=(await adapter.list(undefined,configHome)).find(agent=>agent.id===ownership.handle);
      if(agent?.sessionId){
        try{ownership=await bindNativeLaunch(ownership,agent);}
        catch(error){
                                               
          let observed,registered,osEvidence;
          try{const value=await processIdentity(agent.pid);observed={pid:value.pid,name:value.name,image:value.image,startedAt:value.startedAt,procStart:value.procStart,procStartFt:value.procStartFt};}catch(detail){observed={error:String(detail)};}
          try{const value=JSON.parse(readFileSync(path.join(configHome,'sessions',agent.pid+'.json'),'utf8'));registered={pid:value.pid,pidDomain:value.pidDomain,sessionId:value.sessionId,procStart:value.procStart,procStartFt:value.procStartFt};}catch(detail){registered={error:String(detail)};}
          if(process.platform==='darwin'){
                                                
            try{
              const pids=(await processAncestors(agent.pid,3)).map(value=>value.pid).join(',');
              const read=(binary:string,args:string[])=>{try{return execFileSync(binary,args,{env:psEnvironment(),encoding:'utf8',timeout:3000,maxBuffer:128*1024});}catch(detail){return String(detail);}};
              osEvidence={ps:read('/bin/ps',['-ww','-p',pids,'-o','pid=,ppid=,stat=,lstart=,ucomm=,comm=,args=']),files:read('/usr/sbin/lsof',['-nP','-a','-p',pids,'-d','txt','-F','pcftDin'])};
            }catch(detail){osEvidence={error:String(detail)};}
          }
          throw Object.assign(error instanceof Error?error:new Error(String(error)),{nativeEvidence:{agent:{id:agent.id,sessionId:agent.sessionId,pid:agent.pid,kind:agent.kind},expected:{handle:ownership.handle,sessionId:ownership.sessionId},observed,registered,osEvidence}});
        }
      }else{assert.ok(Date.now()<until,'既有后台夹具未就绪');await delay(100);}
    }
    store.updatePeer(peer.id,{sessionId:ownership.sessionId});store.pair(peer.id,sourceId);
  }finally{adapter.close();store.close();}
}
