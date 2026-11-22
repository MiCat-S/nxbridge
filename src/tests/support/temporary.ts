import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { cleanupTestProcesses, registerTestDirectory } from '../../process/test-processes.js';
import {delay} from '../../shared/time.js';

                                                        
function prepareFixtureRemoval(directory:string):void{
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const filename=path.join(directory,entry.name);
                                                                  
    if(entry.isSymbolicLink()){unlinkSync(filename);continue;}
    if(entry.isDirectory())prepareFixtureRemoval(filename);else if(entry.isFile())chmodSync(filename,0o666);
  }
  chmodSync(directory,0o700);
}
async function removeFixture(directory:string):Promise<void>{
  for(let attempt=0;;attempt++)try{
    if(process.platform==='win32'&&existsSync(directory))prepareFixtureRemoval(directory);
    rmSync(directory,{recursive:true});return;
  }catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='ENOENT'&&!existsSync(directory))return;
                                                     
    if(attempt>=6||!['ENOENT','EBUSY','EPERM','ENOTEMPTY','EMFILE','ENFILE'].includes(code??''))throw error;
                                        
    await delay(200*(attempt+1));
  }
}
export function temporaryDirectory(root=tmpdir()):{directory:string;cleanup:()=>Promise<void>}{
  const directory=mkdtempSync(path.join(root,'nxbridge-test-'));
  registerTestDirectory(directory);
  return{directory,cleanup:async()=>{if(path.dirname(path.resolve(directory))!==path.resolve(root)||!path.basename(directory).startsWith('nxbridge-test-'))throw Error('临时目录越界');const cleanup=await cleanupTestProcesses(directory);if(cleanup.notes.length)throw Error('隔离进程回收未完成，保留测试目录：'+cleanup.notes.join('；'));await removeFixture(directory);}};
}
export function temporary(t:TestContext):string{const tmp=temporaryDirectory();t.after(tmp.cleanup);return tmp.directory;}

                                            
export function temporaryAlias(t:TestContext):string{
  const root=temporary(t),actual=path.join(root,'actual'),alias=path.join(root,'alias');
  mkdirSync(actual);symlinkSync(actual,alias,process.platform==='win32'?'junction':'dir');
  return alias;
}
