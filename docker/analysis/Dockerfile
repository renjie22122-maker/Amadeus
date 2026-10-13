# Optional analysis image; built explicitly, never at application startup.
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /workspace
USER 1000:1000
# CSV, JSON, ZIP, decimal and statistics use Python's standard library.
# Additional libraries must be prepared in a derived image, not installed per call.
