export type ValidationError =
  | "INVALID_URL"
  | "INVALID_SCHEME"
  | "URL_TOO_LONG"
  | "BLOCKED_HOST"
  | "SELF_REFERENCE";

export type ValidationResult =
  | { ok: true; url: URL }
  | { ok: false; error: ValidationError };

export function validateUrl(input: string, serviceHost: string): ValidationResult {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "INVALID_URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "INVALID_SCHEME" };
  }

  if (input.length > 2048) {
    return { ok: false, error: "URL_TOO_LONG" };
  }

  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1"
  ) {
    return { ok: false, error: "BLOCKED_HOST" };
  }

  if (url.hostname === serviceHost) {
    return { ok: false, error: "SELF_REFERENCE" };
  }

  return { ok: true, url };
}
