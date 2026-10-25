export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'The authenticated user has no channel');
  }
}

export class VideoFileTooLargeException extends DomainException {
  constructor(maxSizeBytes: number) {
    super(
      'VIDEO_FILE_TOO_LARGE',
      413,
      `Video file exceeds the maximum size of ${maxSizeBytes} bytes`,
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'Video belongs to another channel');
  }
}

export class VideoNotUploadableException extends DomainException {
  constructor(status: string) {
    super(
      'VIDEO_NOT_UPLOADABLE',
      409,
      `Upload operations are not allowed for a video with status "${status}"`,
    );
  }
}

export class InvalidUploadPartException extends DomainException {
  constructor(partCount: number) {
    super(
      'INVALID_UPLOAD_PART',
      400,
      `Part numbers must be between 1 and ${partCount}`,
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor(missingParts: number[]) {
    super(
      'UPLOAD_INCOMPLETE',
      409,
      `Upload is missing parts: ${missingParts.join(', ')}`,
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor(expectedBytes: number, actualBytes: number) {
    super(
      'UPLOAD_SIZE_MISMATCH',
      409,
      `Uploaded ${actualBytes} bytes but ${expectedBytes} were declared`,
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}

export class ProcessingQueueUnavailableException extends DomainException {
  constructor() {
    super(
      'PROCESSING_QUEUE_UNAVAILABLE',
      503,
      'Video processing could not be scheduled; retry the upload completion',
    );
  }
}
