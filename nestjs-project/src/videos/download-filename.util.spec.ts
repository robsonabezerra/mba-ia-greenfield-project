import { buildDownloadFileName } from './download-filename.util';

describe('buildDownloadFileName', () => {
  it('should keep the title and append the original extension', () => {
    expect(buildDownloadFileName('Minha aula', 'raw-file.MP4')).toBe(
      'Minha aula.mp4',
    );
  });

  it('should strip accents, quotes, slashes and control characters', () => {
    expect(
      buildDownloadFileName('Aula "1"/2\u0007 — introdução', 'a.mov'),
    ).toBe('Aula 12 introducao.mov');
  });

  it('should not duplicate an extension already present in the title', () => {
    expect(buildDownloadFileName('clip.mp4', 'clip.mp4')).toBe('clip.mp4');
  });

  it('should fall back to "video" when nothing usable remains', () => {
    expect(buildDownloadFileName('🎬🎬', 'x.webm')).toBe('video.webm');
  });
});
