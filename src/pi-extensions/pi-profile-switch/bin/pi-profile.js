#!/usr/bin/env node
/**
 * Installed entry point. Node refuses type-stripping under node_modules, so
 * the shipped package loads the TypeScript launcher through jiti (the same
 * loader Pi uses for extensions). Development can run bin/pi-profile.ts
 * directly; both paths share the one TS graph.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
await jiti.import("./pi-profile.ts");
