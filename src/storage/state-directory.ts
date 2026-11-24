import {closeSync,fsyncSync,mkdirSync,openSync} from 'node:fs';
import path from 'node:path';

const pendingDirectories=new Map<string,string>();

                                        
export function syncDirectory(directory:string):void{
  if(process.platform==='win32')return;
  let descriptor:number|undefined;
  try{descriptor=openSync(directory,'r');fsyncSync(descriptor);}
  catch(error){
                                                       
    if(['EACCES','EPERM','EINVAL','ENOTSUP','EOPNOTSUPP','ENOSYS'].includes((error as NodeJS.ErrnoException).code??''))return;
    if(error instanceof Error)error.message='状态目录无法同步 '+directory+'：'+error.message;
    throw error;
  }finally{if(descriptor!==undefined)closeSync(descriptor);}
}

                                     
export function stateDirectory(directory:string,mode=0o777):string|undefined{
  const resolved=path.resolve(directory),created=mkdirSync(resolved,{recursive:true,mode});
  if(process.platform==='win32')return created;
  if(created!==undefined){
    const parent=path.dirname(created),pending=pendingDirectories.get(resolved);
    if(pending===undefined||parent.length<pending.length)pendingDirectories.set(resolved,parent);
  }
  const through=pendingDirectories.get(resolved);if(through===undefined)return created;
                                         
  for(let current=resolved;;){
    syncDirectory(current);if(current===through)break;current=path.dirname(current);
  }
  pendingDirectories.delete(resolved);
  return created;
}
