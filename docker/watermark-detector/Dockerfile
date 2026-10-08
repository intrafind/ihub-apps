# Reference text-watermark detector for iHub Apps (CPU only).
# docker build -t ihub-watermark-detector docker/watermark-detector
FROM python:3.12-slim
WORKDIR /srv
# requirements.txt locks requirements.in to hashed wheels; regenerate it with
#   uv pip compile requirements.in --universal --python-version 3.12 \
#     --generate-hashes --only-binary :all: -o requirements.txt
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes --only-binary :all: -r requirements.txt
COPY app.py .
# Tokenizers are downloaded on first use; `nobody` has no writable home.
ENV HF_HOME=/srv/hf-cache
RUN mkdir -p /srv/hf-cache && chown nobody:nogroup /srv/hf-cache
EXPOSE 8090
USER nobody
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
