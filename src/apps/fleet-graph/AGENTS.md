# fleet-graph

Read-only graph UI over fleet sources (beads, herdr, behold, pil role records, pi-rooms).

* Never add a write path here. Claiming beads, sending DMs and signalling lanes belong to their
  own tools; this app is a window.
* Keep `src/server` free of writes: readers only, and a failing source must surface as a
  labelled gap, never as a blank screen.
* `README.md` records which CLI/path each view depends on; update it with any new reader.
