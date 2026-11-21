import path from 'node:path';
import {fileURLToPath} from 'node:url';

                                     
declare const __NXBRIDGE_BUNDLED__:boolean;
const bundled=typeof __NXBRIDGE_BUNDLED__!=='undefined'&&__NXBRIDGE_BUNDLED__;
export const PACKAGE_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),bundled?'.':'../..');
export const CLI_PATH=path.join(PACKAGE_ROOT,bundled?'nxbridge.mjs':'dist/cli.js');
export const COLLABORATION_GUIDE_PATH=path.join(PACKAGE_ROOT,bundled?'nxbridge-collaboration.md':'docs/collaboration.md');
