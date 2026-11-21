import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {originalIdentityRevision} from './embedded-code.mjs';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function synchronizeIdentityRevision(root=workspace,{check=false}={}){
  const revision=originalIdentityRevision(root),filename=path.join(root,'src/process/windows/identity-revision.ts');
  const text='export const WINDOWS_IDENTITY_REVISION='+JSON.stringify(revision)+';\n';
  if(!existsSync(filename)||readFileSync(filename,'utf8')!==text){
    if(check)throw Error('原生身份助手修订号未同步，请重新构建。');
    writeFileSync(filename,text,'utf8');
  }
  return revision;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))synchronizeIdentityRevision(workspace,{check:process.argv.includes('--check')});
