/**
 * Quick command scripts support inline directives written between square
 * brackets:
 *
 *   [DELAY 500]   pause for 500 milliseconds
 *   [CTRL+C]      send a key combination
 *   [F1]          send a named key
 *   [ENTER]       send a key
 *
 * A literal `[` is written as `\[`. Bracket groups that do not resolve to a
 * known directive (for example the shell test `[ -f file ]`) are kept verbatim
 * as plain text, so ordinary commands keep working unchanged.
 *
 * The Enter that ends a line only exists for lines without directives, and it
 * is still controlled by the execution mode. A line that contains a directive
 * never gets an implicit Enter, so scripts must ask for it explicitly with
 * `[ENTER]`.
 */

export type QuickCommandAction =
  | { kind: "text"; data: string }
  | { kind: "key"; data: string }
  | { kind: "lineEnd" }
  | { kind: "delay"; ms: number };

export interface QuickCommandScriptRunOptions {
  /** Execute mode runs plain command lines, append mode only types them. */
  execute: boolean;
  send: (data: string) => Promise<unknown> | unknown;
}

interface KeyBinding {
  /** Sequence used when no modifier has to be encoded. */
  plain: string;
  /** CSI form that can carry a modifier parameter, e.g. Ctrl+Up. */
  csi?: { param: string; final: string };
}

interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** Upper bound for a single `[DELAY n]` so a typo cannot stall a session. */
export const MAX_QUICK_COMMAND_DELAY_MS = 10 * 60 * 1000;

const MODIFIER_NAMES = new Set(["CTRL", "CONTROL", "ALT", "OPTION", "SHIFT"]);

const DELAY_DIRECTIVE = /^delay\s+(\d+)(?:\s*ms)?$/iu;

const NAMED_KEYS: Record<string, KeyBinding> = {
  ENTER: { plain: "\r" },
  RETURN: { plain: "\r" },
  TAB: { plain: "\t" },
  ESC: { plain: "\x1b" },
  ESCAPE: { plain: "\x1b" },
  SPACE: { plain: " " },
  BACKSPACE: { plain: "\x7f" },
  DELETE: { plain: "\x1b[3~", csi: { param: "3", final: "~" } },
  DEL: { plain: "\x1b[3~", csi: { param: "3", final: "~" } },
  INSERT: { plain: "\x1b[2~", csi: { param: "2", final: "~" } },
  INS: { plain: "\x1b[2~", csi: { param: "2", final: "~" } },
  UP: { plain: "\x1b[A", csi: { param: "", final: "A" } },
  DOWN: { plain: "\x1b[B", csi: { param: "", final: "B" } },
  RIGHT: { plain: "\x1b[C", csi: { param: "", final: "C" } },
  LEFT: { plain: "\x1b[D", csi: { param: "", final: "D" } },
  HOME: { plain: "\x1b[H", csi: { param: "", final: "H" } },
  END: { plain: "\x1b[F", csi: { param: "", final: "F" } },
  PAGEUP: { plain: "\x1b[5~", csi: { param: "5", final: "~" } },
  PGUP: { plain: "\x1b[5~", csi: { param: "5", final: "~" } },
  PAGEDOWN: { plain: "\x1b[6~", csi: { param: "6", final: "~" } },
  PGDN: { plain: "\x1b[6~", csi: { param: "6", final: "~" } },
  F1: { plain: "\x1bOP", csi: { param: "1", final: "P" } },
  F2: { plain: "\x1bOQ", csi: { param: "1", final: "Q" } },
  F3: { plain: "\x1bOR", csi: { param: "1", final: "R" } },
  F4: { plain: "\x1bOS", csi: { param: "1", final: "S" } },
  F5: { plain: "\x1b[15~", csi: { param: "15", final: "~" } },
  F6: { plain: "\x1b[17~", csi: { param: "17", final: "~" } },
  F7: { plain: "\x1b[18~", csi: { param: "18", final: "~" } },
  F8: { plain: "\x1b[19~", csi: { param: "19", final: "~" } },
  F9: { plain: "\x1b[20~", csi: { param: "20", final: "~" } },
  F10: { plain: "\x1b[21~", csi: { param: "21", final: "~" } },
  F11: { plain: "\x1b[23~", csi: { param: "23", final: "~" } },
  F12: { plain: "\x1b[24~", csi: { param: "24", final: "~" } },
};

type ScriptToken =
  | { kind: "literal"; text: string }
  | { kind: "action"; action: QuickCommandAction };

function encodeModifiers(binding: KeyBinding, modifiers: KeyModifiers): string {
  const modifierCode =
    1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  if (modifierCode === 1) {
    return binding.plain;
  }
  if (binding.csi) {
    const { param, final } = binding.csi;
    const encodedParam = param.length > 0 ? `${param};${modifierCode}` : `1;${modifierCode}`;
    return `\x1b[${encodedParam}${final}`;
  }
  return modifiers.alt ? `\x1b${binding.plain}` : binding.plain;
}

function controlCharacterFor(character: string): string | null {
  const code = character.toUpperCase().charCodeAt(0);
  if (code < 0x20 || code > 0x7e) {
    return null;
  }
  if (code === 0x20 || code === 0x40) {
    return "\x00";
  }
  if (code === 0x3f) {
    return "\x7f";
  }
  return String.fromCharCode(code & 0x1f);
}

function encodeCharacter(character: string, modifiers: KeyModifiers): string | null {
  let data = character;
  if (modifiers.ctrl) {
    const control = controlCharacterFor(character);
    if (control === null) {
      return null;
    }
    data = control;
  } else if (modifiers.shift) {
    data = character.toUpperCase();
  }
  return modifiers.alt ? `\x1b${data}` : data;
}

function resolveKey(key: string, modifiers: KeyModifiers): string | null {
  const name = key.toUpperCase();
  const binding = NAMED_KEYS[name];
  if (binding) {
    if (name === "TAB" && modifiers.shift) {
      return modifiers.alt ? "\x1b\x1b[Z" : "\x1b[Z";
    }
    return encodeModifiers(binding, modifiers);
  }
  if (key.length === 1) {
    return encodeCharacter(key, modifiers);
  }
  return null;
}

function resolveDirective(inner: string): QuickCommandAction | null {
  const trimmed = inner.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const delay = DELAY_DIRECTIVE.exec(trimmed);
  if (delay) {
    const ms = Number.parseInt(delay[1], 10);
    if (Number.isNaN(ms)) {
      return null;
    }
    return { kind: "delay", ms: Math.min(ms, MAX_QUICK_COMMAND_DELAY_MS) };
  }

  const parts = trimmed.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return null;
  }

  const modifiers: KeyModifiers = { ctrl: false, alt: false, shift: false };
  let keyName: string | null = null;
  for (const part of parts) {
    const upper = part.toUpperCase();
    if (MODIFIER_NAMES.has(upper)) {
      if (upper === "CTRL" || upper === "CONTROL") {
        modifiers.ctrl = true;
      } else if (upper === "ALT" || upper === "OPTION") {
        modifiers.alt = true;
      } else {
        modifiers.shift = true;
      }
      continue;
    }
    if (keyName !== null) {
      return null;
    }
    keyName = part;
  }

  if (keyName === null) {
    return null;
  }
  const data = resolveKey(keyName, modifiers);
  return data === null ? null : { kind: "key", data };
}

function tokenizeLine(line: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  let literal = "";
  let index = 0;

  while (index < line.length) {
    const character = line[index];
    if (character === "\\" && line[index + 1] === "[") {
      literal += "[";
      index += 2;
      continue;
    }
    if (character === "[") {
      const end = line.indexOf("]", index + 1);
      if (end !== -1) {
        const action = resolveDirective(line.slice(index + 1, end));
        if (action) {
          if (literal.length > 0) {
            tokens.push({ kind: "literal", text: literal });
            literal = "";
          }
          tokens.push({ kind: "action", action });
          index = end + 1;
          continue;
        }
      }
    }
    literal += character;
    index += 1;
  }

  if (literal.length > 0) {
    tokens.push({ kind: "literal", text: literal });
  }
  return tokens;
}

/**
 * Split a quick command body into the actions that have to be sent in order.
 * Lines without directives behave like a plain command line and are terminated
 * by a `lineEnd` action, which the runner resolves against the execution mode.
 */
export function parseQuickCommandScript(raw: string): QuickCommandAction[] {
  const actions: QuickCommandAction[] = [];

  for (const line of raw.split(/\r\n|\r|\n/gu)) {
    const tokens = tokenizeLine(line);
    const hasDirective = tokens.some((token) => token.kind === "action");

    if (!hasDirective) {
      const text = tokens.map((token) => (token.kind === "literal" ? token.text : "")).join("");
      if (text.trim().length === 0) {
        continue;
      }
      actions.push({ kind: "text", data: text });
      actions.push({ kind: "lineEnd" });
      continue;
    }

    for (const token of tokens) {
      if (token.kind === "literal") {
        if (token.text.length > 0) {
          actions.push({ kind: "text", data: token.text });
        }
        continue;
      }
      actions.push(token.action);
    }
  }

  return actions;
}

export function hasQuickCommandDirectives(raw: string): boolean {
  return parseQuickCommandScript(raw).some(
    (action) => action.kind === "key" || action.kind === "delay",
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Send every parsed action to the session, honouring delays and the mode. */
export async function runQuickCommandScript(
  actions: QuickCommandAction[],
  options: QuickCommandScriptRunOptions,
): Promise<void> {
  for (const action of actions) {
    if (action.kind === "delay") {
      await sleep(action.ms);
      continue;
    }
    if (action.kind === "lineEnd") {
      if (options.execute) {
        await options.send("\r");
      }
      continue;
    }
    if (action.data.length === 0) {
      continue;
    }
    await options.send(action.data);
  }
}
