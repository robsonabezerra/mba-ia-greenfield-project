/** Upper bound for a single ffprobe/ffmpeg invocation. */
export const FFMPEG_TIMEOUT_MS = 120_000;

/** How much stderr is kept in error messages. */
export const FFMPEG_STDERR_TAIL_CHARS = 2000;

export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_POSITION_RATIO = 0.1;
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/** Lifetime of the presigned URL FFmpeg reads the source from. */
export const SOURCE_URL_EXPIRES_IN_SECONDS = 3600;

export const PROCESSING_ERROR_MAX_LENGTH = 500;
