# Features — Unreleased

## Text Watermark: Detector Settings Are Optional and Explained

For a model marked **iHub watermark (vLLM)**, the detector settings in **Admin → Models → Output marking** are
now all optional, show their defaults, and say what they are for.

- **Detector URL** is optional. Without one the output is still watermarked; only Verify and the self-test cannot
  recognise the mark. The EU AI Act configuration check shows this as *Attention* instead of *Failing*.
- **Detector credential** is optional and picked from the bearer credentials instead of typed as an id. A detector
  on an internal network that asks for no token is called without one. A credential that is set but cannot be read
  still stops the call and shows as *Failing*.
- **Tokenizer** shows the model ID it falls back to, and **Watermark context** (formerly "Context width") shows its
  default of 4 and explains that it is vLLM's watermark `context_width`, not the model's context window.
- The fields no longer shift out of line when a label wraps.
