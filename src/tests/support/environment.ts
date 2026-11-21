                                  
export function overrideEnvironment(values:NodeJS.ProcessEnv):()=>void{
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  Object.assign(process.env,values);
  return()=>{
    for(const key of Object.keys(values)){
      if(previous[key]===undefined)delete process.env[key];
      else process.env[key]=previous[key];
    }
  };
}
