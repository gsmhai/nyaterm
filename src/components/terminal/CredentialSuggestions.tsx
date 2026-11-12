import { KeyRound, Plus, UserRound } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Kbd } from "@/components/ui/kbd";
import type { CredentialPanelState } from "@/hooks/useCredentialAutofill";
import {
  getSuggestionPopupStyle,
  type SuggestionCursorPosition,
} from "@/lib/terminalSuggestionPosition";
import type { SavedCredential } from "@/types/global";

interface CredentialSuggestionsProps {
  panelState: CredentialPanelState | null;
  selectedIndex: number;
  cursorPosition: SuggestionCursorPosition;
  onSelect: (credential: SavedCredential) => void;
  onDismiss: () => void;
  onOpenOneKeys?: () => void;
}

function CredentialSuggestions({
  panelState,
  selectedIndex,
  cursorPosition,
  onSelect,
  onDismiss: _onDismiss,
  onOpenOneKeys,
}: CredentialSuggestionsProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: "nearest" });
    }
  });

  if (!panelState || panelState.matches.length === 0) return null;

  const { kind, matches } = panelState;
  const Icon = kind === "password" ? KeyRound : UserRound;

  const popupWidth = 340;
  const popupStyle = getSuggestionPopupStyle(cursorPosition, popupWidth);

  return (
    <div
      className="fixed z-[9999] w-[340px] overflow-y-auto rounded-lg border backdrop-blur-sm shadow-2xl terminal-scroll"
      ref={listRef}
      style={{
        ...popupStyle,
        backgroundColor: "color-mix(in srgb, var(--df-bg-panel) 95%, transparent)",
        borderColor: "var(--df-border)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        className="px-2 py-1.5 text-[0.625rem] uppercase tracking-wider border-b flex items-center gap-1.5"
        style={{ color: "var(--df-text-dimmed)", borderColor: "var(--df-border)" }}
      >
        <Icon className="h-3 w-3" />
        <span>
          {kind === "password"
            ? t("credentialAutofill.passwordTitle")
            : t("credentialAutofill.usernameTitle")}
        </span>
        <span className="ml-auto" style={{ color: "var(--df-text-dimmed)" }}>
          {matches.length}
        </span>
      </div>

      {matches.map((credential, index) => (
        <div
          key={credential.id}
          ref={index === selectedIndex ? selectedRef : null}
          className={`px-3 py-1.5 cursor-pointer flex items-center gap-2.5 transition-colors border-l-2 ${
            index === selectedIndex ? "" : "border-transparent"
          } ${index !== selectedIndex ? "df-hover" : ""}`}
          style={{
            backgroundColor:
              index === selectedIndex
                ? "color-mix(in srgb, var(--df-primary) 20%, transparent)"
                : undefined,
            borderLeftColor: index === selectedIndex ? "var(--df-primary)" : "transparent",
          }}
          onClick={() => onSelect(credential)}
        >
          <Icon
            className="h-3.5 w-3.5 shrink-0"
            style={{
              color: index === selectedIndex ? "var(--df-accent)" : "var(--df-text-dimmed)",
            }}
          />
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-[0.75rem] font-medium"
              style={{ color: "var(--df-text)" }}
            >
              {credential.name}
            </span>
            <span
              className="block truncate text-[0.625rem]"
              style={{ color: "var(--df-text-dimmed)" }}
            >
              {credential.username}
            </span>
          </span>
        </div>
      ))}

      {onOpenOneKeys ? (
        <button
          type="button"
          className="df-hover flex w-full items-center gap-1.5 border-t px-3 py-1.5 text-left text-[0.6875rem]"
          style={{ borderColor: "var(--df-border)", color: "var(--df-text-muted)" }}
          onClick={onOpenOneKeys}
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1 truncate">{t("oneKeys.saveTo")}</span>
          <span aria-hidden="true">+</span>
        </button>
      ) : null}

      <div
        className="px-2 py-1 border-t flex items-center gap-3 text-[0.625rem]"
        style={{ borderColor: "var(--df-border)", color: "var(--df-text-dimmed)" }}
      >
        <span>
          <Kbd
            className="px-1 py-0.5 rounded text-[0.5625rem]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            ↑↓ Tab
          </Kbd>{" "}
          {t("credentialAutofill.select")}
        </span>
        <span>
          <Kbd
            className="px-1 py-0.5 rounded text-[0.5625rem]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            Enter
          </Kbd>{" "}
          {t("credentialAutofill.fill")}
        </span>
        <span>
          <Kbd
            className="px-1 py-0.5 rounded text-[0.5625rem]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            Esc
          </Kbd>{" "}
          {t("credentialAutofill.dismiss")}
        </span>
      </div>
    </div>
  );
}

export default memo(CredentialSuggestions);
