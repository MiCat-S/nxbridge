import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pluginManifests=['plugins/claude/.claude-plugin/plugin.json','plugins/codex/.codex-plugin/plugin.json'];

export function synchronizeVersions(root=workspace,{check=false}={}){
  const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
  if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))throw Error('package.json 的版本号无效。');
  const changes=[];
  const update=(relative,change)=>{
    const file=path.join(root,relative),source=readFileSync(file,'utf8'),value=JSON.parse(source),before=JSON.stringify(value);
    change(value);
    if(JSON.stringify(value)!==before){const newline=source.includes('\r\n')?'\r\n':'\n';changes.push({relative,file,text:JSON.stringify(value,null,2).replaceAll('\n',newline)+newline});}
  };
                                
  update('package-lock.json',value=>{value.version=version;value.packages[''].version=version;});
  for(const relative of pluginManifests)update(relative,value=>{value.version=version;});
  if(check&&changes.length)throw Error('版本元数据与 package.json 不一致：'+changes.map(change=>change.relative).join('、')+'。请重新构建以同步。');
  for(const change of changes)writeFileSync(change.file,change.text,'utf8');
  return{version,changed:changes.map(change=>change.relative)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=synchronizeVersions(workspace,{check:process.argv.includes('--check')});
  if(result.changed.length)process.stdout.write('版本元数据已同步：'+result.version+'\n');
}
