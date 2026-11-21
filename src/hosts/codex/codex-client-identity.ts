import { RpcClient } from '../../ipc/rpc.js';
import {BridgeError} from '../../shared/errors.js';

const serverVersions=new WeakMap<RpcClient,string>();
export const codexServerVersion=(rpc:RpcClient):string|undefined=>serverVersions.get(rpc);

function parsedVersion(result:unknown):string|undefined {
  const userAgent=(result as {userAgent?:unknown}|undefined)?.userAgent;
  return typeof userAgent==='string'?/^[^\r\n]+?\/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)\s/.exec(userAgent)?.[1]:undefined;
}

function nativeVersion(result:unknown):string {
  const version=parsedVersion(result);
  if(!version)throw new BridgeError('codex_identity_unknown','Codex 未返回可核验的原生版本；当前协议必须提供客户端版本，未猜测或继续请求。');
  return version;
}

                                                 
export async function backendCodexClient(open:()=>Promise<RpcClient>):Promise<RpcClient>{
  const rpc=await open();let accepted=false;
  try{
    const version=parsedVersion(await rpc.request('initialize',{clientInfo:{name:'codex-backend',title:null,version:''},capabilities:{experimentalApi:true}}));
    if(version)serverVersions.set(rpc,version);
    rpc.notify('initialized');accepted=true;return rpc;
  }finally{if(!accepted)await rpc.close();}
}

                                           
export async function officialCodexClient(open:()=>Promise<RpcClient>):Promise<RpcClient>{
  for(let attempt=0;attempt<3;attempt++){
    const probe=await open();let version:string;
    try{
                                                                             
      version=nativeVersion(await probe.request('initialize',{clientInfo:{name:'codex-backend',title:null,version:''}}));
      probe.notify('initialized');
    }finally{await probe.close();}
    const rpc=await open();let accepted=false;
    try{
      const result=await rpc.request('initialize',{clientInfo:{name:'codex-tui',title:null,version},capabilities:{experimentalApi:true}});
                                         
      if(nativeVersion(result)!==version)continue;
      if(!result.userAgent.startsWith('codex-tui/'+version+' ')||!result.userAgent.endsWith(' (codex-tui; '+version+')'))throw new BridgeError('codex_identity_conflict','该 Codex App Server 已固定为其他客户端身份，重连无法改写；未提交模型请求。请在当前工作结束后重新打开该 Codex 原生窗口或重启其专用运行时。');
      rpc.notify('initialized');serverVersions.set(rpc,version);accepted=true;return rpc;
    }finally{if(!accepted)await rpc.close();}
  }
  throw new BridgeError('codex_identity_changed','Codex 在客户端身份核验期间连续改变版本；未使用过期身份继续请求，请在更新完成后重试。');
}
