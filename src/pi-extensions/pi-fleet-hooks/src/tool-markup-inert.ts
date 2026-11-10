// tool-markup-inert — register FT-47's display-only transformer.
//
// This is the extension entry, and it is deliberately the whole of the durable surface: one
// `registerMarkdownTransformer` call and nothing else. No `on(...)` handler of any kind, so no
// message, session, tool result or provider payload can be changed by this extension. That is a
// safety property, not a style choice — `message_end` runs before pi dispatches tools, and a
// handler that manufactured a `toolCall` block there would be executed by the agent loop.
//
// The host is typed structurally rather than importing `ExtensionAPI` from
// `@earendil-works/pi-coding-agent`. This package ships no SDK dependency (its `node_modules` is
// empty apart from tool caches), so a type-only import of the SDK fails `tsc` with TS2307 — the
// same reason `src/reasoning-recovery.ts`, which does import the SDK type, is outside the
// `typecheck` file list. Declaring the one method this entry uses keeps the entry inside the
// typecheck gate, and the shape below mirrors `MarkdownTransformContext` /
// `MarkdownTransformer` / `registerMarkdownTransformer` from the installed
// `dist/core/extensions/types.d.ts` exactly. `test/tool-markup-render.test.ts` exercises the
// contract against pi's real `AssistantMessageComponent`, so drift is caught by a failing test
// rather than by a review of this comment.

import { isRenderableMessageType, renderInertMarkdown } from "./inert-tool-markup.ts";

/** Mirrors `MarkdownTransformContext` from pi's extension types. */
export interface MarkdownTransformContext {
  messageType: "user" | "assistant" | "assistant-thinking";
  isStreaming: boolean;
  availableWidth: number;
  messageId?: string;
  timestamp?: string;
}

/** Mirrors pi's `MarkdownTransformer`. */
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

/** The only extension surface this entry uses. */
export interface MarkdownTransformerHost {
  registerMarkdownTransformer(transformer: MarkdownTransformer): void;
}

/**
 * The transformer itself, exported so it can be tested without an extension host.
 *
 * Display-only: the returned string is what pi renders. The message, the session entry and the
 * request that goes to the model are untouched.
 */
export const transformAssistantMarkdown: MarkdownTransformer = (markdown, context) => {
  if (!context || !isRenderableMessageType(context.messageType)) return markdown;
  return renderInertMarkdown(markdown);
};

export default function toolMarkupInert(pi: MarkdownTransformerHost): void {
  pi.registerMarkdownTransformer(transformAssistantMarkdown);
}
