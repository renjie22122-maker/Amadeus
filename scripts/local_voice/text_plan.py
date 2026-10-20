"""Lossless source spans and conservative audio checks; not an ASR verdict."""
import re

def plan_text(text, limit=160):
    # Keep punctuation and whitespace, including quotation marks, in source order.
    pieces = re.findall(r'.*?(?:[。！？!?\n]+|$)', text, re.S)
    result = []
    cursor = 0
    for piece in pieces:
        while piece:
            part, piece = piece[:limit], piece[limit:]
            result.append({"start": cursor, "end": cursor + len(part), "source": part})
            cursor += len(part)
    assert "".join(p["source"] for p in result) == text
    return result

def model_text(frontend, text):
    # Kana/Hangul must not pass through a Chinese/English number normalizer.
    if re.search(r'[\u3040-\u30ff\uac00-\ud7af]', text):
        return text
    return frontend.text_normalize(text, split=False)

def check_audio(text, seconds):
    if any(c.isalnum() for c in text) and seconds <= 0:
        raise ValueError("VOICE_INCOMPLETE: a text segment produced no audio")
    dense = len(re.findall(r'[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]', text))
    if dense >= 40 and seconds < dense / 14:
        raise ValueError("VOICE_COVERAGE_SUSPECT: implausibly short audio; completeness is unverified")
