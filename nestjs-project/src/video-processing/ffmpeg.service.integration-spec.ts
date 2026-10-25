import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateTestVideo } from '../test/video-fixtures';
import { FfmpegExecutionError, FfmpegService } from './ffmpeg.service';
import { parseProbeOutput } from './probe-parser';

describe('FfmpegService (integration)', () => {
  const ffmpeg = new FfmpegService();
  let dir: string;
  let videoPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-spec-'));
    videoPath = join(dir, 'sample.mp4');
    await generateTestVideo(videoPath, { durationSeconds: 3 });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should probe a generated MP4 (duration, size, codecs)', async () => {
    const parsed = parseProbeOutput(await ffmpeg.probe(videoPath));

    expect(parsed.hasVideoStream).toBe(true);
    expect(parsed.durationSeconds).toBeGreaterThanOrEqual(2.9);
    expect(parsed.durationSeconds).toBeLessThanOrEqual(3.1);
    expect(parsed.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
  });

  it('should extract one frame as a 1280px-wide JPEG', async () => {
    const out = join(dir, 'thumb.jpg');

    await ffmpeg.extractFrame(videoPath, 0.3, out);

    const probe = await ffmpeg.probe(out);
    expect(probe.streams?.[0]).toMatchObject({
      codec_name: 'mjpeg',
      width: 1280,
    });
  });

  it('should reject non-media input with the ffprobe stderr', async () => {
    const textFile = join(dir, 'not-a-video.mp4');
    writeFileSync(textFile, 'definitely not a video');

    const error = await ffmpeg.probe(textFile).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegExecutionError);
    expect((error as FfmpegExecutionError).stderr).not.toBe('');
  });

  it('should kill a process that exceeds the timeout and reject', async () => {
    await expect(
      ffmpeg.extractFrame(videoPath, 0.3, join(dir, 'slow.jpg'), 1),
    ).rejects.toThrow(/timed out after 1ms/);
  });
});
