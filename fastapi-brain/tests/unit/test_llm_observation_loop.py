"""When the model calls multiple observation tools in one turn, the brain
should execute them concurrently rather than serially — every awaited DB
roundtrip is dead air on a live voice call."""

import asyncio
from types import SimpleNamespace

import pytest

from app.services import llm as llm_mod

# ─── Fake OpenAI streaming primitives ──────────────────────────────────────


def _tool_call_chunk(index, call_id, name, args_json="{}"):
    fn = SimpleNamespace(name=name, arguments=args_json)
    tc = SimpleNamespace(index=index, id=call_id, function=fn)
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=None)])


def _finish_chunk(reason):
    delta = SimpleNamespace(content=None, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=reason)])


def _text_chunk(text, finish=None):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=finish)])


class _FakeStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        async def gen():
            for c in self._chunks:
                yield c

        return gen()


class _FakeCompletions:
    def __init__(self, streams):
        self._streams = streams
        self._i = 0

    async def create(self, **kwargs):
        stream = self._streams[self._i]
        self._i += 1
        return _FakeStream(stream)


class _FakeClient:
    def __init__(self, streams):
        self.chat = SimpleNamespace(completions=_FakeCompletions(streams))


@pytest.mark.asyncio
async def test_observation_tools_run_concurrently(monkeypatch):
    # Pass 1: model calls two observation tools. Pass 2: it speaks.
    streams = [
        [
            _tool_call_chunk(0, "c0", "get_review_summary"),
            _tool_call_chunk(1, "c1", "get_available_offers"),
            _finish_chunk("tool_calls"),
        ],
        [_text_chunk("Here's what I found.", "stop")],
    ]
    monkeypatch.setattr(llm_mod, "get_openai_client", lambda: _FakeClient(streams))

    # Runner that records how many tool executions overlap in time.
    active = 0
    max_active = 0

    async def runner(name, args):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.05)
        active -= 1
        return {"ok": name}

    observations = []
    async for event in llm_mod.converse_response_stream(
        "system",
        [{"role": "user", "content": "is it any good and any deals?"}],
        [],
        "call-obs",
        run_observation_tool=runner,
    ):
        if event["type"] == "observation":
            observations.append(event["name"])

    # Both ran at the same time → peak concurrency 2 (serial would be 1).
    assert max_active == 2
    # Both observations surfaced, order preserved.
    assert observations == ["get_review_summary", "get_available_offers"]
