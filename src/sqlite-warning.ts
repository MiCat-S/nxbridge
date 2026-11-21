                                                       
const printer=process.listeners('warning').find(listener=>listener.name==='onWarning');
if(printer){
  process.off('warning',printer);
  process.on('warning',warning=>{
    if(warning.name==='ExperimentalWarning'&&warning.message==='SQLite is an experimental feature and might change at any time')return;
    printer.call(process,warning);
  });
}
export {};
