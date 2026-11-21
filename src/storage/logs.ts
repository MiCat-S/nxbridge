import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';

                                           
export function rotateLog(filename:string,maxBytes:number,backups:number):boolean{
  try{
    if(!existsSync(filename)||statSync(filename).size<maxBytes)return false;
    const last=filename+'.'+backups;
    if(existsSync(last))unlinkSync(last);
    for(let i=backups-1;i>=1;i--)if(existsSync(filename+'.'+i))renameSync(filename+'.'+i,filename+'.'+(i+1));
    renameSync(filename,filename+'.1');return true;
  }catch(error){
    if(['ENOENT','EACCES','EPERM','EBUSY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))return false;
    throw error;
  }
}

                                                  
export function capLog(filename:string,maxBytes:number):boolean{
  let fd:number|undefined;
  try{
    if(statSync(filename).size<=maxBytes)return false;
    fd=openSync(filename,'r+');const size=fstatSync(fd).size;
    if(size<=maxBytes)return false;
    const tail=Buffer.alloc(Math.floor(maxBytes/2)),length=readSync(fd,tail,0,tail.length,size-tail.length);
    ftruncateSync(fd,0);writeSync(fd,tail,0,length,0);return true;
  }catch(error){if(['ENOENT','EACCES','EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}
  finally{if(fd!==undefined)closeSync(fd);}
}
