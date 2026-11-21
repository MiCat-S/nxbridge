import { writeTransport, clearWrite } from './mod-read.js';

                                                       
const operations=new Set(['state','prompt','register','recovery','observe','tip-agent','tip-sync','ref-capture']);
const bytes=value=>new TextEncoder().encode(value);
const json=value=>JSON.stringify(value).replace(/[^\x00-\x7f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
                                                   
async function mac(secret,value){
  const inner=new Uint8Array(64+bytes(value).length),outer=new Uint8Array(96);
  for(let i=0;i<64;i++){const key=i<32?parseInt(secret.slice(i*2,i*2+2),16):0;inner[i]=key^0x36;outer[i]=key^0x5c;}
  inner.set(bytes(value),64);outer.set(new Uint8Array(await crypto.subtle.digest('SHA-256',inner)),64);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',outer)),value=>value.toString(16).padStart(2,'0')).join('');
}
async function exchange($,transport,body,budget){
  const text=json(body),signature=await mac(transport.secret,text),stop=new AbortController();
  try{
    const response=await Promise.race([$.http.fetch(transport.url,{method:'POST',headers:{'Content-Type':'application/json','X-Nxbridge-Id':transport.id,Authorization:'HMAC '+signature},body:text}),$.clock.sleep(budget,{signal:stop.signal}).then(()=>{throw Error('Mod write timeout');})]);
    if(typeof response.text!=='string'||bytes(response.text).length>2*1024*1024)throw Error('Mod write response invalid');
    const envelope=JSON.parse(response.text);
    if(typeof envelope.body!=='string'||envelope.mac!==await mac(transport.secret,transport.id+'\n'+body.phase+'\n'+body.nonce+'\n'+response.status+'\n'+envelope.body))throw Error('Mod write response unauthenticated');
    return{status:response.status,...JSON.parse(envelope.body)};
  }finally{stop.abort();}
}
                                         
export async function smallWrite($,context,input){
  const transport=writeTransport(context);
  if(!transport||!operations.has(input.operation)||context.contextStart!==false)return{handled:false};
  let nonce,ticket;
                                               
  try{
    const length=bytes(json(input)).length;if(length>2*1024*1024-256)return{handled:false};
    nonce=Array.from(crypto.getRandomValues(new Uint8Array(32)),value=>value.toString(16).padStart(2,'0')).join('');
    const ready=await exchange($,transport,{phase:'prepare',nonce,operation:input.operation,bytes:length},2000);
    if(ready.status!==200||ready.ready!==true||typeof ready.ticket!=='string'||!/^[a-f0-9]{64}$/.test(ready.ticket))throw Error('Mod write unavailable');
    ticket=ready.ticket;
  }catch{clearWrite(context,transport);return{handled:false};}
  let result;
  try{result=await exchange($,transport,{phase:'commit',nonce,ticket,input},9000);}
  catch(error){clearWrite(context,transport);throw Object.assign(error,{uncertain:true,model_message:'connection lost or confirmation timeout; outcome unknown, may have applied; check delivery before retry; resend may duplicate'});}
  if(result.admitted===false){clearWrite(context,transport);return{handled:false};}
  if(result.error)throw Object.assign(new Error(result.error.message),result.error,{model_message:result.error.message});
  if(result.status===200){
    return{handled:true,value:result.value};
  }
  throw Object.assign(Error('Mod write response invalid'),{uncertain:true});
}
