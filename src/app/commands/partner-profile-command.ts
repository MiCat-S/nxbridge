import { z } from 'zod';
import { administrativeTarget } from '../../broker/pairing/admin-target.js';
import { brokerCall } from '../../ipc/ipc.js';
import {BridgeError} from '../../shared/errors.js';
import {type Host} from '../../types.js';
import { hostLabel } from '../../broker/pairing/pair-presentation.js';

export async function partnerProfileCommand(args:string[]):Promise<unknown>{
  const host=z.enum(['codex','claude']).parse(args[0]),target:string[]=[],profile:{model?:string;effort?:string}={};let reset=false;
  for(let index=1;index<args.length;index++){
    const flag=args[index]!;
    if(flag==='--json')continue;
    if(flag==='--reset'){if(reset)throw new BridgeError('invalid_arguments','--reset 不能重复。');reset=true;continue;}
    const value=args[++index];if(!value||value.startsWith('--'))throw new BridgeError('invalid_arguments','参数缺少值：'+flag);
    if(flag==='--model'||flag==='--effort'){const field=flag==='--model'?'model':'effort';if(profile[field]!==undefined)throw new BridgeError('invalid_arguments','参数不能重复：'+flag);profile[field]=value;}
    else if(['--pair','--member','--session'].includes(flag))target.push(flag,value);
    else throw new BridgeError('invalid_arguments','未知参数：'+flag);
  }
  if(reset&&(profile.model!==undefined||profile.effort!==undefined))throw new BridgeError('invalid_arguments','--reset 不能与 --model/--effort 同用。');
  return brokerCall('partner.profile',{...await administrativeTarget(target),host,...profile,action:reset?'reset':Object.keys(profile).length?'set':'get'},{mutation:reset||Object.keys(profile).length>0});
}

interface ProfileView {host:Host;effective:{model?:string;effort?:string|number};requested?:{model?:string;effort?:string|number};status:'pending'|'applied'|'failed'|'host';delivery_held?:boolean;source?:'defaults'|'explicit';session_id?:string|null;error?:{code:string;message:string}}
const describe=(profile:{model?:string;effort?:string|number}|undefined)=>[profile?.model!==undefined?'模型 '+profile.model:'',profile?.effort!==undefined?'推理强度 '+profile.effort:''].filter(Boolean).join('，');
const reason=(view:ProfileView)=>(view.error?.message??'原因未知').trim().replace(/[。.]+$/,'');
                          
export function formatPartnerProfile(view:ProfileView):string{
  const current=describe(view.effective)||'模型和推理强度还没有报告',requested=describe(view.requested);
  const state=view.status==='host'?'没有单独指定，按默认设置。':!requested?'没有单独指定；当前会话保持上面的设置。'
    :view.status==='applied'&&view.delivery_held?`正在重新核对${requested}是否仍然生效；核对完之前，新消息先不发给它。一直停在这里时，可以运行 nxbridge partner-profile ${view.host} --reset 放弃这次选择。`
    :view.status==='applied'?(view.source==='explicit'?'这是为它指定的设置，已生效。':'按默认设置，已生效。')
    :view.status==='pending'?(view.session_id?`已记下${requested}，正在等它生效并核对（它正在工作时会等这一轮做完）${view.delivery_held?`；在这之前，新消息先不发给它。一直停在这里时，可以运行 nxbridge partner-profile ${view.host} --reset 放弃这次选择`:''}。`:`已记下${requested}，它启动时就用这个设置。`)
    :view.delivery_held?`上次修改（${requested}）结果不明，或者实际设置和指定的不一致：${reason(view)}。核对清楚之前，新消息先不发给它；要放弃这次修改，运行 nxbridge partner-profile ${view.host} --reset。`
    :`修改（${requested}）没有成功：${reason(view)}。它继续用原来的设置。`;
  return `后台 ${hostLabel(view.host)}：${current}。${state?'\n'+state:''}\n`;
}
