export function videoSourceKey(videoId: string): string {
  return `videos/${videoId}/source`;
}

export function videoThumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
