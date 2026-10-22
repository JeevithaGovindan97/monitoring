import pino from 'pino';

// Secrets must never be logged: redact the usual suspects wherever they appear.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.password_hash',
      '*.passwordHash',
      '*.SMTP_PASSWORD',
      '*.token',
      '*.private_key',
    ],
    censor: '[redacted]',
  },
});
