import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { nanoid } from 'nanoid';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { r2Client } from './r2.js';

export type UploadedFile = {
  key: string;
  bucket: string;
  sizeBytes?: number;
};

const localBase = env.LOCAL_STORAGE_PATH || path.join(process.cwd(), 'storage');

const buildLocalPath = (key: string) => {
  const resolved = path.resolve(localBase, key);
  if (!resolved.startsWith(path.resolve(localBase))) {
    throw new Error('Invalid storage key');
  }
  return resolved;
};

const uploadToR2 = async (stream: Readable, filename: string, contentType: string): Promise<UploadedFile> => {
  if (!env.R2_ENABLED || !r2Client) {
    throw new Error('R2 is not enabled');
  }
  if (!env.R2_PRIVATE_BUCKET) {
    throw new Error('R2_PRIVATE_BUCKET is not set');
  }
  const safeName = filename.replace(/\s+/g, '_');
  const key = `uploads/${nanoid(12)}-${safeName}`;

  const upload = new Upload({
    client: r2Client,
    params: {
      Bucket: env.R2_PRIVATE_BUCKET,
      Key: key,
      Body: stream,
      ContentType: contentType
    }
  });

  await upload.done();

  return {
    key,
    bucket: env.R2_PRIVATE_BUCKET
  };
};

const saveToLocal = async (stream: Readable, filename: string): Promise<UploadedFile> => {
  const safeName = filename.replace(/\s+/g, '_');
  const key = `uploads/${nanoid(12)}-${safeName}`;
  const targetPath = buildLocalPath(key);
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline(stream, fs.createWriteStream(targetPath));
  return { key, bucket: 'local' };
};

export const saveFile = async (stream: Readable, filename: string, contentType: string): Promise<UploadedFile> => {
  if (env.R2_ENABLED) {
    return uploadToR2(stream, filename, contentType);
  }
  return saveToLocal(stream, filename);
};

export const getObjectStream = async (bucket: string, key: string): Promise<Readable> => {
  if (bucket === 'local' || !env.R2_ENABLED) {
    const targetPath = buildLocalPath(key);
    return fs.createReadStream(targetPath);
  }
  if (!r2Client) {
    throw new Error('R2 client is not configured');
  }
  const response = await r2Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  if (!response.Body) {
    throw new Error('R2 object not found');
  }

  return response.Body as Readable;
};
