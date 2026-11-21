import type { Host } from '../../types.js';

export interface CandidateDisplay {host:Host;name?:string;pid:number|null;state:string;observed_at:number;activity_at:number|null;opened_at:number|null}
export const hostLabel=(host:Host)=>host==='codex'?'Codex':'Claude';
export function candidateLabel(value:CandidateDisplay,duplicate=false):string{
  const name=value.name?.trim(),label=name?(name.length>24?name.slice(0,24)+'…':name):'未命名 '+hostLabel(value.host)+' 窗口';
  return label+(duplicate&&value.pid?'（进程 '+value.pid+'）':'');
}
export function candidateDescription(value:CandidateDisplay,now=Date.now()):string{
  let state: string=({ready:'空闲',busy:'忙碌',needsHuman:'等待人工处理',paused:'已暂停（你在该窗口中断过）；配对后消息等你在那边继续时送达'} as Record<string,string>)[value.state]??'状态未知';
  if(now-value.observed_at>120000)state+='（'+Math.floor((now-value.observed_at)/60000)+' 分钟前所见）';
  const parts=[state];
  if(value.activity_at!==null){const minutes=Math.max(0,Math.floor((now-value.activity_at)/60000));parts.push(minutes<1?'刚刚活跃':minutes<60?minutes+' 分钟前活跃':minutes<1440?Math.floor(minutes/60)+' 小时前活跃':'今天未活跃');}
  if(value.opened_at!==null){const opened=new Date(value.opened_at),today=new Date(now),time=String(opened.getHours()).padStart(2,'0')+':'+String(opened.getMinutes()).padStart(2,'0');parts.push((opened.toDateString()===today.toDateString()?'':(opened.getMonth()+1)+'月'+opened.getDate()+'日 ')+time+' 打开');}
  if(value.pid)parts.push('进程 '+value.pid);return parts.join(' · ');
}
