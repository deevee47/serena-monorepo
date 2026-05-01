"""Pinecone-backed objection classifier.

Tier 1 of the hybrid classifier: embeds an utterance and returns the best-matching
labeled example from the seed index. The LLM-based classifier remains as the
fallback in `classifier.py` when this returns low confidence or errors.

Voting rules (see CONVERSION_ENGINE.md, Phase B-1):
  - Strict win: top-1 cosine similarity >= classifier_top1_strict_threshold
  - Consensus win: top-3 all share the same (type, sentiment) AND
                   average similarity >= classifier_confidence_threshold
  - Otherwise: return None so the caller falls back to the LLM classifier.
"""

from collections import Counter
from typing import Any, NamedTuple

from pinecone import Pinecone

from app.config.settings import settings
from app.utils.embeddings import embed_text
from app.utils.logger import get_logger

_pc: Pinecone | None = None
_index: Any = None


def _get_index() -> Any:
    """Lazily resolve the Pinecone index — resolving at import time fails if
    the index hasn't been created yet (e.g. unit tests, fresh deploys before
    the seed script runs)."""
    global _pc, _index
    if _index is None:
        if _pc is None:
            _pc = Pinecone(api_key=settings.pinecone_api_key)
        _index = _pc.Index(settings.pinecone_objections_index_name)
    return _index


class Match(NamedTuple):
    objection_type: str
    sentiment: str
    subtype: str | None
    score: float
    utterance: str


class VoteResult(NamedTuple):
    objection_type: str
    sentiment: str
    confidence: float
    method: str  # 'strict' | 'consensus'
    subtype: str | None  # B-2: fine-grained sub-type (e.g. PRICE 'too_expensive')


async def query_objections(utterance: str, top_k: int = 5) -> list[Match]:
    vector = await embed_text(utterance)
    raw = _get_index().query(vector=vector, top_k=top_k, include_metadata=True)
    matches: list[Match] = []
    for m in raw.get("matches", []):
        meta = m.get("metadata") or {}
        if "objection_type" not in meta or "sentiment" not in meta:
            continue
        matches.append(
            Match(
                objection_type=meta["objection_type"],
                sentiment=meta["sentiment"],
                subtype=meta.get("subtype"),
                score=float(m.get("score", 0.0)),
                utterance=meta.get("utterance", ""),
            )
        )
    return matches


def vote(matches: list[Match]) -> VoteResult | None:
    if not matches:
        return None

    top = matches[0]
    if top.score >= settings.classifier_top1_strict_threshold:
        return VoteResult(top.objection_type, top.sentiment, top.score, "strict", top.subtype)

    top3 = matches[:3]
    labels = Counter((m.objection_type, m.sentiment) for m in top3)
    label, count = labels.most_common(1)[0]
    if count == len(top3):
        avg_score = sum(m.score for m in top3) / len(top3)
        if avg_score >= settings.classifier_confidence_threshold:
            subtype = _consensus_subtype(top3, fallback=top.subtype)
            return VoteResult(label[0], label[1], avg_score, "consensus", subtype)

    return None


def _consensus_subtype(matches: list[Match], fallback: str | None) -> str | None:
    """Pick the most-common subtype from `matches`. If subtypes don't agree
    (or none are present), fall back to the highest-scoring match's subtype."""
    subtypes = [m.subtype for m in matches if m.subtype]
    if not subtypes:
        return fallback
    counts = Counter(subtypes)
    top_subtype, top_count = counts.most_common(1)[0]
    # Only trust consensus if at least 2 of the 3 matches agree on the subtype.
    if top_count >= 2:
        return top_subtype
    return fallback


async def classify_via_pinecone(utterance: str, call_id: str) -> VoteResult | None:
    """Embed + query + vote. Returns None when the caller should fall back."""
    log = get_logger(call_id)
    matches = await query_objections(utterance, top_k=5)
    result = vote(matches)
    log.debug(
        "objection_pinecone_query",
        utterance=utterance[:80],
        top_matches=[(m.objection_type, m.sentiment, round(m.score, 3)) for m in matches[:3]],
        vote=result._asdict() if result else None,
    )
    return result
