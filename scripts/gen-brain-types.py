#!/usr/bin/env python3
"""Generate TypeScript types from Pydantic models in fastapi-brain.

Eliminates the manual sync between fastapi-brain/app/models/{requests,responses}.py
and shared/contracts/brain-api.types.ts. Run from repo root:

    bun run gen:types       # via package.json script
    python3 scripts/gen-brain-types.py    # direct

Emits TWO files under shared/contracts/:

  - brain-api.generated.ts  — overwritten on every run. Mirrors every Pydantic
                              BaseModel + StrEnum we declare here. Never edit
                              by hand.
  - brain-api.types.ts      — left alone IF its first line says "AUTOGEN
                              KEEPS BRAIN-API.GENERATED IN SYNC". Otherwise
                              re-written to re-export from the generated file
                              plus the manually-curated SSE event union types
                              (which are TS-only — they don't exist as a
                              single Pydantic model on the brain side).

The emitter is intentionally small and self-contained. It supports the subset
of typing constructs we actually use:
   str, int, float, bool, list[X], dict[str, Any], X | None, StrEnum, BaseModel
"""

from __future__ import annotations

import dataclasses
import inspect
import sys
import textwrap
from enum import StrEnum
from pathlib import Path
from typing import Any, Union, get_args, get_origin

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "fastapi-brain"))

from pydantic import BaseModel  # noqa: E402

# Order matters — declared types are emitted top-down so earlier types can
# reference later ones without forward-decl issues in TS (TS hoists type/
# interface declarations, but ordering keeps the file readable).
from app.models import requests as req_module  # noqa: E402
from app.models import responses as resp_module  # noqa: E402

MODULES = [req_module, resp_module]

GENERATED_HEADER = """\
// AUTO-GENERATED FROM fastapi-brain/app/models/{requests,responses}.py
// Do not edit by hand — run `bun run gen:types` (or
// `python3 scripts/gen-brain-types.py`) to regenerate.

"""

# Manually-curated additions appended below the generated section. These are
# TS-only shapes (SSE event unions, helper aliases) — there is no single
# Pydantic source to mirror, but they belong in the same file because the
# gateway imports them alongside the generated interfaces.
MANUAL_SSE_BLOCK = """\

// ─── /converse SSE event union ─────────────────────────────────────────────
// Emitted by POST /converse/stream. Brain-side these are TypedDicts in
// fastapi-brain/app/services/llm.py; no Pydantic model owns the union, so
// the shape lives here as the single source of truth.

export type ToolName = 'send_whatsapp_checkout_link' | 'send_whatsapp_product_info';

export type ConverseStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; tool: string }
  | { type: 'observation'; name: string; args: Record<string, unknown>; result: Record<string, unknown> }
  | { type: 'tool_call'; name: ToolName; args: Record<string, unknown> }
  | { type: 'done'; finish_reason?: string | null };
"""


@dataclasses.dataclass
class FieldEmit:
    name: str
    ts_type: str
    optional: bool
    comment: str | None = None

    def render(self) -> str:
        opt = "?" if self.optional else ""
        line = f"  {self.name}{opt}: {self.ts_type};"
        if self.comment:
            line = f"  /** {self.comment} */\n{line}"
        return line


# ─── Type mapping ──────────────────────────────────────────────────────────


def ts_type_for(annotation: Any) -> tuple[str, bool]:
    """Map a Python type annotation to a TS type string + nullability flag.

    Returns (ts_type, is_nullable). Nullable types render as `T | null` AND
    cause the containing field to be optional (`?:`). This matches Pydantic's
    `field: T | None = None` semantics.
    """
    origin = get_origin(annotation)
    args = get_args(annotation)

    # X | None  →  (TS_for_X, nullable=True)
    if origin is Union or (origin is not None and origin.__class__.__name__ == "UnionType"):
        non_none = [a for a in args if a is not type(None)]
        has_none = len(non_none) != len(args)
        if len(non_none) == 1:
            inner, _ = ts_type_for(non_none[0])
            return (f"{inner} | null", True) if has_none else (inner, False)
        inner_ts = " | ".join(ts_type_for(a)[0] for a in non_none)
        return (f"{inner_ts} | null", True) if has_none else (inner_ts, False)

    if annotation is str:
        return ("string", False)
    if annotation is int or annotation is float:
        return ("number", False)
    if annotation is bool:
        return ("boolean", False)
    if annotation is Any:
        return ("unknown", False)
    if annotation is type(None):
        return ("null", True)

    # list[X], dict[str, X]
    if origin is list:
        inner, _ = ts_type_for(args[0]) if args else ("unknown", False)
        return (f"{inner}[]", False)
    if origin is dict:
        if len(args) == 2:
            _, value_ts = ts_type_for(args[1])
            return (f"Record<string, {ts_type_for(args[1])[0]}>", False)
        return ("Record<string, unknown>", False)

    # Literal["A", "B"] → 'A' | 'B'
    if origin is not None and origin.__class__.__name__ == "_LiteralGenericAlias".__class__.__name__:
        # Defensive fallback — typing.Literal origin handling varies
        return (" | ".join(f"'{a}'" for a in args), False)
    # The common path for typing.Literal
    if str(origin).startswith("typing.Literal") or repr(annotation).startswith("typing.Literal"):
        return (" | ".join(f"'{a}'" for a in args), False)

    # StrEnum subclass → reference by name
    if inspect.isclass(annotation) and issubclass(annotation, StrEnum):
        return (annotation.__name__, False)

    # BaseModel subclass → reference by name
    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
        return (annotation.__name__, False)

    # Anything else falls back to `unknown` rather than blowing up the build.
    return ("unknown", False)


# ─── Emitters ──────────────────────────────────────────────────────────────


def emit_enum(cls: type[StrEnum]) -> str:
    body = "\n".join(f"  {m.name} = '{m.value}'," for m in cls)
    return f"export enum {cls.__name__} {{\n{body}\n}}"


def emit_model(cls: type[BaseModel]) -> str:
    fields: list[FieldEmit] = []
    for name, info in cls.model_fields.items():
        ts_type, nullable = ts_type_for(info.annotation)
        # A field is optional in TS when it has a default OR is nullable.
        has_default = info.default is not None or info.default_factory is not None or info.is_required() is False
        optional = nullable or not info.is_required()
        # Pull a short docstring from the field's description, if any.
        comment = info.description.strip() if info.description else None
        fields.append(FieldEmit(name=name, ts_type=ts_type, optional=optional, comment=comment))

    body = "\n".join(f.render() for f in fields)
    doc = ""
    if cls.__doc__:
        clean = textwrap.dedent(cls.__doc__).strip().splitlines()
        doc = "\n".join(f"// {line}" for line in clean) + "\n"
    return f"{doc}export interface {cls.__name__} {{\n{body}\n}}"


def collect_targets() -> tuple[list[type[StrEnum]], list[type[BaseModel]]]:
    enums: list[type[StrEnum]] = []
    models: list[type[BaseModel]] = []
    seen: set[str] = set()
    for mod in MODULES:
        for name in dir(mod):
            obj = getattr(mod, name)
            if not inspect.isclass(obj):
                continue
            if obj.__module__ != mod.__name__:
                continue  # ignore re-exports
            if name in seen:
                continue
            seen.add(name)
            if issubclass(obj, StrEnum) and obj is not StrEnum:
                enums.append(obj)
            elif issubclass(obj, BaseModel) and obj is not BaseModel:
                models.append(obj)
    return enums, models


def main() -> int:
    enums, models = collect_targets()

    chunks: list[str] = [GENERATED_HEADER.rstrip()]
    for enum_cls in enums:
        chunks.append(emit_enum(enum_cls))
    for model_cls in models:
        chunks.append(emit_model(model_cls))

    generated = "\n\n".join(chunks).rstrip() + "\n"
    generated_path = REPO_ROOT / "shared" / "contracts" / "brain-api.generated.ts"
    generated_path.write_text(generated)

    # The hand-curated types file re-exports everything from the generated
    # file plus the SSE event union (which is TS-only). Only rewrite it if
    # it's already operating in re-export mode — otherwise leave it alone so
    # a developer can keep tweaking it during a refactor.
    types_path = REPO_ROOT / "shared" / "contracts" / "brain-api.types.ts"
    current = types_path.read_text() if types_path.exists() else ""
    sentinel = "AUTOGEN KEEPS BRAIN-API.GENERATED IN SYNC"
    if sentinel in current or not types_path.exists():
        wrapper = (
            f"// {sentinel}.\n"
            "// Hand-edit at your own peril — `bun run gen:types` will overwrite.\n"
            "// Add manually-curated TS-only shapes below the re-export block.\n\n"
            "export * from './brain-api.generated';\n"
            f"{MANUAL_SSE_BLOCK}"
        )
        types_path.write_text(wrapper)
        print(f"wrote {generated_path.relative_to(REPO_ROOT)} + re-export shell")
    else:
        print(
            f"wrote {generated_path.relative_to(REPO_ROOT)}; "
            f"left {types_path.relative_to(REPO_ROOT)} alone "
            f"(no sentinel — see comment block at top of this script to opt in)"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
