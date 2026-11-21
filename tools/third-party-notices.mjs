import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function thirdPartyNotices(metafiles,root){
  const packages=new Map();
  for(const metafile of metafiles)for(const output of Object.values(metafile.outputs))for(const [input,usage]of Object.entries(output.inputs)){
    if(!usage.bytesInOutput||!/(?:^|[\\/])node_modules[\\/]/.test(input))continue;
    const absolute=path.resolve(root,input),parts=absolute.split(path.sep),index=parts.lastIndexOf('node_modules'),boundary=parts.slice(0,index+(parts[index+1]?.startsWith('@')?3:2)).join(path.sep);
    let directory=path.dirname(absolute),metadata;
    while(true){
      const filename=path.join(directory,'package.json');
      if(existsSync(filename)){const value=JSON.parse(readFileSync(filename,'utf8'));if(value.name&&value.version){metadata=value;break;}}
      if(directory===boundary||directory===path.dirname(directory))break;
      directory=path.dirname(directory);
    }
    if(!metadata)throw Error('无法找到已打包依赖的 package.json：'+input);
    const id=metadata.name+'@'+metadata.version;if(packages.has(id))continue;
    const files=readdirSync(directory,{withFileTypes:true}).filter(item=>item.isFile()&&/^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(item.name)).map(item=>item.name).sort();
    if(!files.some(name=>/^(?:licen[cs]e|copying)/i.test(name)))throw Error('已打包依赖缺少许可证全文：'+id);
    const rawLicense=typeof metadata.license==='string'?metadata.license:metadata.license?.type??(Array.isArray(metadata.licenses)?metadata.licenses.map(item=>typeof item==='string'?item:item.type).filter(Boolean).join(' OR '):undefined),license=rawLicense?.trim()||'UNKNOWN';
    const texts=files.map(name=>({name,text:readFileSync(path.join(directory,name),'utf8').trimEnd()}));
    if(!texts.some(file=>/^(?:licen[cs]e|copying)/i.test(file.name)&&file.text.trim()))throw Error('已打包依赖缺少许可证全文：'+id);
    packages.set(id,{name:metadata.name,version:metadata.version,license,files:texts,review:/\b(?:AGPL|GPL|LGPL)(?:-|\b)/i.test(license)||!license||/UNKNOWN|UNLICENSED/i.test(license)});
  }
  const items=[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
  const text='# 第三方依赖许可证与声明\n\n此文件由实际进入发布包的 esbuild 输入生成；保留各依赖的许可证原文。Node.js 内置模块和未打包的可选原生模块不属于此清单。\n\n'+items.map(item=>`## ${item.name} ${item.version}\n\n许可证标识：${item.license}${item.review?'（需要人工审阅）':''}\n\n`+item.files.map(file=>`### ${file.name}\n\n\`\`\`text\n${file.text}\n\`\`\`\n`).join('\n')).join('\n');
  return{text,packages:items.map(({files,...item})=>({...item,files:files.map(file=>file.name)}))};
}
