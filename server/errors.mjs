import { negativeMessage } from "../src/core/runtime/messages.ts";

export function httpError(status, code, message, details = {}) {
  return {
    status,
    body: {
      ...details,
      code,
      error: negativeMessage(message),
    },
  };
}
