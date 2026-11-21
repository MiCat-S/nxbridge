import path from 'node:path';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {stripVTControlCharacters} from 'node:util';
import {NativeTerminal} from './terminal-fixture.js';
import {nativeDescendant,type ProcessIdentity} from '../process/process.js';
import {containerCompletionFile,rememberOwnedChild,releaseOwnedProcess,type OwnedProcessRecord} from '../process/owned-processes.js';
import {spawnPosixSupervisor} from '../process/posix/posix-supervisor.js';
import {delay} from '../shared/time.js';

export interface Terminal {
  output:string;
  errors:string;
  identity:ProcessIdentity;
  send(value:string):void;
  prompt(value:string):Promise<void>;
  wait(check:()=>boolean|Promise<boolean>,reason:string,timeout?:number):Promise<void>;
  close():Promise<void>;
}

export function startTerminal(root:string,home:string,exe:string,args:string[],cwd:string,env:NodeJS.ProcessEnv):Promise<Terminal>{
  return process.platform==='win32'?NativeTerminal.start(root,home,exe,args,cwd,env):PosixTerminal.start(root,home,exe,args,cwd,env);
}

class PosixTerminal implements Terminal {
  output='';
  errors='';
  identity!:ProcessIdentity;
  private exited:Promise<void>;
  private controller?:OwnedProcessRecord;
  private group?:OwnedProcessRecord;
  private constructor(private child:ChildProcessWithoutNullStreams,private host:'codex'|'claude'){
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',(value:string)=>{
      this.output=(this.output+value).slice(-400000);
      if(value.includes('\x1b[6n'))this.send('\x1b[1;1R');
      if(value.includes('\x1b[c'))this.send('\x1b[?1;2c');
    });
    child.stderr.on('data',(value:string)=>this.errors=(this.errors+value).slice(-12000));
    this.exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>resolve());});
    void this.exited.catch(()=>{});
  }
  static async start(root:string,home:string,exe:string,args:string[],cwd:string,env:NodeJS.ProcessEnv):Promise<PosixTerminal>{
    const host=[exe,...args.slice(0,1)].some(value=>/claude/i.test(value))?'claude':'codex';
    const terminalArgs=host==='claude'&&!args.includes('--permission-mode')?[...args,'--permission-mode','default']:args;
    const directory=path.join(root,'terminal-'+randomUUID()),ready=path.join(directory,'ready');mkdirSync(directory);
    const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'",launchId=randomUUID(),completion=containerCompletionFile(home);
    const worker=fileURLToPath(new URL('./posix-terminal-worker.js',import.meta.url));
    const command='stty cols 150 rows 45 && exec '+[process.execPath,worker,home,ready,completion,launchId,exe,...terminalArgs].map(quote).join(' ');
                                                            
    const scriptArgs=process.platform==='darwin'?['-q','/dev/null','/bin/sh','-c',command]:['-q','-f','-e','-c',command,'/dev/null'];
                                                                          
    const pipedInput=process.platform==='darwin';
    const child=pipedInput?spawnPosixSupervisor('/bin/sh',['-c','/bin/cat | exec "$@"','nxbridge-pty','/usr/bin/script',...scriptArgs],{cwd,env,stdio:['pipe','pipe','pipe']}):spawn('/usr/bin/script',scriptArgs,{cwd,env,stdio:['pipe','pipe','pipe']});
    const terminal=new PosixTerminal(child as ChildProcessWithoutNullStreams,host);
    try{
      terminal.controller=await rememberOwnedChild(home,terminal.child,'host-control',pipedInput?{posixGroup:true}:{},launchId);
      if(!terminal.controller)throw Error('伪终端控制进程已经退出');
      await terminal.wait(()=>existsSync(ready),'伪终端工作进程未就绪',15000);
      terminal.group=JSON.parse(readFileSync(ready,'utf8')) as OwnedProcessRecord;
      const deadline=Date.now()+15000;
      for(;;)try{terminal.identity=await nativeDescendant(terminal.group.identity.pid,host,0,undefined,terminal.group);break;}catch(error){
        if(terminal.child.exitCode!==null||Date.now()>=deadline)throw error;
        await delay(50);
      }
      return terminal;
    }catch(error){
      let cleanupError:unknown;try{await terminal.close();}catch(failure){cleanupError=String(failure);}
      throw new Error(String(error)+'\n'+terminal.errors+'\n'+terminal.output.slice(-4000)+(cleanupError?'\n'+cleanupError:''),{cause:error});
    }
  }
  send(value:string):void{if(!this.child.stdin.destroyed)this.child.stdin.write(value);}
  async wait(check:()=>boolean|Promise<boolean>,reason:string,timeout=20000):Promise<void>{
    const end=Date.now()+timeout;
    while(!await check()){
      if(this.child.exitCode!==null||Date.now()>end)throw Error(reason+'\n'+this.errors+'\n'+stripVTControlCharacters(this.output).slice(-4500));
      await delay(50);
    }
  }
  async prompt(value:string):Promise<void>{
    const offset=this.output.length;this.send(value);
    if(this.host==='claude'&&value)await this.wait(()=>stripVTControlCharacters(this.output.slice(offset)).replace(/\s+/gu,'').includes(value.replace(/\s+/gu,'')),'原生输入未回显',15000);
    await delay(this.host==='claude'?600:150);this.send('\r');
  }
  async close():Promise<void>{
    try{if(this.group)await releaseOwnedProcess(this.group);}finally{
      this.child.stdin.end();if(this.controller)await releaseOwnedProcess(this.controller);await this.exited;
    }
  }
}
