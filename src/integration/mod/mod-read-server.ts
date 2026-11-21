import http from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { z } from 'zod';
import { pruneModReadReceipts, sameModReadSecret, type ModReadReceipt } from './mod-read-receipt.js';
import type { Actor } from '../../types.js';
import { nativeHealthSchema } from '../../broker/health/foreground-health.js';
import type { TurnHealth } from '../../broker/health/turn-health.js';
import { describeError } from '../../shared/errors.js';
import { modelError } from '../mcp/model-error.js';

export type ModReadOperation='status'|'monitor';
export interface ModReadTransport {url:string;id:string;secret:string;bindingEpoch:string;write?:ModReadTransport}
interface Capability {transport:ModReadTransport;receipt:ModReadReceipt;actor:Actor;endpointEpoch:string;inflight:Set<ModReadOperation>;prepared:Map<string,{until:number;nonce:string;operation:string}>}
const requestSchema=z.object({operation:z.enum(['status','monitor']),nativeHealth:nativeHealthSchema.optional()}).strict();
export const MOD_WRITE_OPERATIONS=['state','prompt','register','recovery','observe','tip-agent','tip-sync','ref-capture'] as const;
const writeSchema=z.object({operation:z.enum(MOD_WRITE_OPERATIONS)}).passthrough();
const token=z.string().regex(/^[a-f0-9]{64}$/);
const writeEnvelope=z.discriminatedUnion('phase',[z.object({phase:z.literal('prepare'),nonce:token,operation:z.enum(MOD_WRITE_OPERATIONS),bytes:z.number().int().nonnegative().max(2*1024*1024-256)}).strict(),z.object({phase:z.literal('commit'),nonce:token,ticket:token,input:writeSchema}).strict()]);
const sign=(secret:string,body:string)=>createHmac('sha256',Buffer.from(secret,'hex')).update(body).digest('hex');
const denied=()=>Object.assign(new Error('Mod 只读通道不可用。'),{code:'mod_read_unavailable'});

                                        
export class ModReadServer {
  private server?:http.Server;
  private listening?:Promise<void>;
  private closed=false;
  private capabilities=new Map<string,Capability>();
  private writes=new Map<string,Capability>();
  private pendingWrites=new Set<Promise<unknown>>();
  private pruning:Promise<void>;
  constructor(home:string,private read:(actor:Actor,operation:ModReadOperation,receipt:ModReadReceipt,endpointEpoch:string,health?:TurnHealth)=>Promise<unknown>,private write?:(input:Record<string,unknown>,actor:Actor,receipt:ModReadReceipt,endpointEpoch:string,admit:()=>void)=>Promise<unknown>){
    this.pruning=pruneModReadReceipts(home).catch(error=>{process.stderr.write('nxbridge 只读票据清理：'+String(error)+'\n');});
  }
  async open(receipt:ModReadReceipt,actor:Actor,endpointEpoch:string):Promise<ModReadTransport>{
    if(this.closed)throw denied();
    if(!this.listening){
      this.server=http.createServer({maxHeaderSize:8192},(request,response)=>{void this.handle(request,response);});
      this.server.maxHeadersCount=16;this.server.requestTimeout=2000;this.server.headersTimeout=2000;this.server.keepAliveTimeout=20000;this.server.maxConnections=128;
      this.listening=new Promise((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(0,'127.0.0.1',resolve);});
    }
    await this.listening;if(this.closed)throw denied();
    for(const[id,capability]of this.capabilities)if(capability.actor.binding?.key===actor.binding?.key)this.remove(id);
                                  
    if(this.capabilities.size>=1024)this.remove(this.capabilities.keys().next().value!);
    const transport:ModReadTransport={url:`http://127.0.0.1:${(this.server!.address() as {port:number}).port}/mod-read`,id:randomBytes(32).toString('hex'),secret:randomBytes(32).toString('hex'),bindingEpoch:actor.binding!.epoch};
    const capability:Capability={transport,receipt,actor,endpointEpoch,inflight:new Set(),prepared:new Map()};
    if(this.write){transport.write={...transport,url:transport.url.replace('/mod-read','/mod-write'),id:randomBytes(32).toString('hex'),secret:randomBytes(32).toString('hex')};this.writes.set(transport.write.id,capability);}
    this.capabilities.set(transport.id,capability);return transport;
  }
  private remove(id:string):void{const capability=this.capabilities.get(id);if(capability?.transport.write)this.writes.delete(capability.transport.write.id);this.capabilities.delete(id);}
  revoke(binding:Actor['binding']):void{
    for(const[id,capability]of this.capabilities)if(capability.actor.binding?.key===binding?.key&&capability.actor.binding?.epoch===binding?.epoch)this.remove(id);
  }
  private reject(response:http.ServerResponse):void{
    response.writeHead(401,{'content-type':'application/json','cache-control':'no-store'});response.end('{"error":"mod_read_unavailable"}');
  }
  private async handle(request:http.IncomingMessage,response:http.ServerResponse):Promise<void>{
    let capability:Capability|undefined,operation:ModReadOperation|undefined,submitted=false,nonce:string|undefined,phase:string|undefined;
    const writing=request.url==='/mod-write';
    const timer=setTimeout(()=>response.destroy(),writing?10000:2000);
    try{
      const port=(this.server!.address() as {port:number}).port;
      if(this.closed||request.method!=='POST'||!['/mod-read','/mod-write'].includes(request.url??'')||request.headers.host!==`127.0.0.1:${port}`||request.socket.remoteAddress!=='127.0.0.1'||request.headers.origin||!/^application\/json(?:;|$)/i.test(String(request.headers['content-type']??''))){this.reject(response);return;}
      const id=request.headers['x-nxbridge-id'],authorization=request.headers.authorization;
      capability=typeof id==='string'?(writing?this.writes:this.capabilities).get(id):undefined;
      const transport=writing?capability?.transport.write:capability?.transport;
      if(!capability||!transport||typeof authorization!=='string'||(writing?!/^HMAC [a-f0-9]{64}$/.test(authorization):!authorization.startsWith('Bearer ')||!sameModReadSecret(transport.secret,authorization.slice(7)))){this.reject(response);return;}
      const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){const part=Buffer.from(chunk);bytes+=part.length;if(bytes>(writing?2*1024*1024:4096)){this.reject(response);return;}chunks.push(part);}const raw=Buffer.concat(chunks).toString('utf8');
      if(writing){
        if(!sameModReadSecret(sign(transport.secret,raw),authorization.slice(5))){this.reject(response);return;}
        const envelope=JSON.parse(raw);nonce=typeof envelope.nonce==='string'&&/^[a-f0-9]{64}$/.test(envelope.nonce)?envelope.nonce:undefined;phase=envelope.phase;
        const parsed=writeEnvelope.safeParse(envelope);if(!parsed.success){if(nonce&&['prepare','commit'].includes(phase!))this.writeReply(response,transport,phase!,nonce,409,{admitted:false});else this.reject(response);return;}
        if(parsed.data.phase==='prepare'){
                                                   
          if(capability.prepared.size>=128){this.writeReply(response,transport,phase!,nonce!,409,{admitted:false});return;}
          const ticket=randomBytes(32).toString('hex');
          capability.prepared.set(ticket,{until:Date.now()+5000,nonce:nonce!,operation:parsed.data.operation});this.writeReply(response,transport,phase!,nonce!,200,{ready:true,ticket});return;
        }
        const ready=capability.prepared.get(parsed.data.ticket);capability.prepared.delete(parsed.data.ticket);
                                                       
        if(!ready||ready.nonce!==nonce){this.writeReply(response,transport,phase!,nonce!,409,{admitted:true,error:{code:'mod_commit_unknown',message:'commit ticket unavailable; outcome unknown; check result before retry',uncertain:true}});return;}
        if(ready.until<Date.now()||ready.operation!==parsed.data.input.operation){this.writeReply(response,transport,phase!,nonce!,409,{admitted:false});return;}
        const work=this.write!(parsed.data.input,capability.actor,capability.receipt,capability.endpointEpoch,()=>{submitted=true;});this.pendingWrites.add(work);
        let value:unknown;try{value=await work;}finally{this.pendingWrites.delete(work);}
        this.writeReply(response,transport,phase!,nonce!,200,{value});return;
      }
      let parsed:ReturnType<typeof requestSchema.parse>;try{parsed=requestSchema.parse(JSON.parse(raw));}catch{this.reject(response);return;}
      if(capability.inflight.has(parsed.operation)){this.reject(response);return;}
      operation=parsed.operation;capability.inflight.add(operation);
      const value=await this.read(capability.actor,operation,capability.receipt,capability.endpointEpoch,parsed.nativeHealth),body=JSON.stringify(value);
      if(Buffer.byteLength(body)>32768)throw denied();
      response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(body);
    }catch(error){if(!response.destroyed&&!response.headersSent){if(writing&&nonce&&phase&&capability?.transport.write)this.writeReply(response,capability.transport.write,phase,nonce,submitted?500:409,{admitted:submitted,error:modelError(error)});else this.reject(response);}}
    finally{clearTimeout(timer);if(capability&&operation)capability.inflight.delete(operation);}
  }
  private writeReply(response:http.ServerResponse,transport:ModReadTransport,phase:string,nonce:string,status:number,value:unknown):void{
    const body=JSON.stringify(value).replace(/[^\x00-\x7f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify({body,mac:sign(transport.secret,transport.id+'\n'+phase+'\n'+nonce+'\n'+status+'\n'+body)}));
  }
  async close():Promise<void>{
    this.closed=true;this.capabilities.clear();this.writes.clear();await this.pruning;if(!this.server)return;
    await this.listening?.catch(()=>{});this.server.closeAllConnections();await Promise.allSettled(this.pendingWrites);await new Promise<void>(resolve=>this.server!.close(()=>resolve()));
  }
}
