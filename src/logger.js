const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.padEnd(5)} [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  extra === undefined ? out(line) : out(line, extra);
}

export function createLogger(scope) {
  return {
    debug: (m, x) => emit('debug', scope, m, x),
    info: (m, x) => emit('info', scope, m, x),
    warn: (m, x) => emit('warn', scope, m, x),
    error: (m, x) => emit('error', scope, m, x),
  };
}
