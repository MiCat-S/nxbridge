import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { uptime } from 'node:os';
import {atomicJson} from '../shared/files.js';
import { prepareProcessRegistry, processRegistryDirectory, type OwnedProcessRecord } from '../process/owned-processes.js';

                                                   
export async function unknownContainerFixture(home:string,peerId?:string,launchId=randomUUID()):Promise<OwnedProcessRecord>{
  await prepareProcessRegistry(home);const id=randomUUID();
  const record:OwnedProcessRecord={version:1,id,home:path.resolve(home),role:'codex-runtime',peerId,createdAt:Date.now(),bootTime:Date.now()-uptime()*1000,identity:{pid:2147483647,parentPid:0,name:'codex.exe',startedAt:'1'},windowsJob:'Global\\nxbridge-job-'+randomUUID(),completionFile:path.join(processRegistryDirectory(home),id+'.json.done'),proof:{kind:'spawn',launchId}};
  atomicJson(path.join(processRegistryDirectory(home),id+'.json'),record);return record;
}
