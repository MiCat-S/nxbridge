import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { windowsHookIdentityHelper } from './windows-hook-identity.js';
import {BridgeError} from '../../shared/errors.js';
import { remainingTime } from '../../shared/time-budget.js';

export interface WindowsHostIdentity {pid:number;parentPid:number;image:string;launchImage:string;procStart:string;procStartTicks:string;commandLine:string}

                                      
export class WindowsIdentitySession {
  private child?:ChildProcessWithoutNullStreams;
  private opening?:Promise<ChildProcessWithoutNullStreams>;
  private sequence=0;
  private lastResponseAt=0;
  private pending=new Map<number,{resolve:(value:WindowsHostIdentity)=>void;reject:(error:unknown)=>void;timer:NodeJS.Timeout}>();
  private closed=false;
  constructor(private home:string,private launch=(binary:string)=>spawn(binary,['serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']})){}
  private fail(error:unknown,child=this.child):void{
    if(child!==this.child)return;
    this.child=undefined;child?.kill();
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();
  }
  private open(timeout:number):Promise<ChildProcessWithoutNullStreams>{
    if(this.closed)return Promise.reject(new BridgeError('hook_identity_unavailable','身份查询助手已关闭。'));
    if(this.child)return Promise.resolve(this.child);
    return this.opening??=windowsHookIdentityHelper(this.home,timeout).then(binary=>{
      if(this.closed)throw new BridgeError('hook_identity_unavailable','身份查询助手已关闭。');
      const child=this.launch(binary);this.child=child;this.lastResponseAt=performance.now();
      let buffer='';child.stdout.setEncoding('utf8');child.stderr.resume();
      child.stdout.on('data',(chunk:string)=>{
        buffer+=chunk;if(buffer.length>1024*1024){this.fail(new BridgeError('hook_identity_unavailable','身份查询响应超过限制。'),child);return;}
        let at:number;while((at=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
          try{
            const reply=JSON.parse(line),request=this.pending.get(reply.id);this.lastResponseAt=performance.now();if(!request)continue;
            clearTimeout(request.timer);this.pending.delete(reply.id);
            if(reply.error){request.reject(new BridgeError('process_identity_unknown',String(reply.error)));continue;}
            request.resolve(reply.result as WindowsHostIdentity);
          }catch{this.fail(new BridgeError('hook_identity_unavailable','身份查询响应格式错误。'),child);return;}
        }
      });
      child.once('error',()=>this.fail(new BridgeError('hook_identity_unavailable','身份查询助手无法启动。'),child));
      child.once('exit',()=>this.fail(new BridgeError('hook_identity_unavailable','身份查询助手已退出。'),child));
      child.stdin.on('error',()=>this.fail(new BridgeError('hook_identity_unavailable','身份查询管道已关闭。'),child));
      return child;
    }).finally(()=>{this.opening=undefined;});
  }
  async read(pid:number,timeout=2000,skipOrigin=false,host:'codex'|'claude'='codex'):Promise<WindowsHostIdentity>{
    return this.request(pid,timeout,skipOrigin?host+'-hook':host);
  }
                                           
  async prepare(timeout=10000):Promise<void>{await this.request(process.pid,timeout,'process');}
  private async waitForOpen(timeout:number):Promise<ChildProcessWithoutNullStreams>{
    let timer:NodeJS.Timeout|undefined;
    try{return await Promise.race([this.open(timeout),new Promise<never>((_,reject)=>{
                                          
      timer=setTimeout(()=>reject(new BridgeError('process_identity_unknown','等待身份查询助手启动超时，本次身份未确认。')),timeout);
    })]);}finally{clearTimeout(timer);}
  }
  private async request(pid:number,timeout:number,mode:string):Promise<WindowsHostIdentity>{
    if(!Number.isSafeInteger(pid)||pid<=0)throw new BridgeError('process_identity_invalid','hook PID 无效。');
    const deadline=performance.now()+timeout,child=this.child??await this.waitForOpen(timeout),budget=remainingTime(deadline,timeout),id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);const error=new BridgeError('process_identity_unknown','身份查询助手超时，本次身份未确认。');reject(error);
                                                
        if(!this.pending.size||performance.now()-this.lastResponseAt>=5000)this.fail(error,child);
      },budget);
      this.pending.set(id,{resolve,reject,timer});child.stdin.write(`${id} ${mode} ${pid}\n`);
    });
  }
  close():void{this.closed=true;this.fail(new BridgeError('hook_identity_unavailable','身份查询助手已关闭。'));}
}
