import { parse } from 'smol-toml';
import {BridgeError} from '../shared/errors.js';

interface Location {start:number;key:string[]}
const decode=(text:string)=>parse(text,{integersAsBigInt:'asNeeded'});
export function parseConfiguration(text:string,filename:string):Record<string,unknown>{
  try{return decode(text.replace(/^\ufeff/,'')) as Record<string,unknown>;}
  catch(error){
    const value=error as {line?:number;column?:number};
                               
    throw new BridgeError('invalid_config',`${filename}:${value.line??1}:${value.column??1}：TOML 格式无效；原文件未修改。`);
  }
}
function leaves(value:unknown,prefix:string[]=[]):string[][]{
  if(Array.isArray(value))return value.length?value.flatMap(item=>leaves(item,prefix)):[prefix];
  if(value&&typeof value==='object'&&!(value instanceof Date)&&Object.keys(value).length)return Object.entries(value).flatMap(([key,item])=>leaves(item,[...prefix,key]));
  return[prefix];
}
                                
function locations(text:string):Location[]{
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[],result:Location[]=[];
  let context:string[]=[],offset=0;
  for(let i=0;i<lines.length;i++){
    const line=lines[i]!,trimmed=line.trim();
    if(!trimmed||trimmed.startsWith('#')){offset+=line.length;continue;}
    if(trimmed.startsWith('[')){
      const table=decode(line+'\n__nxbridge_location__=true\n');
      context=leaves(table).find(key=>key.at(-1)==='__nxbridge_location__')?.slice(0,-1)??[];
      result.push({start:offset,key:context});offset+=line.length;continue;
    }
    let fragment='',document:Record<string,unknown>|undefined,end=offset;
    for(;i<lines.length;i++){
      fragment+=lines[i]!;end+=lines[i]!.length;
      try{document=decode(fragment) as Record<string,unknown>;break;}catch{                 }
    }
    if(!document)break;
    for(const key of leaves(document))result.push({start:offset,key:[...context,...key]});offset=end;
  }
  return result;
}
export function configLocation(source:string,key:string|string[],filename:string):string{
  const text=source.replace(/^\ufeff/,''),parts=typeof key==='string'?key.split('.'):key;
  let found:Location|undefined;
  try{for(const item of locations(text))if(item.key.length<=parts.length&&item.key.every((part,index)=>part===parts[index])&&(!found||item.key.length>found.key.length))found=item;}catch{                          }
  return`${filename}:${text.slice(0,found?.start??0).split('\n').length}:1`;
}
