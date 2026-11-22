import net from 'node:net';
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {DeliveryError,BridgeError,describeError} from '../../shared/errors.js';
import {type DeliveryResult,type Endpoint,type Peer} from '../../types.js';
import {claudeHome} from '../../shared/local-paths.js';
import {readJson} from '../../shared/files.js';
import { liveProcess, matchesProcess, processIdentity } from '../../process/process.js';
import type { DeliveryMessage } from '../../broker/delivery/file-references.js';
import { modelPeerName } from '../../integration/mcp/model-output.js';
import { storageError, StorageBusyError, preSubmitError } from '../../storage/storage-errors.js';

export interface SessionRecord {sessionId:string;cwd:string;procStart?:string;procStartFt?:string;pidDomain?:string;pid?:number;name?:string;status?:string;messagingSocketPath?:string}

export function canonicalPipe(address:string):string {
  const match=/^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(address);
  if(!match||match[2]==='.'||match[2]==='..'||/[. ]$/.test(match[2]!)||(address.startsWith('\\\\?\\')&&address.includes('/')))throw new BridgeError('invalid_inbox','无效的 Claude Windows inbox 管道。');
  return '\\\\.\\pipe\\'+(match[1]?'local\\':'')+match[2]!.replace(/[A-Z]/g,c=>c.toLowerCase());
}
export function peerKeyFile(pid:number,address:string,home=claudeHome()):string {
  return path.join(home,'sessions',`${pid}.${createHash('sha256').update(canonicalPipe(address)).digest('hex')}.key`);
}
                                                    
const cleanName=(name:string)=>{const n=[...name.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}"<>]/gu,'').trim()];return n.length>64?n.slice(0,64).join('')+'…':n.join('');};
export const peerAddress=(address:string):string=>'uds:'+address.replace(/[^A-Za-z0-9:_/.\\-]/gu,c=>[...Buffer.from(c)].map(b=>'%'+b.toString(16).toUpperCase().padStart(2,'0')).join(''));

export function encodePeerMessage(message:DeliveryMessage,sender:Peer,targetSession:string,replyAddress?:string):Record<string,unknown>{
  const name=modelPeerName(sender);
                               
  const attributes=[...(replyAddress?[`from="${peerAddress(replyAddress)}"`]:[]),`from-name="${cleanName(name===`nxbridge:${sender.host}`?name:`${name} (nxbridge:${sender.host})`)}"`,...(sender.permission==='prompting'?['from-mode="prompting"']:sender.permission==='bypass'?['from-mode="bypass"']:[])];
  const body=`[nxbridge ${message.notice?'system_notice source='+(message.noticeSource??'runtime_monitor')+' notice_id':'message_id'}=${message.id}${!message.notice&&message.replyExpected?' reply_expected':''}${message.inReplyTo?` in_reply_to=${message.inReplyTo}`:''}]\n${message.body.replaceAll('</cross-session-message>','&lt;/cross-session-message&gt;')}${message.hint?'\n\n'+message.hint:''}`;
  return{msgV:1,msg_id:message.id,uuid:message.id,session_id:targetSession,type:'user',message:{role:'user',content:`<cross-session-message ${attributes.join(' ')}>\n${body}\n</cross-session-message>`},priority:'next',...(replyAddress?{from:peerAddress(replyAddress)}:{})};
}

                                           
export async function deliverClaudeInbox(peer:Peer,endpoint:Endpoint,message:DeliveryMessage,sender:Peer,directory:()=>string,replyAddress?:()=>Promise<string>):Promise<DeliveryResult>{
  if(!peer.sessionId||!endpoint.pid||!liveProcess(endpoint.pid))throw preSubmitError(new DeliveryError('offline','Claude 会话不在线。'),'inbox.preflight','enqueue');
  let token:string|undefined,reply:string|undefined;
  try{
    const home=directory(),record=readJson<SessionRecord>(path.join(home,'sessions',`${endpoint.pid}.json`));
    if(record.sessionId!==peer.sessionId||(record.procStartFt??record.procStart??null)!==endpoint.procStart)throw new DeliveryError('stale_endpoint','Claude 会话或进程代次已改变，等待重新登记。');
    const native=await processIdentity(endpoint.pid);
                                                     
    if(['Z','X'].includes(native.state??''))throw new DeliveryError('offline','Claude 会话已经退出。');
    if(!matchesProcess(record,native))throw new DeliveryError('stale_endpoint','Claude 会话或进程代次已改变，等待重新登记。');
    if(process.platform==='win32'){
      const key=readJson<{peerToken:string;procStart?:string;procStartFt?:string}>(peerKeyFile(endpoint.pid,endpoint.address,home));
      if(typeof key.peerToken!=='string'||!key.peerToken||(key.procStartFt??key.procStart??null)!==endpoint.procStart)throw new DeliveryError('peer_key_mismatch','Claude peer key 与当前进程不匹配。');
      token=key.peerToken;
    }else{
      const stat=lstatSync(endpoint.address);
      if(!stat.isSocket()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw new DeliveryError('invalid_inbox','Claude inbox 不是当前用户的 Unix socket。');
      reply=await replyAddress?.();
    }
  }catch(error){throw preSubmitError(error instanceof DeliveryError?error:new DeliveryError('inbox_preflight',describeError(error)),'inbox.preflight','enqueue');}
  let cancelled=false;
  await new Promise<void>((resolve,reject)=>{
    const socket=net.createConnection(endpoint.address);let submitted=false,settled=false;
    const deadline=performance.now()+3000;
    const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(submitted?error:preSubmitError(error,'inbox','enqueue')):resolve();};
    const timer=setTimeout(()=>finish(new DeliveryError('inbox_timeout','Claude inbox 连接超时。',submitted)),3000);
    socket.once('connect',()=>{
      void (async()=>{
                                           
          if(settled)return;
        if(message.beforeSubmit&&!await message.beforeSubmit(deadline)){cancelled=true;finish();return;}
        if(settled)return;
        if(performance.now()>=deadline){finish(new DeliveryError('inbox_timeout','Claude inbox 提交前等待超时。'));return;}
                                           
        const fresh=message.senderSnapshot?.()??sender;
        const payload=encodePeerMessage(message,{...sender,permission:fresh.id===sender.id&&fresh.sessionId===sender.sessionId?fresh.permission:'unknown'},peer.sessionId!,reply);
                                      
        submitted=true;
        socket.write((token?JSON.stringify({type:'auth',token})+'\n':'')+JSON.stringify(payload)+'\n',error=>{
          if(error){finish(new DeliveryError('inbox_write',error.message,submitted));return;}
                                            
          setTimeout(()=>finish(),200).unref();
        });
        })().catch(error=>{const typed=storageError(error,'inbox.beforeSubmit',submitted?undefined:'enqueue');if(typed instanceof StorageBusyError){typed.uncertain=submitted;if(submitted)typed.phase=undefined;finish(typed);}else finish(error instanceof DeliveryError?error:new DeliveryError('inbox_pre_submit',describeError(error),submitted));});
    });
    socket.once('error',error=>finish(new DeliveryError('inbox_error',error.message,submitted)));
    socket.once('close',()=>{if(!settled)finish(new DeliveryError('inbox_closed','Claude 在观察窗口内关闭 inbox；认证或策略状态待核对。',submitted));});
  });
  if(cancelled)return{state:'expired',evidence:'通知条件已恢复或上下文已改变，未提交。'};
  return{state:'unknown',evidence:'peer inbox 写入完成；等待宿主观察或关联回复，不能据此认定已读'};
}
