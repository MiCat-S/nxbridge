import type { Store } from '../../storage/store.js';
import type { Message, Peer } from '../../types.js';
import { CooperationTips } from './cooperation-tips.js';
export type { SyncReminder } from './cooperation-tips.js';

type TipKind='report'|'reuse';
type Channel='partner'|'agent';
interface Sample {chars:number;nxref:boolean;channel:Channel;tip?:TipKind}
interface Totals {samples:number;chars:number;nxref:number}
interface TipState {
  total:Totals;partnerSends:number;agentPrompts:number;firings:Record<TipKind,number>;
  following:Record<TipKind,Totals>;recent:Sample[];
  lastFired:Partial<Record<TipKind,number>>;lastTip?:{kind:TipKind;sequence:number};turns:string[];
                                                                     
  firedContext?:Partial<Record<TipKind,string>>;
  calls:{id:string;tip?:string}[];
}
const totals=():Totals=>({samples:0,chars:0,nxref:0});
const initial=():TipState=>({total:totals(),partnerSends:0,agentPrompts:0,firings:{report:0,reuse:0},following:{report:totals(),reuse:totals()},recent:[],lastFired:{},turns:[],calls:[]});
const add=(total:Totals,sample:Sample)=>{total.samples++;total.chars+=sample.chars;if(sample.nxref)total.nxref++;};

                                      
function deliberateVerbatim(text:string):boolean{
  const value=text.trim();
  if(/^(?:```[^\n]*\n[\s\S]*\n```|~~~[^\n]*\n[\s\S]*\n~~~|"[\s\S]*"|“[\s\S]*”)$/u.test(value))return true;
  if(/^(?:\[[^\]\n]{0,40}\]\s*)?(?:verbatim|exact (?:text|payload)|quote(?:d)? (?:text|payload)|原文|逐字(?:转发|引用)?|原样(?:转发|引用)?|以下(?:内容)?(?:请|需)?(?:原样|逐字))\s*[:：\n]/iu.test(value))return true;
  if(value.startsWith('{')||value.startsWith('['))try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object')return true;}catch{}
  return false;
}

                                             
                                
function anchors(body:string[]):{index:Map<number,number[]>;power:number}{
  const index=new Map<number,number[]>();let power=1;for(let i=1;i<150;i++)power=Math.imul(power,31);
  for(let start=0;start+150<=body.length;start+=150){
    let hash=0;for(let i=start;i<start+150;i++)hash=(Math.imul(hash,31)+body[i]!.codePointAt(0)!)|0;
    const rows=index.get(hash)??[];rows.push(start);index.set(hash,rows);
  }
  return{index,power};
}
function matchedChars(body:string[],source:string[],lookup:ReturnType<typeof anchors>):number{
  let hash=0;
  for(let i=0;i<source.length;i++){
    if(i>=150)hash=(hash-Math.imul(source[i-150]!.codePointAt(0)!,lookup.power))|0;
    hash=(Math.imul(hash,31)+source[i]!.codePointAt(0)!)|0;
    if(i<149)continue;
    const starts=lookup.index.get(hash);if(!starts)continue;
    const offset=i-149;
    for(const start of starts){
      let length=0;while(length<150&&body[start+length]===source[offset+length])length++;
      if(length!==150)continue;
      let left=0;while(left<start&&left<offset&&body[start-left-1]===source[offset-left-1])left++;
      let right=150;while(start+right<body.length&&offset+right<source.length&&body[start+right]===source[offset+right])right++;
      if(left+right>=300)return left+right;
    }
  }
  return 0;
}

export class CommunicationTips {
  readonly cooperation:CooperationTips;
  constructor(private store:Store,options:ConstructorParameters<typeof CooperationTips>[1]={}){this.cooperation=new CooperationTips(store,options);}
  partnerSent(peer:Peer,message:Message):void{if(message.from===peer.id)this.cooperation.contact(peer,message,false);}
  partnerReceived(peer:Peer,message:Message):void{if(message.to===peer.id)this.cooperation.contact(peer,message,true);}
  syncTip(peer:Peer,minutes:number):string|undefined{return this.cooperation.tip(peer,minutes);}
  syncReminder(peer:Peer,minutes:number){return this.cooperation.reminder(peer,minutes);}
  record(peer:Peer,text:string,channel:Channel,callId:string,turnId?:string,excludeMessage?:string):string|undefined{
    return this.store.transaction(()=>{
      const receiptKey=excludeMessage?'communicationTip:message:'+excludeMessage:undefined,receipt=receiptKey?this.store.setting<{tip?:string}>(receiptKey):undefined;if(receipt)return receipt.tip;
      const key='communicationTips:'+peer.id,state=this.store.setting<TipState>(key)??initial();
      const cached=state.calls.find(row=>row.id===callId);if(cached)return cached.tip;
      const chars=Array.from(text),sample:Sample={chars:chars.length,nxref:text.includes('nxref:'),channel};
      const sequence=state.total.samples+1;
      if(state.lastTip&&sequence-state.lastTip.sequence<=10)add(state.following[state.lastTip.kind],sample);
      let kind:TipKind|undefined,tip:string|undefined;
      const context=this.cooperation.contextKey(peer);
      const eligible=(candidate:TipKind)=>(!turnId||!state.turns.includes(turnId))&&sequence-(state.lastFired[candidate]??-10)>=10&&state.firedContext?.[candidate]!==context;
      if(!deliberateVerbatim(text)){
        if(!sample.nxref&&chars.length>=300&&eligible('reuse')){
          const pair=this.store.pairFor(peer.id),pairId=pair?.id,lookup=anchors(chars);
          let budget=4*1024*1024;
          for(const source of this.store.referenceCandidates(peer.id,pairId)){
            if(source.kind==='msg'&&source.id===excludeMessage)continue;
            if(source.text.length<300)continue;
            budget-=source.text.length;if(budget<0)break;
            const matched=matchedChars(chars,Array.from(source.text),lookup);if(!matched)continue;
            kind='reuse';tip=`nxbridge tip (auto match check, not judgment: ${matched} chars match ${source.kind} ${source.id}; if verbatim intended, keep going): reuse -> nxref:${source.kind}:${source.id} saves output tokens`;break;
          }
        }
        if(!tip&&channel==='partner'&&chars.length>2200&&eligible('report')){
          kind='report';tip=`nxbridge tip (auto length check, not judgment: msg ${chars.length} chars; if you intended, keep going): thorough work != thorough report: lead w/ outcome + what reader must decide/do; detail worth keeping -> notes file + path`;
        }
      }
      if(kind){sample.tip=kind;state.firings[kind]++;state.lastFired[kind]=sequence;state.firedContext={...state.firedContext,[kind]:context};state.lastTip={kind,sequence};if(turnId){state.turns.push(turnId);state.turns=state.turns.slice(-64);}this.store.event('communication.tip',{peerId:peer.id,kind,sequence,chars:chars.length,channel});}
      add(state.total,sample);if(channel==='partner')state.partnerSends++;else state.agentPrompts++;
      state.recent.push(sample);state.recent=state.recent.slice(-32);state.calls.push({id:callId,...(tip?{tip}:{})});state.calls=state.calls.slice(-64);
      this.store.setSetting(key,state);if(receiptKey)this.store.setSetting(receiptKey,{...(tip?{tip}:{})});return tip;
    });
  }
  summary(peerId:string):Record<string,unknown>|undefined{
    const state=this.store.setting<TipState>('communicationTips:'+peerId);if(!state)return;
    const values=state.recent.map(s=>s.chars).sort((a,b)=>a-b),{total,partnerSends,agentPrompts,firings,following,recent}=state;
    return{total,partnerSends,agentPrompts,firings,following,recent,window:{samples:values.length,median:values[Math.floor((values.length-1)/2)],p90:values[Math.ceil(values.length*.9)-1]},scope:'original Unicode characters; following=up to 10 subsequent send/Agent calls after latest tip; recent=last 32; matching=recent 128 pair messages + 128 own completed agents, up to 4M source characters'};
  }
}
