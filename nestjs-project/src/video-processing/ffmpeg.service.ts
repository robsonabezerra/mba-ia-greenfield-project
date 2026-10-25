import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import type { ProbeOutput } from './probe-parser';
import {
  FFMPEG_STDERR_TAIL_CHARS,
  FFMPEG_TIMEOUT_MS,
  THUMBNAIL_WIDTH,
} from './video-processing.constants';

export class FfmpegExecutionError extends Error {
  constructor(
    public readonly command: string,
    public readonly stderr: string,
    reason: string,
  ) {
    super(`${command} ${reason}: ${stderr.slice(-FFMPEG_STDERR_TAIL_CHARS)}`);
    this.name = 'FfmpegExecutionError';
  }
}

/** Thin wrapper over the OS ffprobe/ffmpeg binaries (per TD-07). */
@Injectable()
export class FfmpegService {
  async probe(
    input: string,
    timeoutMs: number = FFMPEG_TIMEOUT_MS,
  ): Promise<ProbeOutput> {
    const stdout = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      timeoutMs,
    );
    return JSON.parse(stdout) as ProbeOutput;
  }

  /** Writes one frame at `atSeconds`, scaled to the thumbnail width, as JPEG. */
  async extractFrame(
    input: string,
    atSeconds: number,
    outputPath: string,
    timeoutMs: number = FFMPEG_TIMEOUT_MS,
  ): Promise<void> {
    await this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMBNAIL_WIDTH}:-2`,
        '-q:v',
        '3',
        '-y',
        outputPath,
      ],
      timeoutMs,
    );
  }

  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new FfmpegExecutionError(command, stderr, err.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new FfmpegExecutionError(
              command,
              stderr,
              `timed out after ${timeoutMs}ms`,
            ),
          );
        } else if (code !== 0) {
          reject(
            new FfmpegExecutionError(
              command,
              stderr,
              `exited with code ${code}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      });
    });
  }
}
