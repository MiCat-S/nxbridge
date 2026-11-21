                               
export function profileVersionSupported(selected:string,writer:string):boolean{
  const parse=(v:string)=>/(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?/.exec(v),a=parse(selected),b=parse(writer);if(!a||!b)return false;
  for(let i=1;i<=3;i++){const d=Number(a[i])-Number(b[i]);if(d)return d>0;}
  if(!b[4])return !a[4];if(!a[4])return true;
  const x=a[4].split('.'),y=b[4].split('.');for(let i=0;i<Math.max(x.length,y.length);i++){if(x[i]===y[i])continue;if(x[i]===undefined)return false;if(y[i]===undefined)return true;const n=/^\d+$/.test(x[i]!),m=/^\d+$/.test(y[i]!);return n&&m?Number(x[i])>Number(y[i]):n!==m?!n:x[i]!>y[i]!;}return true;
}
