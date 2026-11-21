import path from 'node:path';
import { existsSync } from 'node:fs';
import {atomicJson,readJson} from '../shared/files.js';
import type { Store } from '../storage/store.js';
import type { Peer } from '../types.js';
import {BridgeError} from '../shared/errors.js';
export { disabledMember, type MemberContext } from './member-state.js';

const filename=(home:string)=>path.join(home,'member-control.json');
export const memberOffResult={enabled:false,disabled:true,code:'member_disabled',message:'此窗口的 nxbridge 已关闭；窗口与配对保留。用户可在任一窗口亲自输入 nxbridge on（Claude 使用 /nxbridge on），或在独立终端执行 nxbridge on <宿主> --member <成员 ID>。'} as const;
export function memberOffResultFor(peer:Pick<Peer,'host'|'id'>){
  const enable_command=`nxbridge on ${peer.host} --member ${peer.id}`;
  return{...memberOffResult,enable_command,message:`${peer.host} 成员 ${peer.id} 的 nxbridge 已关闭；窗口、配对和已排队消息保留。用户可亲自在窗口输入 nxbridge on ${peer.host}（Claude 使用 /nxbridge on ${peer.host}），或在独立终端执行 ${enable_command}。`};
}
export const MEMBER_CONTROL_TOOL={name:'set_enabled',description:'disable nxbridge only on explicit user request (enabled=false), target=self or partner; keep windows, pair and pending msgs; never starts a replacement background partner. AI cannot enable either side; user must type nxbridge on in a native window (/nxbridge on in Claude), or run nxbridge on <host> --member <member ID> in an independent terminal',inputSchema:{type:'object' as const,properties:{target:{type:'string',enum:['self','partner']},enabled:{type:'boolean'},user_requested:{type:'boolean',const:true}},required:['target','enabled','user_requested'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}};

export function writeMemberControls(home:string,store:Store):void{
  const records=store.peers().map(peer=>({peer,record:{peerId:peer.id,host:peer.host,sessionId:peer.sessionId,windows:store.endpoints(peer.id).flatMap(endpoint=>{
    const native=endpoint.native??endpoint;return native.pid&&native.procStart?[{pid:native.pid,procStart:native.procStart,...(endpoint.configHome?{configHome:endpoint.configHome}:{}),threadScoped:!!endpoint.daemon||endpoint.mode==='app-server'||endpoint.processKind==='app-server'}]:[];
  })}}));
  const members=records.filter(({peer})=>!memberEnabled(store,peer)).map(({record})=>record),active=records.filter(({peer})=>memberEnabled(store,peer)&&members.some(member=>member.host===peer.host&&member.sessionId===peer.sessionId)).map(({record})=>record);
  const value={members,active};if(existsSync(filename(home))&&JSON.stringify(readJson(filename(home)))===JSON.stringify(value))return;
  atomicJson(filename(home),value);
}

export function memberEnabled(store:Store,peer:Peer):boolean{
  if(peer.enabled===false)return false;
  if(!peer.rootPeerId)return true;
  const root=store.getPeer(peer.rootPeerId);return !!root&&root.enabled!==false;
}

                                          
export function requireMemberEnabled(store:Store,peer:Peer):void{
  const current=store.getPeer(peer.id);
  if(current&&memberEnabled(store,current))return;
  const result=memberOffResultFor(peer.enabled!==false&&peer.rootPeerId?store.getPeer(peer.rootPeerId)??peer:peer);
  throw Object.assign(new BridgeError('member_disabled',result.message),{enable_command:result.enable_command});
}
