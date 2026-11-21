import {statSync} from 'node:fs';
import path from 'node:path';
import {describeError} from '../shared/errors.js';

                                          
export class ConfigurationReload {
  private stamp:string;
  private checkedAt=Number.NEGATIVE_INFINITY;
  private result:{appliedAt?:number;error?:string}={};
  constructor(private home:string,private now=Date.now){this.stamp=this.signature();}
  private signature():string{
    return['config.toml','config.managed.toml','config.json'].map(name=>{
      try{const stat=statSync(path.join(this.home,name));return[name,stat.dev,stat.ino,stat.size,stat.mtimeMs].join(':');}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return name+':missing';throw error;}
    }).join('|');
  }
  get status(){return{...this.result};}
  applied():void{this.stamp=this.signature();this.result={appliedAt:this.now()};}
  poll(apply:()=>void):'unchanged'|'applied'|'failed'{
    const now=this.now();if(now-this.checkedAt<1000)return'unchanged';this.checkedAt=now;
    const current=this.signature();if(current===this.stamp)return'unchanged';this.stamp=current;
    try{apply();this.result={appliedAt:now};return'applied';}
    catch(error){this.result={...this.result,error:describeError(error).slice(0,1200)};return'failed';}
  }
}
