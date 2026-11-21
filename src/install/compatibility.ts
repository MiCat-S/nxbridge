import type { Host } from '../types.js';
import { BridgeError } from '../shared/errors.js';

export const MIN_CODEX_VERSION='0.164.0';
export function requireCodexVersion(reported:string):void{
  const compatibility=versionCompatibility('codex',reported);
  if(!compatibility.version||compatibility.status==='older-than-tested')throw new BridgeError('codex_version',`需要 Codex ${MIN_CODEX_VERSION} 或更高版本，当前为 ${reported}。请先升级 Codex；未执行安装或更新。`);
}

export const TESTED_VERSIONS:Record<Host,string[]>={codex:['0.164.0','0.166.0'],claude:['2.1.308','2.1.316','2.1.317']};

export function versionCompatibility(host:Host,reported:string){
  const version=(host==='codex'?/codex-cli\s+(\d+\.\d+\.\d+)/:/(\d+\.\d+\.\d+)\s+\(Claude Code\)/).exec(reported)?.[1];
  const tested=TESTED_VERSIONS[host],minimum=tested[0]!;
  const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){const diff=x[i]!-y[i]!;if(diff)return diff;}return 0;};
  const status=!version?'unrecognized':tested.includes(version)?'tested':compare(version,minimum)<0?'older-than-tested':'untested';
  const notice=host==='codex'&&(status==='older-than-tested'||status==='unrecognized')?`需要可核验的 Codex ${MIN_CODEX_VERSION} 或更高版本；请先升级 Codex。`:status==='tested'?'此版本已有实际二进制协议测试。':status==='older-than-tested'?'当前 CLI 早于已测试版本；不会仅因版本号拒绝安装，仍须通过本次必需能力检查。':status==='unrecognized'?'未识别出官方版本号；不能确认版本兼容性，仍须通过本次必需能力检查。':'此版本未完成协议验收；不会仅因版本号拒绝安装，仍须通过本次必需能力检查。';
  return{reported,version:version??null,testedVersions:tested,status,notice};
}

export function platformCompatibility(platform:NodeJS.Platform=process.platform){
  return{platform,accepted:platform==='win32'||platform==='linux',notice:platform==='darwin'?'macOS 尚未完成实机验收；预检通过不代表后台启动、Mod、进程代次与双向通信已经验收。':platform==='linux'?'Linux 已在 WSL Ubuntu-22.04 验收；其他发行版尚未单独验收。':platform==='win32'?'已在当前 Windows 环境验收；其他机器和用户账户尚未单独验收。':'此平台尚未完成实机验收。'};
}
