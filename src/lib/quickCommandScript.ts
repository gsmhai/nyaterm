import { normalizeTerminalCommandInput } from "./sessionInput";

/**
 * Quick-command "script" support.
 *
 * A quick command can be a plain text command (handled elsewhere) or a small
 * script that mixes literal text with special directives written inside `[...]`:
 *
 *   [DELAY 500]            wait 500 milliseconds
 *   [CTRL+1] / [F1] / ...  send a keyboard key / key combination
 *
 * Design notes:
 * - The trailing newline that ends a directive line is NOT sent to the terminal.
 *   This is what makes `[DELAY 500]` / `[CTRL+1]` behave as actions rather than
 *   typed text that ends with an Enter.
 * - A literal `[` is written by escaping it: `\[`.
 * - Blank lines (no text) never produce a spurious Enter; use `[ENTER]` to send
 *   an explicit carriage return.
 * - Keys are translated to their standard VT/control byte sequences and written
 *   straight to the PTY through the same channel typed keys use.
 */

export type ScriptAction =
  | { type: "text"; text: string }
  | { type: "delay"; ms: number }
  | { type: "key"; sequence: string; spec: string };

const DELAY_MS_MAX = 60_000;

// Legacy xterm-style sequences — what interactive shells expect by default.
const NAMED_KEY_SEQUENCES: Record<string, string> = {
  ENTER: "\r",
  RETURN: "\r",
  CR: "\r",
  NEWLINE: "\r",
  ESC: "\x1b",
  ESCAPE: "\x1b",
  TAB: "\t",
  BACKSPACE: "\x7f",
  BS: "\x7f",
  DELETE: "\x1b[3~",
  DEL: "\x1b[3~",
  HOME: "\x1b[H",
  END: "\x1b[F",
  PAGEUP: "\x1b[5~",
  PGUP: "\x1b[5~",
  PAGEDOWN: "\x1b[6~",
  PGDN: "\x1b[6~",
  INSERT: "\x1b[2~",
  INS: "\x1b[2~",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  LEFT: "\x1b[C",
  RIGHT: "\x1b[D",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
  F13: "\x1b[25~",
  F14: "\x1b[26~",
  F15: "\x1b[28~",
  F16: "\x1b[29~",
  F17: "\x1b[31~",
  F18: "\x1b[32~",
  F19: "\x1b[33~",
  F20: "\x1b[34~",
};

/**
 * Translate a key specification such as `CTRL+1`, `F1`, `ALT+ENTER`,
 * `SHIFT+TAB` into the bytes that should be written to the terminal.
 * Returns `null` for unsupported specs (e.g. Win/Meta, or unknown names),
 * which callers treat as literal text so nothing is silently dropped.
 */
export function translateKeySpec(rawSpec: string): string | null {
  const spec = rawSpec.trim().toUpperCase();
  if (!spec) {
    return null;
  }

  const parts = spec.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const base = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const ctrl = mods.includes("CTRL") || mods.includes("CTL") || mods.includes("CONTROL");
  const alt = mods.includes("ALT") || mods.includes("OPT") || mods.includes("OPTION");
  const shift = mods.includes("SHIFT");
  const hasMeta = mods.some((mod) =>
    ["META", "WIN", "WINDOWS", "SUPER", "CMD", "GUI"].includes(mod),
  );
  if (hasMeta) {
    return null;
  }

  if (base in NAMED_KEY_SEQUENCES) {
    const sequence = NAMED_KEY_SEQUENCES[base];
    return alt ? `\x1b${sequence}` : sequence;
  }

  if (base.length === 1) {
    let char = base;
    if (shift && /[a-z]/i.test(char)) {
      char = char.toUpperCase();
    }
    let sequence: string;
    if (ctrl) {
      sequence = String.fromCharCode(char.toLowerCase().charCodeAt(0) & 0x1f);
    } else {
      sequence = char;
    }
    return alt ? `\x1b${sequence}` : sequence;
  }

  return null;
}

/**
 * Cheap guard: does the raw command contain any (unescaped) `[...]` directive?
 * Used to decide whether to route through the script executor.
 */
export function hasQuickCommandDirectives(raw: string): boolean {
  let i = 0;
  while (i < raw.length) {
    const char = raw[i];
    if (char === "\\" && raw[i + 1] === "[") {
      i += 2;
      continue;
    }
    if (char === "[") {
      if (raw.indexOf("]", i + 1) !== -1) {
        return true;
      }
    }
    i += 1;
  }
  return false;
}

/**
 * Parse a quick-command script into an ordered list of actions.
 *
 * - `\\[` becomes a literal `[`.
 * - `[DELAY n]` becomes a delay action (clamped to {@link DELAY_MS_MAX}).
 * - `[<keyspec>]` becomes a key action when the spec is recognized.
 * - An unrecognized `[...]` is preserved verbatim as literal text (brackets
 *   included) so the user never loses data.
 * - The single newline immediately following a `]` is consumed and not emitted.
 */
export function parseQuickCommandScript(raw: string): ScriptAction[] {
  const actions: ScriptAction[] = [];
  let text = "";
  let i = 0;

  const flushText = () => {
    if (text.length > 0) {
      actions.push({ type: "text", text });
      text = "";
    }
  };

  while (i < raw.length) {
    const char = raw[i];

    if (char === "\\" && raw[i + 1] === "[") {
      text += "[";
      i += 2;
      continue;
    }

    if (char === "[") {
      const close = raw.indexOf("]", i + 1);
      if (close === -1) {
        text += "[";
        i += 1;
        continue;
      }

      const inner = raw.slice(i + 1, close).trim();
      i = close + 1;
      if (raw[i] === "\n") {
        i += 1;
      } else if (raw[i] === "\r" && raw[i + 1] === "\n") {
        i += 2;
      }

      const delayMatch = inner.match(/^DELAY\s+(\d{1,9})$/u);
      if (delayMatch) {
        flushText();
        const ms = Math.min(parseInt(delayMatch[1], 10), DELAY_MS_MAX);
        actions.push({ type: "delay", ms });
        continue;
      }

      const sequence = translateKeySpec(inner);
      if (sequence !== null) {
        flushText();
        actions.push({ type: "key", sequence, spec: inner });
        continue;
      }

      text += `[${inner}]`;
      continue;
    }

    text += char;
    i += 1;
  }

  flushText();
  return actions;
}

export interface RunScriptOptions {
  /** When true, trailing Enter is appended to text segments (execute mode). */
  execute: boolean;
  /** Sink for a chunk of raw terminal bytes. */
  send: (data: string) => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Execute a parsed script sequentially. Text is normalized (newlines -> CR) and
 * sent; delays await; keys send their byte sequence. Empty/whitespace-only text
 * segments are skipped so blank lines don't emit a stray Enter.
 */
export async function runQuickCommandScript(
  actions: ScriptAction[],
  options: RunScriptOptions,
): Promise<void> {
  const { execute, send } = options;

  for (const action of actions) {
    if (action.type === "text") {
      const data = normalizeTerminalCommandInput(action.text);
      if (!data.trim()) {
        continue;
      }
      await send(execute ? `${data}\r` : data);
    } else if (action.type === "delay") {
      await delay(action.ms);
    } else if (action.type === "key") {
      await send(action.sequence);
    }
  }
}
