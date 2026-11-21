import type { BrokerSession } from '../../ipc/ipc.js';
import { BridgeError, describeError } from '../../shared/errors.js';
import { codexHome } from '../../shared/local-paths.js';

export const CODEX_HOOK_TOOL='nxbridge_hook';
const HOOK_BUDGET_MS=9000;

                                          
export class McpHook {
  private unhealthy=false;
  private recovery?:NodeJS.Timeout;
  private closed=false;
  constructor(private connection:Pick<BrokerSession,'connect'|'request'>,private budget=HOOK_BUDGET_MS){}
  private recover():void{
    if(this.closed||this.recovery)return;
    this.recovery=setTimeout(()=>{
      this.recovery=undefined;
      void this.bounded(async remaining=>{await this.connection.connect();await this.connection.request('ping',{}, {timeout:remaining()});},500).then(()=>{this.unhealthy=false;},()=>this.recover());
    },5000);this.recovery.unref();
  }
  private async bounded<T>(execute:(remaining:()=>number)=>Promise<T>,limit=this.budget,signal?:AbortSignal):Promise<T>{
    const until=performance.now()+limit;let active=true;
    const remaining=()=>{signal?.throwIfAborted();const left=Math.ceil(until-performance.now());if(!active||this.closed||left<=0)throw new BridgeError('timeout','MCP hook 已到总截止时间，结果尚未确认。');return left;};
    let timer:NodeJS.Timeout|undefined;
    let abort:(()=>void)|undefined;
    try{return await Promise.race([execute(remaining),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new BridgeError('timeout','MCP hook 已到总截止时间，结果尚未确认。')),remaining());abort=()=>reject(new BridgeError('cancelled','原生宿主已取消本次 hook，结果尚未确认。'));signal?.addEventListener('abort',abort,{once:true});})]);}
    finally{active=false;clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
  }
  async run(input:unknown,meta:Record<string,unknown>,requestId:string|number,receipts:Map<string|number,string>,signal?:AbortSignal):Promise<unknown>{
    const event=input as Record<string,unknown>|undefined,threadId=meta.threadId;
    if(typeof threadId!=='string'||!threadId||typeof event?.session_id!=='string'||!event.session_id||event.hook_event_name!=='PostToolUse')throw new BridgeError('unverified_identity','隐藏 hook 只接受原生线程的 PostToolUse。');
    if(this.closed||this.unhealthy)throw new BridgeError('hook_unavailable','MCP hook 正等待协调器恢复；未提交本次请求。');
    const began=Date.now();
    try{return await this.bounded(async remaining=>{
      await this.connection.connect();
                                             
      const timeout=remaining();
      const reply=await this.connection.request('hook.client.mcp',{hook_pid:process.pid,config_home:codexHome(),cwd:process.cwd(),started_at:began,elapsed_ms:Date.now()-began,thread_id:threadId,input},{timeout,mutation:true});
      remaining();if(typeof reply.receipt==='string')receipts.set(requestId,reply.receipt);
      return reply.output??{};
    },this.budget,signal);}catch(error){
      if(['timeout','disconnected','broker_timeout','ENOENT','ECONNREFUSED','EPIPE'].includes((error as {code?:string}).code??'')){this.unhealthy=true;this.recover();}
      throw error;
    }
  }
  acknowledge(receipt:string):void{
    void this.bounded(async remaining=>{await this.connection.connect();await this.connection.request('hook.client.ack',{receipt},{timeout:remaining(),mutation:true});},500).catch(error=>process.stderr.write('nxbridge hook 回执：'+describeError(error)+'\n'));
  }
  close():void{this.closed=true;clearTimeout(this.recovery);}
}
