import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  uploadExpirationHours: parseInt(
    process.env.UPLOAD_EXPIRATION_HOURS || '24',
    10,
  ),
  presignedUrlExpiresInSeconds: parseInt(
    process.env.PRESIGNED_URL_EXPIRES_IN_SECONDS || '3600',
    10,
  ),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  uploadSweepIntervalMinutes: parseInt(
    process.env.UPLOAD_SWEEP_INTERVAL_MINUTES || '60',
    10,
  ),
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '1', 10),
}));
