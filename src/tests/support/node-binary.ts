import { copyFileSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';

// Homebrew's shared Node resolves libnode through @loader_path after relocation.
// Keep the executable a real copy: process identity tests depend on its new image path.
const nodeLibrary=process.platform==='darwin'
  ?(process.report.getReport() as {sharedObjects:string[]}).sharedObjects.find(file=>/^libnode\..*\.dylib$/.test(path.basename(file)))
  :undefined;

export function copyNodeBinary(destination:string):void{
  copyFileSync(process.execPath,destination);
  if(nodeLibrary){
    const library=path.join(path.dirname(destination),path.basename(nodeLibrary));
    if(!existsSync(library))symlinkSync(nodeLibrary,library);
  }
}
