// Minimal OpenAI-compatible mock LLM for screenshots. Streams canned markdown.
import http from 'node:http';

const PORT = process.env.MOCK_PORT || 8080;

const RESPONSES = {
  email: `Subject: Q4 Roadmap Review – Proposed Agenda & Next Steps

Hi Sarah,

Thank you for the productive discussion yesterday. As agreed, I've summarised the key points and proposed next steps so we can move quickly.

**Key decisions**
- The customer-facing launch of the new analytics dashboard moves to **15 November**.
- Legal review of the updated data-processing agreement is owned by **Marcus**.
- We will run a two-week pilot with the Munich and Bonn teams before the company-wide rollout.

**Open items**
1. Confirm the pilot participants by Friday.
2. Share the updated success metrics with the steering committee.
3. Schedule the retrospective for the first week of December.

Please let me know if I've missed anything or if you'd like to adjust the timeline. I'm happy to set up a short call to align.

Best regards,
Daniel`,
  summary: `## Summary

The document outlines the **2026 digital workplace strategy** for a mid-sized manufacturing company. It focuses on three pillars: secure AI adoption, knowledge management, and process automation.

### Key points
- **AI adoption**: A central, self-hosted AI platform replaces individual tool subscriptions; all models run inside the corporate network or with EU-hosted providers.
- **Knowledge management**: Existing SharePoint, Confluence and file-share content is connected through enterprise search rather than migrated.
- **Automation**: Recurring tasks in HR, procurement and customer service are handled by governed AI agents with human approval steps.

### Risks identified
| Risk | Mitigation |
| --- | --- |
| Shadow IT with consumer AI tools | Offer an approved, easier alternative |
| Data leakage to public models | Group-based model access and on-prem inference |
| Low adoption | Department-specific apps with ready-made prompts |

### Recommendation
Start with a six-week pilot in two departments, measure time saved per task, and expand based on the results.`,
  translate: `**Deutsch → Englisch**

Dear team,

Please find attached the final version of the quarterly report. The figures have been checked by the finance department and are ready to be shared with the management board. Kindly review the section on operating costs by Wednesday and let me know if you have any comments.

Kind regards,
Anna Berger`,
  mermaid: `Here is the process as a diagram:

\`\`\`mermaid
flowchart LR
    A[Employee submits request] --> B{Manager approval?}
    B -- Yes --> C[Procurement creates order]
    B -- No --> D[Request returned with comments]
    C --> E[Supplier confirms delivery date]
    E --> F[Goods received & invoice matched]
    F --> G[Payment released]
\`\`\`

**Notes**
- The approval step is the most common bottleneck; consider an auto-approval threshold for orders below €500.
- Invoice matching can be automated when the supplier sends structured e-invoices.`,
  research: `## Research findings: EU AI Act obligations for internal AI assistants

Based on the current text of the regulation and the Commission's implementation guidance, internal assistants used for drafting, summarising and searching are in most cases **limited-risk or minimal-risk systems**.

### What applies to you
1. **Transparency** – Users must be informed that they are interacting with an AI system. A visible label in the interface is sufficient.
2. **AI literacy (Art. 4)** – Organisations must ensure staff using AI systems have an adequate level of understanding. Short onboarding material and in-app guidance meet this requirement.
3. **General-purpose model providers** – Obligations sit mainly with the model provider, not with the deploying company.

### What does *not* apply
- High-risk obligations (Annex III) only apply to specific use cases such as employment decisions, credit scoring or biometric identification.

### Sources
- [EU AI Act – Official Journal text](https://eur-lex.europa.eu/eli/reg/2024/1689/oj)
- [European Commission – AI Act Q&A](https://digital-strategy.ec.europa.eu/en/faqs/artificial-intelligence-act-questions-answers)

> **Recommendation:** Document the intended use of each app in the admin interface and keep the model inventory current. That covers the record-keeping expectations with minimal effort.`,
  default: `Certainly! Here's a structured overview to get you started.

### Overview
iHub Apps gives every team ready-to-use AI assistants that run inside your own infrastructure. Each app combines a curated prompt, the right model, and optional knowledge sources or tools.

### How it works
1. **Choose an app** – for example *Email Composer*, *Summarizer* or *Knowledge Assistant*.
2. **Provide your input** – paste text, upload a document, or dictate with your voice.
3. **Refine the result** – ask follow-up questions, switch models, or compare two answers side by side.

### Tips
- Use the **prompt library** for reusable instructions.
- Enable **web search** when you need current information.
- Admins can restrict models and apps per user group.

Let me know what you'd like to do next!`
};

function pick(messages) {
  const text = messages
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
    .toLowerCase();
  if (/mermaid|diagram|flowchart/.test(text)) return RESPONSES.mermaid;
  if (/e-?mail|subject:|compose/.test(text)) return RESPONSES.email;
  if (/translat|übersetz/.test(text)) return RESPONSES.translate;
  if (/summar|zusammenfass/.test(text)) return RESPONSES.summary;
  if (/research|eu ai act|regulation/.test(text)) return RESPONSES.research;
  return RESPONSES.default;
}

function chunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  })}\n\n`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }]
      })
    );
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', async () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const model = payload.model || 'mock-model';
      const text = pick(payload.messages || []);
      const id = 'chatcmpl-' + Math.random().toString(36).slice(2);
      if (payload.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(chunk(id, model, { role: 'assistant', content: '' }));
        const words = text.split(/(\s+)/);
        for (const w of words) {
          res.write(chunk(id, model, { content: w }));
          await new Promise(r => setTimeout(r, 6));
        }
        res.write(chunk(id, model, {}, 'stop'));
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 812, completion_tokens: 240, total_tokens: 1052 } })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            model,
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
            ],
            usage: { prompt_tokens: 812, completion_tokens: 240, total_tokens: 1052 }
          })
        );
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
server.listen(PORT, () => console.log('mock llm on', PORT));
