import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Host } from '../types.js';

export interface MemberContext {host:Host;sessionId?:string;memberId?:string;pid?:number;procStart?:string;configHome?:string}
export interface DisabledRecord {peerId:string;host:Host;sessionId:string|null;windows:{pid:number;procStart:string;configHome?:string;threadScoped:boolean}[]}
                               
export function disabledMember(home:string,context:MemberContext):DisabledRecord|undefined{
  const file=path.join(home,'member-control.json');if(!existsSync(file))return;
  const {members,active=[]}=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')) as {members:DisabledRecord[];active?:DisabledRecord[]};
  const sameHome=(window:DisabledRecord['windows'][number])=>!context.configHome||!window.configHome||path.resolve(window.configHome)===path.resolve(context.configHome);
  const exact=(member:DisabledRecord)=>member.host===context.host&&member.windows.some(window=>window.pid===context.pid&&window.procStart===context.procStart&&sameHome(window)&&(!window.threadScoped||member.sessionId===context.sessionId));
  if(context.memberId)return members.find(member=>member.host===context.host&&member.peerId===context.memberId);
  if(context.pid&&context.procStart){
    if(active.some(exact))return;
    const found=members.find(exact);if(found)return found;
    if(members.some(member=>member.host===context.host&&member.windows.some(window=>window.pid===context.pid)))return;
  }
  if(!context.sessionId||active.some(member=>member.host===context.host&&member.sessionId===context.sessionId))return;
  const matches=members.filter(member=>member.host===context.host&&member.sessionId===context.sessionId&&(!context.configHome||member.windows.length===0||member.windows.some(sameHome)));
  return matches.length===1?matches[0]:undefined;
}
