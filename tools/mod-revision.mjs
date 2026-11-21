import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function synchronizeModRevision(root=workspace,{check=false}={}){
  const directory=path.join(root,'plugins/claude/hooks');
                                                  
  const inputs=readdirSync(directory).filter(name=>name.endsWith('.js')&&name!=='integration-revision.js').sort();
  const hash=createHash('sha256');
  for(const name of inputs)hash.update(name+'\0'+readFileSync(path.join(directory,name),'utf8').replaceAll('\r\n','\n')+'\0');
  const revision=hash.digest('hex').slice(0,16),text=`export const MOD_REVISION=${JSON.stringify(revision)};\n`;
  for(const relative of ['src/mod-revision.ts','plugins/claude/hooks/integration-revision.js']){
    const filename=path.join(root,relative);
    if(existsSync(filename)&&readFileSync(filename,'utf8')===text)continue;
    if(check)throw Error('Mod 修订号未同步，请重新构建：'+relative);
    writeFileSync(filename,text,'utf8');
  }
  return revision;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))synchronizeModRevision(workspace,{check:process.argv.includes('--check')});
