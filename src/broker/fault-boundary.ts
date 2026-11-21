import {describeError} from '../shared/errors.js';

interface Failure {error:string;count:number;retryAt:number;lastAt:number;observedAt:number}
export const SKIPPED=Symbol('skipped');

                                    
export class FaultBoundary {
  private failures=new Map<string,Failure>();
  constructor(private event:(type:string,data:unknown)=>void,private now=Date.now){}
  ready(stage:string):boolean{
    let value=this.failures.get(stage);const now=this.now();
    if(value&&now-value.observedAt>300000){this.failures.delete(stage);value=undefined;}
    if(value)value.observedAt=now;return (value?.retryAt??0)<=now;
  }
  recovered(stage:string):void{this.failures.delete(stage);}
  failedOnce(stage:string,error:unknown):void{
    const prior=this.failures.get(stage);if(prior){prior.observedAt=this.now();return;}
    this.failed(stage,error);
  }
  failed(stage:string,error:unknown):void{
    const detail=describeError(error),prior=this.failures.get(stage),count=(prior&&this.now()-prior.observedAt<=300000?prior.count:0)+1;
    const retryAt=count>=3?this.now()+Math.min(60000,5000*2**Math.min(count-3,4)):0;
    this.failures.set(stage,{error:detail,count,retryAt,lastAt:this.now(),observedAt:this.now()});
    if(this.failures.size>512)this.failures.delete(this.failures.keys().next().value!);
    const code=(error as {code?:string}|undefined)?.code;
    const data={stage,error:detail,...(typeof code==='string'?{code}:{}),count,...(retryAt?{degraded:true,retryAt}:{})};
    try{this.event('pump.failed',data);}catch{try{process.stderr.write(JSON.stringify({type:'pump.failed',...data})+'\n');}catch{                        }}
  }
  sync(stage:string,work:()=>unknown):boolean{
    if(!this.ready(stage))return false;
    try{const result=work();if(result===SKIPPED)return false;this.recovered(stage);return true;}catch(error){this.failed(stage,error);return false;}
  }
  async run(stage:string,work:()=>unknown|Promise<unknown>):Promise<boolean>{
    if(!this.ready(stage))return false;
    try{const result=await work();if(result===SKIPPED)return false;this.recovered(stage);return true;}catch(error){this.failed(stage,error);return false;}
  }
  map<T,R>(stage:string,values:T[],key:(value:T)=>string,work:(value:T)=>R):R[]{
    const result:R[]=[];
    for(const value of values)this.sync(stage+':'+key(value),()=>{result.push(work(value));});
    return result;
  }
  status(){
                                   
    for(const [stage,value] of this.failures)if(this.now()-value.observedAt>300000)this.failures.delete(stage);
    return [...this.failures].map(([stage,{observedAt,...value}])=>({stage,...value,degraded:value.count>=3}));
  }
}
