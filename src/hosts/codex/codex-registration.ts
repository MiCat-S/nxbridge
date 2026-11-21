import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import {readJson} from '../../shared/files.js';

                                             
export function inspectCodexRegistration(home:string){
  const issues:{code:string;message:string}[]=[];
  const stateFile=path.join(home,'setup-state.json');
  if(!existsSync(stateFile))return{state:'unrecorded',issues};
  let configFile:string|undefined;
  try{
    const setup=readJson<{disabled?:boolean;codexInstalled?:boolean;hostHomes?:{codex?:string};changes?:{keyPath:string}[]}>(stateFile);
    if(setup.disabled||!setup.codexInstalled)return{state:'unrecorded',issues};
    if(!setup.hostHomes?.codex)return{state:'unknown',issues};
    configFile=path.join(setup.hostHomes.codex,'config.toml');
    const config=existsSync(configFile)?parse(readFileSync(configFile,'utf8')):{};
    const plugin=(config.plugins as Record<string,{enabled?:boolean}>|undefined)?.['nxbridge@nxbridge-local'];
    const marketplace=(config.marketplaces as Record<string,unknown>|undefined)?.['nxbridge-local'];
    if(!plugin||!marketplace){
      issues.push({code:'codex_plugin_missing',message:'Codex 配置里找不到 nxbridge 插件的完整登记，新开或重新加载的 Codex 窗口无法加载 nxbridge 的规则和消息入口。请运行 nxbridge setup 恢复，然后重启 Codex，并在 /hooks 中确认已信任 nxbridge 的 hooks。'});
      return{state:'repair_required',configFile,issues};
    }
    if(plugin.enabled===false){
      issues.push({code:'codex_plugin_disabled',message:'Codex 里的 nxbridge 插件已被禁用，新开或重新加载的 Codex 窗口不会加载 nxbridge 的消息入口。如需使用，请重新启用该插件，重启 Codex 后在 /hooks 中确认已信任 nxbridge 的 hooks。'});
      return{state:'disabled',configFile,issues};
    }
    const features=config.features as Record<string,unknown>|undefined;
    const names=features?.non_prefixed_mcp_tool_names as boolean|{enabled?:boolean;server_names?:string[]}|undefined;
    const code=features?.code_mode as boolean|{enabled?:boolean;direct_only_tool_namespaces?:string[]}|undefined;
    const directNames=names===true||typeof names==='object'&&names?.enabled===true&&(names.server_names===undefined||names.server_names.includes('claude'));
    const directTools=code===false||typeof code==='object'&&code?.enabled===false||typeof code==='object'&&code?.direct_only_tool_namespaces?.includes('claude');
    const applied=new Set(setup.changes?.map(change=>change.keyPath));
                                                
    if(features?.code_mode_only_strict_3p_tools!==true&&(applied.has('features.non_prefixed_mcp_tool_names')&&!directNames||applied.has('features.code_mode')&&!directTools)){
      issues.push({code:'codex_namespace_missing',message:'安装时写入 Codex 配置文件的 claude 工具设置已缺失或被改动，新开或重新加载的 Codex 窗口可能找不到搭档工具。请运行 nxbridge setup 恢复，然后重启 Codex；如果是你有意改的，可以忽略这条提示。'});
      return{state:'repair_required',configFile,issues};
    }
    return{state:'current',configFile,issues};
  }catch{
                                         
    issues.push({code:'codex_config_unreadable',message:configFile?'无法读取 '+configFile+'，不能确认 Codex 是否登记了 nxbridge 插件。请检查这个文件的格式和读取权限。':'无法读取 nxbridge 的安装记录 '+stateFile+'，不能确认 Codex 插件登记情况。'});
    return{state:'unknown',configFile,issues};
  }
}
