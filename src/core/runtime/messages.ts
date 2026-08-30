export const NEGATIVE = "... /ᐠ - ˕ -マ";
export const POSITIVE = "!! (˵◝ ⩊  ◜˵マ";

function withoutEmotionalEnding(message: string): string {
  let base = message.trimEnd();
  let changed = true;

  while (changed) {
    changed = false;
    for (const ending of [
      NEGATIVE,
      POSITIVE,
    ]) {
      if (!base.endsWith(ending)) continue;
      base = base.slice(0, -ending.length).trimEnd();
      changed = true;
      break;
    }
  }

  return base.replace(/[.!]+$/u, "");
}

export function negativeMessage(message: string): string {
  return `${withoutEmotionalEnding(message)}${NEGATIVE}`;
}

export function positiveMessage(message: string): string {
  return `${withoutEmotionalEnding(message)}${POSITIVE}`;
}

export function formatRuntimeMessage(type: string, message: string): string {
  if (type === "success") return positiveMessage(message);
  if (type === "error" || type === "warning" || type === "warn") {
    return negativeMessage(message);
  }
  return message;
}

interface RequestErrorOptions {
  code: string;
  status?: number;
}

export class RequestError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, { code, status }: RequestErrorOptions) {
    super(negativeMessage(message));
    this.name = "RequestError";
    this.code = code;
    this.status = status;
  }
}
