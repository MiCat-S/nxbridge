import {readFileSync} from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../shared/errors.js';

export const ipcTokenFile=(home:string)=>path.join(home,'run','token');

export function ipcToken(home:string):string{
  const file=ipcTokenFile(home),token=readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(token))throw new BridgeError('ipc_token_invalid',`本地 IPC 令牌格式无效，已保留原文件：${file}。请运行 nxbridge update 或 nxbridge bootstrap 修复。`);
  return token;
}
