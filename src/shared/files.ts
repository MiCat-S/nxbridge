import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {atomicWriteText,type AtomicWriteOptions} from '../storage/atomic-file.js';
export function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')) as T;
}

export function atomicJson(filename: string, value: unknown, options:AtomicWriteOptions={}): void {
  atomicWriteText(filename,JSON.stringify(value,null,2)+'\n',options);
}

export function sameDirectory(a: string, b: string): boolean {
  const normalize = (value: string) => {let resolved=path.resolve(value);try{resolved=realpathSync.native(resolved);}catch{}return process.platform === 'win32'?resolved.toLowerCase():resolved;};
  return normalize(a) === normalize(b);
}
