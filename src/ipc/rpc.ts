import { EventEmitter } from 'node:events';
import {DeliveryError} from '../shared/errors.js';

export interface RpcMessage { jsonrpc?: string; id?: string | number; method?: string; params?: any; result?: any; error?: {code: number|string;message:string;data?:unknown} }
const circuits=new Map<string,{code:string;message:string;until:number}>();
const circuitKey=(endpoint:string,method:string,params:any)=>JSON.stringify([endpoint,method,params?.threadId??'']);
export function clearRpcFaults(endpoint:string):void{for(const key of circuits.keys())if(JSON.parse(key)[0]===endpoint)circuits.delete(key);}

                                       
export class RpcClient extends EventEmitter {
  private sequence=0;
  private pending=new Map<string|number,{resolve:(v:any)=>void;reject:(e:unknown)=>void;timer:NodeJS.Timeout;mutation:boolean;method:string;key?:string;maxBytes:number}>();
  readonly metrics={responses:0,bytes:0,parseMs:0,largestBytes:0,timeouts:0,rejected:0};
  closed=false;
  constructor(private sendWire:(message:RpcMessage)=>void,private closeWire:()=>void,readonly endpoint?:string) { super(); }
  receive(message:RpcMessage,measurement?:{bytes:number;parseMs:number}):void {
    if(measurement){this.metrics.responses++;this.metrics.bytes+=measurement.bytes;this.metrics.parseMs+=measurement.parseMs;this.metrics.largestBytes=Math.max(this.metrics.largestBytes,measurement.bytes);}
    if(message.id!==undefined&&!message.method){
      const pending=this.pending.get(message.id);if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      if(measurement&&measurement.bytes>pending.maxBytes){
        const fault={code:'response_too_large',message:pending.method+' 响应超过读取预算，已停止同类重试。',until:Date.now()+900000};if(pending.key)circuits.set(pending.key,fault);pending.reject(new DeliveryError(fault.code,fault.message,pending.mutation));return;
      }
      if(message.error){
        if(pending.key&&String(message.error.code)==='-32601')circuits.set(pending.key,{code:String(message.error.code),message:message.error.message,until:Date.now()+900000});
        const data=message.error.data as {uncertain?:boolean;issues?:unknown[];phase?:string;operation?:string;sqliteCode?:number;enable_command?:string}|undefined;
        pending.reject(Object.assign(new DeliveryError(String(message.error.code),message.error.message,data?.uncertain===true),Array.isArray(data?.issues)?{issues:data.issues}:{},{...(typeof data?.enable_command==='string'?{enable_command:data.enable_command}:{}),...(data?.phase==='prepare'||data?.phase==='enqueue'?{phase:data.phase}:{}),...(data?.operation?{operation:data.operation}:{}),...(data?.sqliteCode===undefined?{}:{sqliteCode:data.sqliteCode})}));
      }else pending.resolve(message.result);
    }else if(message.method)this.emit(message.id===undefined?'notification':'request',message);
  }
  request<T=any>(method:string,params:unknown={},options:{timeout?:number;mutation?:boolean;maxBytes?:number}={}):Promise<T>{
    if(this.closed)return Promise.reject(new DeliveryError('disconnected','连接已关闭。'));
    const key=this.endpoint&&!options.mutation?circuitKey(this.endpoint,method,params):undefined;let blocked=key?circuits.get(key):undefined;
    if(blocked&&blocked.until<=Date.now()){circuits.delete(key!);blocked=undefined;}
    if(blocked){this.metrics.rejected++;return Promise.reject(new DeliveryError(blocked.code,blocked.message));}
    if(this.endpoint&&this.pending.size>=16){this.metrics.rejected++;return Promise.reject(new DeliveryError('rpc_backpressure','原生请求队列已满，稍后自动重试。'));}
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);this.metrics.timeouts++;reject(new DeliveryError('timeout',`${method} 等待确认超时。`,options.mutation??false));},options.timeout??15000);
      this.pending.set(id,{resolve,reject,timer,mutation:options.mutation??false,method,key,maxBytes:options.maxBytes??4*1024*1024});
      try{this.sendWire({jsonrpc:'2.0',id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(new DeliveryError('disconnected',error instanceof Error?error.message:String(error),options.mutation??false));}
    });
  }
  notify(method:string,params:unknown={}):void {if(!this.closed)this.sendWire({jsonrpc:'2.0',method,params});}
  respond(id:string|number,result:unknown):void {if(!this.closed)this.sendWire({jsonrpc:'2.0',id,result});}
  disconnected(reason='连接已断开。',code='disconnected'):void {
    if(this.closed)return;this.closed=true;
                                            
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(new DeliveryError(code,reason,p.mutation),{operation:p.method}));}
    while(circuits.size>256)circuits.delete(circuits.keys().next().value!);
    this.pending.clear();this.emit('disconnected');
  }
  close():void {this.disconnected();this.closeWire();}
}
