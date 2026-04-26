export type DebateLeftTabIconName = "status" | "participants" | "workflow" | "memory" | "file_activity";

export function InjectedPromptDialog(props: {
  dialog: null | { phaseTitle: string; round: number; prompt: string };
  onClose: () => void;
}) {
  if (!props.dialog) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 24,
        zIndex: 1000
      }}
    >
      <div
        className="panel stack"
        onClick={(event) => event.stopPropagation()}
        style={{ width: "min(980px, 100%)" }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="stack" style={{ gap: 4 }}>
            <strong>{props.dialog.phaseTitle} · 注入提示词</strong>
            <div className="muted">第 {props.dialog.round} 轮进入该阶段时自动注入到运行时 Prompt。</div>
          </div>
          <button className="btn" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="panel" style={{ whiteSpace: "pre-wrap", maxHeight: "65vh", overflowY: "auto" }}>
          {props.dialog.prompt}
        </div>
      </div>
    </div>
  );
}

export function DebateSidebarRail<TTab extends string>(props: {
  tabs: Array<{ id: TTab; label: string; icon: DebateLeftTabIconName }>;
  activeTab: TTab;
  onSelectTab: (tab: TTab) => void;
}) {
  return (
    <nav
      className="panel debateSidebarRail debateViewportPanel"
      aria-label="左侧栏"
      style={{
        padding: 6,
        overflowY: "auto"
      }}
    >
      <div className="stack" style={{ gap: 6 }}>
        {props.tabs.map((tab) => {
          const selected = props.activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className="btn leftTabButton"
              type="button"
              title={tab.label}
              aria-label={tab.label}
              aria-current={selected ? "page" : undefined}
              onClick={() => props.onSelectTab(tab.id)}
              style={{
                borderColor: selected ? "rgba(38, 99, 235, 0.55)" : undefined,
                background: selected ? "rgba(38, 99, 235, 0.08)" : undefined
              }}
            >
              <span className="leftTabIcon" aria-hidden="true">
                <LeftTabIcon name={tab.icon} />
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function LeftTabIcon({ name }: { name: DebateLeftTabIconName }) {
  const baseProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  } as const;

  if (name === "status") {
    return (
      <svg {...baseProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    );
  }
  if (name === "participants") {
    return (
      <svg {...baseProps}>
        <circle cx="9" cy="9" r="3" />
        <path d="M4.5 18c0-2.8 2.6-5 5.5-5s5.5 2.2 5.5 5" />
        <circle cx="17" cy="10" r="2.5" />
        <path d="M15.5 18c0-1.8 1.6-3.2 3.5-3.2 1.2 0 2.3.6 3 1.5" />
      </svg>
    );
  }
  if (name === "workflow") {
    return (
      <svg {...baseProps}>
        <rect x="4" y="4" width="6" height="6" rx="1.2" />
        <rect x="14" y="14" width="6" height="6" rx="1.2" />
        <path d="M10 7h4" />
        <path d="M14 7v7" />
      </svg>
    );
  }
  if (name === "file_activity") {
    return (
      <svg {...baseProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
        <path d="M8 4.5v3" />
        <path d="M16 4.5v3" />
      </svg>
    );
  }
  return (
    <svg {...baseProps}>
      <path d="M6 5h9l3 3v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M9 9h6" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}
