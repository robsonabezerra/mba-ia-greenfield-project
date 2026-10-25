import { ApiProperty } from '@nestjs/swagger';

export class SignedUploadPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Presigned URL to PUT this part bytes to' })
  url: string;
}

export class SignedUploadPartsResponseDto {
  @ApiProperty({ type: [SignedUploadPartDto] })
  parts: SignedUploadPartDto[];

  @ApiProperty({ format: 'date-time', description: 'When the URLs expire' })
  expires_at: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 67108864, description: 'Bytes stored for the part' })
  size: number;
}

export class UploadStateResponseDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}
