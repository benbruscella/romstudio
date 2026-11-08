import { deflateSync } from 'node:zlib';
/** Small deterministic PNG encoder for headless framebuffer captures. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4000000 ||
    rgba.length !== width * height * 4
  ) {
    throw new Error('Invalid PNG dimensions or pixel count.');
  }
  const crc = (data: Uint8Array): number => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
      }
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Buffer): Buffer => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length, 0);
    bytes.write(kind, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
