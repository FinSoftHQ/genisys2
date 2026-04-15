import pino from 'pino';

export interface LoggerOptions {
  name?: string;
  level?: string;
}

export function createLogger(opts: LoggerOptions = {}) {
  const isProduction = process.env.NODE_ENV === 'production';
  return pino({
    name: opts.name,
    level: opts.level ?? (isProduction ? 'info' : 'debug'),
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    // Raw JSON to stdout; no transport so no colors in production
  });
}
