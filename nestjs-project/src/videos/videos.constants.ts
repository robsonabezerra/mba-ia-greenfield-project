export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const VIDEO_JOBS = {
  PROCESS: 'process-video',
  SWEEP_EXPIRED_UPLOADS: 'sweep-expired-uploads',
} as const;

export const VIDEO_PROCESSING_BACKOFF_DELAY_MS = 5000;
