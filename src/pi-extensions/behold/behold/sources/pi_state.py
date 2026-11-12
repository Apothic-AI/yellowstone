"""pi-side state: per-instance profile provenance, models, mode digests, TODOs, settings.

The distinctions this module exists to keep separate (binding correction #3):

* **declared** — ``PI_PROFILE`` from the lane process's environment. It is the
  *process-start* value and therefore **can be stale** after ``/profile`` was used in the
  running lane.
* **selected** — the per-instance saved launch-plan/profile state
  (``instances/<instance>/pi-profile.json`` ``{profile, source}``), which is what the lane
  is actually running under.
* **resolved** — the saved resolution of that plan (skill paths, tool references).
* **last observed global** — ``pi-profile-state.json.activeProfile`` is one global file for
  the machine, not a lane field. It is rendered in a separate ``global`` section so nobody
  reads it as "this lane's profile".

Mode drift uses the *extension's own* digest function (``modeDefinitionFingerprint`` +
``projectApprovalDigest`` from ``src/pi-extensions/pi-modes``), replicated byte-for-byte.
behold does not invent a digest: if a recorded fingerprint lacks the path or scope needed to
recompute it, the answer is ``unverifiable`` with the reason, not a guess.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any

from .. import guard


def instance_from_agent_dir(agent_dir: str | None, instances_dir: str | None) -> str | None:
    """The lane's instance, from the **verified process's** own ``PI_CODING_AGENT_DIR``.

    Not from the session path: a session can be opened with any ``--session-dir``, so path
    containment is not ownership. Only the environment of a process whose pid triple and
    reporter/pil witnesses agree is consulted, and only this one key is read.
    """
    if not agent_dir or not instances_dir:
        return None
    real_agent = os.path.realpath(agent_dir)
    real_instances = os.path.realpath(instances_dir)
    if not real_agent.startswith(real_instances + os.sep):
        return None
    rest = real_agent[len(real_instances) + 1 :]
    parts = [p for p in rest.split(os.sep) if p]
    # Exactly one component: `instances/launch-A` is an instance,
    # `instances/launch-A/not-agent-dir` is not (V2 accepted the nested form).
    if len(parts) != 1:
        return None
    return parts[0]


# --- profile -----------------------------------------------------------------------

def profile_state(
    instance_dir: str | None,
    profiles_dir: str | None,
    policy: guard.Policy,
) -> dict[str, Any]:
    """Selected + resolved profile with provenance. No environment, no global file."""
    out: dict[str, Any] = {
        "instance": os.path.basename(instance_dir) if instance_dir else None,
        "selected": None,
        "selected_source": None,
        "resolved": None,
        "catalog": None,
        "path": None,
        "error": None,
    }
    if not instance_dir:
        out["error"] = "instance_unknown"
        return out
    path = os.path.join(instance_dir, "pi-profile.json")
    out["path"] = path
    if not os.path.exists(path):
        out["error"] = "no_saved_profile_for_instance"
        return out
    try:
        raw = guard.read_json(path, policy, "pi-profile")
    except (OSError, ValueError) as exc:
        out["error"] = f"profile_unreadable:{exc.__class__.__name__}"
        return out
    if not isinstance(raw, dict):
        out["error"] = "profile_not_an_object"
        return out
    name = raw.get("profile") if isinstance(raw.get("profile"), str) else None
    out["selected"] = name
    out["selected_source"] = raw.get("source") if isinstance(raw.get("source"), str) else None
    resolved = raw.get("resolved") if isinstance(raw.get("resolved"), dict) else {}
    skills = resolved.get("skills") if isinstance(resolved.get("skills"), list) else []
    resolved_skills = []
    for item in skills:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            resolved_skills.append(
                {"name": item["name"], "path": item.get("filePath") if isinstance(item.get("filePath"), str) else None}
            )
    tools = raw.get("tools") if isinstance(raw.get("tools"), list) else []
    tool_refs = raw.get("toolReferences") if isinstance(raw.get("toolReferences"), list) else []
    out["resolved"] = {
        "skills": resolved_skills,
        "skill_count": len(resolved_skills),
        "tools": [t for t in tools if isinstance(t, str)],
        "tool_references": [t for t in tool_refs if isinstance(t, str)],
        "agent_dir": raw.get("agentDir") if isinstance(raw.get("agentDir"), str) else None,
    }
    if name and profiles_dir:
        catalog_path = os.path.join(profiles_dir, f"{name}.json")
        if os.path.exists(catalog_path):
            try:
                catalog = guard.read_json(catalog_path, policy, "profile-catalog")
            except (OSError, ValueError):
                catalog = None
            if isinstance(catalog, dict):
                out["catalog"] = {
                    "label": catalog.get("label") if isinstance(catalog.get("label"), str) else None,
                    "defaultProvider": catalog.get("defaultProvider")
                    if isinstance(catalog.get("defaultProvider"), str)
                    else None,
                    "defaultModel": catalog.get("defaultModel")
                    if isinstance(catalog.get("defaultModel"), str)
                    else None,
                    "defaultThinkingLevel": catalog.get("defaultThinkingLevel")
                    if isinstance(catalog.get("defaultThinkingLevel"), str)
                    else None,
                    "skills": [s for s in catalog.get("skills", []) if isinstance(s, str)]
                    if isinstance(catalog.get("skills"), list)
                    else [],
                    "path": catalog_path,
                }
    return out


def global_profile_active(
    instances_dir: str | None,
    allowed_instances: list[str] | tuple[str, ...],
    policy: guard.Policy,
) -> dict[str, Any]:
    """``pi-profile-state.json`` — one global file, read from **allowed** instances only.

    V3 listed the instances root and opened every ``<instance>/pi-profile-state.json`` it
    found. That is a pre-read fan-out: an instance hosting a held lane (or an instance with
    no lane at all) was opened, and its content reached ``global.M-4`` — the SI #5 rule
    ("deny held `w2` / reserved `wE:t19` before opening process/session/state paths") and the
    prior review's V2-R1 are both about exactly this.

    V4 takes the opposite shape: the caller passes the instance names it has already
    established from **admitted + verified** lanes, and this function constructs one path per
    allowed name. It never lists the instances root, never probes a name it was not given, and
    refuses any name that could escape the directory.
    """
    out: dict[str, Any] = {
        "activeProfile": None,
        "path": None,
        "scope": "global_file",
        "copies": [],
        "state": "absent",
        "error": None,
        "allowed_instances": list(allowed_instances),
        "read_from": [],
    }
    if not instances_dir or not os.path.isdir(instances_dir):
        out["error"] = "instances_dir_unknown"
        out["state"] = "unknown"
        return out
    names: list[str] = []
    for name in allowed_instances:
        if not isinstance(name, str):
            continue
        if name in (".", "..") or os.sep in name or (os.altsep and os.altsep in name):
            out["error"] = "invalid_instance_name_rejected"
            continue
        if not guard.INSTANCE_NAME_RE.match(name):
            out["error"] = "invalid_instance_name_rejected"
            continue
        if name not in names:
            names.append(name)
    if not names:
        out["state"] = "unknown"
        out["error"] = "noaccess: no admitted+verified instance to attribute a global setting from"
        return out

    values: dict[str, str] = {}
    for name in names:
        path = os.path.join(instances_dir, name, "pi-profile-state.json")
        # A stat on an allowed instance's own path — not a directory scan and never a
        # foreign instance.
        if not os.path.exists(path):
            continue
        try:
            raw = guard.read_json(path, policy, "pi-profile-global-state")
        except (OSError, ValueError, guard.DeniedRead) as exc:
            out["error"] = f"unreadable:{exc.__class__.__name__}"
            continue
        out["read_from"].append(path)
        if isinstance(raw, dict) and isinstance(raw.get("activeProfile"), str):
            values[path] = raw["activeProfile"]
            out["copies"].append({"path": path, "activeProfile": raw["activeProfile"]})
    if not values:
        out["error"] = out["error"] or "no_global_profile_state_file"
        out["state"] = "absent"
        return out
    distinct = sorted(set(values.values()))
    out["path"] = sorted(values)[0]
    if len(distinct) > 1:
        # Only copies from *allowed* instances can conflict now.
        out["state"] = "conflict"
        out["error"] = f"global copies disagree: {distinct}"
        out["activeProfile"] = None
    else:
        out["state"] = "present"
        out["activeProfile"] = distinct[0]
    return out


# --- models -----------------------------------------------------------------------

def model_catalog(path: str | None, policy: guard.Policy) -> dict[tuple[str, str | None], dict[str, Any]]:
    """``models-store.json`` -> (provider, model id) with the context denominator."""
    catalog: dict[tuple[str, str | None], dict[str, Any]] = {}
    if not path or not os.path.exists(path):
        return catalog
    try:
        raw = guard.read_json(path, policy, "models-store")
    except (OSError, ValueError):
        return catalog
    providers = raw.get("providers") if isinstance(raw, dict) else None
    if isinstance(providers, dict):
        iterable = []
        for provider_name, entry in providers.items():
            models = entry.get("models") if isinstance(entry, dict) else None
            if isinstance(models, list):
                for model in models:
                    if isinstance(model, dict):
                        iterable.append((provider_name, model))
    elif isinstance(raw, list):
        iterable = [(None, m) for m in raw if isinstance(m, dict)]
    else:
        iterable = [
            (entry.get("provider"), model)
            for entry in (raw.get("models") or [])
            if isinstance(entry, dict)
            for model in (entry.get("models") or [])
            if isinstance(model, dict)
        ] if isinstance(raw, dict) else []
    for provider, model in iterable:
        model_id = model.get("id") if isinstance(model.get("id"), str) else None
        if not model_id:
            continue
        entry_provider = provider or (model.get("provider") if isinstance(model.get("provider"), str) else None)
        window = model.get("contextWindow")
        catalog[(str(entry_provider), model_id)] = {
            "contextWindow": window if isinstance(window, (int, float)) else None,
            "maxTokens": model.get("maxTokens") if isinstance(model.get("maxTokens"), (int, float)) else None,
            "name": model.get("name") if isinstance(model.get("name"), str) else None,
            "reasoning": model.get("reasoning") if isinstance(model.get("reasoning"), bool) else None,
            "api": model.get("api") if isinstance(model.get("api"), str) else None,
        }
    return catalog


def context_max(
    catalog: dict[tuple[str, str | None], dict[str, Any]],
    provider: str | None,
    model: str | None,
) -> tuple[float | None, str | None]:
    if not model:
        return None, "no model"
    for key in ((provider, model), (None, model)):
        entry = catalog.get(key)
        if entry and entry.get("contextWindow"):
            return float(entry["contextWindow"]), f"{key[0] or 'unknown-provider'}/{model}"
    return None, f"model {model!r} not in the model catalog"


# --- mode digest (replicated exactly from pi-modes) --------------------------------

def mode_definition_fingerprint(mode: dict[str, Any]) -> str:
    """Byte-identical to ``modeDefinitionFingerprint`` in pi-modes/src/mode-definitions.ts.

    ``JSON.stringify`` of an object literal with a fixed key order, a sorted array per
    list, then sha256 hex. Python's ``json.dumps`` with the compact separators and
    ``ensure_ascii=False`` produces the same bytes for the values that can appear here.
    """
    canonical = json.dumps(
        {
            "schemaVersion": mode["schemaVersion"],
            "key": mode["key"],
            "label": mode["label"],
            "description": mode.get("description", None),
            "promptStrategy": mode["promptStrategy"],
            "systemPrompt": mode["systemPrompt"],
            "requires": sorted(mode.get("requires") or []),
            "conflictsWith": sorted(mode.get("conflictsWith") or []),
            "before": sorted(mode.get("before") or []),
            "after": sorted(mode.get("after") or []),
            "scope": mode["scope"],
            "path": mode.get("path", None),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def project_approval_digest(fingerprint_digest: str, shadows: Any, shadow_path: Any) -> str:
    canonical = json.dumps([fingerprint_digest, shadows if shadows is not None else None, shadow_path],
                           ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


#: Set when the lane's recorded mode state cannot be re-derived by this reader.
COMPOSED_UNSUPPORTED = (
    "composed_definition_unsupported: the lane records the digest of the *composed* "
    "definition (global base + project overlay/preset), and composing it requires the "
    "pi-modes loader; hashing the standalone file would report false drift"
)


def mode_drift(
    recorded: dict[str, Any] | None,
    *,
    policy: guard.Policy,
    global_mode_dir: str | None,
    cwd: str | None,
    overlays: list[str] | None = None,
    drift_policy: str | None = None,
) -> dict[str, Any]:
    """Recompute the recorded digest for the recorded path, honestly.

    ``recorded`` is the ``fingerprints`` map from ``pi-mode-state.v3``. A definition is
    only re-checkable when its path exists and its scope can be established from that path;
    otherwise the answer is ``unverifiable`` with a reason.
    """
    out: dict[str, Any] = {"state": "unknown", "reason": None, "details": []}
    if not recorded:
        out["reason"] = "no_recorded_fingerprint"
        return out
    # A composed definition (any overlay, or a non-standalone scope) cannot be re-checked by
    # hashing files: the accepted digest covers the composed result. Report that honestly
    # instead of comparing against the wrong object.
    if overlays:
        out["state"] = "unverifiable"
        out["reason"] = COMPOSED_UNSUPPORTED
        out["composed_overlays"] = list(overlays)
        return out
    results = []
    for key, fp in sorted(recorded.items()):
        path = fp.get("path")
        digest = fp.get("digest")
        scope = fp.get("scope")
        if not path or not digest:
            results.append({"key": key, "state": "unverifiable", "reason": "recorded path/digest missing"})
            continue
        if not os.path.exists(path):
            results.append({"key": key, "state": "unverifiable", "reason": "definition path missing"})
            continue
        try:
            raw = guard.read_json(path, policy, "mode-definition")
        except (OSError, ValueError) as exc:
            results.append({"key": key, "state": "unverifiable", "reason": f"unreadable:{exc.__class__.__name__}"})
            continue
        if not isinstance(raw, dict):
            results.append({"key": key, "state": "unverifiable", "reason": "definition is not an object"})
            continue
        resolved_scope = scope
        if resolved_scope == "project":
            out["state"] = "unverifiable"
            out["reason"] = COMPOSED_UNSUPPORTED
            out["details"] = [{"key": key, "state": "unverifiable", "reason": COMPOSED_UNSUPPORTED}]
            return out
        if resolved_scope is None:
            if global_mode_dir and os.path.realpath(path).startswith(os.path.realpath(global_mode_dir) + os.sep):
                resolved_scope = "global"
            elif cwd and os.path.realpath(path).startswith(os.path.realpath(cwd) + os.sep):
                resolved_scope = "project"
            else:
                results.append(
                    {"key": key, "state": "unverifiable", "reason": "definition scope not derivable"}
                )
                continue
        mode = dict(raw)
        mode.setdefault("key", key)
        mode["scope"] = resolved_scope
        mode["path"] = path
        try:
            current = mode_definition_fingerprint(
                {
                    "schemaVersion": mode.get("schemaVersion"),
                    "key": mode["key"],
                    "label": mode.get("label"),
                    "description": mode.get("description"),
                    "promptStrategy": mode.get("promptStrategy"),
                    "systemPrompt": mode.get("systemPrompt"),
                    "requires": mode.get("requires") or [],
                    "conflictsWith": mode.get("conflictsWith") or [],
                    "before": mode.get("before") or [],
                    "after": mode.get("after") or [],
                    "scope": mode["scope"],
                    "path": mode["path"],
                }
            )
        except KeyError as exc:
            results.append({"key": key, "state": "unverifiable", "reason": f"definition missing {exc.args[0]}"})
            continue
        results.append(
            {
                "key": key,
                "state": "match" if current == digest else "drift",
                "recorded": digest,
                "current": current,
                "scope": resolved_scope,
                "path": path,
            }
        )
    states = {r["state"] for r in results}
    if "drift" in states:
        out["state"] = "drift"
    elif states == {"match"}:
        out["state"] = "matched"
    elif "match" in states:
        out["state"] = "partial"
        out["reason"] = "some definitions matched, others are unverifiable"
    else:
        out["state"] = "unverifiable"
        out["reason"] = "no definition could be re-checked"
    out["details"] = results
    return out


# --- TODOs ------------------------------------------------------------------------

def todo_mirror(instance_dir: str | None, session_id: str | None, policy: guard.Policy) -> dict[str, Any]:
    """The second TODO store, keyed by session UUID. Its disagreement is rendered."""
    out: dict[str, Any] = {"found": False, "counts": None, "path": None, "total": None}
    if not instance_dir or not session_id:
        return out
    path = os.path.join(instance_dir, "pi-todo-state.json")
    out["path"] = path
    if not os.path.exists(path):
        return out
    try:
        raw = guard.read_json(path, policy, "pi-todo-state")
    except (OSError, ValueError):
        return out
    if not isinstance(raw, dict):
        return out
    entry = raw.get(session_id)
    if not isinstance(entry, dict):
        return out
    tasks = entry.get("tasks")
    counts: dict[str, int] = {}
    if isinstance(tasks, list):
        for task in tasks:
            if isinstance(task, dict) and isinstance(task.get("status"), str):
                counts[task["status"]] = counts.get(task["status"], 0) + 1
    out.update(
        {
            "found": True,
            "counts": dict(sorted(counts.items())),
            "total": len(tasks) if isinstance(tasks, list) else None,
        }
    )
    return out


# --- settings: installed packages, prompt/skill sources (paths only) ---------------

def settings_summary(agent_dir: str | None, instance_dir: str | None, policy: guard.Policy) -> dict[str, Any]:
    out: dict[str, Any] = {
        "packages": [],
        "prompt_paths": [],
        "skill_paths": [],
        "sources": [],
        "error": None,
    }
    candidates = []
    if agent_dir:
        candidates.append(os.path.join(agent_dir, "settings.json"))
    if instance_dir:
        candidates.append(os.path.join(instance_dir, "settings.json"))
    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            raw = guard.read_json(path, policy, "settings")
        except (OSError, ValueError):
            out["error"] = "settings_unreadable"
            continue
        if not isinstance(raw, dict):
            continue
        out["sources"].append(path)
        packages = raw.get("packages")
        if isinstance(packages, list):
            for entry in packages:
                if isinstance(entry, str):
                    out["packages"].append({"name": entry, "ref": None, "path": path})
                elif isinstance(entry, dict):
                    name = entry.get("name") or entry.get("source") or entry.get("path")
                    if isinstance(name, str):
                        out["packages"].append(
                            {
                                "name": name,
                                "ref": entry.get("ref") if isinstance(entry.get("ref"), str) else None,
                                "path": path,
                            }
                        )
        for key in ("prompts", "promptTemplates", "slashCommands", "commands"):
            value = raw.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        out["prompt_paths"].append(item)
                    elif isinstance(item, dict) and isinstance(item.get("path"), str):
                        out["prompt_paths"].append(item["path"])
        for key in ("skills", "skillPaths"):
            value = raw.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        out["skill_paths"].append(item)
                    elif isinstance(item, dict) and isinstance(item.get("path"), str):
                        out["skill_paths"].append(item["path"])
    out["packages"] = sorted(out["packages"], key=lambda p: (p["name"], p["path"] or ""))
    out["prompt_paths"] = sorted(set(out["prompt_paths"]))
    out["skill_paths"] = sorted(set(out["skill_paths"]))
    return out


def inferred_extensions(replay: dict[str, Any]) -> dict[str, Any]:
    """E-1 as *inferred*: what the session's own prompt/tool replay can show.

    Loaded extensions cannot be inferred exactly from tools alone — an inert extension
    registers nothing and leaves no tool — so this is labelled inferred and names its
    limitation. The exact list is a P3 runtime read (``pi.getAllTools().sourceInfo``).
    """
    skill_sources = sorted(
        {
            os.path.dirname(os.path.dirname(path))
            for path in replay.get("skills", {}).values()
            if isinstance(path, str)
        }
    )
    return {
        "tool_names": replay.get("tools", []),
        "tool_count": len(replay.get("tools", [])),
        "skill_sources": skill_sources,
        "section_names": replay.get("sections", []),
        "limitation": (
            "inferred from the session system-message replay (toolsAdded/toolsRemoved and the "
            "skills section). This cannot prove the extension inventory: an inert extension "
            "registers no tool, and a tool can be registered by code that is not an extension "
            "package. Exact attribution would need loader/registration evidence, which the "
            "tool list alone does not provide."
        ),
    }
