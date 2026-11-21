import type { Store } from '../../storage/store.js';
import { probeProcesses } from '../../process/process.js';
import {BridgeError} from '../../shared/errors.js';

export interface CodexForegroundWindow {endpoint:string;sessionId?:string;foreground:{pid:number;procStart:string}}
const setting='codexForegroundWindows';
const key=(window:CodexForegroundWindow)=>JSON.stringify([window.endpoint,window.foreground.pid,window.foreground.procStart]);
const overlaps=(left:CodexForegroundWindow,right:CodexForegroundWindow)=>left.endpoint===right.endpoint&&(!left.sessionId||!right.sessionId||left.sessionId===right.sessionId);

                                         
export class CodexForegroundWindows {
  private checking?:Promise<void>;
  constructor(private store:Store,private onEnded:(window:CodexForegroundWindow)=>Promise<void>,private probe=probeProcesses){}
  private windows():CodexForegroundWindow[]{return this.store.setting<CodexForegroundWindow[]>(setting)??[];}
  register(window:CodexForegroundWindow):void{
    this.store.setSetting(setting,[...this.windows().filter(value=>key(value)!==key(window)),window]);
  }
  sweep():Promise<void>{
    if(this.checking)return this.checking;
    const work=this.check(this.windows()).finally(()=>{if(this.checking===work)this.checking=undefined;});
    this.checking=work;return work;
  }
  async end(window:CodexForegroundWindow):Promise<void>{
    await this.check([...this.windows().filter(value=>key(value)!==key(window)),window],key(window));
  }
  private async check(windows:CodexForegroundWindow[],only?:string):Promise<void>{
    if(!windows.length)return;
    const states=await this.probe(windows.map(window=>window.foreground)),known=new Map(windows.map((window,index)=>[key(window),states[index]]));
    if(only&&known.get(only)!=='dead')throw new BridgeError('holder_unknown','远程窗口尚未核验退出。');
    for(const window of windows){
      const id=key(window);if(known.get(id)!=='dead'||only&&only!==id)continue;
      const siblings=this.windows().filter(other=>key(other)!==id&&overlaps(window,other));
                                     
      if(siblings.some(other=>known.get(key(other))!=='alive'&&known.get(key(other))!=='dead'))continue;
      if(!siblings.some(other=>known.get(key(other))==='alive'))await this.onEnded(window);
      this.store.setSetting(setting,this.windows().filter(value=>key(value)!==id));
    }
  }
}
