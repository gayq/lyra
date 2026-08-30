export interface StreamDiagnostic {
  at: number;
  stage: string;
  details: Record<string, boolean | number | string | null>;
}

const MAX_DIAGNOSTICS = 100;
const SENSITIVE_KEY = /authorization|cookie|header|token|url/i;

export function recordStreamDiagnostic(
  stage: string,
  details: Record<string, boolean | number | string | null | undefined> = {},
): void {
  const safeDetails: StreamDiagnostic["details"] = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    safeDetails[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : value;
  }

  const entry: StreamDiagnostic = {
    at: Math.round(performance.now()),
    stage,
    details: safeDetails,
  };
  const diagnostics = (window.__lyraStreamDiagnostics ||= []);
  diagnostics.push(entry);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
  window.dispatchEvent(
    new CustomEvent<StreamDiagnostic>("lyra:stream-diagnostic", {
      detail: entry,
    }),
  );
}
