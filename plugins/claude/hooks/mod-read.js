import { loopbackAllowed, proxyEnvironment } from './mod-proxy.js';
                                
const states=new WeakMap();
const maxResponseBytes=32*1024;
const STALLED_MS=5000;
const secret=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export async function prepareRead($,context,open){
  let state=states.get(context);
  if(!state){state={slots:{}};states.set(context,state);}
                                                     
  if(!state.opening){
    state.opening=(async()=>{try{state.proxy=await proxyEnvironment($);const value=await open();if(secret(value?.credential?.id)&&secret(value.credential.secret))state.credential=value.credential;}catch{                       }})();
  }
  await state.opening;return state;
}
export function attachRead(context,transport){
  const state=states.get(context);
  if(!state?.credential||!secret(transport?.id)||!secret(transport.secret)||!/^http:\/\/127\.0\.0\.1:[0-9]+\/mod-read$/.test(transport.url)||transport.bindingEpoch!==context.binding?.epoch||!loopbackAllowed(state.proxy,transport.url))return;
  state.transport=transport;state.slots={};state.slotAt={};
}
export function closeRead(context){const state=states.get(context);if(state)state.transport=undefined;}
export function writeTransport(context){const state=states.get(context),transport=state?.transport?.write;return secret(transport?.id)&&secret(transport.secret)&&/^http:\/\/127\.0\.0\.1:[0-9]+\/mod-write$/.test(transport.url)&&transport.bindingEpoch===context.binding?.epoch?transport:undefined;}
export function clearWrite(context,transport){const state=states.get(context);if(state?.transport?.write===transport)delete state.transport.write;}
const encode=value=>new TextEncoder().encode(value);
export async function smallRead($,context,operation,current){
  const state=states.get(context);
  if(!state?.transport)return{handled:false};
  const now=await $.clock.now();
  const transport=state.transport;if(!transport)return{handled:false};
                                      
  if(state?.slots[operation]){
    if(now-state.slotAt[operation]<STALLED_MS)return{handled:true};
    state.transport=undefined;delete state.slots[operation];return{handled:false};
  }
  state.slotAt[operation]=now;
  let work;
  work=Promise.resolve().then(async()=>{
    try{
      if(state.transport!==transport)throw Error('mod_read_unavailable');
      const body=JSON.stringify({operation,...(context.nativeHealth?{nativeHealth:context.nativeHealth}:{})});
      const response=await $.http.fetch(transport.url,{method:'POST',headers:{'Content-Type':'application/json','X-Nxbridge-Id':transport.id,Authorization:'Bearer '+transport.secret},body});
      const text=response.text;
      if(response.status!==200||typeof text!=='string'||text.length>maxResponseBytes||encode(text).byteLength>maxResponseBytes)throw Error('mod_read_unavailable');
      if(state.transport!==transport||context.binding?.epoch!==transport.bindingEpoch||!await current())throw Error('mod_read_unavailable');
      return{handled:true,value:JSON.parse(text)};
    }catch{if(state.transport===transport)state.transport=undefined;return{handled:false};}
  }).finally(()=>{if(state.slots[operation]===work)delete state.slots[operation];});
  state.slots[operation]=work;
  const stop=new AbortController();
                                              
  try{return await Promise.race([work,$.clock.sleep(STALLED_MS,{signal:stop.signal}).then(()=>{if(state.transport===transport)state.transport=undefined;if(state.slots[operation]===work)delete state.slots[operation];return{handled:false};},()=>({handled:false}))]);}
  catch{return{handled:false};}
  finally{stop.abort();}
}
