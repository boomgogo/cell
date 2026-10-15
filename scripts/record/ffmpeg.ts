// ffmpeg helpers for the recorder and the cut tool, ported from Bubbler's: x264 in BT.709, WAV writing, loudness, and
// the sound encode that lands on −14 LUFS with the true peak at or under −1 dBTP after AAC.
import { type ChildProcess, spawn } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

export interface Ffmpeg extends ChildProcess {
  done: Promise<string>;
}

export function ffmpeg(args: string[], { input = false } = {}): Ffmpeg {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'inherit', 'pipe'] }) as Ffmpeg;
  let err = '';
  child.stderr!.on('data', (d) => (err += d));
  child.done = new Promise((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg failed (${code}): ${err}`)))));
  return child;
}

/** ffprobe a file's streams and duration. */
export async function probe(path: string): Promise<{ width: number; height: number; fps: string; vcodec: string; profile: string; acodec: string; duration: number; size: number }> {
  const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,width,height,r_frame_rate:format=duration,size', '-of', 'json', path]);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => child.on('exit', r));
  const j = JSON.parse(out) as { streams: Record<string, string | number>[]; format: { duration: string; size: string } };
  const v = j.streams.find((s) => s.codec_type === 'video') ?? {};
  const a = j.streams.find((s) => s.codec_type === 'audio') ?? {};
  return {
    width: Number(v.width),
    height: Number(v.height),
    fps: String(v.r_frame_rate),
    vcodec: String(v.codec_name),
    profile: String(v.profile),
    acodec: String(a.codec_name ?? ''),
    duration: Number(j.format.duration),
    size: Number(j.format.size),
  };
}

/**
 * x264 for everything handed to YouTube or X: High profile, two B-frames, a keyframe every half second, BT.709
 * throughout. Without the explicit matrix ffmpeg converts RGB with BT.601 and the colours shift once a player reads the
 * file as BT.709; ffmpeg 8 tags the stream from the frames, so the frames carry the tags too (TAG_709).
 */
export const X264 = (fps: number, crf = 16, preset = 'slow') => [
  '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-g', String(Math.round(fps / 2)), '-bf', '2',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
];
export const TAG_709 = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
export const TO_709 = `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,${TAG_709}`;

export function writeWav(path: string, int16: Int16Array, rate = 48000): void {
  const pcm = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono: the game's sound has no panning
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

/** Integrated loudness (LUFS) and highest true peak (dBTP) of a file's sound. */
export async function loudness(path: string): Promise<{ i: number; peak: number }> {
  const log = await ffmpeg(['-loglevel', 'info', '-nostats', '-i', path, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']).done;
  const s = log.slice(log.lastIndexOf('Summary'));
  return { i: Number(s.match(/I:\s+(\S+)/)![1]), peak: Number(s.match(/Peak:\s+(\S+)/)![1]) };
}

/**
 * The sound of `input` as stereo AAC in `out` (.m4a) at −14 LUFS (what YouTube plays at: it turns loud videos down but
 * quiet ones not up), true peak at or under −1 dBTP once encoded: a gain and a limiter, measured after each encode (AAC
 * overshoots the limiter on sharp sounds). The game's sound is sparse (chomps over quiet), so quiet stretches drop in and
 * out of the loudness gate as the level moves, and loudness jumps by more than the gain: the gain is bracketed and
 * bisected, and the closest encode is kept.
 */
export async function encodeAudio(input: string, out: string, bitrate = '384k'): Promise<{ i: number; peak: number; gain: number; ceiling: number }> {
  const measured = await loudness(input);
  // Silence (or nearly): nothing to bring up.
  let gain = Number.isFinite(measured.i) && measured.i > -70 ? -14 - measured.i : 0;
  let ceiling = -3.5;
  let lo = -Infinity;
  let hi = Infinity;
  let best: { i: number; peak: number; gain: number; ceiling: number } | null = null;
  const encode = async (g: number, c: number, file: string) => {
    const limit = (10 ** (c / 20)).toFixed(4);
    const af = `volume=${g.toFixed(2)}dB,alimiter=limit=${limit}:attack=1:release=60:level=0:latency=1,aresample=48000`;
    await ffmpeg(['-i', input, '-vn', '-af', af, '-c:a', 'aac', '-b:a', bitrate, '-ac', '2', file]).done;
    return loudness(file);
  };
  const tmp = out.replace(/(\.[^.]+)$/, '.try$1');
  for (let k = 0; k < 12; k++) {
    const got = await encode(gain, ceiling, tmp);
    if (!Number.isFinite(got.i)) {
      rmSync(tmp, { force: true });
      await encode(gain, ceiling, out);
      return { ...got, gain, ceiling };
    }
    if (got.peak > -1) {
      // Lower the limiter's ceiling by the overshoot and try the same gain again.
      ceiling = Math.round((ceiling - got.peak - 1.2) * 10) / 10;
      continue;
    }
    if (!best || Math.abs(got.i + 14) < Math.abs(best.i + 14)) {
      best = { ...got, gain, ceiling };
      renameSync(tmp, out);
    }
    if (Math.abs(got.i + 14) <= 0.3) break;
    if (got.i < -14) lo = Math.max(lo, gain);
    else hi = Math.min(hi, gain);
    gain = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : gain + (-14 - got.i);
    gain = Math.round(gain * 100) / 100;
  }
  rmSync(tmp, { force: true });
  return best!;
}

/** Puts the sound under the video (copied, not encoded again): loudness to −14 LUFS, AAC stereo. */
export async function mux(videoPath: string, audioPath: string, outPath: string): Promise<{ i: number; peak: number }> {
  const audio = outPath.replace(/\.mp4$/, '.m4a');
  const sound = await encodeAudio(audioPath, audio);
  await ffmpeg(['-i', videoPath, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', outPath]).done;
  rmSync(audio);
  return sound;
}

/** m:ss (or h:mm:ss). */
export const clock = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
