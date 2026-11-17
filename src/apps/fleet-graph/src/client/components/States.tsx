import { For, type JSX } from "solid-js";

export function LoadingState(props: { label?: string }): JSX.Element {
  return (
    <div class="loading-state" data-testid="loading">
      <div class="loading-bars">
        <For each={[0, 1, 2, 3]}>{() => <span class="loading-bar" />}</For>
      </div>
      <p>{props.label ?? "Reading herdr, behold, bd and pi-rooms…"}</p>
      <p class="muted">The first read walks every lane's session; later polls reuse a cache.</p>
    </div>
  );
}

export function ErrorState(props: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div class="error-state">
      <p>API unreachable: {props.message}</p>
      <button onClick={props.onRetry}>Retry</button>
    </div>
  );
}
