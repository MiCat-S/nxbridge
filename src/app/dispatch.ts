import {BridgeError} from '../shared/errors.js';
import {VERSION} from '../version.js';
import type {Host} from '../types.js';
import type {WrapperShell} from '../hosts/shell.js';
import {HELP_BODY} from './help.js';
const print=(value:unknown)=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
const pick=(args:string[],name:string):string|undefined=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
async function getHost(value:unknown):Promise<Host>{const {z}=await import('zod');return z.enum(['claude','codex']).parse(value);}

                                  
export async function dispatchCommand(command:string|undefined,args:string[]):Promise<void>{
  switch(command){
    case 'service':{
      const {runService}=await import('../broker/service.js');
      const {installedEntry}=await import('../install/runtime-install.js');
      const {bridgeHome}=await import('../shared/local-paths.js');
      const {CLI_PATH}=await import('../shared/package-location.js');
      const {sameDirectory}=await import('../shared/files.js');
      const {pathToFileURL}=await import('node:url');
      const runtime=installedEntry(bridgeHome());
      if(sameDirectory(runtime.entry,CLI_PATH))await runService();else await import(pathToFileURL(runtime.entry).href);
      break;
    }
    case 'service-launch':{
      const {detachService}=await import('../ipc/ipc.js');
      await detachService();
      break;
    }
    case 'bootstrap':{
      const {bootstrapBackground}=await import('../hosts/background-bootstrap.js');
      const result=await bootstrapBackground();
      process.stdout.write(result.text+'\n');
      break;
    }
    case 'prepare-native':{
      const {bridgeHome}=await import('../shared/local-paths.js');
      const {windowsHookIdentityHelper,windowsHelperStatus}=await import('../process/windows/windows-hook-identity.js');
      if(process.platform==='win32')await windowsHookIdentityHelper(bridgeHome(),30000,true);
      print({version:VERSION,windowsHelper:process.platform==='win32'?windowsHelperStatus(bridgeHome()):null});
      break;
    }
    case 'claude-worker':{
      const {z}=await import('zod');
      const {runClaudeWorker}=await import('../hosts/claude/claude-child.js');
      await runClaudeWorker(z.string().min(1).parse(args[0]));
      break;
    }
    case 'setup':
    case 'update':{
      const {setupArguments,SETUP_HELP}=await import('../install/setup-arguments.js');
      const parsed=setupArguments(args);
      if(parsed.help)process.stdout.write(SETUP_HELP);else {const {setup}=await import('../install/setup.js');print(await setup(parsed.options));}
      break;
    }
    case 'uninstall':{
      const {uninstall}=await import('../install/setup.js');
      print(await uninstall(undefined,{dryRun:args.includes('--dry-run'),purge:args.includes('--purge')}));
      break;
    }
    case 'mcp':{
      const {serveMcp}=await import('../integration/mcp/server.js');
      await serveMcp(await getHost(pick(args,'--host')));
      break;
    }
    case 'mod':{
      const {mod}=await import('../integration/mod/mod-control.js');
      const {modInput}=await import('../integration/mod/mod-protocol.js');
      print(await mod(await modInput(args[0])));
      break;
    }
    case 'hook':{
      const {hookCommand}=await import('../integration/hooks/hook-control.js');
      await hookCommand(args);
      break;
    }
    case 'codex':{
      const {launchCodex}=await import('../hosts/launch.js');
      process.exitCode=await launchCodex(args);
      break;
    }
    case 'shell-codex':{
      const {z}=await import('zod');
      const {launchCodex}=await import('../hosts/launch.js');
      process.exitCode=await launchCodex(z.array(z.string()).parse(JSON.parse(Buffer.from(args[0]??'','base64').toString('utf8'))));
      break;
    }
    case 'open':{
      const {openPartner}=await import('../hosts/launch.js');
      const {openTarget}=await import('./commands/open-command.js');
      if(args.includes('--interrupt')&&args[0]!=='claude')throw new BridgeError('invalid_arguments','只有 open claude 支持 --interrupt。');
      const target=await openTarget(await getHost(args[0]),args.slice(1).filter(arg=>arg!=='--interrupt'));
      if(target)process.exitCode=await openPartner(await getHost(args[0]),{...target,interrupt:args.includes('--interrupt')});
      break;
    }
    case 'adopt':
    case 'release':{
      const {hostingCommand}=await import('./commands/hosting-command.js');
      print(await hostingCommand(command,args));
      break;
    }
    case 'retire':{
      const {brokerCall}=await import('../ipc/ipc.js');
      if(args.length!==2||args[0]!=='--member'||!args[1])throw new BridgeError('invalid_arguments','用法：nxbridge retire --member <已解除配对的托管成员ID>；重新核验并回收该成员的自有后台。');
      print(await brokerCall('runtime.retire',{peer_id:args[1]},{mutation:true,timeout:30000}));
      break;
    }
    case 'status':{
      const {brokerCall}=await import('../ipc/ipc.js');
      const {formatGlobalStatus}=await import('../integration/mcp/presentation.js');
      const {bridgeHome}=await import('../shared/local-paths.js');
      const {inspectCodexRegistration}=await import('../hosts/codex/codex-registration.js');
      const status={...await brokerCall('status'),codexRegistration:inspectCodexRegistration(bridgeHome())};
      if(args.includes('--json'))print(status);else process.stdout.write(formatGlobalStatus(status));
      break;
    }
    case 'on':
    case 'off':{
      const {brokerCall}=await import('../ipc/ipc.js');
      const {externalTerminalOrigin}=await import('../hosts/user-origin.js');
      const {administrativeTarget}=await import('../broker/pairing/admin-target.js');
      const target=await getHost(args[0]);
      const selector=args.length>1?await administrativeTarget(args.slice(1)):{};
      print(await brokerCall('member.switch.terminal',{...selector,host:target,enabled:command==='on',terminal_origin:await externalTerminalOrigin()},{mutation:true}));
      break;
    }
    case 'doctor':{
      const {diagnose,diagnoseCurrent}=await import('./commands/doctor.js');
      const {administrativeTarget}=await import('../broker/pairing/admin-target.js');
      if(args.length&&!(args.length===1&&args[0]==='--current'))throw new BridgeError('invalid_arguments','用法：nxbridge doctor [--current]；--current 只诊断当前原生窗口的配对。');
      print(args.includes('--current')?await diagnoseCurrent(await administrativeTarget([])):await diagnose());
      break;
    }
    case 'config':{
      const {bridgeHome}=await import('../shared/local-paths.js');
      const {configurationCommand}=await import('./commands/config-command.js');
      print(await configurationCommand(bridgeHome(),args));
      break;
    }
    case 'pair':{
      const {pairCommand}=await import('./commands/pair-command.js');
      await pairCommand(args);
      break;
    }
    case 'partner-profile':{
      const {formatPartnerProfile,partnerProfileCommand}=await import('./commands/partner-profile-command.js');
      const view=await partnerProfileCommand(args);
      if(args.includes('--json'))print(view);else process.stdout.write(formatPartnerProfile(view as Parameters<typeof formatPartnerProfile>[0]));
      break;
    }
    case 'pause':
    case 'resume':
    case 'unpair':{
      const {brokerCall}=await import('../ipc/ipc.js');
      const {administrativeTarget}=await import('../broker/pairing/admin-target.js');
      print(await brokerCall(command,await administrativeTarget(args), {mutation:true}));
      break;
    }
    case 'reload':{
      const {brokerCall}=await import('../ipc/ipc.js');
      print(await brokerCall('reload',{}, {mutation:true}));
      break;
    }
    case 'restart':{
      const {restartArguments}=await import('../hosts/codex/codex-restart.js');
      const {restartCommand}=await import('./commands/restart-command.js');
      const {administrativeTarget}=await import('../broker/pairing/admin-target.js');
      const explicit=restartArguments(args),selector=explicit.partner?{...await administrativeTarget([]),partner:true as const}:Object.keys(explicit).length?explicit:await administrativeTarget([]),result=await restartCommand(selector);
      process.stdout.write(result.text+'\n');
      break;
    }
    case 'recover':{
      const {recoverCommand}=await import('./commands/restart-command.js');
      const {administrativeTarget}=await import('../broker/pairing/admin-target.js');
      if(args[0]!=='codex')throw new BridgeError('invalid_arguments','用法：nxbridge recover codex [目标] --dry-run，或 nxbridge recover codex [目标] --turn <turn ID>（卡住的这一轮，或最近一轮已失败停下）。');
      const turn=pick(args,'--turn');
      if(!args.includes('--dry-run')&&!turn)throw new BridgeError('turn_required','恢复需要明确指定 --turn；请先执行 recover codex --dry-run 查看当前目标。');
      const selector=args.slice(1).filter((arg,index,rest)=>arg!=='--dry-run'&&arg!=='--turn'&&rest[index-1]!=='--turn');
      print(await recoverCommand({...await administrativeTarget(selector),turn_id:turn,preview:args.includes('--dry-run')}));
      break;
    }
    case 'retry':{
      const {brokerCall}=await import('../ipc/ipc.js');
      print(await brokerCall('retry',{message_id:args[0]},{mutation:true}));
      break;
    }
    case 'connect':{
      const {brokerCall}=await import('../ipc/ipc.js');
      const {tokenFromEnvironment}=await import('../hosts/launch.js');
      print(await brokerCall('codex.connect',{endpoint:args[0],bearerToken:tokenFromEnvironment(pick(args,'--token-env'))},{timeout:30000}));
      break;
    }
    case 'watch':{
      const {watch}=await import('../integration/mcp/presentation.js');
      await watch({once:args.includes('--once'),json:args.includes('--json')});
      break;
    }
    case 'install-wrapper':
    case 'install-alias':{
      const {installWrapper}=await import('../hosts/shell.js');
      const file=pick(args,'--file');
      if(!file)throw new BridgeError('profile_required','请通过 --file 指定 shell profile。');
      print(installWrapper({file,shell:(pick(args,'--shell')??(process.platform==='win32'?'powershell':'bash')) as WrapperShell}));
      break;
    }
    case 'remove-wrapper':{
      const {removeWrapper}=await import('../hosts/shell.js');
      const file=pick(args,'--file');
      if(!file)throw new BridgeError('profile_required','请通过 --file 指定 shell profile。');
      print(removeWrapper({file}));
      break;
    }
    default:process.stdout.write(HELP_BODY);
  }
}
