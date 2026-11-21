import { prepareRead, attachRead, closeRead, smallRead } from './mod-read.js';
import { smallWrite } from './mod-write.js';
let active,ending,modVersion,modRevision,diagnostics,carried,sessionFacts;
                                                         
export function noteReceiptFailure(op,error,consecutive){diagnostics={consecutive,last_error:{op,code:typeof error?.code==='string'?error.code:'unknown',at:Date.now()}};}
                                                               
export function setModVersion(version,revision){selfOff=false;modVersion=typeof version==='string'&&version?version:undefined;modRevision=revision;active=undefined;ending=undefined;}
export async function captureContext($){
  const sessionId=await $.session.id();
  if(!active||active.sessionId!==sessionId){
    const contextReason=ending&&ending.context===active?ending.reason:undefined;
    active={sessionId,cwd:await $.session.cwd(),inbox:await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET'),contextStart:true,...(contextReason?{contextReason}:{})};
                                                                                      
    if(carried?.sessionId===sessionId)active.nativePermission=carried.value;
    applySessionFacts(active);
    ending=undefined;
  }
  return active;
}
                                                            
                                                                                                                              
function noteSessionFacts(sessionId,facts){
  const base=sessionFacts?.sessionId===sessionId?sessionFacts:{sessionId};
  sessionFacts={...base,...facts};
  if(active?.sessionId===sessionId)applySessionFacts(active);
}
function applySessionFacts(context){
  const facts=sessionFacts?.sessionId===context.sessionId?sessionFacts:undefined;
  const value={...(typeof facts?.transcriptPath==='string'?{transcriptPath:facts.transcriptPath}:{}),...(typeof facts?.interactive==='boolean'?{interactive:facts.interactive}:{})};
  if(Object.keys(value).length)context.nativeSession=value;else delete context.nativeSession;
}
export async function observeInteractive($,value){
  const sessionId=await $.session.id();
  noteSessionFacts(sessionId,{interactive:typeof value==='boolean'?value:undefined});
}
                                                 
                                                                   
                                        
                                               
const publishing=new WeakMap();
export const ownedProfileContext=context=>!!context&&publishing.get(context)?.owned===true;
export function markContextStarted(context){publishing.set(context,{...publishing.get(context),started:true});}
export async function publishFacts($,context){
  const mode=context?.nativePermission?.mode,decision=context?.nativeDecision,inbound=context?.nativeInbound,state=context&&publishing.get(context);
  if(!state?.started||!inbound||!decision&&(!mode||mode==='unknown'))return;
                                 
  const profile=context.nativeProfile,key=JSON.stringify([context.binding?.epoch??null,mode??null,decision?.bash??null,decision?.rule??null,inbound.policy,inbound.source??null,profile?.model??null,profile?.flag??null,profile?.effective??null,profile?.effortOverride??null,profile?.effortUnverified??false,profile&&Object.hasOwn(profile,'runtimeEffort')?[profile.runtimeEffort]:[]]);
  if(state.published===key)return;
  state.published=key;
  try{await call($,'register',{context});}catch{if(state.published===key)delete state.published;}
}
                                                                        
                                                                               
const PROBE_COMMAND='nxbridge-permission-probe --noop';
export async function observeDecision($){
  const context=await captureContext($);
  try{
    const verdict=await $.tool.check({tool:'Bash',input:{command:PROBE_COMMAND}});
    if(['allow','ask','deny'].includes(verdict?.decision))context.nativeDecision={bash:verdict.decision,...(typeof verdict.rule==='string'?{rule:verdict.rule.slice(0,200)}:{}),observedAt:Date.now()};
  }catch{}
}
export async function observePermission($,event){
  if(event.agent_id||event.agent_transcript_path)return;
  const context=await captureContext($);
  if(event.session_id!==context.sessionId)return;
                                    
  context.nativePermission={mode:typeof event.permission_mode==='string'?event.permission_mode:'unknown',observedAt:Date.now()};
  carried={sessionId:context.sessionId,value:context.nativePermission};
  if(typeof event.transcript_path==='string'&&event.transcript_path)noteSessionFacts(context.sessionId,{transcriptPath:event.transcript_path});
}
                                                                            
                                                                    
const INBOUND_RANK={accept:1,hold:2,refuse:3};
export function effectiveInbound(values){return inboundDecision(values).policy;}
                                                                                            
                                             
export function inboundDecision(values){
  const known=value=>Object.hasOwn(INBOUND_RANK,value);
  let policy,source;
  if(values.policy!==undefined){policy=known(values.policy)?values.policy:'refuse';source=known(values.policy)?'policy':'invalid';}
  else{const from=values.flag!==undefined?'flag':values.user!==undefined?'user':undefined;if(from){policy=known(values[from])?values[from]:'hold';source=known(values[from])?from:'invalid';}}
  for(const from of ['project','local']){
    const value=values[from];if(value===undefined)continue;
    const candidate=known(value)?value:'hold';
    if(policy===undefined?candidate!=='accept':INBOUND_RANK[candidate]>INBOUND_RANK[policy]){policy=candidate;source=known(value)?from:'invalid';}
  }
  if(values.policy===undefined&&[values.flag,values.user,values.project,values.local].some(value=>value!==undefined&&!known(value))&&INBOUND_RANK[policy??'accept']<INBOUND_RANK.hold){policy='hold';source='invalid';}
  return policy?{policy,source}:{policy:'default',source:'default'};
}
export async function observeInbound($){
  const context=await captureContext($);
  try{
    const sources=['policy','flag','user','project','local'],values={};
    for(const source of sources){const settings=await $.settings.read({source});if(settings&&Object.hasOwn(settings,'crossSessionInbound'))values[source]=settings.crossSessionInbound;}
                                                                                                           
    const expiry=await $.settings.read({key:'dialogExpiry'}),timeout=Number(await $.env.get('CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS'));
    const decision=inboundDecision(values);
    context.nativeInbound={policy:decision.policy,source:decision.source,...(typeof expiry==='string'&&expiry.length<=20?{dialogExpiry:expiry}:{}),...(Number.isSafeInteger(timeout)&&timeout>0?{dialogTimeoutMs:timeout}:{}),observedAt:Date.now()};
  }catch{context.nativeInbound={policy:'unknown',observedAt:Date.now()};}
}
                                                                                                    
                                                            
const profileModel=value=>typeof value==='string'&&value.length>0&&value.length<=200?value:undefined;
const profileEffort=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&value.length>0&&value.length<=40?value:undefined;
const profileValues=(model,effort)=>{const value={...(profileModel(model)?{model}:{}),...(profileEffort(effort)!==undefined?{effort}:{})};return Object.keys(value).length?value:undefined;};
async function readQuietly(run){try{return await run();}catch{return undefined;}}
export async function observeProfile($){
  const context=await captureContext($);
  const model=profileModel(await readQuietly(()=>$.session.model()));
  const layer=await readQuietly(()=>$.settings.read({source:'flag'}));
  const flag=layer&&typeof layer==='object'?profileValues(layer.model,layer.effortLevel):undefined;
  const effective=profileValues(await readQuietly(()=>$.settings.read({key:'model'})),await readQuietly(()=>$.settings.read({key:'effortLevel'})));
  const override=profileEffort(await readQuietly(()=>$.env.get('CLAUDE_CODE_EFFORT_LEVEL')));
  const runtimeEffort=context.nativeProfile?.runtimeEffort,effortUnverified=context.nativeProfile?.effortUnverified;
  context.nativeProfile={...(model?{model}:{}),...(flag?{flag}:{}),...(effective?{effective}:{}),...(typeof override==='string'?{effortOverride:override}:{}),...(runtimeEffort!==undefined?{runtimeEffort}:{}),...(effortUnverified?{effortUnverified:true}:{}),observedAt:Date.now()};
}
const effortCommands=new WeakMap();
export async function beginEffortCommand($,args=''){
  const context=await captureContext($);
  if(!isOff()&&ownedProfileContext(context))effortCommands.set(context,{args:args.trim(),echo:false});
}
function confirmedEffort(text){
  if(/^(?:Effort level set to auto\b|Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=|Effort set to auto for this session, but CLAUDE_CODE_EFFORT_LEVEL=)/.test(text))return null;
  const match=/^Set effort level to ([^\s]+) \(/.exec(text)??/^Effort '[^']+' exceeds[^\n]*; set to '([^']+)' instead/.exec(text);
  if(match)return profileEffort(/^\d+(?:\.\d+)?$/.test(match[1])?Number(match[1]):match[1]);
}
export function observeEffortAppend($,event,result,context){try{
  const pending=effortCommands.get(context),message=result?.message;
  if(!pending||event.agentId||event.door!=='command'||isOff()||active!==context||!ownedProfileContext(context)||message?.role!=='user')return;
  const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'):'';
  if(text.startsWith('<command-name>')){
    pending.echo=text.startsWith('<command-name>/effort</command-name>')&&(/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]??'').trim()===pending.args;
    return;
  }
  if(!pending.echo)return;
  const stdout=/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(text);
  if(!stdout)return;
  effortCommands.delete(context);
  const effort=confirmedEffort(stdout[1]);
  if(effort===undefined&&(/^(?:Cancelled$|Kept effort level as |Invalid argument: |Failed to set effort level: |Not applied: CLAUDE_CODE_EFFORT_LEVEL=|CLAUDE_CODE_EFFORT_LEVEL=|Usage: \/effort [\[<]|Current effort level: |Effort level: auto\b|Ultracode (?:needs dynamic workflows enabled|isn't available on |on \(this session only\):|off\. Effort stays ))/.test(stdout[1])||/^[^\s]+ is session-scoped and won't reach the remote process\./.test(stdout[1])))return;
                                                 
  context.nativeProfile={...context.nativeProfile,...(effort!==undefined?{runtimeEffort:effort}:{}),effortUnverified:effort===undefined,observedAt:Date.now()};
  scheduleProfileRead($);
}catch{}}
export function scheduleProfileRead($){
  if(!ownedProfileContext(active))return;
  const context=active;
                                                  
  $.clock.after(0,async()=>{try{
    if(isOff()||active!==context||!ownedProfileContext(context))return;
    await observeProfile($);
    if(active===context&&!isOff())await publishFacts($,context);
  }catch{}});
}
                                                    
const bypassClass=mode=>mode==='bypassPermissions'||mode==='plan'||mode==='bypass';
export function predictedHold(context,fromMode){
  const policy=context?.nativeInbound?.policy,mode=context?.nativePermission?.mode;
  if(policy==='accept')return false;
  if(policy==='hold')return true;
  if(policy!=='default'||!mode||mode==='unknown')return undefined;
  return bypassClass(mode)!==bypassClass(fromMode);
}
export function markContextEnd(context,reason){
  if(active!==context)return false;
  ending={context,reason:reason==='clear'?'reset':reason==='resume'?'switch':'unknown'};
  return ending.reason;
}
export function unpackContext(value,context){
  if(value?.context&&Object.hasOwn(value,'value')){
    Object.assign(context,value.context,{contextStart:false});
    return value.value;
  }
  return value;
}
                                                                                                 
const LONG_OPERATIONS=new Set(['send','selection-resolve','selection-commit','partner-profile']);
async function processCall($,operation,context,input){
  const data=JSON.stringify({operation,...context,...(modVersion?{mod_version:modVersion}:{}),...(modRevision?{mod_revision:modRevision}:{}),...input});
                                           
  const result=await $.process.run(['node','--no-warnings',$.plugin.root+'/bridge.cjs','mod',operation==='send'?'-':data],{...(LONG_OPERATIONS.has(operation)?{timeoutMs:135_000}:{}),...(operation==='send'?{stdin:data}:{})});
  if(result.exitCode!==0){
    let detail;try{detail=JSON.parse(result.stderr.trim());}catch{}
                          
    throw Object.assign(new Error(detail?.message||result.stderr||'nxbridge call failed'),{code:detail?.code,model_message:detail?.model_message,uncertain:detail?detail.uncertain===true:true,...(typeof detail?.phase==='string'?{phase:detail.phase}:{})});
  }
  return JSON.parse(result.stdout);
}
                                                               
let selfOff=false;
                                        
const lifecycleCalls=new WeakMap();
const OFF_ALLOWED=new Set(['switch','status','status-human','monitor','control-open']);
const OFF_RESULT={enabled:false,disabled:true,code:'member_disabled'};
export const isOff=()=>selfOff;
export const markOff=value=>{selfOff=value;};
                                               
function noteOff(operation,value){if(value?.disabled===true&&value.code==='member_disabled')selfOff=true;else if(operation==='status'&&value&&typeof value==='object')selfOff=false;}
export async function call($,operation,payload={}){
  if(selfOff&&!OFF_ALLOWED.has(operation))return operation==='monitor-prepare'?{...OFF_RESULT,notices:[]}:OFF_RESULT;
  let pending;
  if(operation==='state'||operation==='prompt'){
    const context=payload.context??await captureContext($),previous=lifecycleCalls.get(context)??Promise.resolve();
    pending=previous.catch(()=>{}).then(()=>callInner($,operation,{...payload,context}));
    lifecycleCalls.set(context,pending);
    try{const value=await pending;noteOff(operation,value);return value;}
    finally{if(lifecycleCalls.get(context)===pending)lifecycleCalls.delete(context);}
  }
  const value=await callInner($,operation,payload);noteOff(operation,value);return value;
}
async function callInner($,operation,payload){
  const {context:provided,...input}=payload,context=provided??await captureContext($);
  const state=await prepareRead($,context,()=>processCall($,'control-open',context,{}));
  if(operation==='send'&&(await captureContext($))!==context)throw Object.assign(new Error('origin context changed; message not sent'),{code:'session_changed',uncertain:false});
  const credential=state.credential;
  const sent=diagnostics;
  const extra={...input,...(sent?{mod_diagnostics:sent}:{}),...(credential&&(operation==='monitor'||!state.transport&&['register','context-start','status'].includes(operation))?{read_credential:credential}:{})};
  const fast=await smallWrite($,context,{operation,...context,...(modVersion?{mod_version:modVersion}:{}),...(modRevision?{mod_revision:modRevision}:{}),...extra});
  const value=fast.handled?fast.value:await processCall($,operation,context,extra);
  if(sent&&diagnostics===sent)diagnostics=undefined;
  const result=unpackContext(value,context);
  if(operation==='register'||operation==='context-start')publishing.set(context,{...publishing.get(context),owned:result?.owner==='nxbridge'});
  if(active===context&&value?.readTransport)attachRead(context,value.readTransport);
  if(operation==='context-end')closeRead(context);
  return result;
}
export async function read($,operation){
  const context=await captureContext($),result=await smallRead($,context,operation,async()=>active===context&&await $.session.id()===context.sessionId);
  if(result.handled){noteOff(operation,result.value);return result.value??(operation==='monitor'?{notices:[]}:undefined);}
  const value=await call($,operation,{context});
  return active===context&&await $.session.id()===context.sessionId?value:operation==='monitor'?{notices:[]}:undefined;
}
