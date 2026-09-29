"""
Reference text-watermark detector for iHub Apps (EU AI Act Art. 50, issue #2572).

iHub keeps the watermark keys (per key group) and calls this service with the
text, the key and the model's tokenizer. The service runs vLLM's Gumbel-max
detection primitives on CPU and answers with a p-value. It stores nothing.

Contract (docs/eu-ai-act.md, "Text watermarking with vLLM"):

    POST /detect
    { "text": "...", "tokenizer": "<HF model id>", "algorithm": "gumbel",
      "key": 123456789, "context_width": 4 }
    -> { "p_value": 1.2e-9, "score": 312.4, "num_tokens": 240, "is_watermarked": true }

Run it on an internal network only: requests carry the secret key.

The detector class follows vLLM RFC #53916 (`GumbelWatermarkDetector(key=...,
context_width=...).detect(token_ids)`). Check the import path against the
vLLM release you run; set DETECTOR_IMPORT="module:Class" to override it.
"""

import importlib
import os
from functools import lru_cache
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

DEFAULT_TOKENIZER = os.environ.get("DEFAULT_TOKENIZER")
DETECTOR_IMPORT = os.environ.get(
    "DETECTOR_IMPORT", "vllm.watermarking.detection:GumbelWatermarkDetector"
)
P_THRESHOLD = float(os.environ.get("P_THRESHOLD", "0.01"))


def load_detector_class():
    module_name, _, class_name = DETECTOR_IMPORT.partition(":")
    module = importlib.import_module(module_name)
    return getattr(module, class_name)


class DetectRequest(BaseModel):
    text: str
    tokenizer: Optional[str] = None
    algorithm: str = "gumbel"
    key: int
    context_width: int = 4


app = FastAPI(title="iHub watermark detector", version="1.0.0")


@lru_cache(maxsize=16)
def tokenizer_for(name: Optional[str]):
    from transformers import AutoTokenizer

    model = name or DEFAULT_TOKENIZER
    if not model:
        raise HTTPException(400, "No tokenizer given and DEFAULT_TOKENIZER unset")
    return AutoTokenizer.from_pretrained(model)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/detect")
def detect(req: DetectRequest):
    if req.algorithm != "gumbel":
        raise HTTPException(400, f"Unsupported algorithm {req.algorithm}")
    token_ids = tokenizer_for(req.tokenizer).encode(req.text, add_special_tokens=False)
    detector = load_detector_class()(key=req.key, context_width=req.context_width)
    result = detector.detect(token_ids)
    p_value = float(getattr(result, "p_value"))
    return {
        "p_value": p_value,
        "score": float(getattr(result, "score", 0.0)),
        "num_tokens": int(getattr(result, "num_tokens", getattr(result, "num_scored_tokens", len(token_ids)))),
        "is_watermarked": bool(getattr(result, "is_watermarked", p_value < P_THRESHOLD)),
    }
