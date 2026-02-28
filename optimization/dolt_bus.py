from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

import pymysql
from pymysql.cursors import DictCursor


HOST = "127.0.0.1"
PORT = 3307
DATABASE = "punch_cards"
USER = "root"


CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS compiled_prompts (
    prompt_id VARCHAR(100) NOT NULL PRIMARY KEY,
    module_name VARCHAR(100) NOT NULL,
    signature_name VARCHAR(100) NOT NULL,
    compiled_prompt TEXT NOT NULL,
    compiled_at DATETIME NOT NULL,
    dspy_version VARCHAR(20) NOT NULL
)
"""


CREATE_DIAGNOSIS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS diagnosis_classifications (
    session_id VARCHAR(100) NOT NULL PRIMARY KEY,
    category VARCHAR(64) NOT NULL,
    confidence DOUBLE NOT NULL,
    evidence TEXT NOT NULL,
    classified_at DATETIME NOT NULL,
    classifier_version VARCHAR(32) NOT NULL
)
"""


@dataclass(frozen=True)
class CompiledPromptRecord:
    prompt_id: str
    module_name: str
    signature_name: str
    compiled_prompt: str
    compiled_at: datetime
    dspy_version: str


@dataclass(frozen=True)
class DiagnosisClassificationRecord:
    session_id: str
    category: str
    confidence: float
    evidence: str
    classified_at: datetime
    classifier_version: str


@contextmanager
def _connection() -> Generator[Any, None, None]:
    conn = pymysql.connect(
        host=HOST,
        port=PORT,
        user=USER,
        database=DATABASE,
        cursorclass=DictCursor,
        autocommit=False,
    )
    try:
        with conn.cursor() as cursor:
            cursor.execute(CREATE_TABLE_SQL)
            cursor.execute(CREATE_DIAGNOSIS_TABLE_SQL)
        conn.commit()
        yield conn
    finally:
        conn.close()


def write_compiled_prompt(
    prompt_id: str,
    module_name: str,
    signature_name: str,
    compiled_prompt: str,
    dspy_version: str,
) -> None:
    """Insert or update a compiled prompt record in Dolt/MySQL."""
    now = datetime.utcnow()
    with _connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO compiled_prompts (
                    prompt_id,
                    module_name,
                    signature_name,
                    compiled_prompt,
                    compiled_at,
                    dspy_version
                ) VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    module_name = VALUES(module_name),
                    signature_name = VALUES(signature_name),
                    compiled_prompt = VALUES(compiled_prompt),
                    compiled_at = VALUES(compiled_at),
                    dspy_version = VALUES(dspy_version)
                """,
                (
                    prompt_id,
                    module_name,
                    signature_name,
                    compiled_prompt,
                    now,
                    dspy_version,
                ),
            )
        conn.commit()


def read_compiled_prompt(prompt_id: str) -> CompiledPromptRecord | None:
    """Read a compiled prompt by id from Dolt/MySQL."""
    with _connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    prompt_id,
                    module_name,
                    signature_name,
                    compiled_prompt,
                    compiled_at,
                    dspy_version
                FROM compiled_prompts
                WHERE prompt_id = %s
                """,
                (prompt_id,),
            )
            row = cursor.fetchone()

    if row is None:
        return None

    record = cast(dict[str, Any], row)
    return CompiledPromptRecord(
        prompt_id=str(record["prompt_id"]),
        module_name=str(record["module_name"]),
        signature_name=str(record["signature_name"]),
        compiled_prompt=str(record["compiled_prompt"]),
        compiled_at=cast(datetime, record["compiled_at"]),
        dspy_version=str(record["dspy_version"]),
    )


def write_diagnosis_classification(
    session_id: str,
    category: str,
    confidence: float,
    evidence: str,
    classifier_version: str,
) -> None:
    """Insert or update a DSPy diagnosis classification in Dolt/MySQL."""
    now = datetime.utcnow()
    with _connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO diagnosis_classifications (
                    session_id,
                    category,
                    confidence,
                    evidence,
                    classified_at,
                    classifier_version
                ) VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    category = VALUES(category),
                    confidence = VALUES(confidence),
                    evidence = VALUES(evidence),
                    classified_at = VALUES(classified_at),
                    classifier_version = VALUES(classifier_version)
                """,
                (
                    session_id,
                    category,
                    confidence,
                    evidence,
                    now,
                    classifier_version,
                ),
            )
        conn.commit()


def read_diagnosis_classification(
    session_id: str,
) -> DiagnosisClassificationRecord | None:
    """Read a DSPy diagnosis classification by session_id from Dolt/MySQL."""
    with _connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    session_id,
                    category,
                    confidence,
                    evidence,
                    classified_at,
                    classifier_version
                FROM diagnosis_classifications
                WHERE session_id = %s
                """,
                (session_id,),
            )
            row = cursor.fetchone()

    if row is None:
        return None

    record = cast(dict[str, Any], row)
    return DiagnosisClassificationRecord(
        session_id=str(record["session_id"]),
        category=str(record["category"]),
        confidence=float(record["confidence"]),
        evidence=str(record["evidence"]),
        classified_at=cast(datetime, record["classified_at"]),
        classifier_version=str(record["classifier_version"]),
    )


if __name__ == "__main__":
    demo_prompt_id = "smoke-prompt-001"
    write_compiled_prompt(
        prompt_id=demo_prompt_id,
        module_name="qa_predictor",
        signature_name="question_to_answer",
        compiled_prompt="You are a helpful assistant. Answer the question directly.",
        dspy_version="3.1.3",
    )
    record = read_compiled_prompt(demo_prompt_id)
    print(record)
