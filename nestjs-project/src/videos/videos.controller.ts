import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreatedVideoResponseDto } from './dto/created-video-response.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import {
  SignedUploadPartsResponseDto,
  UploadStateResponseDto,
} from './dto/upload-parts-response.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload in object storage. ' +
      'The file bytes are then sent directly to storage through presigned part URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload opened',
    type: CreatedVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'User has no channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the maximum size',
    schema: errorSchema,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreatedVideoResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':slug/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Returns presigned URLs for the requested parts of the draft. The client PUTs each part directly to object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: SignedUploadPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed or part number out of range (INVALID_UPLOAD_PART)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video no longer accepts uploads',
    schema: errorSchema,
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignedUploadPartsResponseDto> {
    return this.videosService.signUploadParts(user.sub, slug, dto);
  }

  @Get(':slug/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get upload state',
    description:
      'Lists the parts already stored for the draft so an interrupted upload can resume.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload state',
    type: UploadStateResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video no longer accepts uploads',
    schema: errorSchema,
  })
  async getUploadState(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<UploadStateResponseDto> {
    return this.videosService.getUploadState(user.sub, slug);
  }
}
