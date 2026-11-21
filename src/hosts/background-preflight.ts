import { neutralEnvironment } from '../process/environment.js';
import { installedEntry } from '../install/runtime-install.js';
import { probeIndependentWindows } from '../process/windows/windows-background.js';
import { deferBackgroundRetry, requireBackgroundRetry } from './background-state.js';
import {describeError} from '../shared/errors.js';

                                          
export async function verifyBackgroundContext(home:string):Promise<void>{
  if(process.platform!=='win32')return;
  requireBackgroundRetry(home);
  try{await probeIndependentWindows(installedEntry(home).node,neutralEnvironment({},true).env);}
  catch(error){deferBackgroundRetry(home,describeError(error));throw error;}
}
