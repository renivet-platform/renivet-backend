import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket, createConnection } from 'node:net';
import { MediaScannerPort } from './media-ports';

export class MediaScannerUnavailableError extends Error {
  constructor() { super('Media malware scanning is unavailable.'); this.name = 'MediaScannerUnavailableError'; }
}

@Injectable()
export class ClamAvMediaScanner implements MediaScannerPort {
  private readonly host: string | undefined;
  private readonly port: number | undefined;

  constructor(config: ConfigService) {
    this.host = config.get<string>('MEDIA_CLAMD_HOST')?.trim();
    const rawPort = config.get<string | number>('MEDIA_CLAMD_PORT');
    const port = rawPort === undefined ? NaN : Number(rawPort);
    this.port = Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.host && !/[/:\\\s]/.test(this.host) && this.port);
  }

  async scan(bytes: Buffer): Promise<'CLEAN' | 'INFECTED'> {
    if (!this.isConfigured() || !this.host || !this.port) throw new MediaScannerUnavailableError();
    const socket = createConnection({ host: this.host, port: this.port });
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')));
    try {
      await connected(socket);
      await write(socket, Buffer.from('zINSTREAM\0'));
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        await write(socket, Buffer.concat([length, chunk]));
      }
      await write(socket, Buffer.alloc(4));
      const response = await readResponse(socket);
      if (/^stream: OK$/i.test(response)) return 'CLEAN';
      if (/^stream: .+ FOUND$/i.test(response)) return 'INFECTED';
      throw new MediaScannerUnavailableError();
    } catch {
      throw new MediaScannerUnavailableError();
    } finally {
      socket.destroy();
    }
  }
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => { socket.off('error', onError); resolve(); });
  });
}

function write(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

function readResponse(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 1_024) { cleanup(); reject(new Error('invalid response')); return; }
      const end = response.indexOf(0);
      if (end >= 0) { cleanup(); resolve(response.subarray(0, end).toString('utf8')); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error('truncated response')); };
    const cleanup = () => {
      socket.off('data', onData); socket.off('error', onError); socket.off('end', onEnd);
    };
    socket.on('data', onData); socket.once('error', onError); socket.once('end', onEnd);
  });
}
