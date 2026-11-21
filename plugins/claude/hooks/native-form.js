import { modelMessage } from './errors.js';

let pending;

                                                            
export async function nativeForm($, questions) {
  const first=questions[0];
  if(!first)throw Object.assign(new Error('native form has no questions'),{model_message:'native form returned no full answers'});
  if(pending)throw new Error('nxbridge native form already open');
  const state={questions,claimed:false,result:undefined};
  pending=state;
  try{
    state.sessionId=await $.session.id();
    try{await $.ui.ask(first.question,{header:first.header,options:first.options?.map(option=>option.label),...(first.multiSelect?{multiSelect:true}:{})});}
    catch(error){if(!state.result)throw error;}
    if(!state.result)throw Object.assign(new Error('native form result unavailable'),{model_message:'native form returned no full answers'});
    return state.result;
  }finally{if(pending===state)pending=undefined;}
}

export function isNativeForm(e){return pending?.claimed===true&&!e.agentId&&e.tool_use_id===pending.toolUseId&&e.questions?.[0]?.question===pending.questions[0].question;}

export async function nativeFormCall($,e,next){
  const state=pending;
  if(!state||state.claimed||e.agentId||e.questions?.[0]?.question!==state.questions[0].question||await $.session.id()!==state.sessionId)return next(e);
  state.claimed=true;
  state.toolUseId=e.tool_use_id;
  state.result=await next({...e,questions:state.questions});
  return state.result;
}

export function nativeFormFailure($,e,next){return pending&&!e.agentId&&e.questions?.[0]?.question===pending.questions[0].question?{deny:'nxbridge native form unavailable: '+modelMessage(next.error)}:next(e);}
