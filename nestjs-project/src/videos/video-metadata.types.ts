/** Curated summary of `ffprobe -show_format -show_streams`, stored as jsonb. */
export interface VideoMetadata {
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  bitrate: number | null;
  format_name: string;
  size_bytes: number;
}
