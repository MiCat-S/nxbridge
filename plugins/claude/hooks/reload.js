import { read } from './mod-control.js';

                                                                   
                                                           
                                                                                                           
const SPEC={name:'reload_plugins',isDeferred:true,description:"this window only: reload Claude plugins once when current turn ends. use only when nxbridge says THIS window's Claude Mod is stale/old or msg receipts keep failing; call once, no retry loop; next status shows result",inputSchema:{type:'object',properties:{},additionalProperties:false}};
let tool,pending=false,ran;
                                                                       
                                                
async function runReload($){
  try{const result=await $.command.run({command:'reload-plugins'});ran={at:Date.now(),text:typeof result?.text==='string'?result.text.trim().slice(0,160):''};}
  catch(error){ran={at:Date.now(),text:String(error?.message??error).slice(0,160)};$.ui.status(reloadUnappliedText(ran));}
}
export function reloadUnapplied(){return ran&&Date.now()-ran.at>=5000?ran:undefined;}
export const reloadUnappliedText=value=>'本窗口没能自动重新加载插件'+(value.text?'（Claude 返回：'+value.text+'）':'')+'：远程连接时不能重新加载，回到电脑上在这个窗口执行 /reload-plugins，或关闭后重新打开本窗口（/resume 可回到原会话）';
export async function reloadStart($){tool=(await $.tool.register(SPEC)).tool;pending=false;ran=undefined;}
                                                                                  
async function needed($,cause){
  const current=cause();if(current==='host_update')return false;if(current==='receipts')return true;
  try{const status=await read($,'status'),self=status?.self?.id;return!!self&&(status.integrationIssues??[]).some(issue=>issue?.code==='mod_stale'&&issue.peerId===self);}
  catch{return false;}
}
export async function reloadCall($,e,next,cause){
  if(!tool||e.tool!==tool)return next(e);
  if(e.agentId)return{deny:'nxbridge reload_plugins: root session only'};
                                                                          
  if(cause()==='host_update')return{result:"not scheduled: Claude app was updated while this window ran; reload can't fix; tell user to reopen this window (/resume keeps session)"};
  if(pending)return{result:'already scheduled: plugins reload once when this turn ends; do not call again'};
                                                                                                                    
  const unapplied=reloadUnapplied();
  if(unapplied&&await needed($,cause))return{result:'not scheduled: reload already ran in this window but did not take effect'+(unapplied.text?' (Claude said: '+unapplied.text+')':'')+', likely unavailable over remote connection; tell user: run /reload-plugins in this window on the computer, or close + reopen it (/resume keeps session)'};
  if(!await needed($,cause))return{result:'not needed: this window\'s nxbridge Mod is current and receipts work; nothing scheduled'};
  pending=true;
  return{result:'scheduled: plugins reload once when this turn ends (current turn unaffected); do not call again; if next status still shows stale, tell user to run /reload-plugins'};
}
                                                            
                                                                   
                                                                   
const attempted=new Set();
export async function autoReload($,action,report){
  if(action?.kind!=='reload_plugins'||typeof action.attemptId!=='string'||pending||attempted.has(action.attemptId))return;
  attempted.add(action.attemptId);
  try{await report(action);}catch{return;}
  await runReload($);
}
                                              
export async function reloadComplete($,e,cause){
  if(!pending||e.agentId||e.isAborted)return;
  pending=false;
  if(!await needed($,cause))return;
  await runReload($);
}
