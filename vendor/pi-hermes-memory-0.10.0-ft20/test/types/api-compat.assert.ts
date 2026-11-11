/**
 * Compile-time regression for host tool-registration type compatibility.
 *
 * This file is part of the typecheck (`tsconfig.json` includes it). It does not
 * run; it fails the build if the tool parameter schemas ever stop inferring
 * their literal unions — which is the defect being fixed. A `Static<T>` that
 * widened to `unknown` would break the `satisfies HostToolDefinition<…>` checks
 * and the `Equals<…, false>` assertions below.
 *
 * It is written the way the host does it: the handler's parameter type is
 * `Static<typeof parameters>`, so the two must agree for the file to compile.
 * That is the property being protected, stated in the compiler's own terms
 * rather than by restating the expected type somewhere the schema cannot see it.
 *
 * If this file becomes unnecessary because upstream `StringEnum` is typed
 * against TypeBox again, delete it and the `schema-compat.ts` indirection with it.
 */

import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { stringEnum } from "../../src/tools/schema-compat.js";

/** `true` only when the two types are mutually assignable. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Compile-time assertion; `false` becomes a type error. */
type Assert<T extends true> = T;

/** A host-style definition: `TParams` must satisfy TypeBox's `TSchema`, and the
 * handler receives exactly `Static<TParams>`. */
interface HostToolDefinition<TParams extends TSchema> {
  parameters: TParams;
  execute: (id: string, params: Static<TParams>) => Promise<void>;
}

/** Mirrors the schema in `memory-search-tool.ts`. */
const memorySearchParameters = Type.Object({
  query: Type.String(),
  project: Type.Optional(Type.String()),
  target: Type.Optional(stringEnum(["memory", "user", "failure", "project"] as const)),
  category: Type.Optional(stringEnum([
    "failure", "correction", "insight", "preference", "convention", "tool-quirk",
  ] as const)),
  limit: Type.Optional(Type.Number()),
});

const memorySearch = {
  parameters: memorySearchParameters,
  execute: async (_id: string, params: Static<typeof memorySearchParameters>) => {
    // The unions must survive inference, not widen to `unknown`.
    const target: "memory" | "user" | "failure" | "project" | undefined = params.target;
    const category:
      | "failure" | "correction" | "insight" | "preference" | "convention" | "tool-quirk"
      | undefined = params.category;
    void target;
    void category;
  },
} satisfies HostToolDefinition<typeof memorySearchParameters>;

/** Mirrors the schema in `session-search-tool.ts`. */
const sessionSearchParameters = Type.Object({
  query: Type.String(),
  project: Type.Optional(Type.String()),
  role: Type.Optional(stringEnum(["user", "assistant"] as const)),
  limit: Type.Optional(Type.Number()),
});

const sessionSearch = {
  parameters: sessionSearchParameters,
  execute: async (_id: string, params: Static<typeof sessionSearchParameters>) => {
    const role: "user" | "assistant" | undefined = params.role;
    void role;
  },
} satisfies HostToolDefinition<typeof sessionSearchParameters>;

// --- The assertions -------------------------------------------------------

type MemorySearchStatic = Static<typeof memorySearchParameters>;
type SessionSearchStatic = Static<typeof sessionSearchParameters>;

// `target` is the literal union, not `unknown`.
export type MemorySearchTargetIsUnion = Assert<
  Equals<MemorySearchStatic["target"], "memory" | "user" | "failure" | "project" | undefined>
>;

// `category` is the literal union too.
export type MemorySearchCategoryIsUnion = Assert<
  Equals<
    MemorySearchStatic["category"],
    "failure" | "correction" | "insight" | "preference" | "convention" | "tool-quirk" | undefined
  >
>;

// `role` is the literal union.
export type SessionSearchRoleIsUnion = Assert<
  Equals<SessionSearchStatic["role"], "user" | "assistant" | undefined>
>;

// A widened (unknown) property would have failed the three assertions above;
// this one pins the opposite direction so a future edit cannot quietly loosen
// the handler to accept anything.
export type MemorySearchTargetIsNotUnknown = Assert<
  Equals<Equals<MemorySearchStatic["target"], unknown>, false>
>;

export const __typecheckOnly = { memorySearch, sessionSearch } as const;
