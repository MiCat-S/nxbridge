import { call, markOff } from './mod-control.js';
import { inputSource, attestedHuman, refuseHuman } from './human-origin.js';

                                                     
                                                                          
                                                                                                                                               
const SPEC={name:'set_enabled',isDeferred:true,description:"switch nxbridge for self or partner, ONLY on user's explicit request. off keeps window, pair + queued msgs, never starts a replacement. model can only turn off; turning on needs user: type /nxbridge on [codex|claude] in a native input, or run `nxbridge on <codex|claude>` in a terminal",inputSchema:{type:'object',properties:{target:{type:'string',enum:['self','partner']},enabled:{type:'boolean'},user_requested:{type:'boolean',const:true}},required:['target','enabled','user_requested'],additionalProperties:false}};
let tool;
export async function switchStart($){tool=(await $.tool.register(SPEC)).tool;}
export async function switchCall($,e,next){
  if(!tool||e.tool!==tool)return next(e);
  if(e.agentId)return{deny:'nxbridge set_enabled: root session only'};
  const input=e;
  if(input.user_requested!==true||!['self','partner'].includes(input.target)||typeof input.enabled!=='boolean')return{deny:'nxbridge set_enabled: need target self|partner, enabled bool, user_requested true'};
                                                                                                    
  if(input.enabled)return{result:'not done: turning nxbridge on needs the user; tell user to type `/nxbridge on` (this window) or `/nxbridge on codex` (partner) in the input box, or run `nxbridge on <claude|codex>` in a terminal'};
  try{const value=await call($,'switch',{target:input.target,enabled:false});if(input.target==='self')markOff(true);return{result:value?.message??'nxbridge off'};}
  catch(error){return{result:'not switched: '+(error?.model_message||error?.message||'call failed')};}
}
                                                         
export const SWITCH_COMMAND=/^(on|off)(?:\s+(self|claude|codex))?$/;
export async function switchCommand($,e){
  const match=SWITCH_COMMAND.exec(e.args?.trim()??'');
  const source=await inputSource($,e);
  if(!attestedHuman(e,source))return refuseHuman($,'switch',source,'开关命令必须由你本人在这个 Claude 窗口的输入框里提交。也可以在系统终端（Terminal.app、Windows Terminal 等，不是 Claude 里的终端面板）运行 nxbridge on claude 或 nxbridge on codex。');
  const target=match[2]==='codex'?'partner':'self';
  try{const value=await call($,'switch',{target,enabled:match[1]==='on',origin:'composer'});if(target==='self')markOff(match[1]!=='on');return{text:value?.message??(match[1]==='on'?'已开启':'已关闭')};}
  catch(error){return{text:'未切换：'+(error?.message??String(error))};}
}
