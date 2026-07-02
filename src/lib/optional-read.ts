export interface OptionalReadWarningSink {
  warnings: string[];
}

export function formatReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function optionalRead<T>(label: string, sink: OptionalReadWarningSink, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    sink.warnings.push(`${label} failed: ${formatReadError(error)}`);
    return undefined;
  }
}

export function warningFields(sink: OptionalReadWarningSink): { warnings?: string[]; partialFailure?: true } {
  return sink.warnings.length ? { warnings: sink.warnings, partialFailure: true } : {};
}
