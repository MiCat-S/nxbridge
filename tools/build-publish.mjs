import { build, transform, analyzeMetafile } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './third-party-notices.mjs';
import { synchronizeVersions } from './sync-version.mjs';
import { synchronizeModRevision } from './mod-revision.mjs';
import { embeddedCodePlugin, originalIdentityRevision } from './embedded-code.mjs';
import {synchronizeIdentityRevision} from './identity-revision.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'publish');
synchronizeVersions(root);
synchronizeModRevision(root);
synchronizeIdentityRevision(root);
const documents=[['docs/user-guide.md','README.md'],['LICENSE','LICENSE']].map(([source,name])=>{
  const filename=path.join(root,source);if(!existsSync(filename))throw Error('发布构建缺少必需文件：'+source);
  return{name,text:readFileSync(filename,'utf8')};
});
                             
rmSync(output,{recursive:true,force:true});mkdirSync(output);
const common={bundle:true,minify:true,treeShaking:true,legalComments:'none',sourcemap:false,charset:'utf8',target:'node24',logLevel:'warning'};
const metadata=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const external=['node:*','bufferutil','utf-8-validate'];
const embeddedRecords=[];
                                                  
const locales={name:'nxbridge-zod-locales',setup(context){context.onLoad({filter:/[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/},args=>({contents:"export {default as en} from './en.js';",resolveDir:path.dirname(args.path),loader:'js'}));}};
const vendorOptions={...common,platform:'node',format:'esm',splitting:true,chunkNames:'vendor-shared-[hash]',entryPoints:{'vendor-core':path.join(root,'tools/vendor-core.mjs'),'vendor-mcp':path.join(root,'tools/vendor-mcp.mjs')},outdir:output,outExtension:{'.js':'.mjs'},external,plugins:[locales],metafile:true,banner:{js:"import {createRequire as __nxCreateRequire} from 'node:module';const require=__nxCreateRequire(import.meta.url);"}};
                                 
const vendorBuild=await build(vendorOptions);
const vendorImports=new Map([['zod','./vendor-core.mjs'],['ws','./vendor-core.mjs'],['smol-toml','./vendor-core.mjs'],...['server/index.js','server/stdio.js','types.js'].map(name=>['@modelcontextprotocol/sdk/'+name,'./vendor-mcp.mjs'])]);
const vendorResolve={name:'nxbridge-vendor-imports',setup(context){context.onResolve({filter:/^(?:zod|ws|smol-toml|@modelcontextprotocol\/sdk\/)/},args=>{
  if(!args.importer.startsWith(path.join(root,'src')+path.sep)||!vendorImports.has(args.path))return;
  return{path:vendorImports.get(args.path),external:true};
});}};
                                              
const hookResolve={name:'nxbridge-hook-import',setup(context){context.onResolve({filter:/\/hook-control\.js$/},args=>path.basename(args.importer)==='hook-entry.ts'?{path:'./hook-control.mjs',external:true}:undefined);}};
                                  
const evidenceImports={name:'nxbridge-evidence-source',setup(context){context.onResolve({filter:/^\.\.\/dist\/.+\.js$/},args=>({path:path.join(root,'src',args.path.slice('../dist/'.length).replace(/\.js$/,'.ts'))}));}};
const runtimeOptions={...common,platform:'node',format:'esm',outdir:output,outExtension:{'.js':'.mjs'},define:{__NXBRIDGE_BUNDLED__:'true',__NXBRIDGE_VERSION__:JSON.stringify(metadata.version),__NXBRIDGE_IDENTITY_REVISION__:JSON.stringify(originalIdentityRevision(root)),'process.env.NODE_ENV':'"production"'},banner:{js:"import {createRequire as __nxCreateRequire} from 'node:module';const require=__nxCreateRequire(import.meta.url);"},external,metafile:true};
                                           
const native=await build({...runtimeOptions,banner:{},entryPoints:{'runtime-native-source':path.join(root,'src/process/windows/native-sources.ts')},plugins:[embeddedCodePlugin(root,embeddedRecords)]});
const runtimeResolve={name:'nxbridge-runtime-imports',setup(context){context.onResolve({filter:/\/(?:native-sources|dispatch)\.js$/},args=>{
  if(!args.importer.startsWith(path.join(root,'src')+path.sep))return;
  if(args.path.endsWith('/native-sources.js'))return{path:'./runtime-native-source.mjs',external:true};
  if(path.basename(args.importer)==='cli.ts'&&args.path==='./app/dispatch.js')return{path:'./runtime-dispatch.mjs',external:true};
});}};
                                            
const entryPoints=Object.fromEntries([['nxbridge','src/cli.ts'],['runtime-dispatch','src/app/dispatch.ts'],['question-control','src/integration/mcp/question-control.ts'],['mcp-entry','src/mcp-entry.ts'],['mod-entry','src/mod-entry.ts'],['hook-control','src/integration/hooks/hook-control.ts'],['macos-evidence','tools/collect-macos-evidence.mjs']].map(([name,source])=>[name,path.join(root,source)]));
const main=await build({...runtimeOptions,entryPoints,plugins:[locales,vendorResolve,runtimeResolve,evidenceImports,embeddedCodePlugin(root,embeddedRecords)]});
                                                
const hook=await build({...runtimeOptions,entryPoints:{'hook-entry':path.join(root,'src/hook-entry.ts')},plugins:[locales,vendorResolve,hookResolve,embeddedCodePlugin(root,embeddedRecords)]});
const metafiles=[main.metafile,vendorBuild.metafile,native.metafile,hook.metafile];
const dependencyBytes={};
for(const meta of metafiles)for(const [filename,entry]of Object.entries(meta.outputs)){
  const sizes={};for(const [input,info]of Object.entries(entry.inputs)){const match=/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input),name=match?.[1]??'nxbridge';sizes[name]=(sizes[name]??0)+info.bytesInOutput;}dependencyBytes[path.basename(filename)]=sizes;
}
if(process.argv.includes('--analyze'))process.stderr.write(await analyzeMetafile(main.metafile));
                                         
const builtins=new Set(builtinModules.flatMap(name=>[name,'node:'+name]));
const emittedFiles=new Set(metafiles.flatMap(meta=>Object.keys(meta.outputs).map(file=>path.resolve(root,file))));
for(const meta of metafiles)for(const [file,item]of Object.entries(meta.outputs))for(const dependency of item.imports){
  if(!dependency.external||builtins.has(dependency.path)||['bufferutil','utf-8-validate'].includes(dependency.path))continue;
  if(dependency.path.startsWith('./')&&emittedFiles.has(path.resolve(root,path.dirname(file),dependency.path)))continue;
  throw Error('发布包仍依赖外部模块：'+dependency.path);
}
                                      
const outputByFile=new Map(metafiles.flatMap(meta=>Object.entries(meta.outputs).map(([file,item])=>[path.resolve(root,file),item])));
                                           
const commandSources=new Set(['src/cli.ts','src/app/dispatch.ts','src/install/setup.ts','src/broker/coordinator.ts','src/broker/service.ts','src/broker/lifecycle/coordinator.ts','src/broker/health/coordinator.ts'].map(file=>path.resolve(root,file)));
for(const name of ['question-control','mcp-entry','mod-entry','hook-control','macos-evidence']){
  const item=outputByFile.get(path.join(output,name+'.mjs'));
  for(const source of Object.keys(item.inputs))if(commandSources.has(path.resolve(root,source)))throw Error(`短入口 ${name} 意外包含命令实现：${source}`);
}
for(const dependency of outputByFile.get(path.join(output,'hook-entry.mjs')).imports){
  if(builtins.has(dependency.path))continue;
  if(dependency.kind==='dynamic-import'&&dependency.path==='./hook-control.mjs')continue;
  throw Error('hook 超时保护启动前意外加载模块：'+dependency.path);
}
for(const meta of metafiles)for(const [file,item]of Object.entries(meta.outputs)){
  const source=readFileSync(path.resolve(root,file),'utf8');
  for(const match of source.matchAll(/\bimport\s*([^;]+?)\s*from\s*["'](\.\/(?:vendor-|runtime-)[^"']+)["']/g)){
    const specifiers=match[1],target=outputByFile.get(path.resolve(root,path.dirname(file),match[2]));
    if(!target)throw Error('共享模块文件缺失：'+match[2]);
    const exported=new Set(target.exports??[]),requested=new Set();
    if(/^\s*\{/.test(specifiers))for(const item of specifiers.slice(specifiers.indexOf('{')+1,specifiers.lastIndexOf('}')).split(',')){const name=item.trim().split(/\s+as\s+/)[0];if(name)requested.add(name);}
    else if(specifiers.trim()&&!specifiers.trim().startsWith('*'))requested.add('default');
    for(const name of requested)if(!exported.has(name))throw Error(`共享模块未导出 ${name}（${file} -> ${match[2]}）。`);
  }
}
async function copy(directory,target){
  mkdirSync(target,{recursive:true});
  const entries=readdirSync(directory,{withFileTypes:true}),bundledInputs=new Set();
  if(entries.some(item=>item.isFile()&&item.name==='register.js')){
    const result=await build({...common,platform:'neutral',format:'esm',entryPoints:[path.join(directory,'register.js')],outfile:path.join(target,'register.js'),metafile:true});metafiles.push(result.metafile);
    for(const input of Object.keys(result.metafile.inputs))bundledInputs.add(path.resolve(root,input));
  }
  for(const item of entries){
    if(item.name==='README.md'||item.name==='zh.md'||/\.(?:map|ts)$/.test(item.name))continue;
    const source=path.join(directory,item.name),destination=path.join(target,item.name);
    if(item.isDirectory()){await copy(source,destination);continue;}
                                 
    if(!item.isFile()||item.name==='runtime.json'||bundledInputs.has(source))continue;
    if(/\.[cm]?js$/.test(item.name)){
      const result=await transform(readFileSync(source,'utf8'),{minify:true,legalComments:'none',sourcemap:false,charset:'utf8',target:'node24',loader:'js'});writeFileSync(destination,result.code,'utf8');
    }else if(item.name.endsWith('.json'))writeFileSync(destination,JSON.stringify(JSON.parse(readFileSync(source,'utf8')))+'\n','utf8');
    else if(item.name.endsWith('.md'))writeFileSync(destination,readFileSync(source,'utf8').replace(/<!--[\s\S]*?-->/g,'').trim()+'\n','utf8');
    else throw Error('未声明的发布文件：'+source);
  }
}
await copy(path.join(root,'plugins'),path.join(output,'plugins'));
writeFileSync(path.join(output,'nxbridge-collaboration.md'),readFileSync(path.join(root,'docs/collaboration.md'),'utf8').replace(/<!--[\s\S]*?-->/g,'').trim()+'\n','utf8');
for(const document of documents)writeFileSync(path.join(output,document.name),document.text,'utf8');
mkdirSync(path.join(output,'tools'));
writeFileSync(path.join(output,'tools','collect-macos-evidence.mjs'),"import '../macos-evidence.mjs';\n",'utf8');
writeFileSync(path.join(output,'tools','macos-validation.md'),readFileSync(path.join(root,'tools','macos-validation.md'),'utf8'),'utf8');
const notices=thirdPartyNotices(metafiles,root);writeFileSync(path.join(output,'THIRD-PARTY-NOTICES.md'),notices.text,'utf8');
for(const dependency of notices.packages.filter(item=>item.review))process.stderr.write('第三方许可证需要人工审阅：'+dependency.name+'@'+dependency.version+' '+dependency.license+'\n');
const files={};
function hashes(directory,prefix=''){
  for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const filename=path.join(directory,item.name),relative=prefix+item.name;
    if(item.isDirectory())hashes(filename,relative+'/');else files[relative]=createHash('sha256').update(readFileSync(filename)).digest('hex');
  }
}
hashes(output);
const version=metadata.version,dependencies=metadata.dependencies,buildId=version+'-'+createHash('sha256').update(JSON.stringify({files,dependencies})).digest('hex').slice(0,12);
writeFileSync(path.join(output,'publish.json'),JSON.stringify({owner:'nxbridge-publish-v1',version,buildId,files,dependencies})+'\n','utf8');
const size=directory=>existsSync(directory)?readdirSync(directory,{withFileTypes:true}).reduce((total,item)=>total+(item.isDirectory()?size(path.join(directory,item.name)):statSync(path.join(directory,item.name)).size),0):0;
process.stdout.write(JSON.stringify({buildId,totalBytes:size(output),bundles:{'nxbridge.mjs':statSync(path.join(output,'nxbridge.mjs')).size,'question-control.mjs':statSync(path.join(output,'question-control.mjs')).size},dependencyBytes,licenses:notices.packages,oldDistAndNodeModulesBytes:size(path.join(root,'dist'))+size(path.join(root,'node_modules'))},null,2)+'\n');
