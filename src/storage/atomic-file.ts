import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import path from 'node:path';
import { windowsFileLockOwners } from '../process/windows/windows-file-lock.js';
import {syncDirectory} from './state-directory.js';

const BACKOFF=[20,40,80,160,320,640];
const sleeper=new Int32Array(new SharedArrayBuffer(4));

export function retryWindowsFileOperation<T>(operation:()=>T,filename:string,options:{platform?:NodeJS.Platform;wait?:(ms:number)=>void;diagnose?:(file:string)=>string}={}):T{
  for(let attempt=0;;attempt++)try{return operation();}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if((options.platform??process.platform)!=='win32'||!['EPERM','EBUSY','EACCES'].includes(code??''))throw error;
    if(attempt>=BACKOFF.length){
      if(error instanceof Error)error.message=`${filename}：${error.message}；${(options.diagnose??windowsFileLockOwners)(filename)} 未删除或绕过目标文件；请关闭占用后重新运行原命令。`;
      throw error;
    }
    (options.wait??(ms=>Atomics.wait(sleeper,0,0,ms)))(BACKOFF[attempt]!);
  }
}

export interface AtomicWriteOptions {exclusive?:boolean;durability?:'durable'|'buffered'}

                                            
export function atomicWriteText(filename:string,text:string,options:AtomicWriteOptions={}):void{
  atomicWriteFile(filename,text,options);
}

export function atomicWriteFile(filename:string,content:string|Buffer,options:AtomicWriteOptions={}):void{
  const exclusive=options.exclusive??false,durable=options.durability!=='buffered';
  const temporary=filename+'.'+randomUUID()+'.tmp';
  let failure:unknown,temporaryPresent=true;
  try{
    writeFileSync(temporary,content,{encoding:'utf8',mode:0o600,flag:'wx',flush:durable});
    retryWindowsFileOperation(()=>exclusive?linkSync(temporary,filename):renameSync(temporary,filename),filename);
    if(!exclusive)temporaryPresent=false;
                                       
    if(durable)syncDirectory(path.dirname(filename));
  }catch(error){failure=error;throw error;}
  finally{
    try{if(temporaryPresent)retryWindowsFileOperation(()=>unlinkSync(temporary),temporary);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT'){
        if(failure instanceof Error)failure.message+=` 临时文件待清理：${temporary}。`;
        else if(!failure)throw error;
      }
    }
  }
}
