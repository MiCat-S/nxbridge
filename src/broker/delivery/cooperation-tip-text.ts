                                
                                                                    
                                                                     
                                                                  
                                                  

export interface CooperationTipFacts {
  unpaired:boolean;
  elapsedMinutes:number;
  intervalMinutes:number;
  effort?:string|number;
  partnerIdleMinutes?:number;
  silence?:{ordinal:1|2|3};
  context?:{tokens:number;threshold:number};
  owedMessageIds?:string[];
  idleMessageIds?:string[];
}

                                                           
const list=(ids:string[])=>ids.slice(0,3).join(', ')+(ids.length>3?` +${ids.length-3} more`:'');

export function cooperationTipText(facts:CooperationTipFacts):string{
  const observed:string[]=[],asks:string[]=[];
                                                        
  if(facts.unpaired)observed.push('no partner yet',`solo ${facts.elapsedMinutes}m`);
  else{if(facts.partnerIdleMinutes!==undefined)observed.push(`partner idle ${facts.partnerIdleMinutes}m`);observed.push(`no contact ${facts.elapsedMinutes}m`);}
  if(facts.context)observed.push('long context');
                       
  if(facts.unpaired)asks.push('first partner msg pairs on demand');
                                         
  if(facts.owedMessageIds?.length)asks.push(`partner msgs since your last send: ${list(facts.owedMessageIds)} -> reply/brief update if needed`);
                                                 
  if(facts.idleMessageIds?.length)asks.push(`expected reply still pending: ${list(facts.idleMessageIds)} -> check if it still blocks you`);
                                  
  if(facts.context)asks.push('recheck pending partner tasks + CURRENT');
                                                                                                   
  if(facts.silence||facts.context||facts.unpaired){
    const ordinal=facts.silence&&facts.silence.ordinal>1?`tip ${facts.silence.ordinal}/3${facts.silence.ordinal===3?', last this stretch':''}: `:'';
    asks.push(`${ordinal}recheck split per nxbridge routing + any extra user rules: hand off partner-fit work or brief sync; solo ok if right`);
  }
  return `nxbridge tip: ${observed.join(', ')}; ${asks.join('; ')}`;
}
