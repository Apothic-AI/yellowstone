import type { Config } from "vike/types";
import vikeSolid from "vike-solid/config";

export default {
  title: "Fleet Graph",
  description: "Read-only flow graph of the Pi fleet: work items, lanes, beads and rooms.",
  extends: [vikeSolid],
  // The app is a browser canvas over a local, read-only API. There is nothing to
  // server-render, and keeping it client-only means no loader can run a CLI at
  // build time.
  ssr: false
} satisfies Config;
