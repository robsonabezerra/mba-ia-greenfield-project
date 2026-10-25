export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const S3_NOT_FOUND_ERRORS = ['NotFound', 'NoSuchKey'] as const;
export const S3_LIST_PARTS_PAGE_SIZE = 1000;
