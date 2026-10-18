// Minimal structural logger so modules accept pino without depending on it directly (spec §20).
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const noop = (): void => {};
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
