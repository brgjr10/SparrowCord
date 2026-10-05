const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = Object.keys(LEVELS);
let threshold = LEVELS.info;

function levelName() {
  return LEVEL_NAMES.find((name) => LEVELS[name] === threshold) ?? 'info';
}

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const tail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  setLevel(name) {
    if (!LEVELS[name]) {
      // A typo'd log level must not be silently accepted — the operator would
      // wonder why their debug output never appeared. (SPARROWCORD-014)
      console.warn(`unknown logLevel "${name}" — using "${levelName()}"`);
      return;
    }
    threshold = LEVELS[name];
  },
  debug: (msg, extra) => emit('debug', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  error: (msg, extra) => emit('error', msg, extra),
};