import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

async function putPart(url: string, body: Buffer): Promise<number> {
  const res = await fetch(url, { method: 'PUT', body });
  return res.status;
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  const newKey = (name: string): string => {
    const key = `test/storage/${randomUUID()}/${name}`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await module.close();
  });

  async function uploadInTwoParts(
    key: string,
  ): Promise<{ part1: Buffer; part2: Buffer }> {
    const part1 = randomBytes(FIVE_MIB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url1 = await storage.presignUploadPart(key, uploadId, 1, 300);
    const url2 = await storage.presignUploadPart(key, uploadId, 2, 300);
    expect(await putPart(url1, part1)).toBe(200);
    expect(await putPart(url2, part2)).toBe(200);
    const parts = await storage.listParts(key, uploadId);
    await storage.completeMultipartUpload(key, uploadId, parts);
    return { part1, part2 };
  }

  it('uploads an object in two presigned parts and completes it', async () => {
    const key = newKey('source');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const part1 = randomBytes(FIVE_MIB);
    const part2 = randomBytes(2048);

    expect(
      await putPart(
        await storage.presignUploadPart(key, uploadId, 1, 300),
        part1,
      ),
    ).toBe(200);
    expect(
      await putPart(
        await storage.presignUploadPart(key, uploadId, 2, 300),
        part2,
      ),
    ).toBe(200);

    const parts = await storage.listParts(key, uploadId);
    expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
      [1, FIVE_MIB],
      [2, 2048],
    ]);

    await storage.completeMultipartUpload(key, uploadId, parts);

    const head = await storage.headObject(key);
    expect(head).toEqual({
      contentLength: FIVE_MIB + 2048,
      contentType: 'video/mp4',
    });
  });

  it('serves a presigned GET with Range as 206 Partial Content', async () => {
    const key = newKey('ranged');
    const { part1, part2 } = await uploadInTwoParts(key);
    const total = part1.length + part2.length;

    const url = await storage.presignGetObject(key, {
      expiresIn: 300,
      responseContentType: 'video/mp4',
    });
    const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-99/${total}`);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(
      part1.subarray(0, 100),
    );
  });

  it('applies the signed response-content-disposition', async () => {
    const key = newKey('attachment');
    await storage.putObject(key, Buffer.from('hello'), 'video/mp4');

    const url = await storage.presignGetObject(key, {
      expiresIn: 300,
      responseContentDisposition: 'attachment; filename="x.mp4"',
    });
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="x.mp4"',
    );
  });

  it('stops accepting the UploadId after abortMultipartUpload', async () => {
    const key = newKey('aborted');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await putPart(
      await storage.presignUploadPart(key, uploadId, 1, 300),
      randomBytes(1024),
    );

    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('presigns an internal GET usable from inside the Docker network', async () => {
    const key = newKey('internal');
    await storage.putObject(key, Buffer.from('internal'), 'text/plain');

    const url = await storage.presignInternalGetObject(key, 300);
    const res = await fetch(url);

    expect(new URL(url).origin).toBe(new URL(process.env.S3_ENDPOINT!).origin);
    expect(await res.text()).toBe('internal');
  });

  it('returns null from headObject for a missing key', async () => {
    await expect(storage.headObject(newKey('missing'))).resolves.toBeNull();
  });

  it('deletes an object', async () => {
    const key = newKey('deleted');
    await storage.putObject(key, Buffer.from('bye'), 'text/plain');

    await storage.deleteObject(key);

    await expect(storage.headObject(key)).resolves.toBeNull();
  });
});
