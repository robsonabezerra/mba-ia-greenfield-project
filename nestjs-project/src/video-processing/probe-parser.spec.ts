import { parseProbeOutput, type ProbeOutput } from './probe-parser';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  duration: '10.000000',
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const format = {
  duration: '10.010000',
  bit_rate: '5000000',
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  size: '6262500',
};

describe('parseProbeOutput', () => {
  it('should map a video with audio to duration and metadata', () => {
    const output: ProbeOutput = { format, streams: [videoStream, audioStream] };

    expect(parseProbeOutput(output)).toEqual({
      hasVideoStream: true,
      durationSeconds: 10.01,
      metadata: {
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        bitrate: 5000000,
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        size_bytes: 6262500,
      },
    });
  });

  it('should report audio_codec null for a video without audio', () => {
    const result = parseProbeOutput({ format, streams: [videoStream] });

    expect(result.metadata?.audio_codec).toBeNull();
  });

  it('should report no video stream for audio-only input (cover art ignored)', () => {
    const result = parseProbeOutput({
      format,
      streams: [
        audioStream,
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          disposition: { attached_pic: 1 },
        },
      ],
    });

    expect(result).toEqual({
      hasVideoStream: false,
      durationSeconds: null,
      metadata: null,
    });
  });

  it('should fall back to the stream duration and return null when both are missing', () => {
    const fromStream = parseProbeOutput({
      format: { ...format, duration: undefined },
      streams: [videoStream],
    });
    const missing = parseProbeOutput({
      format: { format_name: 'matroska,webm' },
      streams: [{ ...videoStream, duration: 'N/A' }],
    });

    expect(fromStream.durationSeconds).toBe(10);
    expect(missing.durationSeconds).toBeNull();
    expect(missing.metadata?.bitrate).toBeNull();
  });
});
