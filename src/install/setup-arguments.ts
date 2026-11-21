import {BridgeError} from '../shared/errors.js';
import {type Host} from '../types.js';
import type { setup } from './setup.js';

export const SETUP_HELP='用法：nxbridge setup|update [--dry-run] [--prepare-only] [--from <publish 目录>] [--bin-dir <目录>]\n  --codex-command / --claude-command <可执行文件>\n  --codex-command-arg / --claude-command-arg <参数>（可重复）\n  --codex-home / --claude-home <配置目录>\n  --clear-codex-command / --clear-claude-command\n  --help / -h：只显示帮助\n';

                                     
export function setupArguments(args:string[]):{help:boolean;options:Parameters<typeof setup>[0]}{
  const switches=new Set(['--dry-run','--prepare-only','--help','-h','--clear-codex-command','--clear-claude-command']);
  const values=new Set(['--from','--bin-dir','--codex-command','--claude-command','--codex-command-arg','--claude-command-arg','--codex-home','--claude-home']);
  const parsed=new Map<string,string[]>();
  for(let i=0;i<args.length;i++){
    const argument=args[i]!,separator=argument.indexOf('='),flag=separator<0?argument:argument.slice(0,separator),inline=separator<0?undefined:argument.slice(separator+1),repeated=flag.endsWith('-command-arg');
    if(!switches.has(flag)&&!values.has(flag))throw new BridgeError('invalid_arguments','无法识别安装参数：'+flag+'。使用 --help 查看用法。');
    if(parsed.has(flag)&&!repeated)throw new BridgeError('invalid_arguments','安装参数不能重复：'+flag+'。');
    let value='';
    if(values.has(flag)){
      const supplied=inline??args[++i];
      if(supplied===undefined||!repeated&&!supplied||inline===undefined&&(switches.has(supplied)||values.has(supplied)))throw new BridgeError('invalid_arguments',flag+' 需要一个值；传入同名安装选项时请使用 '+flag+'=--flag。');
      value=supplied;
    }else if(inline!==undefined)throw new BridgeError('invalid_arguments',flag+' 不接受值。');
    parsed.set(flag,[...(parsed.get(flag)??[]),value]);
  }
  const commands:Partial<Record<Host,string[]|null>>={},hostHomes:Partial<Record<Host,string>>={};
  for(const host of ['codex','claude'] as const){
    const flag='--'+host+'-command',executable=parsed.get(flag)?.[0],extra=parsed.get(flag+'-arg')??[],clear=parsed.has('--clear-'+host+'-command');
    if(executable&&clear||extra.length&&!executable)throw new BridgeError('launch_command_invalid',`${flag} 与清除选项不能同时使用，附加参数需要同时指定可执行文件。`);
    if(executable)commands[host]=[executable,...extra];else if(clear)commands[host]=null;
    const directory=parsed.get('--'+host+'-home')?.[0];if(directory)hostHomes[host]=directory;
  }
  return{help:parsed.has('--help')||parsed.has('-h'),options:{dryRun:parsed.has('--dry-run'),prepareOnly:parsed.has('--prepare-only'),from:parsed.get('--from')?.[0],binDirectory:parsed.get('--bin-dir')?.[0],...(Object.keys(commands).length?{commands}:{}),...(Object.keys(hostHomes).length?{hostHomes}:{})}};
}
