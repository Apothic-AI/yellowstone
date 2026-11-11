import { Type, type TUnsafe } from "typebox";

/**
 * TypeBox-compatible string enum.
 *
 * ## Why this exists
 *
 * Host `ToolDefinition<TParams extends TSchema>` derives the tool-call parameter
 * type as TypeBox's `Static<TParams>`, where `TSchema` is TypeBox's own. A schema
 * that is not a TypeBox schema contributes nothing to that inference, so the
 * affected property widens to `unknown` and the tool's `execute` handler can no
 * longer be typed against the literals it actually accepts.
 *
 * `@earendil-works/pi-ai`'s `StringEnum` returns `Schema<T[number]>` from
 * `@earendil-works/pi-schema` — a foreign schema type — which is exactly that
 * case against the current host. `Type.Unsafe<T>` yields TypeBox's `TUnsafe<T>`,
 * whose `Static` is `T`, so the literal union survives inference.
 *
 * ## Wire format, and the one deliberate delta
 *
 * The emitted JSON is the same document `StringEnum` builds — `{ type: "string",
 * enum: [...] }` plus `description`/`default` when given — and `Type.Unsafe`
 * adds no enumerable keys or symbols, so nothing extra reaches a provider.
 *
 * One internal marker differs, and it is recorded here rather than hidden:
 * because `StringEnum` returns a *plain* object, `Type.Optional(...)` used to
 * stamp `~optional: true` onto that property. A TypeBox-tagged schema takes the
 * symbol path instead, so that marker is no longer emitted. `~optional` is not a
 * JSON Schema keyword and no other property in these schemas ever carried it
 * (native `Type.Optional(Type.String())` does not emit it either — verified in
 * `test/api-compat.test.mjs`). The computed `required` array is identical in
 * both cases, which is what actually decides whether a provider treats the
 * parameter as optional.
 *
 * `test/api-compat.test.mjs` pins all of this: byte-equality of the enum node,
 * identical `required`, and the `~optional` delta as an explicit assertion so it
 * cannot drift unnoticed.
 */
export function stringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default ? { default: options.default } : {}),
  });
}
