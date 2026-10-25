import type { Response } from 'supertest';

export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

export interface TokenPairBody {
  access_token: string;
  refresh_token: string;
}

export interface RegisteredUserBody {
  id: string;
  email: string;
}

export interface CurrentUserBody {
  sub: string;
  email: string;
}

/** Narrows supertest's untyped `res.body` to the expected response contract. */
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}
