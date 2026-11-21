import {existsSync} from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../../shared/errors.js';
import {claudeHome} from '../../shared/local-paths.js';
import {readJson} from '../../shared/files.js';
import {processAncestors,matchesProcess,type ProcessIdentity} from '../../process/process.js';
import {readWindowsHookIdentity} from '../../process/windows/windows-hook-identity.js';
import type {RegisterInput} from '../../types.js';
import type {SessionRecord} from './claude-inbox.js';
export async function claudeIdentity(expected?:string,options:{pid?:number;home?:string;skipOrigin?:boolean;timeout?:number;readNative?:()=>ReturnType<typeof readWindowsHookIdentity>}={}):Promise<{record:SessionRecord;pid:number;native:ProcessIdentity}>{
  const origin=options.pid??(options.skipOrigin?process.pid:process.ppid);
  const native=process.platform==='win32'?await(options.readNative?.()??readWindowsHookIdentity(origin,undefined,'claude',options.timeout,options.skipOrigin)):undefined;
  const ancestors:ProcessIdentity[]=native?[{pid:native.pid,parentPid:native.parentPid,name:'claude.exe',image:native.image,launchImage:native.launchImage,startedAt:native.procStart,procStart:native.procStartTicks,procStartFt:native.procStart}]:(
    await processAncestors(origin,options.skipOrigin?11:10,options.timeout)
  ).slice(options.skipOrigin?1:0);
  for(const info of ancestors){
    const pid=info.pid;
    const filename=path.join(options.home??claudeHome(),'sessions',`${pid}.json`);
    if(existsSync(filename)){
      const record=readJson<SessionRecord>(filename);
      if(!matchesProcess(record,info))throw new BridgeError('stale_session','Claude 会话登记与操作系统进程代次不符。');
      if(expected&&record.sessionId!==expected)throw new BridgeError('session_changed','Claude 会话已经切换，请使用当前会话 ID 重新登记。');
      if(record.sessionId)return{record,pid,native:info};
    }
  }
  throw new BridgeError('claude_identity_missing','无法从官方会话登记核验当前 Claude 进程。');
}

export function claudeRegistration(identity:{record:SessionRecord;pid:number},address:string,questionSupport?:boolean,execution?:{configHome:string;ownedLaunch?:RegisterInput['ownedLaunch']}):RegisterInput{
  const {record,pid}=identity;
  const peerId=process.env.NXBRIDGE_MANAGED_PEER,marker=process.env.NXBRIDGE_OWNED_LAUNCH;
  const ownedLaunch=execution?execution.ownedLaunch:peerId&&marker?.startsWith('claude:')?{peerId,launchId:marker.slice(7)}:undefined,configHome=execution?.configHome??claudeHome();
  return{host:'claude',sessionId:record.sessionId,cwd:record.cwd,name:record.name??'Claude',kind:'root',...(ownedLaunch?{ownedLaunch}:{}),endpoint:{mode:'claude-inbox',address,pid,configHome,procStart:record.procStartFt??record.procStart??null,epoch:`${pid}:${record.procStartFt??record.procStart??address}:${address}`,...(questionSupport===undefined?{}:{questionSupport})}};
}
