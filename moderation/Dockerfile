FROM python:3.12-slim

# Optional extra root CAs (filtering proxy such as NetFree) for pip during build.
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-dejavu-core \
    && update-ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2

WORKDIR /app
COPY moderation/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY moderation/app/ .

# Runs unprivileged: originals are mounted read-only, output goes to /blurred (named volume, initialised from this dir).
RUN useradd -r -u 10001 moderator && mkdir -p /blurred && chown 10001 /blurred
USER 10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["python", "server.py"]
