/** gRPC wire framing: 1-byte compressed flag + 4-byte big-endian length. */

export function encodeGrpcFrame(message: Buffer, compressed = false): Buffer {
  const frame = Buffer.alloc(5 + message.byteLength);
  frame.writeUInt8(compressed ? 1 : 0, 0);
  frame.writeUInt32BE(message.byteLength, 1);
  message.copy(frame, 5);
  return frame;
}

export interface GrpcFrame {
  compressed: boolean;
  message: Buffer;
}

export class GrpcFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrpcFrameError';
  }
}

/** Decodes a fully buffered gRPC body into its frames. */
export function decodeGrpcFrames(body: Buffer): GrpcFrame[] {
  const frames: GrpcFrame[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    if (offset + 5 > body.byteLength) {
      throw new GrpcFrameError('truncated gRPC frame header');
    }
    const compressed = body.readUInt8(offset) === 1;
    const length = body.readUInt32BE(offset + 1);
    if (offset + 5 + length > body.byteLength) {
      throw new GrpcFrameError('truncated gRPC frame payload');
    }
    frames.push({ compressed, message: body.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return frames;
}

/** Percent-encodes a grpc-message trailer value (gRPC spec). */
export function encodeGrpcMessage(message: string): string {
  return encodeURIComponent(message).replace(/%20/g, ' ');
}
