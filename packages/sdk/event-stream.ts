/** OpenAI-compatible SSE, decoded incrementally across arbitrary byte and line boundaries. */
export async function* sseData(response: Response, maxBytes: number) {
  if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream')
    throw new Error('Expected an event stream');
  const reader=response.body.getReader(), decoder=new TextDecoder('utf-8',{fatal:true});
  let pending='', bytes=0, lines:string[]=[];
  try {
    while (true) {
      const part=await reader.read();
      if (part.done) { pending+=decoder.decode(); break; }
      bytes+=part.value.byteLength;
      if (bytes>maxBytes) throw new Error('Event stream exceeded its byte limit');
      pending+=decoder.decode(part.value,{stream:true});
      let end;
      while ((end=pending.indexOf('\n'))>=0) {
        const line=pending.slice(0,end).replace(/\r$/,''); pending=pending.slice(end+1);
        if (!line) { if (lines.length) yield lines.join('\n'); lines=[]; }
        else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /,''));
      }
    }
    if (pending || lines.length) throw new Error('Incomplete stream event');
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

