import { open } from 'node:fs/promises';
import { codexChildResult, codexQueuedAgentMetadata } from './codex-subagent-read.js';

interface Final {itemId:string;text:string;at:number}
interface Injection {messageId:string;itemId:string;historySequence:number}
interface SampledInjection extends Injection {sampledThroughSequence:number}

export interface CodexCompletedTurn {
  turnId:string;startedAt:number;completedAt:number;
  trigger?:string;parentTurnId?:string;userInputs:(string|null)[];
  final?:Final;lastWorkAt?:number;sampledInjection?:SampledInjection;childTurnIds?:string[];
}

export interface CodexTurnEvidence {
  status:'supported'|'unsupported'|'unavailable';caughtUp:boolean;turns:CodexCompletedTurn[];
  latestTurnId?:string;openTurnId?:string;bytesRead:number;
}

interface ActiveTurn extends Omit<CodexCompletedTurn,'completedAt'> {
  answer?:{itemId:string;at:number;text?:string;canonical:boolean};
  pendingUserInputs:number;calls:Map<string,boolean>;sawModel:boolean;
  injection?:Injection;children?:{ids:string[];sequence:number};
}

interface Cursor {
  dev:number;ino:number;size:number;mtime:number;offset:number;tail:Buffer;skipping:boolean;
  idleBoundary:boolean;queuedAgentMetadata:boolean;lastCompletedAt?:number;latestTurnId?:string;
  active?:ActiveTurn;turns:CodexCompletedTurn[];
  offeredCall?:{id:string;sequence:number};offeredInjection?:Injection;
}

const HEADER_BYTES=64*1024,SCAN_BYTES=8*1024*1024,MAX_LINE=4*1024*1024,CHUNK=128*1024,SCAN_MS=60;
const cursors=new Map<string,Cursor>(),pending=new Map<string,Promise<CodexTurnEvidence>>();
const startEvents=new Set(['task_started','turn_started']);
const completeEvents=new Set(['task_complete','turn_complete']);
const workItems=new Set(['CommandExecution','FileChange','WebSearch','ImageGeneration','ImageView','CollabAgentToolCall']);
const workCalls=new Set(['function_call','custom_tool_call','local_shell_call','web_search_call','image_generation_call','computer_call']);
const systemUserKinds=new Set(['multi_agent.subagent_notification']);
const systemUserSources=new Set(['agents_md','harness','skills']);
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
const sequence=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const sendTool=(name:string)=>name==='send_message'||name==='mcp__claude__send_message';
const sampleModel=(p:any)=>p.type==='reasoning'||p.role==='assistant'&&p.type==='message'||workCalls.has(p.type);

function resetEvidence(cursor:Cursor):void{
  cursor.idleBoundary=false;
  cursor.queuedAgentMetadata=false;
  cursor.active=cursor.offeredCall=cursor.offeredInjection=undefined;
  cursor.latestTurnId=cursor.lastCompletedAt=undefined;
  cursor.turns=[];
}

function start(cursor:Cursor,p:any,at:number):void{
  if(!id(p.turn_id))return resetEvidence(cursor);
  const earlier=cursor.active;
  if(earlier||cursor.turns.some(turn=>turn.turnId===p.turn_id)){
                                
    resetEvidence(cursor);cursor.latestTurnId=p.turn_id;return;
  }
  const attribution=p.turn_attribution?.turn_id===p.turn_id?p.turn_attribution:undefined;
  cursor.latestTurnId=p.turn_id;
  cursor.active={turnId:p.turn_id,startedAt:at,userInputs:[],pendingUserInputs:0,calls:new Map(),sawModel:false,
    ...(id(attribution?.turn_trigger)?{trigger:attribution.turn_trigger}:{}),
    ...(id(attribution?.parent_turn_id)?{parentTurnId:attribution.parent_turn_id}:{}),
    ...(cursor.idleBoundary&&cursor.offeredInjection?{injection:cursor.offeredInjection}:{})};
  cursor.idleBoundary=false;
  cursor.offeredCall=cursor.offeredInjection=undefined;
}

function complete(cursor:Cursor,p:any,at:number):void{
  const turn=cursor.active;
  if(!id(p.turn_id))return resetEvidence(cursor);
  if(turn&&turn.turnId!==p.turn_id)return resetEvidence(cursor);
  cursor.latestTurnId=p.turn_id;
  cursor.active=undefined;
  cursor.idleBoundary=true;
  cursor.lastCompletedAt=at;
  cursor.offeredCall=cursor.offeredInjection=undefined;
  if(!turn||p.error!=null||p.status!=null&&p.status!=='completed'||at<turn.startedAt)return;
  const {turnId,startedAt,userInputs,trigger,parentTurnId,lastWorkAt,sampledInjection,childTurnIds,pendingUserInputs}=turn;
  const answer=turn.answer;
  const final=answer?.text&&answer.at<=at?{itemId:answer.itemId,text:answer.text,at:answer.at}:undefined;
  cursor.turns.push({turnId,startedAt,completedAt:at,userInputs:[...userInputs,...Array<null>(pendingUserInputs).fill(null)],
    ...(trigger?{trigger}:{}),...(parentTurnId?{parentTurnId}:{}),
    ...(lastWorkAt!==undefined&&lastWorkAt<=at?{lastWorkAt}:{}),
    ...(final?{final}:{}),...(sampledInjection?{sampledInjection}:{}),...(childTurnIds?{childTurnIds}:{})});
  if(cursor.turns.length>8)cursor.turns.shift();
}

function activity(turn:ActiveTurn,at:number):void{turn.lastWorkAt=Math.max(turn.lastWorkAt??at,at);}

function recordInput(turn:ActiveTurn,p:any):void{
  if(turn.pendingUserInputs)turn.pendingUserInputs--;
  turn.userInputs.push(id(p.client_id)?p.client_id:null);
}

function textBlocks(content:unknown,kind:string):string|undefined{
  if(!Array.isArray(content))return;
  const text=content.filter(part=>part?.type===kind&&typeof part.text==='string').map(part=>part.text).join('');
  return text.trim()?text:undefined;
}

function itemCompleted(turn:ActiveTurn|undefined,p:any,at:number,sessionId:string):void{
  if(!turn||p.thread_id!==sessionId||at<turn.startedAt)return;
  const item=p.item;
                                           
  if(item?.type==='SubAgentActivity'&&item.kind==='completed'&&id(item.agent_thread_id))return activity(turn,at);
  if(p.turn_id!==turn.turnId)return;
  if(item?.type==='UserMessage')return recordInput(turn,item);
  if(item?.type==='AgentMessage'&&item.phase==='final_answer'&&id(item.id)){
    const text=item.moderation?.moderated===true?undefined:textBlocks(item.content,'Text');
    turn.answer={itemId:item.id,text,at,canonical:true};
    return;
  }
  if(workItems.has(item?.type)||item?.type==='McpToolCall'&&id(item.tool)&&!sendTool(item.tool))activity(turn,at);
}

function evidenceOfInjection(cursor:Cursor,p:any,m:any,at:number):void{
  if(!cursor.idleBoundary||cursor.lastCompletedAt!==undefined&&at<cursor.lastCompletedAt||!sequence(m?.history_sequence))return;
  const callId=p.call_id,offered=cursor.offeredCall;
  if(!id(callId))return;
  if(p.type==='function_call'&&callId.startsWith('nxbridge-')&&callId.length>'nxbridge-'.length&&
    (p.name==='receive_messages'&&p.namespace==='claude'||p.name==='mcp__claude__receive_messages')){
    cursor.offeredCall={id:callId,sequence:m.history_sequence};
  }else if(p.type==='function_call_output'&&id(p.id)&&offered?.id===callId&&offered.sequence<m.history_sequence){
                                    
    cursor.offeredInjection={messageId:callId.slice('nxbridge-'.length),itemId:p.id,historySequence:m.history_sequence};
    cursor.offeredCall=undefined;
  }
}

function isSystemUser(p:any):boolean{
  const native=p.internal_chat_message_metadata_passthrough;
  return Array.isArray(p.content)&&p.content.length>0&&p.content.every((_:unknown,index:number)=>{
    const kind=native?.content_item_kinds?.[index],source=native?.content_item_metadata?.[index]?.provenance?.type;
    return source!=='user'&&!(typeof kind==='string'&&kind.startsWith('user.'))&&
      (systemUserKinds.has(kind)||systemUserSources.has(source));
  });
}

function childContext(p:any):string[]|undefined{
  const native=p.internal_chat_message_metadata_passthrough;
  if(!Array.isArray(p.content))return;
  for(const [index,part] of p.content.entries()){
    const source=native?.content_item_metadata?.[index]?.provenance;
    if(native?.content_item_kinds?.[index]!=='hooks.additional_context'||source?.type!=='harness'||source.hook!==true||typeof part?.text!=='string')continue;
    const match=/(?:^|\n)\[nxbridge own_subagents_completed\]\nYour own child tasks completed: (\[[^\n]+\])\. Read /.exec(part.text);
    if(!match)continue;
    try{
      const children=JSON.parse(match[1]!);
      if(!Array.isArray(children)||!children.length||!children.every(child=>id(child?.agent)&&id(child?.turn)))continue;
      const ids=children.map(child=>child.turn as string);
      if(new Set(ids).size===ids.length)return ids;
    }catch{                         }
  }
}

function response(cursor:Cursor,p:any,m:any,at:number,queued:boolean):void{
  if(m?.compaction_output)return;
  const turn=cursor.active;
  if(!turn)return evidenceOfInjection(cursor,p,m,at);
  const scoped=p.internal_chat_message_metadata_passthrough?.turn_id??m?.retained_source?.id?.turn_id;
  if(at<turn.startedAt||scoped!==undefined&&scoped!==turn.turnId)return;
  try{if(codexChildResult(p,queued))activity(turn,at);}
  catch{                      }
  const sampled=m?.sampled_through_sequence;
  if(sampleModel(p)){
    if(!turn.sawModel){
      turn.sawModel=true;
      if(turn.injection&&sequence(sampled)&&sampled>=turn.injection.historySequence)turn.sampledInjection={...turn.injection,sampledThroughSequence:sampled};
    }
    if(turn.children&&sequence(sampled)&&sampled>=turn.children.sequence)turn.childTurnIds=turn.children.ids;
  }
  if(p.type==='message'){
    if(p.role==='user'&&!isSystemUser(p))turn.pendingUserInputs++;
    if(p.role==='developer'&&scoped===turn.turnId&&sequence(m?.history_sequence)){
      const ids=childContext(p);if(ids)turn.children={ids,sequence:m.history_sequence};
    }
    if(p.role==='assistant'&&p.phase==='final_answer'&&id(p.id)&&!(turn.answer?.canonical&&turn.answer.itemId===p.id)){
      turn.answer={itemId:p.id,text:textBlocks(p.content,'output_text'),at,canonical:false};
    }
  }else if(workCalls.has(p.type)){
    const work=p.type!=='function_call'&&p.type!=='custom_tool_call'||id(p.name)&&!sendTool(p.name);
    if(id(p.call_id))turn.calls.set(p.call_id,work);
    if(work)activity(turn,at);
  }else if((p.type==='function_call_output'||p.type==='custom_tool_call_output')&&turn.calls.get(p.call_id)===true)activity(turn,at);
}

function accept(cursor:Cursor,line:Buffer,sessionId:string):void{
  if(!line.length)return;
  let row:any;try{row=JSON.parse(line.toString('utf8'));}catch{return resetEvidence(cursor);}
  const p=row?.payload,queued=cursor.queuedAgentMetadata;
  cursor.queuedAgentMetadata=!!row&&codexQueuedAgentMetadata(row);
  if(row?.type==='compacted'){
    cursor.offeredCall=cursor.offeredInjection=undefined;
    if(cursor.active){cursor.active.injection=undefined;cursor.active.sampledInjection=undefined;}
    return;
  }
  if(!p||typeof p.type!=='string')return;
  const at=typeof row.timestamp==='string'?Date.parse(row.timestamp):NaN;
  if(row.type==='event_msg'){
    if(p.type==='thread_rolled_back'||p.type==='turn_aborted')return resetEvidence(cursor);
    if(startEvents.has(p.type))return Number.isFinite(at)?start(cursor,p,at):resetEvidence(cursor);
    if(completeEvents.has(p.type))return Number.isFinite(at)?complete(cursor,p,at):resetEvidence(cursor);
    if(p.type==='user_message'&&cursor.active){recordInput(cursor.active,p);return;}
    if(p.type==='item_completed'){
      if(p.item?.type==='UserMessage'&&(!id(p.thread_id)||!id(p.turn_id)||!Number.isFinite(at)))return resetEvidence(cursor);
      if(Number.isFinite(at))itemCompleted(cursor.active,p,at,sessionId);
    }
  }else if(row.type==='response_item'){
    if(p.role==='user'&&!Number.isFinite(at))return resetEvidence(cursor);
    if(Number.isFinite(at))response(cursor,p,row.metadata,at,queued);
  }
}

const empty=(status:CodexTurnEvidence['status']):CodexTurnEvidence=>({status,caughtUp:false,turns:[],bytesRead:0});

                                           
export function readCodexTurnEvidence(file:unknown,sessionId:string):Promise<CodexTurnEvidence>{
  if(!id(file)||!id(sessionId))return Promise.resolve(empty('unavailable'));
  const key=JSON.stringify([file,sessionId]),running=pending.get(key);if(running)return running;
  const work=read(file,sessionId,key).finally(()=>pending.delete(key));pending.set(key,work);return work;
}

async function read(file:string,sessionId:string,key:string):Promise<CodexTurnEvidence>{
  const fd=await open(file,'r').catch(()=>undefined);if(!fd)return empty('unavailable');
  try{
    const {dev,ino,size,mtimeMs}=await fd.stat();let cursor=cursors.get(key);
    if(!cursor||cursor.dev!==dev||cursor.ino!==ino||cursor.size>size||cursor.size===size&&cursor.mtime!==mtimeMs){
      const head=Buffer.alloc(Math.min(size,HEADER_BYTES)),{bytesRead}=await fd.read(head,0,head.length,0),end=head.subarray(0,bytesRead).indexOf(10);
      if(end<0)return empty(bytesRead===HEADER_BYTES?'unsupported':'unavailable');
      let meta:any;try{meta=JSON.parse(head.subarray(0,end).toString('utf8'));}catch{return empty('unsupported');}
      if(meta?.type!=='session_meta'||meta.payload?.id!==sessionId)return empty('unsupported');
      const offset=Math.max(end+1,size-SCAN_BYTES);
      cursor={dev,ino,size,mtime:mtimeMs,offset,tail:Buffer.alloc(0),skipping:offset>end+1,idleBoundary:offset===end+1,queuedAgentMetadata:false,turns:[]};
    }
    cursors.delete(key);cursors.set(key,cursor);
    if(cursors.size>16)cursors.delete(cursors.keys().next().value!);
    const from=cursor.offset,limit=Math.min(size,from+SCAN_BYTES),started=performance.now();
    while(cursor.offset<limit){
      const buffer=Buffer.allocUnsafe(Math.min(CHUNK,limit-cursor.offset)),{bytesRead}=await fd.read(buffer,0,buffer.length,cursor.offset);
      if(!bytesRead)break;
      cursor.offset+=bytesRead;
      let tail=Buffer.concat([cursor.tail,buffer.subarray(0,bytesRead)]),end:number;
      if(cursor.skipping){
        end=tail.indexOf(10);if(end<0)continue;
        cursor.skipping=false;tail=tail.subarray(end+1);
      }
      while((end=tail.indexOf(10))>=0){
        if(end<=MAX_LINE)accept(cursor,tail.subarray(0,end),sessionId);else resetEvidence(cursor);
        tail=tail.subarray(end+1);
      }
      cursor.skipping=tail.length>MAX_LINE;
      if(cursor.skipping)resetEvidence(cursor);
      cursor.tail=cursor.skipping?Buffer.alloc(0):Buffer.from(tail);
      if(performance.now()-started>=SCAN_MS)break;
    }
    cursor.size=size;cursor.mtime=mtimeMs;
    const caughtUp=cursor.offset===size&&!cursor.tail.length&&!cursor.skipping&&(cursor.offset===from||(await fd.stat()).size===size);
    return{status:'supported',caughtUp,latestTurnId:cursor.latestTurnId,openTurnId:cursor.active?.turnId,turns:[...cursor.turns],bytesRead:cursor.offset-from};
  }catch{cursors.delete(key);return empty('unavailable');}
  finally{await fd.close();}
}
