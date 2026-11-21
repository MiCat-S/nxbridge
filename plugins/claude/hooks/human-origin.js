import { call, captureContext } from './mod-control.js';

                                                                         
                                                                       
                                                                                       
const APP_SURFACES=new Set(['desktop','vscode']);
export async function inputSource($,e){
  const kind=typeof e.origin?.kind==='string'?e.origin.kind:'none';
  let surfaces=[];
  if(kind==='sdk')try{surfaces=[...(await $.session.surfaces())].filter(value=>typeof value==='string');}catch{                      }
  return{kind,surfaces};
}
                                             
export function attestedHuman(e,source,{bridge=false}={}){
  if(e.agentId)return false;
  return source.kind==='composer'||bridge&&source.kind==='bridge'||source.kind==='sdk'&&source.surfaces.some(value=>APP_SURFACES.has(value));
}
                                                 
export async function humanPrompt($,e){
  const source=await inputSource($,e);
  if(attestedHuman(e,source,{bridge:true}))return true;
  if(e.agentId||source.kind!=='sdk')return false;
  try{
    const context=await captureContext($);
    const policy=await call($,'config-model',{context,input:{action:'get',key:'hosts.claude.sdk_user_prompt'}});
    return policy?.value===true&&await captureContext($)===context;
  }catch{                                return false;}
}
                                                
export async function refuseHuman($,command,source,text){
  try{await call($,'human-refused',{command,origin:source.kind,surfaces:source.surfaces});}catch{                    }
  if(source.kind==='sdk'&&!source.surfaces.some(value=>APP_SURFACES.has(value)))text+='通过 SDK 接入的第三方界面（如 Paseo）提交的命令不算本人确认；hosts.claude.sdk_user_prompt 只放开普通输入，不放开命令。';
  return{text};
}
