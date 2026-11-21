import type { IncomingMessage } from 'node:http';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

                                                
export async function readModelBody(request:IncomingMessage):Promise<Buffer>{
  const chunks:Buffer[]=[];
  for await(const chunk of request)chunks.push(Buffer.from(chunk));
  const body=Buffer.concat(chunks),encoding=request.headers['content-encoding'];
  return encoding==='zstd'?zstdDecompressSync(body):encoding==='gzip'?gunzipSync(body):body;
}
