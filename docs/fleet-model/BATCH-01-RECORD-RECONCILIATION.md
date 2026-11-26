# Batch01 record reconciliation — bounded documents only

Worker `fleet-batch-records`, child in prompt. Read BATCH-01-CONCURRENT-BRIEF.md. Operator changed
cadence2026-11-10T20:39Z: up to5concurrentissues, batchboundaries notperissuecompaction. Batch01
FT18/FT20/FT19/FT26/FT47; lasttwo delegatedYellowstone. Preserve issueacceptance+realcontrols.

Exclusive authorized edits: `pi-fleet-model/FLEET-ISSUE-QUEUE.json` and
`pi-fleet-model/FLEET-ISSUE-QUEUE-REPORT.md`; NEW output under `.local/state/fleet-batch-01/records/`.
Do NOT edit source FleetTODOs, code, config, instructions, anyliveconsumer/store, Beads other than
ownchildclaim, dagr run(parentonlywriter), foreign epic, or otherdocs. No model/network/packagecalls.
Take byteexact timestamped preimages of bothfiles, then APPEND a cadence refresh preserving all
original source_file/priorrefreshes/history/mappings/resolvedevidence. Currentfields may updateonly
selected5issues to batch01active/cadence/trueedges. Do not markheadingsresolved or countoldsource
asfresh. Source canreadmetadata/headingsforcounts (not privatebody necessary), SHA/bytes/lines +
instrument explicit. No factclaimclosed on reportalone.

Everyqueueentry's old compaction_gate text is historical cadence, not active. Do not rewritehistory
silently: top-levelauthoritativecadenceobject + explicit supersededhistoricalfield annotation, and
selectedentry gate/notes updates + appendrefreshwithbefore/afterrefs so futurelanesdon'tserialize
remainingentries. Ownqueueonly noforeignrecords. FT18/20 are compatible READONLYsharedsurface,
FT19TODOSdisjoint, FT26roomsisolatedworktree vsFT47inerttagsisolated; acceptedimplementation may
requireactualcanonicalwriteconflictserialization later. No research/globalmutex. Keep allotherfields
andissueorder unchanged. Validate JSON/refintegrity/historypreservation and measuredcounts/diffscope.
Report paths/hashes/checks, STOP. OriginalauditandFT32evidence/quarantineimmutable. No operatorfile
resolutionorautomaticcleanup. Record worker may not change AGENTS ormodeprompt—the operational
operatorcadencewinsoldbriefs already, no fleetpromptrewrite needed.
