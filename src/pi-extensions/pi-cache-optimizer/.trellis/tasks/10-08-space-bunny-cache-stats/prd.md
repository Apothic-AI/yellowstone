# Add cache stats for OpenCode Zen Space Bunny

## Problem

Pi reports cache usage for OpenCode Zen's `space-bunny-free` model, but the cache optimizer has no matching model-family adapter. The extension therefore omits its cache stats and can leave the previous model's footer visible.

## Goal

Recognize OpenCode Zen Space Bunny using its model id/name and display truthful cache usage under a Space Bunny-specific label.

## Requirements

1. Add a `Space Bunny cache` entry to the existing OpenAI-shaped model-family table, keyed by the `space-bunny` id/name token.
2. Continue using the existing OpenAI-compatible usage normalization path for Pi-normalized and supported raw usage fields.
3. Test model-id matching, assistant-message `model`/`name` matching, and the generic-provider non-match case.
4. Update the authoritative adapter/footer-stats spec with the new token and label.
5. Adapter selection must remain based only on model id/name and assistant message `model`/`name`. Provider id, API type, base URL, and compatibility metadata must not select the adapter.
6. Unknown or missing cache usage remains zero/under-reported; do not synthesize cache hits.

## Acceptance criteria

- `space-bunny-free` selects `Space Bunny cache` through both the active-model and assistant-message paths.
- The same model token matches independently of provider/API metadata, while an unrelated model remains unmatched even when its provider is `opencode` and API is `openai-completions`.
- Space Bunny cache usage normalizes through the existing OpenAI-shaped adapter and updates its own provider/model stats bucket.
- `npm run typecheck`, `npm test`, `npm run check:diff`, and `npm run check:pack` pass.
