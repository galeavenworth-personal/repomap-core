from __future__ import annotations

import dspy  # type: ignore[import-untyped]
from dspy.primitives.prediction import Prediction  # type: ignore[import-untyped]
from dspy.utils import DummyLM  # type: ignore[import-untyped]


DEFAULT_QUESTION = "What is 2+2?"
DEFAULT_ANSWER = "4"


def run_smoke_prediction(question: str = DEFAULT_QUESTION) -> Prediction:
    """Run a local-only DSPy Signature->Predict smoke pipeline with DummyLM."""
    lm = DummyLM({DEFAULT_QUESTION: {"answer": DEFAULT_ANSWER}})
    predictor = dspy.Predict("question -> answer")

    with dspy.context(lm=lm):
        return predictor(question=question)


def smoke_answer(question: str = DEFAULT_QUESTION) -> str:
    """Return the answer field from the smoke prediction."""
    prediction = run_smoke_prediction(question=question)
    return prediction.answer


if __name__ == "__main__":
    result = run_smoke_prediction()
    print(f"question={DEFAULT_QUESTION!r}")
    print(f"answer={result.answer!r}")
