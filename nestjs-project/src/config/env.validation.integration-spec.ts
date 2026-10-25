import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and videos', () => {
  it('should require S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY', () => {
    const { error } = envValidationSchema.validate(
      {
        ...requiredEnv,
        S3_ACCESS_KEY_ID: undefined,
        S3_SECRET_ACCESS_KEY: undefined,
      },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY_ID');
    expect(error!.message).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('should apply defaults for storage, queue and video limits', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value).toMatchObject({
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'streamtube',
      VIDEO_MAX_SIZE_BYTES: 10737418240,
      UPLOAD_PART_SIZE_BYTES: 67108864,
      UPLOAD_EXPIRATION_HOURS: 24,
      VIDEO_PROCESSING_ATTEMPTS: 3,
    });
  });

  it('should reject UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242879' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });
});
