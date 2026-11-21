import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {ensureHome,socketDirectory,removeOwnedSocket} from '../ipc/home.js';
import {isElevated} from '../process/permissions.js';
import {runCli} from '../process/host-command.js';
import {windowsTool} from '../shared/windows-tools.js';
import {delay} from '../shared/time.js';
import {connectAppServer} from '../hosts/codex/adapter.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';

test('提权 Codex 可在当前用户私有的中完整性目录监听，权限策略不依赖高完整性标签',{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await isElevated()){t.skip('此探针需要提权令牌');return;}
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),configHome=path.join(temp.directory,'codex');
  await ensureHome(home);mkdirSync(configHome);
  writeFileSync(path.join(configHome,'config.toml'),'check_for_update_on_startup=false\n[features]\napps=false\nremote_plugin=false\n','utf8');
  const directory=await socketDirectory(home),endpoint='unix://'+path.join(directory,'integrity.sock');
  await promisify(execFile)(windowsTool('icacls.exe'),[directory,'/setintegritylevel','(OI)(CI)M'],{windowsHide:true});
  let ended=false,failure:unknown;
                                        
  const pending=runCli('codex',['--no-daemon','app-server','--listen',endpoint],{home,config:{...DEFAULT_CONFIG,codexHome:configHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},timeout:12000}).catch(error=>{failure=error;}).finally(()=>{ended=true;});
  let client:Awaited<ReturnType<typeof connectAppServer>>|undefined;
  try{
    const deadline=Date.now()+10000;
    while(!client){
      try{client=await connectAppServer(endpoint,DEFAULT_CONFIG,undefined,home,{readOnly:true});}
      catch(error){if(ended||Date.now()>=deadline)throw failure??error;await delay(50);}
    }
    assert.deepEqual((await client.request<{data:unknown[]}>('thread/loaded/list',{})).data,[]);
  }finally{client?.close();await pending;await removeOwnedSocket(home,endpoint);await temp.cleanup();}
});
