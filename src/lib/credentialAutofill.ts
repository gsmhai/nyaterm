import type { SavedCredential } from "@/types/global";

export type CredentialPromptKind = "username" | "password";

const ANSI_PATTERN =
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
const OSC_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const USERNAME_PROMPT_PATTERN =
  /\b(user\s*name|username|login|login\s+as|account|user)\b|(?:\u7528\u6237\u540d|\u7528\u6237|\u8d26\u53f7|\u8d26\u6237|\u767b\u5f55\u540d)/i;
const PASSWORD_PROMPT_PATTERN =
  /\b(pass(word|phrase|code)?|pin|otp|verification\s*code|auth(entication)?\s*code|2fa|mfa)\b|(?:\u5bc6\u7801|\u53e3\u4ee4|\u9a8c\u8bc1\u7801|\u52a8\u6001\u7801|\u52a8\u6001\u53e3\u4ee4)/i;
const PROMPT_TERMINATOR_PATTERN = /[:\uff1a]\s*$/u;

export function stripTerminalControlSequences(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

export function extractCredentialPromptText(output: string): string {
  const stripped = stripTerminalControlSequences(output);
  const lastChar = stripped[stripped.length - 1];
  if (lastChar === "\r" || lastChar === "\n") return "";

  const normalized = stripped.replace(/\r/g, "\n").replace(/\n+/g, "\n");
  const lines = normalized.split("\n");
  const prompt = (lines[lines.length - 1] ?? "").trim();
  return prompt.length > 500 ? prompt.slice(-500) : prompt;
}

export function detectCredentialPromptKind(output: string): CredentialPromptKind | null {
  const prompt = extractCredentialPromptText(output);
  if (!prompt || !PROMPT_TERMINATOR_PATTERN.test(prompt)) return null;
  if (PASSWORD_PROMPT_PATTERN.test(prompt)) return "password";
  if (USERNAME_PROMPT_PATTERN.test(prompt)) return "username";
  return null;
}

export function isDefaultPasswordPrompt(output: string): boolean {
  const prompt = extractCredentialPromptText(output);
  return Boolean(
    prompt && PROMPT_TERMINATOR_PATTERN.test(prompt) && PASSWORD_PROMPT_PATTERN.test(prompt),
  );
}

/**
 * True for standard username prompts such as `login:`, `Username for 'https://…':`
 * or `用户名：`. This is the built-in counterpart of `isDefaultPasswordPrompt` and
 * lets OneKeys react even when an account has no custom Expect regex configured.
 */
export function isDefaultUsernamePrompt(output: string): boolean {
  const prompt = extractCredentialPromptText(output);
  return Boolean(
    prompt && PROMPT_TERMINATOR_PATTERN.test(prompt) && USERNAME_PROMPT_PATTERN.test(prompt),
  );
}

export function compilePromptRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "im");
  } catch {
    return null;
  }
}

export function getCredentialPromptPattern(
  credential: SavedCredential,
  kind: CredentialPromptKind,
): string {
  const custom =
    kind === "username" ? credential.username_prompt_regex : credential.password_prompt_regex;
  return custom?.trim() ?? "";
}

export function credentialMatchesPrompt(
  credential: SavedCredential,
  kind: CredentialPromptKind,
  output: string,
): boolean {
  if (!credential.enabled) return false;
  if (kind === "username" && !credential.username.trim()) return false;
  if (kind === "password" && !credential.has_password) return false;

  const pattern = getCredentialPromptPattern(credential, kind);
  if (!pattern) return false;
  const regex = compilePromptRegex(pattern);
  if (!regex) return false;
  return regex.test(output);
}

export function findMatchingCredentials(
  credentials: SavedCredential[],
  kind: CredentialPromptKind,
  output: string,
): SavedCredential[] {
  return credentials.filter((credential) => credentialMatchesPrompt(credential, kind, output));
}

export function findPasswordOnlyFallbackCredentials(
  credentials: SavedCredential[],
): SavedCredential[] {
  return credentials.filter((credential) => credential.enabled);
}

/** Accounts that can answer a username prompt without a custom Expect regex. */
export function findUsernameFallbackCredentials(credentials: SavedCredential[]): SavedCredential[] {
  return credentials.filter(
    (credential) => credential.enabled && credential.username.trim().length > 0,
  );
}

export function validatePromptRegex(pattern: string): boolean {
  const trimmed = pattern.trim();
  return Boolean(trimmed && compilePromptRegex(trimmed));
}
