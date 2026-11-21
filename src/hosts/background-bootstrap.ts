import { connectBroker, ensureBroker, serviceOrigin } from '../ipc/ipc.js';
import {bridgeHome} from '../shared/local-paths.js';
import {delay} from '../shared/time.js';
import { processIdentity } from '../process/process.js';
import { ownedProcessState } from '../process/process-stop.js';
import { reserveBrokerStartup } from '../broker/broker-startup.js';
import { recordBackgroundState } from './background-state.js';
import {BridgeError,DeliveryError} from '../shared/errors.js';
import { verifyBackgroundContext } from './background-preflight.js';

                                     
export async function bootstrapBackground(home=bridgeHome(),services:{preflight?:typeof verifyBackgroundContext}={}):Promise<{text:string}>{
  let current:{pid:number;runtime?:{generation:string;windowsIndependent?:boolean}}|undefined;
  try{const rpc=await connectBroker(home);try{current=await rpc.request('ping',{});}finally{rpc.close();}}catch(error){if(!['ENOENT','ECONNREFUSED','ECONNRESET','EPIPE','broker_timeout','disconnected','starting'].includes((error as {code?:string}).code??''))throw error;}
  if(current&&(process.platform!=='win32'||current.runtime?.windowsIndependent)){
    recordBackgroundState(home);
    return{text:`后台协调器已在独立运行（进程 ${current.pid}），无需重复操作。`};
  }
  await(services.preflight??verifyBackgroundContext)(home);
  const origin=await serviceOrigin(),caller=origin.find(value=>value.pid===process.pid);
  if(!caller)throw new BridgeError('broker_origin_unverified','无法核验引导命令的原生进程身份。');
  const release=await reserveBrokerStartup(home,caller);
  try{
    if(current){
      const identity=await processIdentity(current.pid);
      if(current.runtime?.generation&&identity.startedAt!==current.runtime.generation)throw new BridgeError('broker_changed','协调器已改变，请重新运行引导命令。');
      const rpc=await connectBroker(home);
      try{await rpc.request('shutdown',{releaseOwned:false,startupToken:release.token,expectedBroker:{pid:current.pid,generation:current.runtime?.generation}},{mutation:true,timeout:60000});}
      catch(error){if(!(error instanceof DeliveryError&&error.uncertain))throw error;}
      finally{rpc.close();}
      const deadline=Date.now()+15000;
      for(;;){const state=await ownedProcessState(identity);if(state==='dead')break;if(state==='unknown'||Date.now()>=deadline)throw new BridgeError('broker_stop_timeout','旧协调器尚未核验退出，未启动第二个协调器。');await delay(100);}
    }
    await release.assertCurrent();
    const rpc=await ensureBroker(home,{bootstrap:true,reserved:true});
    try{
      const ready=await rpc.request<{pid:number;runtime?:{windowsIndependent?:boolean}}>('ping',{});
      if(process.platform==='win32'&&!ready.runtime?.windowsIndependent)throw new BridgeError('background_launch_unconfirmed','协调器入口未提供经过原生验证的独立运行证据。');
      recordBackgroundState(home);
      return{text:`后台协调器已独立运行（进程 ${ready.pid}），关闭任何 Claude 或 Codex 窗口都不会影响它。`};
    }finally{rpc.close();}
  }finally{await release();}
}
