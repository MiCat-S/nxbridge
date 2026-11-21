import path from 'node:path';
                                                              
const systemRoot = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows';
export const windowsTool = (name: string) => path.win32.join(systemRoot(), 'System32', name);
export const windowsPowerShell = () => path.win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
