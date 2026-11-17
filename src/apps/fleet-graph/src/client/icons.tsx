import type { JSX } from "solid-js";

const base = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

export function IconWork(props: { title?: string }): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <title>{props.title ?? "Work view"}</title>
      <rect x="3" y="4" width="7" height="7" rx="1.6" />
      <rect x="14" y="4" width="7" height="7" rx="1.6" />
      <rect x="3" y="15" width="7" height="6" rx="1.6" />
      <rect x="14" y="15" width="7" height="6" rx="1.6" />
    </svg>
  );
}

export function IconBeads(props: { title?: string }): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <title>{props.title ?? "Bead cards"}</title>
      <rect x="4" y="3" width="16" height="6" rx="1.6" />
      <rect x="4" y="12" width="16" height="6" rx="1.6" />
      <path d="M7 21h10" />
    </svg>
  );
}

export function IconChat(props: { title?: string }): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <title>{props.title ?? "Chat"}</title>
      <path d="M21 12a8.5 8.5 0 0 1-8.5 8.5H4l2.2-4.1A8.5 8.5 0 1 1 21 12Z" />
      <path d="M8.5 11h7M8.5 14.5h4" />
    </svg>
  );
}

export function IconRefresh(props: { title?: string }): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <title>{props.title ?? "Refresh"}</title>
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

export function IconClose(props: { title?: string }): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <title>{props.title ?? "Close"}</title>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconCopy(props: { title?: string }): JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <title>{props.title ?? "Copy"}</title>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}
