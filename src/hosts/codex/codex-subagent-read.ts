import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface CodexSubagentReadFloor {dev:number;ino:number;offset:number}
export interface CodexSubagentReadCandidate {key:string;agentId:string;childTurnId:string;agentPath?:string;floor:CodexSubagentReadFloor}

const HEADER_BYTES=64*1024,TAIL_BYTES=1024*1024;

function readBytes(fd:number,offset:number,size:number):Buffer{
  const buffer=Buffer.allocUnsafe(size);
  let read=0;
  while(read<size){
    const count=readSync(fd,buffer,read,size-read,offset+read);
    if(!count)break;
    read+=count;
  }
  return buffer.subarray(0,read);
}

function withTranscript<T>(file:unknown,sessionId:string,work:(fd:number,floor:CodexSubagentReadFloor)=>T):T|undefined{
  if(typeof file!=='string'||!file||!sessionId)return;
  let fd:number|undefined;
  try{
    fd=openSync(file,'r');
    const {dev,ino,size:offset}=fstatSync(fd);
    const head=readBytes(fd,0,Math.min(offset,HEADER_BYTES)),end=head.indexOf(10);
    if(end<0)return;
    const row=JSON.parse(head.subarray(0,end).toString('utf8'));
    if(row.type!=='session_meta'||row.payload?.id!==sessionId)return;
    return work(fd,{dev,ino,offset});
  }catch{return;}
  finally{if(fd!==undefined)closeSync(fd);}
}

                                    
export function captureCodexSubagentReadFloor(file:unknown,sessionId:string):CodexSubagentReadFloor|undefined{
  return withTranscript(file,sessionId,(_fd,floor)=>floor);
}

const sequence=(value:unknown):number|undefined=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined;

function v1Result(item:any):string|undefined{
  if(item.type!=='message'||item.role!=='user'||!Array.isArray(item.content))return;
  const kinds=item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if(!Array.isArray(kinds))return;
  const index=kinds.indexOf('multi_agent.subagent_notification');
  if(index<0||index!==kinds.lastIndexOf('multi_agent.subagent_notification'))return;
  const content=item.content[index];
  if(content?.type!=='input_text'||typeof content.text!=='string')return;
  const match=/^<subagent_notification>\n([\s\S]+)\n<\/subagent_notification>$/.exec(content.text);
  if(!match)return;
  const notice=JSON.parse(match[1]!);
  if(typeof notice?.agent_path==='string'&&notice.status&&Object.hasOwn(notice.status,'completed'))return notice.agent_path;
}

function v2Result(item:any):string|undefined{
  if(item.type!=='agent_message'||typeof item.author!=='string'||!Array.isArray(item.content)||item.content.length!==1)return;
  const separator=item.author.lastIndexOf('/');
  if(separator<1||item.recipient!==item.author.slice(0,separator))return;
  const [content]=item.content;
  if(content?.type==='input_text'&&typeof content.text==='string'&&content.text.startsWith(`Message Type: FINAL_ANSWER\nTask name: ${item.recipient}\nSender: ${item.author}\nPayload:\n`))return item.author;
}

export const codexQueuedAgentMetadata=(row:any):boolean=>row.type==='inter_agent_communication_metadata'&&row.payload?.trigger_turn===false;
export const codexChildResult=(item:any,queued:boolean):string|undefined=>v1Result(item)??(queued?v2Result(item):undefined);

                                           
export function readCodexSubagentCompletions(file:unknown,sessionId:string,parentTurnId:string,pending:readonly CodexSubagentReadCandidate[]):ReadonlySet<string>{
  if(!parentTurnId||!pending.length)return new Set();
  return withTranscript(file,sessionId,(fd,end)=>{
    const candidates=pending.filter(({floor})=>floor.dev===end.dev&&floor.ino===end.ino&&Number.isSafeInteger(floor.offset)&&floor.offset>=0&&floor.offset<end.offset);
    if(!candidates.length)return new Set<string>();
    const start=Math.max(0,end.offset-TAIL_BYTES),buffer=readBytes(fd,start,end.offset-start);
    const matches=new Map<string,{historySequence?:number;read:boolean}>(),ambiguous=new Set<string>();
    let turn:string|undefined,queuedAgentMetadata=false;
                                  
    let offset=start?buffer.indexOf(10)+1:0;
    if(start&&!offset)return new Set<string>();
    for(let next;(next=buffer.indexOf(10,offset))>=0;offset=next+1){
      const row=JSON.parse(buffer.subarray(offset,next).toString('utf8'));
      const payload=row.payload,queued=queuedAgentMetadata;
      queuedAgentMetadata=codexQueuedAgentMetadata(row);
      if(row.type==='event_msg'){
        if(['task_started','turn_started'].includes(payload?.type)){
          turn=payload.turn_id;
        }
        if(['task_complete','turn_complete','turn_aborted','thread_rolled_back'].includes(payload?.type))turn=undefined;
        if(payload?.type==='thread_rolled_back'){matches.clear();ambiguous.clear();}
      }
      if(row.type==='compacted'){matches.clear();ambiguous.clear();continue;}
      if(row.type!=='response_item'||!payload)continue;
      const reference=codexChildResult(payload,queued);
      if(reference){
        const compatible=candidates.filter(candidate=>start+offset>=candidate.floor.offset&&(candidate.agentId===reference||candidate.agentPath===reference));
        for(const candidate of compatible){
          if(compatible.length!==1||matches.has(candidate.key))ambiguous.add(candidate.key);
          else matches.set(candidate.key,{historySequence:sequence(row.metadata?.history_sequence),read:false});
        }
      }else if(turn===parentTurnId&&payload.type==='message'&&payload.role==='assistant'&&!row.metadata?.compaction_output&&Array.isArray(payload.content)&&payload.content.some((entry:any)=>entry?.type==='output_text'&&typeof entry.text==='string'&&entry.text.trim())){
        const sampled=sequence(row.metadata?.sampled_through_sequence);
        for(const match of matches.values()){
                                                    
          if(match.historySequence===undefined?sampled===undefined:sampled!==undefined&&sampled>=match.historySequence)match.read=true;
        }
      }
    }
    return new Set(turn===parentTurnId?[...matches].filter(([key,match])=>match.read&&!ambiguous.has(key)).map(([key])=>key):[]);
  })??new Set();
}
