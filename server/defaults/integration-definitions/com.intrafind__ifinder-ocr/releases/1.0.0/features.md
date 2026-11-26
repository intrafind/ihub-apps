# iFinder OCR service 1.0.0

- First version of the built-in OCR engine for the iFinder OCR service (`type: ocr`), installed once as `ifinder-ocr`. Once installed, pick it under **Admin → Chat history → Text recognition → Engine**: uploaded images and the scanned pages of PDFs then go to your OCR service (Tesseract) instead of a vision model, and stay on your servers.
- The service URL (`serviceUrl`) is required, e.g. `http://if-ocr:9618/ocr-api`. A URL without a path gets `/ocr-api`.
- `authorizationRef` is an optional credential for a service set up for JWT or OAuth2: it is sent as a `Bearer` token, or as it is when it starts with `Basic `. In its default setup the service needs none.
- One action, `recognize`: one image in, its text out. iHub sends a PDF page as a PNG image, so only pages without a text layer are recognized. The service reads PNG, JPEG, GIF, BMP and TIFF; a WebP image is refused.
- The recognition languages are set on the service (`intrafind.ocr.engine.tesseract.languages`, German and English by default), not in iHub.
- The service address goes through the SSRF check: company-internal addresses pass, `localhost`, link-local and metadata addresses need `ssrf.allowedHosts`. `ssl.domainWhitelist` applies to a service with a private CA.
- **Test** checks the URL and the credential as entered and sends a small blank image to the service.
