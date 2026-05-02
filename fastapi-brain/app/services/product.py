from pinecone import Pinecone

from app.config.settings import settings
from app.models.requests import ProductContext
from app.utils.embeddings import embed_text
from app.utils.logger import get_logger

_pc = Pinecone(api_key=settings.pinecone_api_key)
_index = _pc.Index(settings.pinecone_index_name)


def _metadata_to_product_context(metadata: dict) -> ProductContext:
    tags = metadata.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    return ProductContext(
        product_id=metadata["product_id"],
        name=metadata["name"],
        price=float(metadata["price"]),
        description=metadata.get("description", ""),
        key_features=tags,
    )


async def find_alternatives(
    query: str,
    exclude_id: str,
    top_k: int = 3,
) -> list[ProductContext]:
    log = get_logger()
    vector = await embed_text(query)

    results = _index.query(
        vector=vector,
        top_k=top_k,
        filter={"product_id": {"$ne": exclude_id}},
        include_metadata=True,
    )  # type: ignore[union-attr]

    matches = results.get("matches", [])
    log.debug("pinecone_alternatives", query=query[:80], exclude_id=exclude_id, count=len(matches))

    contexts: list[ProductContext] = []
    for match in matches:
        if match.get("metadata"):
            contexts.append(_metadata_to_product_context(match["metadata"]))
    return contexts


async def find_cheaper_alternative(
    current_price: float,
    query: str,
    exclude_id: str,
    category: str | None = None,
) -> ProductContext | None:
    """Find a cheaper product to pivot to.

    `category` is a soft constraint: when provided, we filter Pinecone to
    matching-category products. This stops the agent from suggesting a $39
    hoodie as a 'cheaper alternative' to a $349 ergonomic chair.
    """
    log = get_logger()
    vector = await embed_text(query)

    pinecone_filter: dict = {
        "price": {"$lt": current_price},
        "product_id": {"$ne": exclude_id},
    }
    if category:
        pinecone_filter["category"] = {"$eq": category}

    results = _index.query(
        vector=vector,
        top_k=3,
        filter=pinecone_filter,
        include_metadata=True,
    )

    matches = results.get("matches", [])
    log.debug(
        "pinecone_cheaper",
        query=query[:80],
        exclude_id=exclude_id,
        current_price=current_price,
        category=category,
        count=len(matches),
    )

    if not matches or not matches[0].get("metadata"):
        return None
    return _metadata_to_product_context(matches[0]["metadata"])
