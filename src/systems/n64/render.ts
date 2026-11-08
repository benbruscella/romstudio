import { Vr4300Gap } from '../../runtime/vr4300.js';

/** Inspect an RDP color image as opaque RGBA pixels. This is a buffer capture,
 * separate from VI cropping, scaling, interlace and analog display filtering. */
export function renderN64ColorImage(
  ram: Uint8Array,
  image: { format: number; size: number; width: number; address: number },
  height: number,
): Uint8Array {
  if (image.format !== 0 || (image.size !== 2 && image.size !== 3)) {
    throw new Vr4300Gap(
      'n64-color-image',
      0,
      image.address,
      'Expected an RGBA16/RGBA32 color image.',
    );
  }
  const bytes = image.size === 2 ? 2 : 4;
  if (
    !Number.isInteger(height) ||
    height < 1 ||
    image.width < 1 ||
    image.address + image.width * height * bytes > ram.byteLength
  ) {
    throw new Vr4300Gap(
      'n64-color-image-range',
      0,
      image.address,
      'The color image exceeds installed RDRAM.',
    );
  }
  const rgba = new Uint8Array(image.width * height * 4),
    view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  for (let pixel = 0; pixel < image.width * height; pixel++) {
    const source = image.address + pixel * bytes,
      target = pixel * 4;
    if (bytes === 2) {
      const packed = view.getUint16(source, false);
      for (let channel = 0; channel < 3; channel++) {
        const value = (packed >>> (11 - channel * 5)) & 31;
        rgba[target + channel] = (value << 3) | (value >>> 2);
      }
    } else {
      rgba.set(ram.subarray(source, source + 3), target);
    }
    rgba[target + 3] = 255; // Framebuffer alpha bits contain coverage, not canvas transparency.
  }
  return rgba;
}
