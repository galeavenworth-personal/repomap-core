from __future__ import annotations

import pytest

from optimization import smoke


@pytest.mark.smoke
def test_smoke_answer_default_question() -> None:
    assert smoke.smoke_answer() == smoke.DEFAULT_ANSWER


@pytest.mark.smoke
def test_signature_predict_pipeline_returns_prediction() -> None:
    prediction = smoke.run_smoke_prediction()
    assert prediction.answer == smoke.DEFAULT_ANSWER
