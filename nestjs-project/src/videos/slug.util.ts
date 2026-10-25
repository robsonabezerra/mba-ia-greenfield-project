import { randomBytes } from 'crypto';

const SLUG_BYTES = 8;

/** 64 random bits as 11 URL-safe characters — the video's public identifier. */
export function generateVideoSlug(): string {
  return randomBytes(SLUG_BYTES).toString('base64url');
}
