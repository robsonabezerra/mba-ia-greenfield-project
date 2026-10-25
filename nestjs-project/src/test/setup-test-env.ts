// Loaded by Jest right after `dotenv/config` (unit, integration and e2e).
// Tests run inside the API container, so presigned URLs must be signed for the
// internal storage host instead of the browser-facing one.
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
// Isolated BullMQ key prefix: the long-running `video-worker` service (dev
// prefix) never consumes jobs created by tests.
process.env.QUEUE_PREFIX = 'streamtube-test';
// Smallest part size S3 accepts, so multipart flows run with small fixtures.
process.env.UPLOAD_PART_SIZE_BYTES = '5242880';
