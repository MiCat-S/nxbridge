import net from 'node:net';
import WebSocket from 'ws';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {probeProcesses} from '../../process/process.js';
import {readJson} from '../../shared/files.js';
import {type Endpoint,type Peer} from '../../types.js';
import {runtimeFor,assertManagedRuntimeEndpoint,type ManagedRuntime} from '../../hosts/managed-runtimes.js';
import {remainingTime} from '../../shared/time-budget.js';
import {type RuntimeAvailability} from './contracts.js';
export async function probeSocket(address:string,timeout=600):Promise<boolean>{
  return new Promise(resolve=>{
    const socket=net.createConnection(address),finish=(ok:boolean)=>{clearTimeout(timer);socket.destroy();resolve(ok);};
    const timer=setTimeout(()=>finish(false),timeout);
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
  });
}
export async function probeAppServer(address:string,token?:string,timeout=750):Promise<boolean|undefined>{
  if(address.startsWith('unix://')){
                                                         
    if(process.platform==='win32')return undefined;
    return probeSocket(address.slice(7),timeout);
  }
  if(!/^wss?:\/\//.test(address))return false;
  return new Promise(resolve=>{
    const socket=new WebSocket(address,{handshakeTimeout:timeout,...(token?{headers:{Authorization:`Bearer ${token}`}}:{})});
    let settled=false;const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);socket.terminate();resolve(ok);};
    const timer=setTimeout(()=>finish(false),timeout);
    socket.once('open',()=>finish(true));socket.once('error',()=>finish(false));socket.once('close',()=>finish(false));
  });
}
export async function probePeerRuntime(peer:Peer,endpoint:Endpoint|undefined,home?:string,appServerProbe?:()=>Promise<boolean|undefined>,deadline?:number):Promise<RuntimeAvailability>{
  const now=Date.now(),reasons:string[]=[],unknown:string[]=[];
  if(endpoint?.pendingContext&&endpoint.pid&&endpoint.procStart){
    const state=(await probeProcesses([{pid:endpoint.pid,procStart:endpoint.procStart}],remainingTime(deadline,1500)))[0];
    return{state:state==='alive'?'starting':state==='dead'?'blocked':'unknown',nativeState:state,reasons:[state==='alive'?'native window registered; conversation awaits first native turn':state==='dead'?'native host exited or PID generation changed':'native host PID generation unverifiable'],checked_at:now};
  }
  if(!peer.sessionId)return{state:peer.launchFailure||['needsHuman','offline'].includes(peer.state)?'blocked':'starting',reasons:[peer.launchFailure?'搭档启动失败：'+peer.launchFailure.message:peer.state==='needsHuman'?'partner startup waits for user input/approval in its own window':'partner session not yet created'],checked_at:now};
  if(!endpoint)return{state:'blocked',reasons:['no registered delivery endpoint'],checked_at:now};
  const identities:{label:string;pid:number;procStart:string}[]=[];
  let ownedRuntime:ManagedRuntime|undefined;
  const native=endpoint.native??(endpoint.pid?{pid:endpoint.pid,procStart:endpoint.procStart??''}:undefined);
  if(native)identities.push({label:'native host',...native});
  if(endpoint.mode==='embedded'&&!endpoint.daemon&&endpoint.bridge)identities.push({label:'MCP bridge',...endpoint.bridge});
                                                   
  if(home&&peer.host==='codex'){
    try{ownedRuntime=runtimeFor(home,{endpoint:endpoint.address})?.value;if(ownedRuntime?.pid)identities.push({label:'owned App Server',pid:ownedRuntime.pid,procStart:ownedRuntime.procStart??''});}catch{unknown.push('owned runtime evidence unreadable');}
  }
  if(home&&peer.owner==='nxbridge'&&peer.host==='claude'){
    const id=createHash('sha256').update(peer.id).digest('hex').slice(0,16);
    try{
      const child=readJson<{peerId:string;sessionId:string;phase:string;worker?:{pid:number;startedAt:string};address:string}>(path.join(home,'run','claude-child-'+id+'.json'));
      if(child.peerId===peer.id&&child.sessionId===peer.sessionId&&['active','starting','failed'].includes(child.phase)){
        if(child.worker)identities.push({label:'owned Claude worker',pid:child.worker.pid,procStart:child.worker.startedAt});
        if(child.phase==='failed')reasons.push('owned Claude worker failed');
        if(child.address&&!await probeSocket(child.address,remainingTime(deadline,600)))reasons.push('owned Claude worker endpoint unreachable');
      }
    }catch{                             }
  }
  const results=await probeProcesses(identities,remainingTime(deadline,1500));
  for(let i=0;i<results.length;i++)if(results[i]==='dead')reasons.push(identities[i]!.label+' exited or PID generation changed');else if(results[i]==='unknown')unknown.push(identities[i]!.label+' PID generation unverifiable');
  if(endpoint.mode==='claude-inbox'&&!await probeSocket(endpoint.address,remainingTime(deadline,600)))reasons.push('Claude inbox endpoint unreachable');
  if(endpoint.mode==='app-server'&&results.every(result=>result==='alive')){
                                                
    if(home&&peer.host==='codex')await assertManagedRuntimeEndpoint(home,endpoint.address,ownedRuntime?.pid&&ownedRuntime.procStart?{pid:ownedRuntime.pid,procStart:ownedRuntime.procStart}:undefined);
    const reachable=await(appServerProbe?appServerProbe():probeAppServer(endpoint.address,undefined,remainingTime(deadline,750)));
    if(reachable===false)reasons.push('App Server endpoint unreachable');else if(reachable===undefined)unknown.push('App Server endpoint reachability unverified');
  }
  if(!endpoint.active)reasons.push('delivery endpoint not connected/registered');
  return{state:reasons.length?'blocked':unknown.length?'unknown':'reachable',...(native?{nativeState:results[0]}:{}),reasons:[...reasons,...unknown],checked_at:now};
}
