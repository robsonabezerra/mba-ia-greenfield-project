import { spawn } from 'child_process';

export interface TestVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  withAudio?: boolean;
  /** Video bitrate, e.g. '8M' — raises the file size for multipart tests. */
  videoBitrate?: string;
}

/** Generates an H.264/AAC MP4 with FFmpeg's lavfi sources (no binary fixtures). */
export function generateTestVideo(
  outputPath: string,
  {
    durationSeconds = 3,
    width = 320,
    height = 240,
    withAudio = true,
    videoBitrate,
  }: TestVideoOptions = {},
): Promise<void> {
  const args = [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=25`,
  ];
  if (withAudio) {
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=1000:duration=${durationSeconds}`,
    );
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (videoBitrate) {
    // Strict CBR (filler data): lavfi test patterns compress to almost nothing
    // otherwise, and multipart tests need files larger than one part.
    args.push(
      '-b:v',
      videoBitrate,
      '-minrate',
      videoBitrate,
      '-maxrate',
      videoBitrate,
      '-bufsize',
      videoBitrate,
      '-x264-params',
      'nal-hrd=cbr',
    );
  }
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push('-movflags', '+faststart', outputPath);

  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg fixture failed (${code}): ${stderr}`)),
    );
  });
}
