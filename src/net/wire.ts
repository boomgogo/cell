// Bytes for what a room sends often: what each player can see, ten times a second, and the world's save.
//
// A place on the sphere is a unit vector, sent as three signed 16-bit numbers: half a unit of the world's
// 16 000-unit radius, finer than anything is drawn.
import type { Vec3 } from '../sphere/vec3.ts';

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private at = 0;

  constructor(size = 4096) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
  }

  private room(n: number): void {
    if (this.at + n <= this.buf.byteLength) return;
    const bigger = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.at + n));
    new Uint8Array(bigger).set(new Uint8Array(this.buf, 0, this.at));
    this.buf = bigger;
    this.view = new DataView(bigger);
  }

  u8(v: number): this {
    this.room(1);
    this.view.setUint8(this.at, clampInt(v, 0, 255));
    this.at += 1;
    return this;
  }

  u16(v: number): this {
    this.room(2);
    this.view.setUint16(this.at, clampInt(v, 0, 65535));
    this.at += 2;
    return this;
  }

  u32(v: number): this {
    this.room(4);
    this.view.setUint32(this.at, clampInt(v, 0, 4294967295));
    this.at += 4;
    return this;
  }

  i16(v: number): this {
    this.room(2);
    this.view.setInt16(this.at, clampInt(v, -32768, 32767));
    this.at += 2;
    return this;
  }

  f32(v: number): this {
    this.room(4);
    this.view.setFloat32(this.at, Number.isFinite(v) ? v : 0);
    this.at += 4;
    return this;
  }

  /** A unit vector: a place on the sphere, or a direction along it. */
  unit(v: Vec3): this {
    return this.i16(v.x * 32767).i16(v.y * 32767).i16(v.z * 32767);
  }

  /** Short text: a name. At most 255 bytes of UTF-8. */
  text(s: string): this {
    const bytes = ENCODER.encode(s).subarray(0, 255);
    this.u8(bytes.length);
    this.room(bytes.length);
    new Uint8Array(this.buf, this.at, bytes.length).set(bytes);
    this.at += bytes.length;
    return this;
  }

  /** Bytes as they are. */
  raw(bytes: Uint8Array): this {
    this.room(bytes.length);
    new Uint8Array(this.buf, this.at, bytes.length).set(bytes);
    this.at += bytes.length;
    return this;
  }

  get length(): number {
    return this.at;
  }

  /** What has been written, as a copy: the writer can then start again. */
  bytes(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.at));
  }

  reset(): this {
    this.at = 0;
    return this;
  }
}

export class Reader {
  private readonly view: DataView;
  private readonly raw: Uint8Array;
  private at = 0;

  constructor(bytes: Uint8Array) {
    this.raw = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Throws when the bytes run out: what came was not whole, and is dropped whole. */
  private need(n: number): void {
    if (this.at + n > this.view.byteLength) throw new RangeError('short message');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.at++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.at);
    this.at += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at);
    this.at += 4;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.at);
    this.at += 2;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.at);
    this.at += 4;
    return v;
  }

  /** Into `out`, normalised: sixteen bits a part leave it a hair off the sphere. */
  unit(out: Vec3): Vec3 {
    const x = this.i16() / 32767;
    const y = this.i16() / 32767;
    const z = this.i16() / 32767;
    const l = Math.hypot(x, y, z) || 1;
    out.x = x / l;
    out.y = y / l;
    out.z = z / l;
    return out;
  }

  text(): string {
    const n = this.u8();
    this.need(n);
    const s = DECODER.decode(this.raw.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }

  /** The rest of the bytes. */
  rest(): Uint8Array {
    const out = this.raw.subarray(this.at);
    this.at = this.raw.length;
    return out;
  }

  get done(): boolean {
    return this.at >= this.view.byteLength;
  }
}

/** Squeezes bytes with the browser's own deflate: a world's save is mostly small numbers and repeats. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(Number.isFinite(v) ? v : 0);
  return n < lo ? lo : n > hi ? hi : n;
}
