                                    
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parse} from 'smol-toml';
import {bridgeHome,codexHome} from '../dist/shared/local-paths.js';
import {loadConfig} from '../dist/config/load.js';
import {sameDirectory} from '../dist/shared/files.js';
import {activeRuntime,fileHashes} from '../dist/install/runtime-install.js';
import {VERSION} from '../dist/version.js';

const terminal=new Set(['runtimeQueued','contextObserved','responded','refused','expired']);
export function readAuditState(home){
  const db=new DatabaseSync(path.join(home,'nxbridge.db'),{readOnly:true});
  try{
    db.exec('BEGIN');
                                            
    const protectedIds=new Set(db.prepare("WITH RECURSIVE protected(id) AS (SELECT id FROM messages WHERE state NOT IN ('runtimeQueued','contextObserved','responded','refused','expired') UNION SELECT id FROM messages WHERE sender IN (SELECT id FROM peers WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.enabled')=0 END) OR recipient IN (SELECT id FROM peers WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.enabled')=0 END) UNION SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.messageId') END FROM questions UNION SELECT m.in_reply_to FROM messages m JOIN protected p ON m.id=p.id WHERE m.in_reply_to IS NOT NULL) SELECT id FROM protected WHERE id IS NOT NULL").all().map(row=>row.id));
    return{
      pairs:db.prepare('SELECT id,claude,codex FROM pairs WHERE archived=0 ORDER BY id').all(),
      messages:db.prepare('SELECT id,state FROM messages ORDER BY id').all().map(row=>({...row,protected:protectedIds.has(row.id)}))
    };
  }finally{db.close();}
}
function snapshot(home){
  const nativeHome=loadConfig(home).codexHome??codexHome(),directory=path.join(nativeHome,'plugins','cache','nxbridge-local','nxbridge',VERSION);
  const files=fileHashes(directory);assert.ok(Object.keys(files).length,'无法读取已安装的 Codex 插件文件');
                                                  
  return JSON.parse(JSON.stringify({owner:'nxbridge-update-audit-v1',at:new Date().toISOString(),home,buildId:activeRuntime(home)?.buildId??null,bundle:{directory,files},hookTrust:parse(readFileSync(path.join(nativeHome,'config.toml'),'utf8')).hooks?.state??null,state:readAuditState(home)}));
}
export function verifyUpdateAudit(before,after){
  assert.equal(before.owner,'nxbridge-update-audit-v1','更新前快照格式不符');
  assert.equal(after.owner,before.owner);
  assert.ok(sameDirectory(before.home,after.home),'两份快照必须属于同一个安装目录');
  assert.ok(sameDirectory(before.bundle.directory,after.bundle.directory),'插件缓存目录发生变化');
  assert.deepEqual(after.bundle.files,before.bundle.files,'运行时更新不能改变插件文件字节');
  assert.deepEqual(after.hookTrust,before.hookTrust,'运行时更新不能改变原生 hooks 信任');
  for(const pair of before.state.pairs)assert.deepEqual(after.state.pairs.find(row=>row.id===pair.id),pair,'原配对必须保留');
  const ids=new Set(after.state.messages.map(row=>row.id)),missing=before.state.messages.filter(row=>!ids.has(row.id));
  assert.deepEqual(missing.filter(row=>row.protected||!terminal.has(row.state)),[],'待处理消息及受保护的回复祖先必须保留');
  return{beforeAt:before.at,afterAt:after.at,beforeBuildId:before.buildId,buildId:after.buildId,bundleUnchanged:true,hookTrustStateUnchanged:true,originalPairsPreserved:true,protectedMessagesPreserved:true,pairsBefore:before.state.pairs.length,pairsAfter:after.state.pairs.length,messagesBefore:before.state.messages.length,messagesAfter:after.state.messages.length,removedUnprotectedTerminalIds:missing.map(row=>row.id)};
}
const save=(file,value,exclusive=false)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',...(exclusive?{flag:'wx'}:{})});
async function main(){
  const [mode,file,...extra]=process.argv.slice(2);
  if(!['snapshot','verify'].includes(mode)||!file||extra.length)throw Error('用法：node tools/audit-runtime-update.mjs snapshot <更新前快照.json> | verify <更新前快照.json>；先 npm run build。');
  const after=snapshot(bridgeHome());
  if(mode==='snapshot'){save(file,after,true);console.log(JSON.stringify({snapshot:path.resolve(file),buildId:after.buildId,messages:after.state.messages.length}));return;}
  const before=JSON.parse(readFileSync(file,'utf8')),afterFile=file+'.after.json',reportFile=file+'.report.json';
                                   
  save(afterFile,after);
  try{const result=verifyUpdateAudit(before,after);save(reportFile,result);console.log(JSON.stringify({...result,afterFile,reportFile}));}
  catch(error){save(reportFile,{beforeFile:path.resolve(file),afterFile:path.resolve(afterFile),error:error.message});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
