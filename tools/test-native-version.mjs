                                   
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const [version, ...files] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw Error('请指定明确版本，例如 0.166.0。');

function npmCommand() {
  const fromScript = process.env.npm_execpath;
  if (fromScript && path.basename(fromScript) === 'npm-cli.js') return [process.execPath, path.resolve(fromScript)];
  if (process.platform !== 'win32') return ['npm'];
                                                                         
  const directories = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const directory of directories.filter(Boolean)) {
    const entry = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(entry)) return [process.execPath, entry];
  }
  throw Error('未找到 npm-cli.js，请安装 Node.js 自带的 npm。');
}

function run(command, args, options) {
  const child = spawn(command, args, {...options, stdio: 'inherit', windowsHide: true});
  return new Promise((resolve, reject) => {
    const interrupt = () => child.kill('SIGTERM');
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) process.on(signal, interrupt);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      for (const name of signals) process.off(name, interrupt);
      resolve(code ?? (signal ? 130 : 1));
    });
  });
}

let directory;
try {
  const env = {...process.env};
  if (env.NXBRIDGE_TEST_CODEX_BINARY) {
    env.NXBRIDGE_TEST_CODEX_BINARY = path.resolve(env.NXBRIDGE_TEST_CODEX_BINARY);
  } else {
    const [command, ...prefix] = npmCommand();
    directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'nxbridge-test-'));
    const code = await run(command, [
      ...prefix, 'install', '--global=false', '--prefix', directory,
      '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', '--include=optional',
      '--prefer-offline', '--registry=https://registry.npmjs.org', '@openai/codex@' + version,
    ], {cwd: directory});
    if (code !== 0) throw Error(`安装官方 Codex ${version} 失败（退出码 ${code}）。`);
    env.NXBRIDGE_TEST_CODEX_BINARY = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
                                     
    const bin = process.platform === 'win32' ? directory : path.join(directory, 'node_modules', '.bin');
    env.PATH = [bin, process.env.PATH].filter(Boolean).join(path.delimiter);
  }
  const binary = env.NXBRIDGE_TEST_CODEX_BINARY;
  const script = /\.(?:c?js|mjs)$/i.test(binary);
  const {stdout} = await execute(script ? process.execPath : binary, [...(script ? [binary] : []), '--version'], {
    windowsHide: true, timeout: 15000,
  });
  const reported = stdout.trim();
  if (reported !== `codex-cli ${version}`) throw Error(`Codex 版本不符：要求 ${version}，${binary} 报告 ${JSON.stringify(reported)}。`);
  console.log(reported);
  const targets = files.length ? files : ['dist/native-tests/codex.test.js'];
  process.exitCode = await run(process.execPath, [
    'tools/run-tests.mjs', '--test', '--test-concurrency=1', '--test-timeout=90000', ...targets,
  ], {cwd: workspace, env});
} finally {
  if (directory) {
    if (realpathSync(directory) !== directory || path.dirname(directory) !== realpathSync(tmpdir()) || !path.basename(directory).startsWith('nxbridge-test-')) {
      throw Error('临时目录越界。');
    }
    rmSync(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  }
}
