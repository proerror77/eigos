/** Read SSE data events across arbitrary UTF-8 byte, CR/LF and network chunk boundaries. */
export async function* sseData(response: Response, maxBytes: number) {
  if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream')
    throw new Error('Expected an event stream');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', bytes = 0, skipLF = false;
  let data: string[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) { pending += decoder.decode(); break; }
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('Event stream exceeded its byte limit');
      const decoded = decoder.decode(part.value, { stream: true });
      if (!decoded) continue;
      let start = skipLF && decoded[0] === '\n' ? 1 : 0;
      skipLF = false;
      for (let i = start; i < decoded.length; i++) {
        const character = decoded[i];
        if (character !== '\r' && character !== '\n') continue;
        const line = pending + decoded.slice(start, i);
        pending = '';
        if (character === '\r') {
          if (decoded[i+1] === '\n') i++;
          else if (i+1 === decoded.length) skipLF = true;
        }
        start = i+1;
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line === 'data') data.push('');
      }
      pending += decoded.slice(start);
    }
    if (pending || data.length) throw new Error('Incomplete stream event');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
