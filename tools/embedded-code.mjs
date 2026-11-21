import ts from 'typescript';
import {transform} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

                                 
const marker=/\/\* @nxbridge-embed (csharp|powershell|sql|javascript|sh|cmd) \*\//;
const needsGap=(language,left,right)=>{
  const word=value=>/[\p{L}\p{N}\p{M}\p{Pc}@$\\]/u.test(value);
  if(word(left)&&word(right))return true;
  if(/[+\-*/%<>=!&|^?.:]/.test(left)&&/[+\-*/%<>=!&|^?.:]/.test(right))return true;
  if(left==='.'&&/\d/.test(right)||/\d/.test(left)&&right==='.')return true;
  if(language==='sql'&&(/[:@$?]/.test(left+right)||word(left)&&right==="'"))return true;
  return false;
};
const quoteEnd=(text,start,quote,doubled=false,escape='\\')=>{
  for(let i=start+1;i<text.length;i++){
    if(escape&&text[i]===escape){i++;continue;}
    if(text[i]===quote){if(doubled&&text[i+1]===quote){i++;continue;}return i+1;}
  }
  throw Error('嵌入代码含未结束的字符串。');
};
export function compactCode(language,text){
                                               
  if(language==='sh'||language==='cmd')return text;
  let result='',i=0;
  while(i<text.length){
    const char=text[i],next=text[i+1];
    if(language==='csharp'&&char==='$'&&(next==='"'||next==='@'))throw Error('暂不压缩 C# 插值字符串。');
    if(language==='csharp'&&char==='@'&&next==='"'){const end=quoteEnd(text,i+1,'"',true,'');result+=text.slice(i,end);i=end;continue;}
    if(language==='powershell'&&char==='@'&&(next==="'"||next==='"')&&/\r|\n/.test(text[i+2]??'')){
      const close=new RegExp('^'+next+'@(?=\\r?$)','gm');close.lastIndex=i+2;const match=close.exec(text);
      if(!match)throw Error('嵌入 PowerShell here-string 未结束。');
      const end=match.index+2;result+=text.slice(i,end);i=end;continue;
    }
    if(language==='powershell'&&char==='`'){const length=next==='\r'&&text[i+2]==='\n'?3:2;result+=text.slice(i,i+length);i+=length;continue;}
    if(language==='powershell'&&char==='"'){
      const end=quoteEnd(text,i,'"',true,'`');
                                        
      if(text.slice(i,end).includes('$('))return text;
      result+=text.slice(i,end);i=end;continue;
    }
    if(char==="'"||char==='"'||language==='sql'&&(char==='`'||char==='[')){
      const quote=char==='['?']':char,doubled=language==='sql'||language==='powershell';
      const end=quoteEnd(text,i,quote,doubled,doubled?'':'\\');result+=text.slice(i,end);i=end;continue;
    }
    if(language==='csharp'&&char==='#'||language==='powershell'&&/^#(?:requires|!)/i.test(text.slice(i))){
      const end=text.indexOf('\n',i);result=result.trimEnd()+'\n'+text.slice(i,end<0?text.length:end)+'\n';i=end<0?text.length:end+1;continue;
    }
    const lineComment=language==='csharp'&&char==='/'&&next==='/'||language==='sql'&&char==='-'&&next==='-'||language==='powershell'&&char==='#';
    if(lineComment){const end=text.indexOf('\n',i);result+=language==='powershell'?'\n':' ';i=end<0?text.length:end+1;continue;}
    const blockComment=(language==='csharp'||language==='sql')&&char==='/'&&next==='*'||language==='powershell'&&char==='<'&&next==='#';
    if(blockComment){const end=text.indexOf(language==='powershell'?'#>':'*/',i+2);if(end<0)throw Error('嵌入代码注释未结束。');result+=' ';i=end+2;continue;}
    if(/[ \t\r\n\f]/.test(char)){
      const begin=i;while(i<text.length&&/[ \t\r\n\f]/.test(text[i]))i++;
      const gap=text.slice(begin,i);
      if(language==='powershell'&&/[\r\n]/.test(gap)){result+='\n'.repeat((gap.match(/\n/g)??['\n']).length);continue;}
      if(language==='powershell'||result&&i<text.length&&needsGap(language,result.at(-1),text[i]))result+=' ';continue;
    }
    result+=char;i++;
  }
  const compact=result.trim();
                                       
  return language==='sql'?(/^\s/.test(text)?' ':'')+compact+(/\s$/.test(text)?' ':''):compact;
}
const templatePart=value=>JSON.stringify(value).slice(1,-1).replaceAll('`','\\`').replaceAll('${','\\${');
const segments=(node,raw)=>{
  if(ts.isStringLiteral(node))return{parts:[node.text],expressions:[]};
  const value=literal=>(raw?literal.rawText??literal.text:literal.text).replaceAll('\r\n','\n');
  if(ts.isNoSubstitutionTemplateLiteral(node))return{parts:[value(node)],expressions:[]};
  if(ts.isTemplateExpression(node))return{parts:[value(node.head),...node.templateSpans.map(span=>value(span.literal))],expressions:node.templateSpans.map(span=>span.expression)};
  throw Error('标记只能用于字符串或模板表达式。');
};
export async function compressOwnSource(filename,source){
  if(!marker.test(source)&&!source.includes('embeddedSource('))return{contents:source,records:[]};
  const ast=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true),targets=[],markers=new Set();
  const visit=node=>{
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='embeddedSource'){
      if(node.arguments.length!==2||!ts.isStringLiteral(node.arguments[0])||!['csharp','powershell','sql','javascript','sh','cmd'].includes(node.arguments[0].text))throw Error('嵌入代码声明无效：'+filename);
      const value=node.arguments[1],tagged=ts.isTaggedTemplateExpression(value);
      if(tagged&&value.tag.getText(ast)!=='String.raw')throw Error('嵌入模板只允许 String.raw。');
      targets.push({node,language:node.arguments[0].text,...segments(tagged?value.template:value,tagged)});return;
    }
    const comments=[...(ts.getLeadingCommentRanges(source,node.pos)??[]),...(ts.getTrailingCommentRanges(source,node.pos)??[])].filter(range=>marker.test(source.slice(range.pos,range.end)));
    for(const comment of comments)markers.add(comment.pos);
    const found=comments.length?marker.exec(source.slice(comments.at(-1).pos,comments.at(-1).end)):undefined;
    if(found&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)||ts.isTaggedTemplateExpression(node))){
      const tagged=ts.isTaggedTemplateExpression(node);
      if(tagged&&node.tag.getText(ast)!=='String.raw')throw Error('嵌入模板只允许 String.raw。');
      targets.push({node,language:found[1],...segments(tagged?node.template:node,tagged)});
      return;
    }
    ts.forEachChild(node,visit);
  };visit(ast);
  if(targets.filter(target=>!ts.isCallExpression(target.node)).length!==markers.size)throw Error('嵌入代码标记没有匹配唯一表达式：'+filename);
  const edits=[],records=[];
  for(const target of targets){
    const {node,language,parts,expressions}=target,prefix='__NXBRIDGE_EMBED_HOLE_';
    if(parts.some(part=>part.includes(prefix)))throw Error('嵌入模板占位符冲突。');
    const original=parts.map((part,i)=>part+(i<expressions.length?prefix+i+'__':'')).join('');
    const header=language==='javascript'?original.match(/^\/\/[^\n]*\n/)?.[0]??'':'';
    const compact=language==='javascript'?header+(await transform(original.slice(header.length),{minify:true,legalComments:'none',target:'node24',loader:'js',charset:'utf8'})).code.trim():compactCode(language,original);
    const pieces=[];let from=0;
    for(let i=0;i<expressions.length;i++){
      const token=prefix+i+'__',index=compact.indexOf(token,from);
      if(index<0||compact.indexOf(token,index+token.length)>=0)throw Error('压缩改变了动态模板的占位符：'+filename);
      pieces.push(compact.slice(from,index));from=index+token.length;
    }pieces.push(compact.slice(from));
    const replacement=expressions.length?'`'+pieces.map((piece,i)=>templatePart(piece)+(i<expressions.length?'${'+expressions[i].getText(ast)+'}':'')).join('')+'`':JSON.stringify(compact);
    edits.push({start:node.getStart(ast),end:node.end,replacement});
    records.push({file:filename.replaceAll('\\','/'),line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,language,original,compact,expressions:expressions.map(value=>value.getText(ast)),bytesBefore:Buffer.byteLength(original),bytesAfter:Buffer.byteLength(compact)});
  }
  let contents=source;for(const edit of edits.sort((a,b)=>b.start-a.start))contents=contents.slice(0,edit.start)+edit.replacement+contents.slice(edit.end);
  return{contents,records};
}
export function originalIdentityRevision(root){
  const file='native-sources.ts',ast=ts.createSourceFile(file,readFileSync(path.join(root,'src/process/windows',file),'utf8'),ts.ScriptTarget.Latest,true);
  const source=['windowsHookIdentitySource','windowsJobHolderSource'].map(name=>{
    let value;
    const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name){const expression=ts.isBinaryExpression(node.initializer)?node.initializer.left:node.initializer;const argument=ts.isCallExpression(expression)&&expression.expression.getText(ast)==='embeddedSource'?expression.arguments[1]:expression;value=segments(ts.isTaggedTemplateExpression(argument)?argument.template:argument,ts.isTaggedTemplateExpression(argument)).parts[0];return;}ts.forEachChild(node,visit);};visit(ast);
    if(!value)throw Error('原生助手源码缺失：'+name);return value;
  }).join('');
  return createHash('sha256').update(source).digest('hex').slice(0,16);
}
export function embeddedCodePlugin(root,records){
  const sourceRoot=path.resolve(root,'src')+path.sep;
  return{name:'nxbridge-embedded-code',setup(context){context.onLoad({filter:/\.ts$/},async args=>{
    if(!path.resolve(args.path).startsWith(sourceRoot))return;
    const result=await compressOwnSource(path.relative(sourceRoot,args.path),readFileSync(args.path,'utf8'));records.push(...result.records);
    return{contents:result.contents,resolveDir:path.dirname(args.path),loader:'ts'};
  });}};
}
