import type { VideoMetadata } from '../videos/video-metadata.types';

/** Subset of `ffprobe -print_format json -show_format -show_streams`. */
export interface ProbeOutput {
  format?: {
    duration?: string;
    bit_rate?: string;
    format_name?: string;
    size?: string;
  };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    disposition?: { attached_pic?: number };
  }[];
}

export interface ParsedProbe {
  hasVideoStream: boolean;
  durationSeconds: number | null;
  metadata: VideoMetadata | null;
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseProbeOutput(output: ProbeOutput): ParsedProbe {
  const streams = output.streams ?? [];
  // Cover art in audio files is exposed as a video stream; it is not a video.
  const video = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  if (!video) {
    return { hasVideoStream: false, durationSeconds: null, metadata: null };
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = output.format ?? {};

  return {
    hasVideoStream: true,
    durationSeconds: toNumber(format.duration) ?? toNumber(video.duration),
    metadata: {
      width: video.width ?? 0,
      height: video.height ?? 0,
      video_codec: video.codec_name ?? 'unknown',
      audio_codec: audio?.codec_name ?? null,
      bitrate: toNumber(format.bit_rate),
      format_name: format.format_name ?? 'unknown',
      size_bytes: toNumber(format.size) ?? 0,
    },
  };
}
