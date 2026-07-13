import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readBodyUpTo } from './body.js';

describe('readBodyUpTo', () => {
  it('rejects an HTTP/2-style abort that follows end in the same turn', async () => {
    const stream = Object.assign(new PassThrough(), { rstCode: 0 });
    // Node's HTTP/2 streams can report a remote RST_STREAM as end followed by
    // aborted. Register after readBodyUpTo so its deferred end resolution is
    // still pending when this listener emits the abort.
    stream.once('end', () => stream.emit('aborted'));
    const read = readBodyUpTo(stream, 1024);
    stream.end('partial');
    await expect(read).rejects.toThrow('aborted');
  });

  it('resolves a normally completed body', async () => {
    await expect(readBodyUpTo(Readable.from([Buffer.from('complete')]), 1024)).resolves.toEqual({
      complete: true,
      buffer: Buffer.from('complete'),
    });
  });
});
