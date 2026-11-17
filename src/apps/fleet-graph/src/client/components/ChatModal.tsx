/** Read-only operator <-> lane DM history, plus room posts shared by both. */

import { For, Show, createResource, createSignal, type JSX } from "solid-js";
import type { LaneRecord, RoomsResponse } from "../../shared/types.ts";
import { relativeTime } from "../../shared/format.ts";
import { IconClose, IconCopy } from "../icons.tsx";

async function fetchMessages(lane: string): Promise<RoomsResponse> {
  const res = await fetch("/api/lane/" + encodeURIComponent(lane) + "/messages");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.json()) as RoomsResponse;
}

export function ChatModal(props: { lane: LaneRecord; onClose: () => void }): JSX.Element {
  const [data] = createResource(() => props.lane.name, fetchMessages);
  const [copied, setCopied] = createSignal(false);
  const sendHint = () => 'rooms_dm({ to: "' + props.lane.name + '", text: "…" })';
  return (
    <div class="modal-backdrop" onClick={props.onClose} role="presentation">
      <section class="modal chat-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={"DM history with " + props.lane.name}>
        <header class="modal-head">
          <div>
            <h2>{props.lane.name}</h2>
            <p class="modal-sub">
              operator ⇄ lane · read-only history ·{" "}
              <Show when={data()?.identity} fallback="rooms identity unknown">
                rooms pin <span class="mono">{data()!.identity}</span>
              </Show>
            </p>
          </div>
          <button class="icon-button" onClick={props.onClose} aria-label="Close chat">
            <IconClose />
          </button>
        </header>
        <Show when={data()?.rooms?.length}>
          <div class="room-chips">
            <For each={data()!.rooms}>{(room) => <span class="room-chip">#{room}</span>}</For>
          </div>
        </Show>
        <div class="chat-body">
          <Show when={!data.loading} fallback={<p class="empty-note">Reading the pi-rooms store…</p>}>
            <Show when={data()?.available} fallback={<p class="empty-note">pi-rooms store unavailable: {data()?.error ?? "unknown"}</p>}>
              <Show
                when={(data()?.messages?.length ?? 0) > 0}
                fallback={
                  <p class="empty-note">
                    No operator ⇄ {props.lane.name} messages found in the rooms store. This modal reads the store directly; it never
                    writes to it.
                  </p>
                }
              >
                <For each={data()!.messages}>
                  {(message) => (
                    <article class="chat-message" classList={{ mine: message.from !== "operator", other: message.from === "operator" }}>
                      <header>
                        <span class="chat-from">{message.from}</span>
                        <Show when={message.source === "room"}>
                          <span class="chat-room">#{message.room}</span>
                        </Show>
                        <span class="chat-time">{relativeTime(message.sentAt)}</span>
                      </header>
                      <p>{message.text}</p>
                    </article>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
        <footer class="modal-foot">
          <span class="readonly-note">Sending is not wired in v1 — the app is read-only.</span>
          <button
            class="copy-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(sendHint());
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                setCopied(false);
              }
            }}
          >
            <IconCopy /> {copied() ? "copied" : "copy send snippet"}
          </button>
          <code class="mono send-hint">{sendHint()}</code>
        </footer>
      </section>
    </div>
  );
}
