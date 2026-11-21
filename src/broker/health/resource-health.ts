import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
const STALE_MS=90000,GiB=1024**3;
export interface ResourceSample {
  checkedAt:number;cpuPercent?:number;cpuWindowMs?:number;memoryFreeBytes?:number;memoryTotalBytes?:number;
  diskFreeBytes?:number;diskTotalBytes?:number;brokerLagMs?:number;
  io:{metadataMs?:number;pressureSomeAvg10?:number;pressureFullAvg10?:number;ownBlockReads?:number;ownBlockWrites?:number;systemAvailable:boolean};
  unavailable:string[];
}
export type ResourceSampler=(lagMs:number)=>Promise<ResourceSample>;

                                                
export function resourceSampler(home:string,platform:NodeJS.Platform=process.platform):ResourceSampler{
                                       
  if(process.env.NXBRIDGE_TEST_SCOPE)return async lag=>({checkedAt:Date.now(),brokerLagMs:lag,io:{systemAvailable:false},unavailable:['isolated test sampler']});
  return async brokerLagMs=>{
    const totals=()=>os.cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
    const before=totals(),usage=process.resourceUsage(),cpuStarted=performance.now();
                                            
    await new Promise<void>(resolve=>setTimeout(resolve,100));
    const cpuWindowMs=performance.now()-cpuStarted,after=totals();
    const value:ResourceSample={checkedAt:Date.now(),memoryFreeBytes:os.freemem(),memoryTotalBytes:os.totalmem(),brokerLagMs:Math.max(brokerLagMs,cpuWindowMs-100),io:{systemAvailable:false},unavailable:[]};
    if(after.total>before.total){value.cpuPercent=Math.max(0,Math.min(100,100*(1-(after.idle-before.idle)/(after.total-before.total))));value.cpuWindowMs=cpuWindowMs;}
    if(platform!=='win32'){const next=process.resourceUsage();value.io.ownBlockReads=Math.max(0,next.fsRead-usage.fsRead);value.io.ownBlockWrites=Math.max(0,next.fsWrite-usage.fsWrite);}
    const began=performance.now();
    const results=await Promise.allSettled([statfs(home).then(result=>{value.io.metadataMs=performance.now()-began;return result;}),platform==='linux'?readFile('/proc/meminfo','utf8'):Promise.resolve(undefined),platform==='linux'?readFile('/proc/pressure/io','utf8'):Promise.resolve(undefined)]);
    const disk=results[0];if(disk.status==='fulfilled'){value.diskFreeBytes=disk.value.bavail*disk.value.bsize;value.diskTotalBytes=disk.value.blocks*disk.value.bsize;}else value.unavailable.push('data-volume free space unavailable');
    const memory=results[1];if(memory.status==='fulfilled'&&memory.value){const available=/^MemAvailable:\s+(\d+) kB$/m.exec(memory.value);if(available)value.memoryFreeBytes=Number(available[1])*1024;}
    const pressure=results[2];if(pressure.status==='fulfilled'&&pressure.value){for(const [kind,key] of [['some','pressureSomeAvg10'],['full','pressureFullAvg10']] as const){const match=new RegExp('^'+kind+' avg10=([\\d.]+)','m').exec(pressure.value);if(match)value.io[key]=Number(match[1]);}value.io.systemAvailable=value.io.pressureSomeAvg10!==undefined;}
    if(!value.io.systemAvailable)value.unavailable.push(platform+' system-wide IO pressure unavailable; metadata latency measures nxbridge filesystem access only');
    return value;
  };
}

export function resourceEvidence(value:ResourceSample|undefined):string{
  if(!value||Date.now()-value.checkedAt>STALE_MS)return'';
  const fields=[value.cpuPercent===undefined?undefined:`cpu ~${Math.round(value.cpuPercent)}% (${Math.round(value.cpuWindowMs??0)} ms sample)`,value.memoryFreeBytes===undefined||!value.memoryTotalBytes?undefined:`ram free ${Math.round(value.memoryFreeBytes/value.memoryTotalBytes*100)}%`,value.diskFreeBytes===undefined?undefined:`disk free ${(value.diskFreeBytes/GiB).toFixed(1)} GB`,value.brokerLagMs===undefined?undefined:`broker lag ${Math.round(value.brokerLagMs)} ms`].filter(Boolean);
  return fields.length?'evidence: '+fields.join(', '):'';
}
export function resourceSummary(value:ResourceSample):string{
  const size=(bytes:number)=>(bytes/GiB).toFixed(1)+' GB',at=new Date(value.checkedAt),time=[at.getHours(),at.getMinutes(),at.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':');
  const fields=[value.cpuPercent===undefined?undefined:`CPU 约 ${Math.round(value.cpuPercent)}%（${Math.round(value.cpuWindowMs??0)} ms 采样）`,value.memoryFreeBytes===undefined||value.memoryTotalBytes===undefined?undefined:`内存剩余 ${size(value.memoryFreeBytes)}/${size(value.memoryTotalBytes)}`,value.diskFreeBytes===undefined||value.diskTotalBytes===undefined?undefined:`nxbridge 数据盘剩余 ${size(value.diskFreeBytes)}/${size(value.diskTotalBytes)}`,value.brokerLagMs===undefined?undefined:`nxbridge 响应延迟 ${Math.round(value.brokerLagMs)} ms`,value.io.metadataMs===undefined?undefined:`文件访问延迟 ${Math.round(value.io.metadataMs)} ms`,value.io.pressureSomeAvg10===undefined?undefined:`IO 压力 ${value.io.pressureSomeAvg10}%`].filter(Boolean);
  return fields.length?`机器资源（${time}）：${fields.join('，')}${value.io.systemAvailable?'':'（此系统无法测整体 IO 压力，只测 nxbridge 自身文件访问）'}`:'';
}

export class ResourceHealth {
  private latest?:ResourceSample;
  private running?:Promise<void>;
  private stopped=false;
  private reason?:'hook_timeout'|'runtime_unverified';
  constructor(private sampler:ResourceSampler,private now=Date.now){}
  stop():void{this.stopped=true;}
  request(reason:'hook_timeout'|'runtime_unverified'):Promise<void>{if(this.stopped)return Promise.resolve();this.reason=reason;if(this.latest&&this.now()-this.latest.checkedAt<5000)return Promise.resolve();return this.sample();}
  sample(lagMs=0):Promise<void>{
    return this.running??=(async()=>{
      let value:ResourceSample;try{value=await this.sampler(lagMs);}catch{return;}
      if(this.stopped)return;this.latest=value;
    })().finally(()=>{this.running=undefined;});
  }
  snapshot():{state:'fresh'|'stale'|'unavailable';reason?:string;pending:boolean;sample?:ResourceSample;summary?:string}{const fresh=!!this.latest&&this.now()-this.latest.checkedAt<=STALE_MS;return{state:!this.latest?'unavailable':fresh?'fresh':'stale',...(this.reason?{reason:this.reason}:{}),pending:!!this.running,...(this.latest?{sample:this.latest}:{}),...(fresh?{summary:resourceSummary(this.latest!)}:{})};}
}
