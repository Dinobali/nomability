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

export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 12 characters and include uppercase, lowercase, number, and symbol.';

export const isStrongPassword = (password: string) => {
  if (password.length < 12) return false;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  return hasUpper && hasLower && hasNumber && hasSymbol;
};
