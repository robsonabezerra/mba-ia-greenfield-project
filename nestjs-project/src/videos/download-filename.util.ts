import { extname } from 'path';

const FALLBACK_NAME = 'video';

/**
 * Attachment file name: the title made header-safe (ASCII letters, digits,
 * spaces, dots, dashes, underscores) plus the original file extension.
 */
export function buildDownloadFileName(
  title: string,
  originalFileName: string,
): string {
  const extension = extname(originalFileName).toLowerCase();
  let base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  if (extension && base.toLowerCase().endsWith(extension)) {
    base = base.slice(0, -extension.length).trim();
  }
  return `${base || FALLBACK_NAME}${extension}`;
}
