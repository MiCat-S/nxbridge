const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const filename = path.join(__dirname, 'runtime.json');
const bundled = path.resolve(__dirname, '../../nxbridge.mjs');
const runtime = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { node: process.execPath, entry: fs.existsSync(bundled) ? bundled : path.resolve(__dirname, '../../dist/cli.js') };
if (runtime.home) process.env.NXBRIDGE_HOME = runtime.home;
if (runtime.launcher) { require(runtime.launcher); } else {
const native = file => { const value = fs.realpathSync.native(file); return process.platform === 'win32' ? value.toLowerCase() : value; };
const command = process.argv[2], dedicated = path.join(path.dirname(runtime.entry), command + '-entry.mjs'), entry = ['mcp', 'mod', 'hook'].includes(command) && fs.existsSync(dedicated) ? dedicated : runtime.entry;
if (native(runtime.node) === native(process.execPath)) {
                                         
  import(pathToFileURL(entry).href).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
} else {
const child = spawn(runtime.node, ['--no-warnings', entry, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, shell: false, env: { ...process.env, ...(runtime.home ? { NXBRIDGE_HOME: runtime.home } : {}) } });
child.on('error', error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
}
}
