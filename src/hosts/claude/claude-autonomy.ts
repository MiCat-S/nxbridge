import path from 'node:path';
import { readFileSync } from 'node:fs';
import {BridgeError} from '../../shared/errors.js';

                                              
export function claudeBypassConsent(configHome:string){
  let unreadable=false;
  const read=(name:string):Record<string,unknown>=>{
    try{const value=JSON.parse(readFileSync(path.join(configHome,name),'utf8').replace(/^\uFEFF/,''));return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')unreadable=true;return{};}
  };
  const user=read('settings.json'),legacy=read('.claude.json');
  const source=user.skipDangerousModePermissionPrompt===true?'user':legacy.bypassPermissionsModeAccepted===true?'legacy':undefined;
  if(source)return{accepted:true,source,config_home:configHome};
  const code=unreadable?'invalid_config':'claude_bypass_consent_required';
  const message=unreadable?`无法读取或解析 Claude 用户配置（${configHome}），未启动后台；请修复这套原生配置。`:`后台 Claude 的无人审批模式需要先完成一次原生声明。请使用这套配置（${configHome}），在终端运行 claude --dangerously-skip-permissions 并接受提示，然后重试原操作。`;
  return{accepted:unreadable?null:false,config_home:configHome,code,message};
}

                                                 
export function claudeLaunchPrerequisite(configHome:string,cwd:string){
  const consent=claudeBypassConsent(configHome);
  if(process.platform==='linux'&&process.getuid?.()===0)return{...consent,code:'claude_bypass_root_unsupported',message:'Claude 原生禁止 root/sudo 使用无人审批模式。请以普通 Linux 用户运行 nxbridge；原草稿已保留。'};
  const managed=process.platform==='win32'?path.join(process.env.ProgramFiles??'C:\\Program Files','ClaudeCode','managed-settings.json'):process.platform==='darwin'?'/Library/Application Support/ClaudeCode/managed-settings.json':'/etc/claude-code/managed-settings.json';
  for(const [source,file]of [['policy',managed],['user',path.join(configHome,'settings.json')],['project',path.join(cwd,'.claude','settings.json')],['local',path.join(cwd,'.claude','settings.local.json')]]){
    try{
      if(JSON.parse(readFileSync(file!,'utf8').replace(/^\uFEFF/,'')).permissions?.disableBypassPermissionsMode==='disable')return{...consent,bypass_disabled:true,policy_source:source,code:'claude_bypass_disabled',message:`Claude 的${source==='policy'?'组织':source==='user'?'用户':'项目'}设置禁用了全部放行模式，后台无法按要求自动执行；请由用户或管理员调整对应的原生设置（${file}）后重试，原草稿已保留。`};
    }catch{                                   }
  }
  return consent;
}

export function requireClaudeBypassConsent(configHome:string,cwd=configHome):void{
  const value=claudeLaunchPrerequisite(configHome,cwd);if(value.accepted!==true||value.code)throw new BridgeError(value.code!,value.message!);
}
