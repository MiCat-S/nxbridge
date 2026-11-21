import {BridgeError} from '../../shared/errors.js';
import {type Message,type Peer} from '../../types.js';
import type { Store } from '../../storage/store.js';

const limit=256*1024;
const agentId=/^\/?[\w-]+(?:\/[\w-]+)*$/;

                                       
export class References {
  constructor(private store:Store){}
  capture(peer:Peer,id:string,text:string):void{
    if(!agentId.test(id)||!text.trim())throw new BridgeError('agent_incomplete','子代理最终答案不可用。');
    this.check(text);this.store.setSetting(`ref:agent:${peer.id}:${id}`,text);
  }
  message(message:Message):string{
    const snapshot=this.store.setting<string>(`ref:message:${message.id}`);
    if(snapshot===undefined&&this.store.snapshotRequired(message.id))throw new BridgeError('ref_missing','nxref 展开快照已过期，不能使用原始引用代替正文。');
    return snapshot??message.body;
  }
  snapshot(message:Message,expanded:string):void{
    if(expanded!==message.body)this.store.transaction(()=>{this.store.requireSnapshot(message.id);this.store.setSetting(`ref:message:${message.id}`,expanded);});
  }
  expand(peer:Peer,text:string,seen=new Set<string>()):string{
    this.check(text);
    const parts:string[]=[];let offset=0,bytes=0;
                                          
    const literals=[...text.matchAll(/(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?^\k<fence>[ \t]*$|(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)|"(?:\\.|[^"\\])*"|(?<![\p{L}\p{N}_])'(?:\\.|[^'\\])*'(?![\p{L}\p{N}_])|“[^”]*”|‘[^’]*’/gmu)].map(m=>({start:m.index,end:m.index+m[0].length}));
    let literal=0;
    const append=(part:string)=>{bytes+=Buffer.byteLength(part);if(bytes>limit)throw new BridgeError('ref_too_large','展开正文超过 256 KiB。');parts.push(part);};
    for(const match of text.matchAll(/\bnxref:([^\s`<>"()[\]{},;，；。！？]*)/gu)){
      while(literal<literals.length&&literals[literal]!.end<=match.index)literal++;
      if(literal<literals.length&&literals[literal]!.start<=match.index)continue;
      const token=match[1]!.replace(/[.!?]+$/u,''),ref=/^(msg|agent):(.+)$/.exec(token);
      if(!ref||!(ref[1]==='agent'?agentId.test(ref[2]!):/^[\w-]+$/.test(ref[2]!)))continue;
      append(text.slice(offset,match.index));
      const key=ref[1]+':'+ref[2];
      if(seen.has(key))throw new BridgeError('ref_cycle','nxref 引用存在循环。');
      const next=new Set(seen);next.add(key);
      let value:string|undefined;
      if(ref[1]==='agent')value=this.store.setting<string>(`ref:agent:${peer.id}:${ref[2]}`);
      else{
        const pair=this.store.pairFor(peer.id);let source:Message|undefined;
        try{source=this.store.message(ref[2]!);}catch(error){if(!(error instanceof BridgeError)||error.code!=='message_missing')throw error;}
        if(pair&&source&&source.pairId===pair.id&&(pair.claude===peer.id||pair.codex===peer.id))value=this.message(source);
      }
      if(value===undefined)throw new BridgeError('ref_missing','nxref 不存在，或不属于当前会话及配对。');
      append(`[nxref ${key}]\n`);append(this.expand(peer,value,next));append('\n[/nxref]');offset=match.index+'nxref:'.length+token.length;
    }
    append(text.slice(offset));return parts.join('');
  }
  private check(text:string):void{if(Buffer.byteLength(text)>limit)throw new BridgeError('ref_too_large','展开正文超过 256 KiB。');}
}
