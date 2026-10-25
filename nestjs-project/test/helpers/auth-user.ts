import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthService } from '../../src/auth/auth.service';
import type { MailService } from '../../src/mail/mail.service';
import { bodyOf, type TokenPairBody } from './response-body';

const PASSWORD = 'password123';

/** Registers, confirms and logs a user in through the HTTP API. */
export async function createAuthenticatedUser(
  app: INestApplication<App>,
  email: string,
): Promise<{ accessToken: string }> {
  // Auth endpoints are rate limited; helpers must not leak 429s into tests.
  app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();

  const authService: AuthService = app.get(AuthService);
  const { mailService } = authService as unknown as {
    mailService: MailService;
  };
  let confirmationToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return { accessToken: bodyOf<TokenPairBody>(res).access_token };
}
