import { listen, type UnlistenFn } from "@/lib/backend/api";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CredentialPromptKind,
  compilePromptRegex,
  extractCredentialPromptText,
  findMatchingCredentials,
  findPasswordOnlyFallbackCredentials,
  findUsernameFallbackCredentials,
  getCredentialPromptPattern,
  isDefaultPasswordPrompt,
  isDefaultUsernamePrompt,
  stripTerminalControlSequences,
} from "@/lib/credentialAutofill";
import { invoke } from "@/lib/invoke";
import { sendSessionInput } from "@/lib/sessionInput";
import type { SuggestionCursorPosition } from "@/lib/terminalSuggestionPosition";
import type { SavedCredential } from "@/types/global";

interface XTermCoreWithRenderDimensions {
  _core?: {
    _renderService?: {
      dimensions?: {
        css: {
          cell: {
            height: number;
            width: number;
          };
        };
      };
    };
  };
}

export interface CredentialPanelState {
  kind: CredentialPromptKind;
  matches: SavedCredential[];
  promptText: string;
}

/** Live OneKeys preferences mirrored from app settings. */
export interface OneKeyAutofillOptions {
  /** Master switch: detect prompts at all. */
  enabled: boolean;
  /** Send the value immediately when exactly one account matches. */
  autoFill: boolean;
}

const DEFAULT_ONE_KEY_OPTIONS: OneKeyAutofillOptions = {
  enabled: true,
  autoFill: false,
};

function extractCurrentPromptLine(promptText: string) {
  return promptText.trim();
}

function credentialPatternMatches(
  credential: SavedCredential,
  kind: CredentialPromptKind,
  output: string,
) {
  const pattern = getCredentialPromptPattern(credential, kind);
  if (!pattern) return false;
  const regex = compilePromptRegex(pattern);
  return Boolean(regex?.test(output));
}

export function useCredentialAutofill(
  terminalRef: React.RefObject<Terminal | null>,
  sessionIdRef: React.RefObject<string>,
  activeRef: React.RefObject<boolean>,
  visibleRef: React.RefObject<boolean>,
  performanceModeRef: React.RefObject<string>,
  canDetectPrompt?: () => boolean,
  oneKeysOptionsRef?: React.RefObject<OneKeyAutofillOptions | null>,
) {
  const [panelState, setPanelState] = useState<CredentialPanelState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState<SuggestionCursorPosition>({
    top: 0,
    left: 0,
  });

  const panelStateRef = useRef<CredentialPanelState | null>(null);
  const selectedIndexRef = useRef(-1);
  const showPanelRef = useRef(false);
  const matchesRef = useRef<SavedCredential[]>([]);

  const credentialsRef = useRef<SavedCredential[]>([]);
  const credentialsLoadedRef = useRef(false);
  const loadInFlightRef = useRef<Promise<void> | null>(null);
  const reloadAfterInFlightRef = useRef(false);
  const detectionInFlightRef = useRef(false);
  const detectionPendingRef = useRef(false);
  const outputBufferRef = useRef("");
  const recentPromptsRef = useRef<Map<string, number>>(new Map());
  const pendingCredentialRef = useRef<{
    credentialId: string;
    expiresAt: number;
  } | null>(null);
  const sendingRef = useRef(false);
  const detectPromptRef = useRef<((snapshot: string) => Promise<void>) | null>(null);
  const feedOutputRef = useRef<((payload: string) => void) | null>(null);
  const handleSelectRef = useRef<((credential: SavedCredential) => Promise<void>) | null>(null);

  const loadCredentials = useCallback(async (force = false) => {
    if (credentialsLoadedRef.current && !force) return;

    if (loadInFlightRef.current) {
      if (force) reloadAfterInFlightRef.current = true;
      await loadInFlightRef.current;
      if (force && reloadAfterInFlightRef.current) {
        await loadCredentials(true);
      }
      return;
    }

    reloadAfterInFlightRef.current = false;
    const promise = invoke<SavedCredential[]>("get_saved_credentials")
      .then((creds) => {
        credentialsRef.current = creds;
        credentialsLoadedRef.current = true;
      })
      .catch(() => {
        credentialsRef.current = [];
        credentialsLoadedRef.current = true;
      })
      .finally(() => {
        loadInFlightRef.current = null;
      });

    loadInFlightRef.current = promise;
    await promise;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void loadCredentials();
    void listen<void>("credentials-changed", () => {
      if (!cancelled) void loadCredentials(true);
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadCredentials]);

  const getCursorViewportPosition = useCallback((): SuggestionCursorPosition => {
    try {
      const terminal = terminalRef.current;
      if (!terminal) return { top: 0, left: 0 };
      const core = (terminal as Terminal & XTermCoreWithRenderDimensions)._core;
      const dims = core?._renderService?.dimensions;
      if (!dims) return { top: 0, left: 0 };

      const cellHeight = dims.css.cell.height;
      const cellWidth = dims.css.cell.width;
      const cursorY = terminal.buffer.active.cursorY;
      const cursorX = terminal.buffer.active.cursorX;

      const screenEl = terminal.element?.querySelector(".xterm-screen");
      if (!screenEl) return { top: 0, left: 0 };
      const rect = screenEl.getBoundingClientRect();

      return {
        top: rect.top + (cursorY + 1) * cellHeight,
        left: rect.left + cursorX * cellWidth,
        lineTop: rect.top + cursorY * cellHeight,
      };
    } catch {
      return { top: 0, left: 0 };
    }
  }, [terminalRef]);

  const dismiss = useCallback(() => {
    if (!showPanelRef.current && matchesRef.current.length === 0 && selectedIndexRef.current === -1)
      return;
    showPanelRef.current = false;
    matchesRef.current = [];
    selectedIndexRef.current = -1;
    panelStateRef.current = null;
    detectionPendingRef.current = false;
    outputBufferRef.current = "";
    recentPromptsRef.current.clear();
    setPanelState(null);
    setSelectedIndex(-1);
  }, []);

  const sendCredentialValue = useCallback(
    async (credential: SavedCredential, kind: CredentialPromptKind) => {
      const session = sessionIdRef.current;
      if (kind === "username") {
        await sendSessionInput(session, `${credential.username}\r`, {
          preview: null,
          registerSubmission: null,
          origin: "credential_autofill",
          sensitivity: "secret",
        });
        return;
      }

      const password = await invoke<string | null>("get_saved_credential_password", {
        id: credential.id,
      });
      if (!password) return;
      await sendSessionInput(session, `${password}\r`, {
        preview: null,
        registerSubmission: null,
        origin: "credential_autofill",
        sensitivity: "secret",
      });
    },
    [sessionIdRef],
  );

  const showPanel = useCallback(
    (kind: CredentialPromptKind, matches: SavedCredential[], promptText: string) => {
      const state: CredentialPanelState = { kind, matches, promptText };
      panelStateRef.current = state;
      matchesRef.current = matches;
      showPanelRef.current = true;
      selectedIndexRef.current = 0;
      setPanelState(state);
      setSelectedIndex(0);
      setCursorPosition(getCursorViewportPosition());
    },
    [getCursorViewportPosition],
  );

  /**
   * Send one credential and reset detection state. Shared by the interactive
   * picker and the OneKeys auto-fill path so both behave identically (notably
   * the "username now, password next" hand-off).
   */
  const applyCredentialFill = useCallback(
    async (credential: SavedCredential, kind: CredentialPromptKind) => {
      if (sendingRef.current) return false;
      sendingRef.current = true;
      try {
        await sendCredentialValue(credential, kind);
        if (kind === "username") {
          pendingCredentialRef.current = {
            credentialId: credential.id,
            expiresAt: Date.now() + 60_000,
          };
        } else {
          pendingCredentialRef.current = null;
        }
      } finally {
        sendingRef.current = false;
      }

      showPanelRef.current = false;
      matchesRef.current = [];
      selectedIndexRef.current = -1;
      panelStateRef.current = null;
      detectionPendingRef.current = false;
      setPanelState(null);
      setSelectedIndex(-1);
      recentPromptsRef.current.clear();

      if (kind === "username") {
        // Keep the buffer so a password prompt that arrived during selection
        // can still be detected. The pending prompt text suppresses only the
        // username prompt that was just filled.
        if (outputBufferRef.current) {
          void detectPromptRef.current?.(outputBufferRef.current);
        }
      } else {
        outputBufferRef.current = "";
        recentPromptsRef.current.clear();
      }
      return true;
    },
    [sendCredentialValue],
  );

  const handleSelectImpl = useCallback(
    async (credential: SavedCredential) => {
      const state = panelStateRef.current;
      if (!state) return;
      await applyCredentialFill(credential, state.kind);
    },
    [applyCredentialFill],
  );

  useEffect(() => {
    handleSelectRef.current = handleSelectImpl;
  }, [handleSelectImpl]);

  const handleSelect = useCallback(async (credential: SavedCredential) => {
    await handleSelectRef.current?.(credential);
  }, []);

  const rememberPrompt = useCallback(
    (kind: CredentialPromptKind, promptText: string, now: number): boolean => {
      for (const [key, ts] of recentPromptsRef.current) {
        if (now - ts > 30_000) recentPromptsRef.current.delete(key);
      }
      const key = `${kind}:${promptText}`;
      const last = recentPromptsRef.current.get(key);
      if (last && now - last < 30_000) return false;
      recentPromptsRef.current.set(key, now);
      return true;
    },
    [],
  );

  const detectPrompt = useCallback(
    async (snapshot: string) => {
      if (detectionInFlightRef.current) {
        detectionPendingRef.current = true;
        return;
      }
      if (!activeRef.current || !visibleRef.current || panelStateRef.current) return;

      detectionInFlightRef.current = true;
      try {
        await loadCredentials();
        if (!activeRef.current || !visibleRef.current || panelStateRef.current) return;

        const credentials = credentialsRef.current;
        if (credentials.length === 0) return;

        const now = Date.now();
        const promptText = extractCredentialPromptText(snapshot);
        if (!promptText) return;

        const currentLine = extractCurrentPromptLine(promptText);
        const pending = pendingCredentialRef.current;
        if (pending && pending.expiresAt <= now) {
          pendingCredentialRef.current = null;
        }

        const activePending = pendingCredentialRef.current;
        if (activePending) {
          const pendingCred = credentials.find(
            (credential) => credential.id === activePending.credentialId,
          );

          if (
            pendingCred &&
            (credentialPatternMatches(pendingCred, "password", currentLine) ||
              credentialPatternMatches(pendingCred, "password", promptText))
          ) {
            pendingCredentialRef.current = null;
            outputBufferRef.current = "";
            recentPromptsRef.current.clear();
            await sendCredentialValue(pendingCred, "password");
            return;
          }

          if (isDefaultPasswordPrompt(currentLine)) {
            pendingCredentialRef.current = null;
          } else {
            return;
          }
        }

        const options = oneKeysOptionsRef?.current ?? DEFAULT_ONE_KEY_OPTIONS;
        const canAutoFill = (credential: SavedCredential, kind: CredentialPromptKind) =>
          kind === "username"
            ? credential.username.trim().length > 0
            : Boolean(credential.has_password);

        const offerMatches = async (
          kind: CredentialPromptKind,
          matches: SavedCredential[],
        ): Promise<boolean> => {
          if (matches.length === 0) return false;
          if (!rememberPrompt(kind, promptText, now)) return true;

          // Only auto-send when the answer is unambiguous. With several accounts
          // the picker stays up so we never type the wrong credentials.
          if (options.autoFill && matches.length === 1 && canAutoFill(matches[0], kind)) {
            await applyCredentialFill(matches[0], kind);
          } else {
            showPanel(kind, matches, promptText);
          }
          return true;
        };

        const passwordMatches = findMatchingCredentials(credentials, "password", promptText);
        if (await offerMatches("password", passwordMatches)) return;

        if (isDefaultPasswordPrompt(promptText)) {
          const fallbackMatches = findPasswordOnlyFallbackCredentials(credentials);
          if (await offerMatches("password", fallbackMatches)) return;
        }

        let usernameMatches = findMatchingCredentials(credentials, "username", promptText);
        // Built-in fallback: `Username for 'https://…':`, `login:` etc. must
        // still surface OneKeys accounts even without a custom Expect regex.
        if (usernameMatches.length === 0 && isDefaultUsernamePrompt(promptText)) {
          usernameMatches = findUsernameFallbackCredentials(credentials);
        }
        await offerMatches("username", usernameMatches);
      } finally {
        detectionInFlightRef.current = false;
        if (detectionPendingRef.current) {
          detectionPendingRef.current = false;
          void detectPromptRef.current?.(outputBufferRef.current);
        }
      }
    },
    [
      activeRef,
      visibleRef,
      loadCredentials,
      rememberPrompt,
      sendCredentialValue,
      showPanel,
      applyCredentialFill,
      oneKeysOptionsRef,
    ],
  );

  useEffect(() => {
    detectPromptRef.current = detectPrompt;
  }, [detectPrompt]);

  const feedOutputImpl = useCallback(
    (payload: string) => {
      if (performanceModeRef.current !== "normal") return;
      if ((oneKeysOptionsRef?.current ?? DEFAULT_ONE_KEY_OPTIONS).enabled === false) {
        outputBufferRef.current = "";
        recentPromptsRef.current.clear();
        return;
      }
      if (!activeRef.current || !visibleRef.current) return;
      if (canDetectPrompt && !canDetectPrompt()) {
        outputBufferRef.current = "";
        recentPromptsRef.current.clear();
        detectionPendingRef.current = false;
        return;
      }

      const visible = stripTerminalControlSequences(payload);
      if (!visible) return;
      outputBufferRef.current = `${outputBufferRef.current}${visible}`.slice(-4096);

      if (panelStateRef.current || sendingRef.current) return;
      void detectPrompt(outputBufferRef.current);
    },
    [activeRef, visibleRef, performanceModeRef, canDetectPrompt, detectPrompt, oneKeysOptionsRef],
  );

  useEffect(() => {
    feedOutputRef.current = feedOutputImpl;
  }, [feedOutputImpl]);

  const feedOutput = useCallback((payload: string) => {
    feedOutputRef.current?.(payload);
  }, []);

  const reset = useCallback(() => {
    showPanelRef.current = false;
    matchesRef.current = [];
    selectedIndexRef.current = -1;
    panelStateRef.current = null;
    outputBufferRef.current = "";
    pendingCredentialRef.current = null;
    detectionInFlightRef.current = false;
    detectionPendingRef.current = false;
    recentPromptsRef.current.clear();
    sendingRef.current = false;
    setPanelState(null);
    setSelectedIndex(-1);
  }, []);

  return {
    panelState,
    selectedIndex,
    setSelectedIndex,
    cursorPosition,
    showPanelRef,
    matchesRef,
    selectedIndexRef,
    feedOutput,
    handleSelect,
    dismiss,
    reset,
  };
}
