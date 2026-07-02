import * as fs from 'node:fs';

const SENSITIVE_KEY_RE = /(api[-_]?key|token|secret|password|private[-_]?key|authorization)/i;

let verboseMode = false;
let debugMode = false;
let logFilePath: string | undefined;

function isEnabled(): boolean {
  return verboseMode || debugMode || process.env.JUSTLEND_VERBOSE === '1' || process.env.JUSTLEND_DEBUG === '1';
}

export function configureDiagnostics(opts: { verbose?: boolean; debug?: boolean; logFile?: string }): void {
  verboseMode = Boolean(opts.verbose);
  debugMode = Boolean(opts.debug);
  logFilePath = opts.logFile || process.env.JUSTLEND_LOG_FILE || undefined;
}

export function isDebugMode(): boolean {
  return debugMode || process.env.JUSTLEND_DEBUG === '1';
}

export function redactValue(key: string, value: unknown): unknown {
  if (value == null) return value;
  if (SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.replace(/(TRON-PRO-API-KEY|Authorization)(['"\s:=]+)([^'"\s,}]+)/gi, '$1$2[REDACTED]');
  }
  return value;
}

export function redactObject<T>(input: T): T {
  if (Array.isArray(input)) return input.map(item => redactObject(item)) as T;
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = typeof value === 'object' && value !== null ? redactObject(value) : redactValue(key, value);
    }
    return out as T;
  }
  return input;
}

export function debugLog(event: string, meta: Record<string, unknown> = {}): void {
  if (!isEnabled()) return;
  const payload = redactObject({ ts: new Date().toISOString(), event, ...meta });
  const line = `[justlend:${event}] ${JSON.stringify(payload)}\n`;
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line);
      return;
    } catch {
      // Fall through to stderr if file logging fails.
    }
  }
  process.stderr.write(line);
}
