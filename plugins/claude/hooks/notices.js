import { call, captureContext } from './mod-control.js';

const queued=new Map();
                                                
export const preSubmitBusy=error=>error?.code==='storage_busy'&&error.uncertain===false&&['prepare','enqueue'].includes(error.phase);
                                                                      
                                                              
export const retryable=error=>error?.uncertain===false&&['prepare','enqueue'].includes(error.phase);
const prefix='nxbridge notice pickup ';
export const isMonitorRecipient=value=>['nxbridge runtime monitor','nxbridge runtime monitor (nxbridge:claude)','nxbridge:claude'].includes(value);
                                                   
export function noticePickup(e){
  if(e.agentId||typeof e.text!=='string')return;
  if(e.origin?.kind==='plugin'&&e.text.startsWith(prefix))return e.text.slice(prefix.length);
  if(['peer','peer-send-message'].includes(e.origin?.kind)){
    const match=/^<cross-session-message from-name="nxbridge runtime monitor \(nxbridge:claude\)"(?: from-mode="[^"\r\n]+")?>\r?\n\[nxbridge system_notice source=runtime_monitor notice_id=([^\]\s]+)\]([\s\S]*?)<\/cross-session-message>\s*$/.exec(e.text);
                                    
    if(match&&['','nxbridge 运行状态有更新；本会话的 AI 将核验详情，必要时向你说明。'].includes(match[2].trim()))return match[1];
  }
}
const pickup=noticePickup;
                                                          
const STALE_DROP='nxbridge：这条提醒送达前问题已消失，已自动丢弃，无需处理';
                                                          
const DELIVERED_DROP='nxbridge：这条提醒已随前面的对话附上，无需处理';
                                                                 
const DEFERRED_DROP='nxbridge：Claude 正忙，这条提醒等空闲时再送，无需处理';
                                               
const delivered=new Set();
function remember(notice){
  for(const id of notice.componentIds??[])if(id!==notice.id){delivered.delete(id);delivered.add(id);if(delivered.size>64)delivered.delete(delivered.values().next().value);}
}
                                             
const OUTAGE_PREFIX='broker-outage:';
                                                       
async function releaseOutage($,id,context){try{await ack($,{id},context,'denied','outage_definitive_not_delivered');}catch{}}
const text=notice=>`[nxbridge system_notice source=${notice.source??'runtime_monitor'} notice_id=${notice.id}]\n${notice.message}`;
async function ack($,notice,context,state,error){try{await call($,'monitor-ack',{notice_id:notice.id,state,context,...(error?{error}:{})});}catch{}}
                                                                                    
async function prepare($,id,context,readyBoundary=false,result={}){
  if(await captureContext($)!==context)return;
  const response=await call($,'monitor-prepare',{notice_id:id,context,...(readyBoundary?{ready_boundary:true}:{})});
  if(response?.deferred===true)result.deferred=true;
  return await captureContext($)===context?response.notices?.find(n=>n.id===id):undefined;
}
                                                                    
                                                                                              
                                                     
const held=new Map();
export const hasHeld=()=>held.size>0;
function hold(id,context,report,notice){
  held.delete(id);held.set(id,{context,report,...(notice?{notice}:{})});
  if(held.size>32){const [oldest,lease]=held.entries().next().value;held.delete(oldest);lease.report('cancelled');}
}
                                                                 
export function upgradeHeld(id){const lease=held.get(id);if(!lease||lease.notice)return false;held.delete(id);return true;}
                                             
function absorb(notice){
  for(const id of notice.componentIds??[]){const lease=id!==notice.id&&held.get(id);if(lease&&!lease.notice){held.delete(id);lease.report('cancelled');}}
}
                                               
export async function takeHeld($,context){
  const entries=[];
  for(const id of [...held.keys()]){
    const lease=held.get(id);if(!lease)continue;
    held.delete(id);
    if(lease.context!==context){
                                  
      if(lease.notice)await ack($,lease.notice,lease.context,'denied','对话已切换，提醒未附上');
      lease.report('cancelled');continue;
    }
    if(lease.notice){entries.push({notice:lease.notice,lease,text:text(lease.notice)});continue;}
    let notice;
    try{notice=await prepare($,id,context);}
    catch(error){if(retryable(error))lease.report('retry',preSubmitBusy(error)?'数据库繁忙':String(error?.message??error));else lease.report('unknown',String(error?.message??error));continue;}
    if(!notice){lease.report('cancelled');continue;}
    if(typeof notice.message!=='string'||!notice.message.trim()){await ack($,notice,context,'unknown','运行时通知正文为空，未加入对话');lease.report('unknown','运行时通知正文为空');continue;}
    absorb(notice);
    entries.push({notice,lease,text:text(notice)});
  }
  return entries;
}
                                                       
export async function settleHeld($,entries,context,state,error){
  for(const {notice,lease} of entries){
    if(state==='requeue'){hold(notice.id,context,lease.report,notice);continue;}
    await ack($,notice,context,state,error);lease.report(state,error);
    if(state==='submitted')remember(notice);
  }
}
                                                       
const PASSIVE_DROP='nxbridge：这条提醒只需告知，会在下次对话时附上，未打扰 AI';
export async function noticePrompt($,e,next){
  const id=pickup(e);if(!id)return next(e);
  const lease=queued.get(id);
  if(!lease){
                                                          
    if(id.startsWith(OUTAGE_PREFIX))await releaseOutage($,id,await captureContext($));
    return{drop:delivered.has(id)?DELIVERED_DROP:STALE_DROP};
  }
  const {context,report}=lease;
  queued.delete(id);
  let notice;
  try{
    const prepared={};
    notice=await prepare($,id,context,e.isMeta===true&&!e.turnId,prepared);
    if(!notice&&prepared.deferred){report('cancelled');return{drop:DEFERRED_DROP};}
    if(!notice){
      if(id.startsWith(OUTAGE_PREFIX))await releaseOutage($,id,context);
      if(delivered.has(id)){report('submitted');return{drop:DELIVERED_DROP};}
      report('cancelled');return{drop:STALE_DROP};
    }
    if(typeof notice.message!=='string'||!notice.message.trim())throw Error('运行时通知正文为空，未加入对话');
    absorb(notice);
                                    
    if(notice.wake!==true&&!e.turnId){hold(id,context,report,notice);return{drop:PASSIVE_DROP};}
                                                      
    const entry=text(notice),attached=e.isMeta&&!e.turnId;
    const result=await next(attached?{...e,context:[...(e.context??[]),entry]}:{...e,text:entry});
    const missing=attached&&!result?.drop&&!result?.context?.includes(entry),error=result?.drop??(missing?'通知正文未出现在宿主上下文回执中':undefined);
    const state=result?.drop?'denied':missing?'unknown':'submitted';
    await ack($,notice,context,state,error);
    report(state,error);
    if(state==='submitted')remember(notice);
    return result;
  }catch(error){
                                                                
    if(!notice&&retryable(error)){report('retry',preSubmitBusy(error)?'数据库繁忙':String(error?.message??error));return{drop:'nxbridge：运行时通知暂时未能送达，稍后自动重试，无需处理'};}
    if(notice)await ack($,notice,context,'unknown',String(error));report('unknown',String(error));throw error;
  }
}
export function noticeFailure($,e,next){
  return !next.called&&pickup(e)?{drop:'nxbridge：运行时通知暂时无法核验，未加入对话'}:next(e);
}
export async function deliverNotice($,notice,context,report){
                                                 
  if(notice.wake===true){
    upgradeHeld(notice.id);
                                                        
    for(const[id,registered]of queued)if(registered.context!==context){queued.delete(id);if(id.startsWith(OUTAGE_PREFIX))await releaseOutage($,id,registered.context);}
    queued.set(notice.id,{context,report});
                                                                
    let result;try{result=await call($,'monitor-enqueue',{notice_id:notice.id,context});}catch(error){if(retryable(error))queued.delete(notice.id);throw error;}
                                                             
    if(result?.drop||result?.deferred===true)queued.delete(notice.id);
    return result;
  }
                                
  hold(notice.id,context,report);
  return{held:true};
}
