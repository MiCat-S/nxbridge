const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const filename = path.join(__dirname, 'runtime.json');
const bundled = path.resolve(__dirname, '../../nxbridge.mjs');
const runtime = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { node: process.execPath, entry: fs.existsSync(bundled) ? bundled : path.resolve(__dirname, '../../dist/cli.js') };
const args = process.argv.slice(2);
if (args[0] === 'question-control') {
                              
  if (runtime.home) process.env.NXBRIDGE_HOME = runtime.home;
  const current = runtime.launcher ? JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.launcher), 'runtime.json'), 'utf8')) : runtime;
  import(pathToFileURL(path.join(path.dirname(current.entry), path.extname(current.entry) === '.mjs' ? 'question-control.mjs' : 'question-control.js')).href).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
} else {
  if (runtime.home) process.env.NXBRIDGE_HOME = runtime.home;
  if (runtime.launcher) { require(runtime.launcher); } else {
  const native = file => { const value = fs.realpathSync.native(file); return process.platform === 'win32' ? value.toLowerCase() : value; };
  const dedicated = path.join(path.dirname(runtime.entry), args[0] + '-entry.mjs'), entry = ['mcp', 'mod', 'hook'].includes(args[0]) && fs.existsSync(dedicated) ? dedicated : runtime.entry;
  if (native(runtime.node) === native(process.execPath)) {
    import(pathToFileURL(entry).href).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
  } else {
  const child = spawn(runtime.node, ['--no-warnings', entry, ...args], { stdio: 'inherit', windowsHide: true, shell: false, env: { ...process.env, ...(runtime.home ? { NXBRIDGE_HOME: runtime.home } : {}) } });
  child.on('error', error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  }
  }
}
