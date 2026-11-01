#!/bin/sh
# Scale the shared build server to zero when nothing is using it.
#
# WHY THIS EXISTS, AND WHY IT IS NOT `uptime`
#
# The box bills per second while started, and the observed leak was not one long
# forgotten build -- it was that any lane starts the machine on demand and nobody
# stops it. Twenty-one recorded start invocations across sessions, with stop paths
# that depend on someone remembering. That is the thing to fix, and it has to be a
# policy the box enforces about itself rather than a script in a runbook.
#
# Load average cannot be the signal. A futex-blocked test binary -- five threads,
# zero CPU, zero sockets, waiting on a channel -- contributes the same load average
# as an idle box, and an operator stop based on `load ~ 0.00` killed a box that five
# dxdb lanes were actively using. So "idle" here is defined as the ABSENCE of work,
# measured three ways, and any single one is enough to keep the box up:
#
#   1. A builder-state lease exists.     Leases are the admission-control truth:
#                                        a running build holds one, so a leased box
#                                        is never idle regardless of CPU.
#   2. Any cargo/rustc/wasm-pack runs.   Catches builds that did not take a lease
#                                        (another project's Makefile, a hand-run
#                                        ssh command, a lane that predates the lease
#                                        protocol). Zombies never count.
#   3. CPU time advanced since the last sample.
#                                        Catches everything else -- a test binary
#                                        doing real work without a cargo process
#                                        above it. Compares cumulative
#                                        user+system jiffies, so it measures WORK
#                                        DONE, never instantaneous load.
#   4. A file under the build roots changed recently.
#                                        Catches a build BETWEEN processes -- sync,
#                                        fetch, unpack -- where nothing is running
#                                        and CPU is quiet, which is the window an
#                                        unleased project is most exposed to.
#
# Idleness must persist for IDLE_GRACE seconds before the box stops itself, so a
# brief gap between two chained builds (rsync, then compile) does not trigger a stop
# mid-tranche. The box cannot enforce that itself (no Fly credential -- see below),
# so `--status` carries the counter instead: each poll advances it while the answer
# stays `idle` and any other answer resets it, and the host stops only once it has
# reached the grace. Every sample and every decision is written to
# /data/state/idle.log so a stop can always be explained after the fact.
#
# HOW IT STOPS: the machine's own Fly metadata is the authority, not a local script.
# It starts `flyctl`-free -- the box calls the Fly machines API through its own
# machine token, which is why this needs no flyctl on the box and no operator
# credentials.
#
# USAGE
#   builder-idle            run the watchdog in the foreground (mostly for testing)
#   builder-idle --once     take one sample, report, and exit (no stop)
#   builder-idle --status    print the current verdict as JSON
#
# ENV: IDLE_GRACE (seconds of confirmed idleness before stopping, default 900),
#      IDLE_INTERVAL (sample period, default 60), BUILDER_STATE_DIR,
#      BUILD_IDLE_DISABLE=1 (keep the box up; logs why it would have stopped).

set -u

STATE_DIR=${BUILDER_STATE_DIR:-/data/state}
LOG=$STATE_DIR/idle.log
CPU_SAMPLE=$STATE_DIR/cpu-sample
IDLE_SINCE_FILE=$STATE_DIR/idle-since
PENDING_FILE=$STATE_DIR/idle-pending-since
GRACE=${IDLE_GRACE:-900}
INTERVAL=${IDLE_INTERVAL:-60}
# Threshold as a percentage of one core: 2 means "less than 2% busy is idle".
IDLE_CPU_RATE_HUNDREDTHS=${IDLE_CPU_RATE_HUNDREDTHS:-2}

mkdir -p "$STATE_DIR"

now() { date -u +%s; }
# When this boot began. Idleness cannot predate it, and a marker left over from a
# previous boot must not be inherited -- that is the one way the idle counter could
# ever stop a box too early.
boot_time() {
    up=$(awk '{ print int($1) }' /proc/uptime 2>/dev/null || echo 0)
    printf '%s\n' "$(( $(now) - up ))"
}
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(iso)" "$*" >>"$LOG"; }

# Cumulative user+system jiffies across every process. Monotonic for the life of the
# boot, so a delta is work done and a zero delta is genuinely no work.
cpu_jiffies() {
    awk '/^cpu /{s=0; for(i=2;i<=NF;i++) s+=$i; print s; exit}' /proc/stat 2>/dev/null || echo 0
}

build_processes() {
    # -x matches the exact command name, so this cannot be fooled by a shell whose
    # argv merely mentions the word (which is how a naive `pgrep -f cargo` reports
    # its own grep, or a wrapper script, as a build).
    #
    # Zombies do not count. A killed build leaves children whose command name
    # outlives them and which burn no CPU ever again, and nothing guarantees PID 1
    # here reaps them; counting those pins the verdict at `building` for the rest
    # of the boot, which is one way a genuinely idle box never scales to zero.
    # Output is `name/pid` so a `building` verdict can say WHICH process it saw.
    for name in cargo rustc wasm-pack rustdoc; do
        for pid in $(pgrep -x "$name" 2>/dev/null); do
            state=$(awk -F')' '{ print $2 }' "/proc/$pid/stat" 2>/dev/null | awk '{ print $1 }')
            [ "$state" = Z ] && continue
            printf '%s/%s\n' "$name" "$pid"
        done
    done
}

leased() {
    if command -v builder-state >/dev/null 2>&1; then
        builder-state status --json 2>/dev/null | grep -q '"leased":true'
        return $?
    fi
    # No builder-state: fail closed (treat as busy) rather than stopping a box we
    # cannot prove is unused.
    return 0
}

# A build can be BETWEEN processes -- rsyncing sources, waiting on a fetch, or
# unpacking a seed -- with no cargo running and CPU near zero. Leases cover the
# projects that take them, so this is the signal for the ones that do not.
# -print -quit makes the cost proportional to activity: it returns at the first
# recent file while a build is live, and only walks the whole tree when the box
# looks quiet. Both roots are scanned because starla builds under
# /data/projects/<slug>/builds and the older projects still use /data/builds.
recent_churn() {
    find /data/builds /data/projects -maxdepth 6 \
        -newermt "-${CHURN_WINDOW_MIN:-10} minutes" -print -quit 2>/dev/null
}

# $1 = "advance" to compare against and update the stored CPU baseline, anything
# else to observe without touching it. A read-only status matters: two lanes
# polling --status must not keep resetting the baseline, or a genuinely idle box
# would report cpu-active forever and never scale to zero.
# $1 = "advance" (the watchdog loop) or "observe" (a status poll). Both update the
# CPU baseline; that is safe because idleness is judged as a RATE, not a bare delta.
# A bare delta cannot work here: the only caller of --status is the host supervisor,
# so if observing did not update the baseline the comparison would always be against
# a stale sample and the box could never be judged idle -- which is exactly how the
# first version of this script would have failed to scale anything to zero.
verdict() {
    # A missing builder-state must not read as `leased`: fail closed either way
    # (the host stops only on `idle`), but a quote-verdict should say what is
    # actually wrong. This happened for real on 2026-10-30 -- a restart left
    # /usr/local/bin empty and the box silently dropped its admission control.
    if ! command -v builder-state >/dev/null 2>&1; then
        echo "no-lease-tool"
        return
    fi
    if leased; then
        echo "leased"
        return
    fi
    pids=$(build_processes)
    if [ -n "$pids" ]; then
        echo "building"
        return
    fi
    if [ -n "$(recent_churn)" ]; then
        echo "churning"
        return
    fi

    # Jiffies are USER_HZ (100/s) on Linux, so 100 jiffies = one CPU-second.
    prev_line=$(cat "$CPU_SAMPLE" 2>/dev/null || echo "")
    cur=$(cpu_jiffies)
    cur_ts=$(now)
    if [ -z "$prev_line" ]; then
        printf '%s %s\n' "$cur" "$cur_ts" >"$CPU_SAMPLE"
        # No baseline yet: do not claim idleness on no evidence.
        echo "warmup"
        return
    fi
    prev=$(printf '%s' "$prev_line" | awk '{print $1}')
    prev_ts=$(printf '%s' "$prev_line" | awk '{print $2}')
    printf '%s %s\n' "$cur" "$cur_ts" >"$CPU_SAMPLE"

    elapsed=$(( cur_ts - prev_ts ))
    if [ "$elapsed" -le 0 ]; then
        echo "warmup"
        return
    fi
    delta=$(( cur - prev ))
    [ "$delta" -lt 0 ] && delta=0

    # CPU-seconds burned per wall-second, in hundredths, compared against the
    # threshold. $(RATE) of one core busy is enough to count as activity: a
    # compile, a test, or a link all exceed it, while a sleeping or futex-blocked
    # process does not (which is the signal load average could not give).
    # delta jiffies / elapsed seconds = hundredths of a CPU-second per second.
    rate_hundredths=$(( delta / elapsed ))
    if [ "$rate_hundredths" -ge "$IDLE_CPU_RATE_HUNDREDTHS" ]; then
        echo "cpu-active"
        return
    fi
    echo "idle"
}

stop_machine() {
    # The Fly machines API from inside the machine: no flyctl, no operator token.
    #
    # This path is normally UNAVAILABLE by design, not by accident: the box was
    # created with `machine run` on /bin/sleep, so it carries no FLY_* environment
    # and no machine token, and planting one would put a standing credential on a
    # shared box any build could read. The host applies the stop; this function
    # exists only for a box that someone deliberately equipped.
    # FALLBACK_ORDER matters -- a stop that fails must be visible, never silent.
    for path in \
        /usr/local/bin/fly-machine-stop \
        /data/bin/fly-machine-stop
    do
        if [ -x "$path" ]; then
            "$path" && return 0
        fi
    done
    # Last resort that needs no API at all: Fly restarts an exited init, so this is
    # NOT equivalent to a stop -- it is deliberately not attempted here. Report
    # instead of pretending.
    log "no fly-machine-stop on this box (expected: the host owns the stop)"
    return 1
}

one_cycle() {
    v=$(verdict advance)
    if [ "$v" = "idle" ]; then
        pending=$(cat "$PENDING_FILE" 2>/dev/null || echo "")
        [ -n "$pending" ] || { pending=$(now); printf '%s\n' "$pending" >"$PENDING_FILE"; }
        idle_for=$(( $(now) - pending ))
        log "idle confirmed ${idle_for}s/${GRACE}s"
        if [ "$idle_for" -ge "$GRACE" ]; then
            if [ "${BUILD_IDLE_DISABLE:-0}" = "1" ]; then
                log "would stop now, but BUILD_IDLE_DISABLE=1"
                return 0
            fi
            log "idle ${idle_for}s >= ${GRACE}s; scaling to zero"
            if stop_machine; then
                log "stop issued"
                printf '%s\n' "$(now)" >"$IDLE_SINCE_FILE"
                return 0
            fi
            log "stop FAILED; will retry next cycle"
        fi
    else
        if [ -f "$PENDING_FILE" ]; then
            log "activity ($v); idle timer cleared"
            rm -f "$PENDING_FILE"
        fi
    fi
}

case "${1:-}" in
    --once)
        v=$(verdict)
        printf '{"verdict":"%s","time":"%s"}\n' "$v" "$(iso)"
        exit 0
        ;;
    --status)
        v=$(verdict)
        # A --status poll IS a sample, so it maintains the idle marker exactly as
        # the foreground loop would: set on idle, cleared by any activity. This
        # matters because the box-side loop cannot own the grace period -- the box
        # has no Fly credential by design, so the host is the only sampler. Without
        # this the grace is dead code and a single idle sample stops the box, which
        # re-opens the race that once killed five lanes: start the box, let the
        # supervisor poll before the build takes its lease, lose the build.
        if [ "$v" = "idle" ]; then
            pending=$(cat "$PENDING_FILE" 2>/dev/null || echo "")
            boot=$(boot_time)
            if [ -z "$pending" ] || [ "$pending" -lt "$boot" ]; then
                pending=$(now); printf '%s\n' "$pending" >"$PENDING_FILE"
            fi
        else
            rm -f "$PENDING_FILE"
        fi
        pending=$(cat "$PENDING_FILE" 2>/dev/null || echo "")
        if [ -n "$pending" ]; then idle_for=$(( $(now) - pending )); else idle_for=0; fi
        # `procs` names what a `building` verdict actually saw, so a stuck verdict is
        # self-explaining instead of needing another diagnostic round trip. It is
        # computed here rather than reused from verdict() because verdict() runs in
        # a command substitution, so its variables do not survive the subshell.
        procs=""
        [ "$v" = building ] && procs=$(build_processes | tr '\n' ',' | sed 's/,$//')
        printf '{"verdict":"%s","idleSeconds":%s,"grace":%s,"procs":"%s","time":"%s"}\n' \
            "$v" "$idle_for" "$GRACE" "$procs" "$(iso)"
        exit 0
        ;;
esac

log "watchdog starting (grace=${GRACE}s interval=${INTERVAL}s pid=$$)"
# Seed the CPU baseline so the first real cycle compares against something.
cpu_jiffies >"$CPU_SAMPLE"
while :; do
    one_cycle
    sleep "$INTERVAL"
done
