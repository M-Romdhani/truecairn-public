// Minimal structured logger. Replace with pino later; for now JSON-per-line
// keeps logs grep-able and avoids a dependency.

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

const MIN = LEVELS[envLevel()];

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
};
