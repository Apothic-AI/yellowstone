/**
 * FT-20 — runtime regression for the tool-registration API compatibility fix.
 *
 * The fix replaces `@earendil-works/pi-ai`'s `StringEnum` with a TypeBox-native
 * `stringEnum` in two tools, because the host derives tool-call parameter types
 * with TypeBox's `Static` and a pi-schema `Schema<…>` widens the property to
 * `unknown`.
 *
 * A type-level fix must not change what reaches the provider. These tests pin
 * that: for every realistic argument shape, the emitted JSON is byte-identical
 * to the SDK helper's, and `enum` still constrains the accepted values.
 *
 * No provider, no network, no store, no agent process.
 *
 * Run:  node --test test/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { stringEnum } from "../dist/src/tools/schema-compat.js";

/* ------------------------------------------------------------------ */
/* 1. Wire compatibility with the helper it replaced                   */
/* ------------------------------------------------------------------ */

test("emitted JSON is identical to the SDK StringEnum for a plain enum", () => {
  const values = ["memory", "user", "failure", "project"];
  const ours = stringEnum(values);
  const theirs = StringEnum(values);
  assert.equal(JSON.stringify(ours), JSON.stringify(theirs));
  assert.deepEqual(JSON.parse(JSON.stringify(ours)), { type: "string", enum: values });
});

test("emitted JSON is identical when a description is given", () => {
  const values = ["user", "assistant"];
  const options = { description: "Filter by message role (optional)." };
  assert.equal(
    JSON.stringify(stringEnum(values, options)),
    JSON.stringify(StringEnum(values, options)),
  );
});

test("emitted JSON is identical when a default is given", () => {
  const values = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"];
  const options = { description: "Filter by memory category.", default: "insight" };
  assert.equal(
    JSON.stringify(stringEnum(values, options)),
    JSON.stringify(StringEnum(values, options)),
  );
});

test("no extra keys or symbols leak into the schema object", () => {
  const ours = stringEnum(["memory", "user"]);
  assert.deepEqual(Object.keys(ours).sort(), ["enum", "type"]);
  assert.deepEqual(Object.getOwnPropertySymbols(ours), []);
});

test("inside Type.Object the enum node is identical and `required` is unchanged", () => {
  // The shape both tools actually use: an optional enum inside an object.
  const mine = Type.Object({
    query: Type.String(),
    target: Type.Optional(stringEnum(["memory", "user", "failure", "project"])),
  });
  const reference = Type.Object({
    query: Type.String(),
    target: Type.Optional(StringEnum(["memory", "user", "failure", "project"])),
  });

  // What decides optionality for a provider: identical.
  assert.deepEqual(mine.required, reference.required);
  assert.deepEqual(JSON.parse(JSON.stringify(mine)).required, ["query"]);

  // The enum node itself: identical once TypeBox-internal `~` keys are removed.
  const stripInternal = (node) => Object.fromEntries(
    Object.entries(node).filter(([key]) => !key.startsWith("~")),
  );
  assert.deepEqual(
    stripInternal(mine.properties.target),
    stripInternal(reference.properties.target),
  );
  assert.deepEqual(
    stripInternal(mine.properties.target),
    { type: "string", enum: ["memory", "user", "failure", "project"] },
  );
});

test("the only document delta is the internal ~optional marker, and it is deliberate", () => {
  // Recorded on purpose. `StringEnum` returns a plain object, so Type.Optional
  // stamped `~optional: true` on it; a TypeBox-tagged schema takes the symbol
  // path and does not. `~optional` is not a JSON Schema keyword and nothing else
  // in these schemas emits it — see the next test, which is what makes this a
  // consistency fix rather than a behavioural one.
  const mine = Type.Object({ target: Type.Optional(stringEnum(["a", "b"])) });
  const reference = Type.Object({ target: Type.Optional(StringEnum(["a", "b"])) });
  assert.equal(JSON.parse(JSON.stringify(mine)).properties.target["~optional"], undefined);
  assert.equal(JSON.parse(JSON.stringify(reference)).properties.target["~optional"], true);
  assert.deepEqual(mine.required, reference.required);
});

test("native TypeBox optionals never emit ~optional either, so the fix matches the norm", () => {
  const native = Type.Object({ q: Type.String(), p: Type.Optional(Type.String()) });
  const doc = JSON.parse(JSON.stringify(native));
  assert.equal(doc.properties.p["~optional"], undefined);
  assert.deepEqual(doc.required, ["q"]);
});

test("the object wrapper still marks the enum as optional, not required", () => {
  const schema = JSON.parse(JSON.stringify(Type.Object({
    role: Type.Optional(stringEnum(["user", "assistant"])),
  })));
  assert.deepEqual(schema.required ?? [], []);
  assert.equal(schema.properties.role.type, "string");
});

/* ------------------------------------------------------------------ */
/* 2. The enum still constrains values                                 */
/* ------------------------------------------------------------------ */

test("enum values are preserved in order, without duplication", () => {
  const values = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"];
  const schema = stringEnum(values);
  assert.deepEqual(schema.enum, values);
  assert.equal(new Set(schema.enum).size, values.length);
});

test("a single-value enum is emitted as a one-element enum, not a const", () => {
  // Providers that reject anyOf/const are the reason StringEnum exists; a
  // one-element `enum` must stay an enum.
  const schema = stringEnum(["user"]);
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), { type: "string", enum: ["user"] });
});

/* ------------------------------------------------------------------ */
/* 3. Type-level expectations, restated at runtime where cheap         */
/* ------------------------------------------------------------------ */

test("the helper is runtime-identical even though it is typed more precisely", () => {
  // `stringEnum` returns TUnsafe<T[number]> (TypeBox) instead of pi-schema
  // Schema<T>. Both are plain objects at runtime — this guards against a future
  // version of either helper making the schema a class or a proxy.
  const ours = stringEnum(["memory", "user"]);
  const proto = Object.getPrototypeOf(ours);
  assert.equal(proto, Object.prototype, "not a plain object");
  assert.equal(typeof ours, "object");
});
