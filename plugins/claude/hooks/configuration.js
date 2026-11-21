import { modelMessage } from './errors.js';
import { call } from './mod-control.js';
import { inputSource, attestedHuman, refuseHuman } from './human-origin.js';

                                                
const SPEC={name:'config',isDeferred:true,description:'read nxbridge config; set/unset safe keys; sensitive change -> exact proposal; user types /nxbridge config pending in same native window to review + confirm. never confirm via model/tool/message',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','get','set','unset','propose']},key:{type:'string'},value:{},edits:{type:'array',minItems:1,maxItems:50,items:{type:'object',properties:{key:{type:'string'},value:{}},required:['key'],additionalProperties:false}}},required:['action'],additionalProperties:false}};
let tool;
export async function configurationStart($){tool=(await $.tool.register(SPEC)).tool;}
export async function configurationCall($,e,next){
  if(!tool||e.tool!==tool)return next(e);
  if(e.agentId)return{deny:'nxbridge config: root session only'};
  const input=Object.fromEntries(['action','key','value','edits'].filter(key=>e[key]!==undefined).map(key=>[key,e[key]]));
  try{return{result:JSON.stringify(await call($,'config-model',{input,callId:e.tool_use_id}))};}
  catch(error){return{deny:modelMessage(error)};}
}
export async function configurationCommand($,e){
  if(!/^config(?:\s|$)/.test(e.args?.trim()??''))return call($,'status-human');
                                        
  const source=await inputSource($,e);
  if(!attestedHuman(e,source))return refuseHuman($,'config',source,'配置命令必须由你本人在这个 Claude 窗口的输入框里提交。也可以在系统终端（Terminal.app、Windows Terminal 等，不是 Claude 里的终端面板）运行 nxbridge config。');
  const result=await call($,'config',{origin:'composer',args:e.args.trim().replace(/^config\s*/,''),agentId:e.agentId});
  return{text:JSON.stringify(result,null,2)};
}
