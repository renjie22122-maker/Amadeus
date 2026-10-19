"""One ephemeral reference feature entry; no speaker data is persisted to model weights."""
import hashlib
from pathlib import Path
import uuid


def prepare_reference(engine, audio, prompt, cache):
    path = Path(audio)
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    key = (digest, prompt)
    if cache.get('key') == key:
        return cache['id'], True
    if cache.get('id'):
        engine.frontend.spk2info.pop(cache['id'], None)
    cache.clear()
    identity = 'amadeus-reference-' + str(uuid.uuid4())
    # Match inference_zero_shot's preprocessing before using the official cache API.
    normalized = engine.frontend.text_normalize(prompt, split=False)
    engine.add_zero_shot_spk(normalized, str(path), identity)
    cache.update(key=key, id=identity)
    return identity, False
