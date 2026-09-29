# EU AI Act Compliance Kit

The software parts of Art. 50 are described in [EU AI Act Transparency](eu-ai-act.md). The Code of Practice on Transparency of AI-Generated Content (final, 10 June 2026) also asks for organisational measures. This kit collects templates and checklists for them (issue #2567). It is a starting point, not legal advice: have legal or compliance review every item for your organisation.

## 1. Provider or deployer?

| You… | Your role | You must |
| --- | --- | --- |
| install iHub and offer it **under your own name or trademark** (your logo, your product name, white label) | **Provider** of that installation (Art. 3(3)) | meet 50(1) and 50(2): keep the disclosure on, mark output, offer detection, keep this kit's documents |
| **modify** iHub and put it into service under your own name | **Provider** of the modified system | as above |
| use iHub **unmodified**, under your authority, without your own name on it | possibly **Deployer** — legal assesses per case | meet 50(4): label deep fakes and published public-interest text unless human-reviewed with editorial responsibility |
| use AI output to inform the public on matters of public interest | **Deployer** (50(4)) | label it (the export label and "AI" icon), or have it reviewed and name the editorially responsible person |

iHub's own planning treats self-installers conservatively as providers. Record your assessment under **Admin → EU AI Act → Settings → Provider details** (legal entity, contact, address, role).

How to configure iHub compliantly:

1. Leave the feature **EU AI Act Transparency** on (Admin → Features).
2. Fill in **provider details**, the **editorial-responsibility contact** and the **terms of service** (section 2), and set the **installation URL**.
3. Keep **signing** on and check the **certificate** (Admin → EU AI Act → Certificates). For a trusted signer, install a certificate from a CA on the C2PA Trust List.
4. Keep **image marking** (C2PA + TrustMark) and **detection** on; choose the detector access that fits your audience.
5. Review the **model matrix**: every enabled model without text marking is non-conforming. Self-host models with the vLLM watermark (key groups), prefer vendors that document marking, or accept and document the gap.
6. Review **app opt-outs and exemptions** — each needs a written reason.
7. Run the **self-test**, then download the **compliance report**.

## 2. Terms of service clause (CoP Measure 1.2(b))

Add a clause like this to the acceptable-use policy or terms of service of your installation, then tick "Our terms of service prohibit removing or tampering with AI markings" on the EU AI Act page and enter the URL:

> **AI markings.** Content generated with this service may carry visible labels and machine-readable markings (such as signed metadata, invisible watermarks and text signposts) that identify it as AI-generated. You must not remove, alter, obscure or circumvent these markings, and must not use or offer tools to do so, except where the law requires it. Where you publish AI-generated or AI-manipulated content that is a deep fake, or text to inform the public on matters of public interest, you are responsible for labelling it as required by Article 50(4) of the EU AI Act.

German:

> **KI-Kennzeichnungen.** Mit diesem Dienst erzeugte Inhalte können sichtbare Hinweise und maschinenlesbare Kennzeichnungen tragen (z. B. signierte Metadaten, unsichtbare Wasserzeichen, Textwegweiser), die sie als KI-generiert ausweisen. Sie dürfen diese Kennzeichnungen nicht entfernen, verändern, verdecken oder umgehen und keine Werkzeuge dafür einsetzen oder anbieten, soweit das Gesetz nichts anderes verlangt. Veröffentlichen Sie KI-generierte oder -manipulierte Inhalte, die Deepfakes sind, oder Texte zur Information der Öffentlichkeit über Angelegenheiten von öffentlichem Interesse, sind Sie für die Kennzeichnung nach Artikel 50 Absatz 4 KI-Verordnung verantwortlich.

## 3. Vendor statements on marking (CoP Measure 4.2)

You may rely on a model vendor's marking only if you have it **in writing**. Ask each vendor you use and file the answers with your compliance documentation:

- Does the model mark its output? Text, images, audio, video — which technique (e.g. SynthID, C2PA), from which date, for which API/model versions?
- Is the marking applied to API output, or only in the vendor's own apps?
- Which detector can verify it, and who may use it?
- What test results (false-positive and true-positive rates, robustness) does the vendor publish?
- Will the vendor notify changes?

| Vendor | Models | Statement received | Marking | Recorded in iHub (`contentMarking`) |
| --- | --- | --- | --- | --- |
| Google | Gemini (text, images) | ☐ | images: SynthID; text: ? | `imageWatermark: upstream:synthid`; `textWatermark: none` until confirmed |
| OpenAI | GPT | ☐ | ? | `none` |
| Anthropic | Claude | ☐ | ? | `none` |
| Mistral | Mistral | ☐ | ? | `none` |
| AWS Bedrock | per model | ☐ | ? | `none` |

When a vendor confirms text marking, set `textWatermark: "upstream:<vendor>"` on the model and keep the statement.

## 4. Compliance process (CoP Measure 4.1) — skeleton

Fill in and keep it with the compliance report.

1. **Scope and roles**: installations, owners, provider/deployer role, contacts.
2. **Marking techniques**: per modality and model (take the table from the compliance report); the reasons for every gap, opt-out and exemption.
3. **Testing before release**: run the marking benchmark (`npm run test:marking-benchmark -- --full`) before every upgrade and after every model or marking change; record TPR/FPR per technique, transform and length; acceptance thresholds.
4. **Monitoring**: review the EU AI Act page monthly; nightly benchmark (CI); certificate expiry; vendor changes; incidents (removed or forged marks reported to you).
5. **Staff training (Measure 4.3)**: who administers iHub, what they must know (disclosure, opt-outs, acknowledgements, detection access), refreshed yearly.
6. **Cooperation with authorities (Measure 4.4)**: contact person; how you hand over the compliance report, detection access and test results; unlimited detector access for authorities, researchers, media and fact-checkers (CoP 2.1).
7. **Detector retirement (Measure 2.1.4)**: keep old certificates and key versions detect-only; hand the detector to the authority if you stop operating it.
8. **Records**: where the audit log, the reports and the vendor statements are kept, and for how long.

## 5. C2PA conformance and a trusted certificate

Public validators show a signer as trusted only if its root is on the **C2PA Trust List**, and Trust-List CAs issue C2PA signing certificates only to **conforming generator products**. The path for iHub:

1. Expression of interest in the C2PA conformance program for iHub as a generator product (<https://c2pa.org/conformance/>).
2. Product security architecture template: key storage (installation keystore encrypted with the installation key; HSM/KMS planned), certificate lifecycle (rotation, detect-only retirement), manifest content (no personal data).
3. Evaluation; then order a certificate from a Trust-List CA (e.g. DigiCert, SSL.com).
4. Ask the CA whether its subscriber agreement allows **one key for many customer installations** (the planned one-click IntraFind certificate, issue #2578) or requires **per-installation certificates via CSR** (recommended in review; iHub's CSR flow already supports it).

Until then, auto-generated and company certificates validate cryptographically and show as untrusted in public tools — accepted for now.

## 6. Code of Practice signature

Checklist before signing:

- ☐ Marking gaps documented (cloud-model text) with a plan
- ☐ Detector available and access documented; signed reports enabled
- ☐ Benchmark results recorded (Measures 3.1–3.3)
- ☐ Signpost in place for 2 February 2027 (Measure 3.4(c)) — `/.well-known/ai-provenance` reachable, installation URL set
- ☐ ToS clause (Measure 1.2) published
- ☐ Compliance process (Measure 4.1) adopted, training (4.3) scheduled
