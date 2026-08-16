export type ValidationError =
  | "INVALID_URL"
  | "INVALID_SCHEME"
  | "URL_TOO_LONG"
  | "BLOCKED_HOST"
  | "SELF_REFERENCE";

export type ValidationResult =
  | { ok: true; url: URL }
  | { ok: false; error: ValidationError };

export function validateUrl(input: string): ValidationResult {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "INVALID_URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "INVALID_SCHEME" };
  }

  return { ok: true, url };
}
