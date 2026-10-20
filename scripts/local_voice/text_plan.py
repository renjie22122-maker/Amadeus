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

def text_language(text, language=None):
    hint = (language or "auto").lower().replace("_", "-").split("-")[0]
    if hint != "auto":
        return hint
    if re.search(r'[\u3040-\u30ff]', text):
        return "ja"
    if re.search(r'[\uac00-\ud7af]', text):
        return "ko"
    if any(c.isalpha() and not c.isascii() and not ('\u3400' <= c <= '\u9fff') for c in text):
        return "und"
    return "zh" if re.search(r'[\u3400-\u9fff]', text) else "en"

def model_text(frontend, text, language=None):
    route = text_language(text, language)
    # No Japanese/Korean normalizer is installed: preserve kanji/kana verbatim.
    # Even a conflicting zh/en hint must not erase unsupported scripts.
    if route not in ("zh", "en") or re.search(r'[\u3040-\u30ff\uac00-\ud7af]', text):
        return text
    normalizer = getattr(frontend, route + "_tn_model", None)
    if getattr(frontend, "text_frontend", None) == "wetext" and normalizer is not None:
        # WeText's default is auto. Select its prepared language without mutating
        # the resident engine or downloading another model.
        import copy
        selected = copy.copy(normalizer)
        if hasattr(selected, "lang"):
            selected.lang = route
        return selected.normalize(text)
    if route != text_language(text):
        return text  # An auto-only frontend cannot honor this explicit hint.
    return frontend.text_normalize(text, split=False)

def check_audio(text, seconds):
    if any(c.isalnum() for c in text) and seconds <= 0:
        raise ValueError("VOICE_INCOMPLETE: a text segment produced no audio")
    dense = len(re.findall(r'[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]', text))
    if dense >= 40 and seconds < dense / 14:
        raise ValueError("VOICE_COVERAGE_SUSPECT: implausibly short audio; completeness is unverified")
