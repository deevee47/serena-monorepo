"""converse_response_stream must use the shared pooled OpenAI client rather
than constructing a fresh AsyncOpenAI on every turn."""

from types import SimpleNamespace

import pytest

from app.services import llm as llm_mod


def _chunk(content=None, finish_reason=None):
    delta = SimpleNamespace(content=content, tool_calls=None)
    choice = SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice])


class _FakeStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        async def gen():
            for c in self._chunks:
                yield c

        return gen()


class _FakeCompletions:
    def __init__(self, chunks):
        self._chunks = chunks
        self.create_calls = 0

    async def create(self, **kwargs):
        self.create_calls += 1
        return _FakeStream(self._chunks)


class _FakeClient:
    def __init__(self, chunks):
        self.chat = SimpleNamespace(completions=_FakeCompletions(chunks))


@pytest.mark.asyncio
async def test_converse_stream_uses_pooled_client(monkeypatch):
    fake = _FakeClient(
        [_chunk(content="Hey "), _chunk(content="there"), _chunk(finish_reason="stop")]
    )
    # raising=True (default): fails loudly if llm.py never wires the pooled client.
    monkeypatch.setattr(llm_mod, "get_openai_client", lambda: fake)

    deltas = []
    async for event in llm_mod.converse_response_stream(
        "system prompt",
        [{"role": "user", "content": "hi"}],
        [],
        "call-1",
    ):
        if event["type"] == "text":
            deltas.append(event["delta"])

    assert "".join(deltas) == "Hey there"
    # Exactly one completion request, against the pooled client we injected.
    assert fake.chat.completions.create_calls == 1
