import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class CreateVideoDto {
  /** Original file name; its name without extension is the default title. */
  @IsString()
  @Length(1, 255)
  file_name: string;

  /** Declared file size in bytes (capped by VIDEO_MAX_SIZE_BYTES, 10 GiB). */
  @IsInt()
  @Min(1)
  file_size: number;

  /** Video MIME type, e.g. `video/mp4`. */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/, {
    message: 'content_type must be a video MIME type (video/*)',
  })
  content_type: string;

  /** Optional title; defaults to the file name without extension. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;
}
