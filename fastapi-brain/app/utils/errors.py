class BrainError(Exception):
    def __init__(self, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class LLMError(BrainError):
    pass


class ClassificationError(BrainError):
    pass


class ProductRetrievalError(BrainError):
    pass


class PromptBuildError(BrainError):
    pass
