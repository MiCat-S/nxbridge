import path from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type {Executable} from '../../process/host-command.js';

const packages:Record<string,string>={
  'x86_64-unknown-linux-musl':'linux-x64','aarch64-unknown-linux-musl':'linux-arm64',
  'x86_64-apple-darwin':'darwin-x64','aarch64-apple-darwin':'darwin-arm64',
  'x86_64-pc-windows-msvc':'win32-x64','aarch64-pc-windows-msvc':'win32-arm64',
};
const managed=/^CODEX_MANAGED_(?:PACKAGE_ROOT|BY_(?:NPM|BUN|PNPM|VITE_PLUS))$/i;
const canonical=(file:string)=>realpathSync.native(file);
const same=(left:string,right:string)=>{try{const a=canonical(left),b=canonical(right);return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}catch{return false;}};
function manifest(file:string):any{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return undefined;}}
function* ancestors(directory:string):Generator<string>{for(;;){yield directory;const parent=path.dirname(directory);if(parent===directory)return;directory=parent;}}
function resolvePackage(from:string,name:string):string|undefined{
                                                            
  for(const directory of ancestors(from)){const file=path.join(directory,'node_modules',name,'package.json');if(existsSync(file))return file;}
  return;
}

function packageRoot(executable:Executable):{root:string;entry:string}|undefined{
  const script=executable.prefix[0],entry=path.resolve(script&&/^node(?:\.exe)?$/i.test(path.basename(executable.command))&&/\.[cm]?js$/i.test(script)?script:executable.command);
  let resolved:string;try{resolved=canonical(entry);}catch{return;}
  const candidates=new Set<string>();
  for(const start of new Set([entry,resolved])){
    for(const directory of ancestors(path.dirname(start)))if(manifest(path.join(directory,'package.json'))?.name==='@openai/codex')candidates.add(directory);
    const main=resolvePackage(path.dirname(start),'@openai/codex');if(main)candidates.add(path.dirname(main));
  }
  for(const candidate of candidates){
    let root:string;try{root=canonical(candidate);}catch{continue;}
    if(manifest(path.join(root,'package.json'))?.name!=='@openai/codex'||!existsSync(path.join(root,'bin','codex.js')))continue;
    if(same(resolved,path.join(root,'bin','codex.js')))return{root,entry};
    const parts=resolved.replaceAll('\\','/').split('/'),name=parts.at(-1),triple=parts.at(-3);
    if(parts.at(-4)!=='vendor'||parts.at(-2)!=='bin'||!triple||!packages[triple]||name!==(triple.endsWith('windows-msvc')?'codex.exe':'codex'))continue;
    const dependency=resolvePackage(root,'@openai/codex-'+packages[triple]),vendor=path.join(dependency?path.dirname(dependency):root,'vendor');
    if(same(resolved,path.join(vendor,triple,'bin',name)))return{root,entry};
  }
  return;
}

function manager(root:string,entry:string,env:NodeJS.ProcessEnv):'NPM'|'BUN'|'PNPM'|'VITE_PLUS'{
                                                                   
  for(const start of new Set([root,path.dirname(entry)]))for(const directory of ancestors(start)){
    if(path.basename(directory)==='packages'){
      const record=manifest(path.join(directory,'@openai','codex.json'));
      if(record?.name==='@openai/codex'&&(!record.installId||typeof record.installId==='string')){
        const id=record.installId||'',install=id.startsWith('#')?path.join(directory,'@openai','codex'+id):path.join(directory,'@openai','codex',id);
        if(['lib/node_modules','node_modules'].some(suffix=>same(path.join(install,suffix,'@openai','codex'),root)))return'VITE_PLUS';
      }
    }
    const modules=path.join(directory,'node_modules');
    if(existsSync(path.join(modules,'.modules.yaml'))&&same(path.join(modules,'@openai','codex'),root))return'PNPM';
  }
  const values=process.platform==='win32'?Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toLowerCase(),value])):env;
  return /\bbun\//.test(values.npm_config_user_agent??'')||(values.npm_execpath??'').includes('bun')||root.replaceAll('\\','/').includes('.bun/install/global')?'BUN':'NPM';
}

                                                
export function codexPackageEnvironment(executable:Executable,input:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
  const env={...input};for(const key of Object.keys(env))if(managed.test(key))delete env[key];
  const found=packageRoot(executable);if(found){env.CODEX_MANAGED_PACKAGE_ROOT=found.root;env['CODEX_MANAGED_BY_'+manager(found.root,found.entry,env)]='1';}
  return env;
}
