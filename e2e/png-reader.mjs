/**
 * Minimaler PNG-Leser fuer die Auswertung exportierter Notenbilder.
 *
 * Nur so viel, wie der Ende-zu-Ende-Test braucht: Bildgroesse lesen und
 * den Schwaerzungsgrad eines Bildausschnitts bestimmen. Damit laesst sich
 * pruefen, ob im Export tatsaechlich Notenzeichen stehen und nicht nur
 * Notenlinien.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export class PNG {
  constructor(width, height, pixels, channels) {
    this.width = width;
    this.height = height;
    /** Roh-Pixeldaten nach dem Entfiltern. */
    this.pixels = pixels;
    this.channels = channels;
  }

  /** Liest eine PNG-Datei (8 Bit, Graustufen/RGB/RGBA, ohne Interlacing). */
  static read(path) {
    const data = readFileSync(path);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (data[i] !== signature[i]) throw new Error('Keine gueltige PNG-Datei.');
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idatParts = [];

    while (offset < data.length) {
      const length = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      const body = data.subarray(offset + 8, offset + 8 + length);

      if (type === 'IHDR') {
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        bitDepth = body[8];
        colorType = body[9];
        if (body[12] !== 0) throw new Error('Interlaced PNG wird nicht unterstuetzt.');
      } else if (type === 'IDAT') {
        idatParts.push(body);
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + length;
    }

    if (bitDepth !== 8) throw new Error(`Bittiefe ${bitDepth} wird nicht unterstuetzt.`);
    const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 };
    const channels = channelsByColorType[colorType];
    if (!channels) throw new Error(`Farbtyp ${colorType} wird nicht unterstuetzt.`);

    const raw = inflateSync(Buffer.concat(idatParts));
    const stride = width * channels;
    const pixels = Buffer.alloc(height * stride);

    // PNG-Zeilenfilter rueckgaengig machen.
    let rawOffset = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[rawOffset++];
      const rowStart = y * stride;
      const previousStart = (y - 1) * stride;

      for (let x = 0; x < stride; x++) {
        const value = raw[rawOffset + x];
        const left = x >= channels ? pixels[rowStart + x - channels] : 0;
        const up = y > 0 ? pixels[previousStart + x] : 0;
        const upLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels] : 0;

        let result;
        switch (filter) {
          case 0: result = value; break;
          case 1: result = value + left; break;
          case 2: result = value + up; break;
          case 3: result = value + ((left + up) >> 1); break;
          case 4: result = value + paeth(left, up, upLeft); break;
          default: throw new Error(`Unbekannter Zeilenfilter ${filter}.`);
        }
        pixels[rowStart + x] = result & 0xff;
      }
      rawOffset += stride;
    }

    return new PNG(width, height, pixels, channels);
  }

  /** Helligkeit eines Pixels (0 = schwarz, 255 = weiss). */
  luminance(x, y) {
    const index = (y * this.width + x) * this.channels;
    if (this.channels <= 2) return this.pixels[index];
    return (
      this.pixels[index] * 0.299 +
      this.pixels[index + 1] * 0.587 +
      this.pixels[index + 2] * 0.114
    );
  }

  /**
   * Anteil dunkler Pixel in einem Ausschnitt.
   * Die Angaben sind relative Koordinaten von 0 bis 1.
   */
  inkRatio(x0, x1, y0, y1, threshold = 160) {
    const left = Math.max(0, Math.floor(x0 * this.width));
    const right = Math.min(this.width, Math.ceil(x1 * this.width));
    const top = Math.max(0, Math.floor(y0 * this.height));
    const bottom = Math.min(this.height, Math.ceil(y1 * this.height));

    let dark = 0;
    let total = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if (this.luminance(x, y) < threshold) dark++;
        total++;
      }
    }
    return total > 0 ? dark / total : 0;
  }
}

/** Paeth-Praediktor nach der PNG-Spezifikation. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}
