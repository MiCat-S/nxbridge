import path from 'node:path';
import { readFileSync } from 'node:fs';
import {BridgeError} from '../../shared/errors.js';
import {type ModelProfile} from '../../types.js';

export function claudeProfileSettings(profile:ModelProfile):Record<string,string|number>{
  return{...(profile.model?{model:profile.model}:{}),...(profile.effort!==undefined?{effortLevel:profile.effort}:{})};
}
export function claudeProfileArgs(profile:ModelProfile):string[]{
  return[...(profile.model?['--model',profile.model]:[]),...(profile.effort!==undefined?['--effort',String(profile.effort)]:[])];
}

                                                           
export function claudeLaunchArgs(prefix:string[],args:string[],cwd:string):string[]{
  const argv=[...prefix,...args],layers:{index:number;length:number;value:string}[]=[];
  for(let index=0;index<argv.length;index++){
    const arg=argv[index]!;if(arg==='--')break;
    if(arg==='--settings'&&argv[index+1]!==undefined){layers.push({index,length:2,value:argv[index+1]!});index++;}
    else if(arg.startsWith('--settings='))layers.push({index,length:1,value:arg.slice(11)});
  }
  if(layers.length<2||!layers.some(layer=>layer.index<prefix.length)||!layers.some(layer=>layer.index>=prefix.length))return argv;
  let settings:Record<string,unknown>={};
                                         
  for(const layer of [layers.filter(layer=>layer.index<prefix.length).at(-1)!,layers.filter(layer=>layer.index>=prefix.length).at(-1)!]){
    let value:unknown;
    try{const input=layer.value.trim(),json=(input.startsWith('{')?input:readFileSync(path.resolve(cwd,layer.value),'utf8')).replace(/^\uFEFF/,'');value=JSON.parse(json.trim()?json:'{}');}
    catch{throw new BridgeError('invalid_config',`hosts.claude.command 里的 --settings 无法读取或解析，未启动后台。相对路径基于后台搭档的项目目录 ${cwd}；请改成完整路径，或直接传入 JSON 对象。`);}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new BridgeError('invalid_config','自定义 Claude 命令的 --settings 必须是 JSON 对象，未启动后台。');
                                             
    settings={...settings,...value};
  }
  const last=layers.at(-1)!,drop=new Set(layers.flatMap(layer=>Array.from({length:layer.length},(_,offset)=>layer.index+offset)));
  return argv.flatMap((arg,index)=>index===last.index?['--settings',JSON.stringify(settings)]:drop.has(index)?[]:[arg]);
}
