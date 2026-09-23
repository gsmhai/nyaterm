import { useHotkeys } from "react-hotkeys-hook";
import { resolveShortcutKeys } from "@/hooks/useShortcutMap";
import { MOD, resolveIndexedKeys } from "@/lib/shortcutRegistry";

export { MOD };

const REMOTE_DESKTOP_INPUT_ROOT_SELECTOR =
  '[data-remote-desktop-input-root="true"], [data-rdp-input-root="true"]';

function isElement(value: EventTarget | null): value is Element {
  return value instanceof Element;
}

function isInsideRemoteDesktopInputRoot(event: KeyboardEvent) {
  if (
    event
      .composedPath()
      .some((target) => isElement(target) && target.matches(REMOTE_DESKTOP_INPUT_ROOT_SELECTOR))
  ) {
    return true;
  }
  return (
    isElement(event.target) && event.target.closest(REMOTE_DESKTOP_INPUT_ROOT_SELECTOR) !== null
  );
}

const HOTKEY_OPTIONS = {
  enableOnFormTags: true,
  preventDefault: true,
  ignoreEventWhen: isInsideRemoteDesktopInputRoot,
} as const;

const LOCAL_VIEW_HOTKEY_OPTIONS = {
  enableOnFormTags: true,
  preventDefault: true,
} as const;

export interface ShortcutCallbacks {
  onNewSession: () => void;
  onTemporarySshLink: () => void;
  onOpenSessionSwitcher: () => void;
  onNewLocalTerminal: () => void;
  onCloseTab: () => void;
  onDuplicateSession: () => void;
  onMultiplexSsh: () => void;
  onDuplicateSessionWithCommand: () => void;
  onMultiplexSshWithCommand: () => void;
  onNextTab: () => void;
  onPrevTab: () => void;
  onSwitchTab: (index: number) => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  onTogglePaneFocus: () => void;
  onToggleNativeFullscreen: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onOpenSettings: () => void;
  onOpenChat: () => void;
  onShowAllCommands: () => void;
  onLockScreen: () => void;
  onManageSyncGroups: () => void;
  onClearTerminal: () => void;
  onToggleRecording: () => void;
}

export function useGlobalShortcuts(
  cb: ShortcutCallbacks,
  keybindings: Record<string, string> = {},
) {
  const k = (id: string) => resolveShortcutKeys(id, keybindings);

  useHotkeys(k("tab.newSession"), cb.onNewSession, HOTKEY_OPTIONS);
  useHotkeys(k("tab.temporarySshLink"), cb.onTemporarySshLink, HOTKEY_OPTIONS);
  useHotkeys(k("tab.quickSwitch"), cb.onOpenSessionSwitcher, HOTKEY_OPTIONS);
  useHotkeys(k("tab.newLocalTerminal"), cb.onNewLocalTerminal, HOTKEY_OPTIONS);
  useHotkeys(k("tab.close"), cb.onCloseTab, HOTKEY_OPTIONS);
  useHotkeys(k("tab.duplicateSession"), cb.onDuplicateSession, HOTKEY_OPTIONS);
  useHotkeys(k("tab.multiplexSsh"), cb.onMultiplexSsh, HOTKEY_OPTIONS);
  useHotkeys(
    k("tab.duplicateSessionWithCommand"),
    cb.onDuplicateSessionWithCommand,
    HOTKEY_OPTIONS,
  );
  useHotkeys(k("tab.multiplexSshWithCommand"), cb.onMultiplexSshWithCommand, HOTKEY_OPTIONS);
  useHotkeys(k("tab.next"), cb.onNextTab, HOTKEY_OPTIONS);
  useHotkeys(k("tab.prev"), cb.onPrevTab, HOTKEY_OPTIONS);

  const switchTabKeys = k("tab.switchTo");
  useHotkeys(resolveIndexedKeys(switchTabKeys, 1), () => cb.onSwitchTab(0), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 2), () => cb.onSwitchTab(1), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 3), () => cb.onSwitchTab(2), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 4), () => cb.onSwitchTab(3), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 5), () => cb.onSwitchTab(4), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 6), () => cb.onSwitchTab(5), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 7), () => cb.onSwitchTab(6), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 8), () => cb.onSwitchTab(7), HOTKEY_OPTIONS);
  useHotkeys(resolveIndexedKeys(switchTabKeys, 9), () => cb.onSwitchTab(-1), HOTKEY_OPTIONS);

  useHotkeys(k("view.toggleLeftSidebar"), cb.onToggleLeftSidebar, HOTKEY_OPTIONS);
  useHotkeys(k("view.toggleRightSidebar"), cb.onToggleRightSidebar, HOTKEY_OPTIONS);
  useHotkeys(k("view.togglePaneFocus"), cb.onTogglePaneFocus, LOCAL_VIEW_HOTKEY_OPTIONS);
  useHotkeys(
    k("view.toggleNativeFullscreen"),
    cb.onToggleNativeFullscreen,
    LOCAL_VIEW_HOTKEY_OPTIONS,
  );
  useHotkeys(k("view.zoomIn"), cb.onZoomIn, HOTKEY_OPTIONS);
  useHotkeys(k("view.zoomOut"), cb.onZoomOut, HOTKEY_OPTIONS);
  useHotkeys(k("view.resetZoom"), cb.onResetZoom, HOTKEY_OPTIONS);
  useHotkeys(k("view.openSettings"), cb.onOpenSettings, HOTKEY_OPTIONS);
  useHotkeys(k("view.openChat"), cb.onOpenChat, HOTKEY_OPTIONS);
  useHotkeys(k("view.showAllCommands"), cb.onShowAllCommands, HOTKEY_OPTIONS);

  useHotkeys(k("terminal.manageSyncGroups"), cb.onManageSyncGroups, HOTKEY_OPTIONS);
  useHotkeys(k("terminal.clear"), cb.onClearTerminal, HOTKEY_OPTIONS);
  useHotkeys(k("terminal.recording.toggle"), cb.onToggleRecording, HOTKEY_OPTIONS);

  useHotkeys(k("special.lockScreen"), cb.onLockScreen, HOTKEY_OPTIONS);
}
