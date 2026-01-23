import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';

export const hashPassword = async (password: string) => {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(password, salt);
};

export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export const generateToken = () => nanoid(32);

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
