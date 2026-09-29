# iHub watermark detector (reference)

A small HTTP service that detects the vLLM Gumbel-max text watermark for iHub
Apps. iHub sends the text, the key of a key group and the model's tokenizer;
the service answers with a p-value. Nothing is stored.

```bash
docker build -t ihub-watermark-detector docker/watermark-detector
docker run -p 8090:8090 -e DEFAULT_TOKENIZER=mistralai/Mistral-Small-24B-Instruct-2501 ihub-watermark-detector
```

Then set the key group's detector URL to `http://<host>:8090/detect` on the
EU AI Act page (Detection → Key groups). Keep the service on an internal
network: requests carry the secret key. See `docs/eu-ai-act.md`.
