import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bridgeHome, codexHome, claudeHome, ipcAddress } from '../../shared/local-paths.js';
import { disabledMember } from '../../broker/member-state.js';
import {BridgeError} from '../../shared/errors.js';
import {isEmbeddedWake,type Host} from '../../types.js';

                                              
async function request(home:string,method:string,params:unknown,timeout:number):Promise<any>{
  let token:string;try{token=readFileSync(path.join(home,'run','token'),'utf8').trim();}catch(error){throw Object.assign(error as Error,{hookUnsubmitted:true});}
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(ipcAddress(home));let submitted=false,done=false,buffer='';
    const finish=(error?:unknown,result?:unknown)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(error)reject(Object.assign(error as Error,submitted?{}:{hookUnsubmitted:true}));else resolve(result);};
    const timer=setTimeout(()=>finish(new BridgeError('timeout','hook 客户端等待协调器超时，结果尚未确认。')),Math.max(1,timeout));
    socket.setEncoding('utf8');socket.once('connect',()=>{submitted=true;socket.write(JSON.stringify({jsonrpc:'2.0',id:1,method,params,token})+'\n');});
    socket.on('error',error=>finish(error));socket.on('close',()=>finish(new BridgeError('disconnected','hook 客户端连接已断开，结果尚未确认。')));
    socket.on('data',(chunk:string)=>{
      buffer+=chunk;if(buffer.length>4*1024*1024){finish(new BridgeError('response_too_large','hook 响应超过限制。'));return;}
      const at=buffer.indexOf('\n');if(at<0)return;
      try{const reply=JSON.parse(buffer.slice(0,at));if(reply.id!==1)throw new Error('hook 响应编号无效');if(reply.error)finish(Object.assign(new BridgeError(String(reply.error.code),String(reply.error.message)),reply.error.data??{}));else finish(undefined,reply.result);}
      catch(error){finish(error);}
    });
  });
}

export async function hookClient(host:Host,input:any,provided:(ack:()=>Promise<void>)=>void,fallback:()=>Promise<unknown>):Promise<unknown>{
  const home=bridgeHome(),control=input.hook_event_name==='UserPromptSubmit'&&!input.agent_id&&!input.agent_transcript_path&&typeof input.prompt==='string'&&/^\s*nxbridge\s+(?:on|off|status)(?:\s+(?:self|codex|claude))?\s*$/.test(input.prompt);
  try{
    if(!control&&disabledMember(home,{host,sessionId:input.session_id})){input.nxbridge_disabled=true;return host==='codex'&&input.hook_event_name==='UserPromptSubmit'&&isEmbeddedWake(input.prompt)?{continue:false}:{};}
    const state=path.join(home,'setup-state.json');
    if(existsSync(state)&&JSON.parse(readFileSync(state,'utf8').replace(/^\uFEFF/,'')).disabled)return fallback();
  }catch{return fallback();}
  const inherited=Number(process.env.NXBRIDGE_HOOK_STARTED_AT),age=performance.timeOrigin-inherited,startedAt=Number.isFinite(inherited)&&age>=0&&age<10000?inherited:performance.timeOrigin;
  const timeout=()=>Math.max(1,(host==='codex'&&['Interrupt','SessionEnd'].includes(input.hook_event_name)?2300:9000)-(Date.now()-startedAt));
  let reply:any;
  const peerId=process.env.NXBRIDGE_MANAGED_PEER,marker=process.env.NXBRIDGE_OWNED_LAUNCH;
  try{reply=await request(home,host==='claude'?'hook.client.claude':'hook.client',{hook_pid:process.pid,config_home:host==='claude'?claudeHome():codexHome(),cwd:process.cwd(),started_at:startedAt,elapsed_ms:performance.now(),input,...(host==='claude'?{messaging_socket:process.env.CLAUDE_CODE_MESSAGING_SOCKET||undefined,owned_launch:peerId&&marker?.startsWith('claude:')?{peerId,launchId:marker.slice(7)}:undefined}:{})},timeout());}
  catch(error){
    const detail=error as {hookUnsubmitted?:boolean;code?:string};
    if(detail.hookUnsubmitted||['unknown_method','-32601','starting','hook_identity_unavailable'].includes(detail.code??'')||host==='claude'&&['process_identity_unknown','native_identity_unavailable'].includes(detail.code??''))return fallback();
    throw error;
  }
  if(reply?.disabled)input.nxbridge_disabled=true;
  if(typeof reply?.receipt==='string')provided(async()=>{await request(home,'hook.client.ack',{receipt:reply.receipt},timeout());});
  return reply?.output??{};
}
