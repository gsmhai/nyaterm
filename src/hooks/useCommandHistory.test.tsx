import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  applyTerminalInputData,
  canSuggestFromTracker,
  createTerminalInputState,
  resyncFromTerminalLine,
} from "@/lib/terminalInputTracker";
import { useCommandHistory } from "./useCommandHistory";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock("@/lib/invoke", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/backend/api", () => ({
  listen: async (event: string, handler: () => void) => {
    mocks.listeners.set(event, handler);
    return () => {
      mocks.listeners.delete(event);
    };
  },
}));

const alwaysAllowed = () => true;
const neverAllowed = () => false;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listeners.clear();
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "fuzzy_search_commands"
      ? [
          {
            command: "ls -la",
            display: "List files",
            indices: [],
            score: 10,
            source: "quickCommand",
          },
        ]
      : [],
  );
});

it("keeps command suggestion searches available on desktop", async () => {
  const inputStateRef = {
    current: { ...createTerminalInputState(), value: "ls", cursor: 2 },
  };
  const { result } = renderHook(() =>
    useCommandHistory({ current: null }, inputStateRef, vi.fn(), () => true, true, 1, 100),
  );
  act(() => result.current.triggerSearch({ manual: true }));
  await waitFor(() => expect(result.current.showSuggestions).toBe(true));
  expect(mocks.invoke).toHaveBeenCalledWith("fuzzy_search_history", {
    pattern: "ls",
    limit: 8,
    minCommandLength: 1,
    maxCommandLength: 100,
  });
  expect(mocks.invoke).toHaveBeenCalledWith("fuzzy_search_commands", {
    pattern: "ls",
    limit: 8,
  });
  expect(result.current.suggestions[0].command).toBe("ls -la");
});

it.each([
  ["Down to an empty prompt", ["\x1b[B"], "$ ", "s", "s"],
  ["Up then Down", ["\x1b[A", "\x1b[B"], "$ ", "s", "s"],
  ["Tab at an empty prompt", ["\t"], "$ ", "s", "s"],
  ["Tab with preserved command spaces", ["\t"], "$ s  s   s", "!", "s  s   s!"],
])(
  "searches both providers with only recovered input after %s",
  async (_label, keys, shellLine, nextKey, expectedPattern) => {
    const inputStateRef = { current: createTerminalInputState() };
    const { result } = renderHook(() =>
      useCommandHistory(
        { current: null },
        inputStateRef,
        vi.fn(),
        () => canSuggestFromTracker(inputStateRef.current),
        true,
        1,
        100,
      ),
    );

    act(() => {
      for (const key of keys) {
        inputStateRef.current = applyTerminalInputData(inputStateRef.current, key);
      }
      // This provider test starts after the terminal has confirmed history echo.
      const recovered = resyncFromTerminalLine(inputStateRef.current, shellLine, true);
      expect(recovered).not.toBeNull();
      inputStateRef.current = applyTerminalInputData(recovered!, nextKey);
      result.current.triggerSearch();
    });

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "fuzzy_search_history",
        expect.objectContaining({ pattern: expectedPattern }),
      ),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("fuzzy_search_commands", {
      pattern: expectedPattern,
      limit: 8,
    });
    await waitFor(() => expect(result.current.showSuggestions).toBe(true));
  },
);

it("refreshes on global history events while the pane may show suggestions", async () => {
  const inputStateRef = {
    current: { ...createTerminalInputState(), value: "g", cursor: 1 },
  };
  renderHook(() =>
    useCommandHistory({ current: null }, inputStateRef, vi.fn(), alwaysAllowed, true, 1, 100),
  );

  await waitFor(() => expect(mocks.listeners.has("command-history-changed")).toBe(true));
  // Wait out the mount-time search, then assert the event itself triggers one.
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  mocks.invoke.mockClear();

  act(() => mocks.listeners.get("command-history-changed")?.());

  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "fuzzy_search_history",
      expect.objectContaining({ pattern: "g" }),
    ),
  );
});

it("ignores global history events for an unfocused split pane", async () => {
  const inputStateRef = {
    current: { ...createTerminalInputState(), value: "g", cursor: 1 },
  };
  const { result } = renderHook(() =>
    // XTerminal returns false from canShowCommandSuggestions when the pane is
    // not active, so global events must not revive its stale input buffer.
    useCommandHistory(
      { current: null },
      inputStateRef,
      vi.fn(),
      neverAllowed,
      true,
      1,
      100,
    ),
  );

  await waitFor(() => expect(mocks.listeners.has("command-history-changed")).toBe(true));

  act(() => {
    mocks.listeners.get("command-history-changed")?.();
    mocks.listeners.get("quick-commands-changed")?.();
  });

  // Longer than the 80ms debounce of any wrongly scheduled search.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(result.current.showSuggestions).toBe(false);
});
