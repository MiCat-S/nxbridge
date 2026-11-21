import { createRequire } from 'node:module';

declare const __NXBRIDGE_VERSION__: string;

                                                
export const VERSION:string=typeof __NXBRIDGE_VERSION__==='string'?__NXBRIDGE_VERSION__:createRequire(import.meta.url)('../package.json').version;
