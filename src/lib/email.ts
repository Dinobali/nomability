import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT || 587,
      secure: false,
      auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
    })
  : null;

export const sendMail = async (to: string, subject: string, html: string) => {
  if (!transporter) {
    return;
  }
  await transporter.sendMail({
    from: env.FROM_EMAIL ? `${env.FROM_NAME || 'Nomability'} <${env.FROM_EMAIL}>` : undefined,
    to,
    subject,
    html
  });
};
