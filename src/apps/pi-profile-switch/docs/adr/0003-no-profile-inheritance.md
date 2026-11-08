# No profile inheritance

## Context

Creating a variant from an existing profile is a common need. The most convenient approach is to let a profile point at a parent via `extends` and only write the differing fields.

## Decision

Profiles do not support inheritance: no `extends`, no deep merge, no array appending. A project profile with the same name completely replaces the global one. To create a variant, copy the full definition in the CRUD wizard and save it under a new name.

## Rejected alternatives

**`extends` with deep merge.** Rejected because once users depend on inheritance there is no going back; only self-contained definitions let you understand what a profile actually selects without resolving a parent chain.

## Consequences

- Variants duplicate fields with their prototypes; changes to a prototype do not propagate to its variants.
