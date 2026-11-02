# create_pdf examples

Complete `create_pdf` calls to adapt. Keep the structure, replace the content. `blocks`, `styles` and `images` are shown as JSON values for readability; pass each one as JSON text.

## 1. Business report (cover page, table of contents, chart, callout)

```json
{
  "filename": "q3-2026-sales-report",
  "title": "Sales Report Q3 2026",
  "subtitle": "Region DACH",
  "author": "Sales Operations",
  "language": "en",
  "theme": "professional",
  "coverPage": true,
  "toc": true,
  "header": "{title}",
  "footer": "Internal",
  "blocks": [
    {
      "markdown": "# Summary\n\nRevenue grew **8.4 %** quarter over quarter, driven by the enterprise segment. Churn stayed below target.\n\n- Enterprise revenue: **€ 4.2 m** (+12 %)\n- SMB revenue: **€ 1.9 m** (+1 %)\n- Net retention: **112 %**\n\n# Revenue by month\n\n| Month | Enterprise (k€) | SMB (k€) | Total (k€) |\n|:------|---------------:|--------:|----------:|\n| July | 1,310 | 620 | 1,930 |\n| August | 1,380 | 630 | 2,010 |\n| September | 1,510 | 650 | 2,160 |"
    },
    {
      "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"420\" height=\"190\" viewBox=\"0 0 420 190\" font-family=\"sans-serif\"><text x=\"0\" y=\"14\" font-size=\"12\" font-weight=\"bold\" fill=\"#111827\">Total revenue (k€)</text><line x1=\"40\" y1=\"160\" x2=\"410\" y2=\"160\" stroke=\"#9ca3af\"/><rect x=\"70\" y=\"63\" width=\"70\" height=\"97\" fill=\"#495057\"/><rect x=\"180\" y=\"59\" width=\"70\" height=\"101\" fill=\"#495057\"/><rect x=\"290\" y=\"52\" width=\"70\" height=\"108\" fill=\"#1f4e79\"/><text x=\"105\" y=\"176\" font-size=\"10\" text-anchor=\"middle\" fill=\"#374151\">Jul</text><text x=\"215\" y=\"176\" font-size=\"10\" text-anchor=\"middle\" fill=\"#374151\">Aug</text><text x=\"325\" y=\"176\" font-size=\"10\" text-anchor=\"middle\" fill=\"#374151\">Sep</text><text x=\"105\" y=\"58\" font-size=\"9\" text-anchor=\"middle\" fill=\"#111827\">1,930</text><text x=\"215\" y=\"54\" font-size=\"9\" text-anchor=\"middle\" fill=\"#111827\">2,010</text><text x=\"325\" y=\"47\" font-size=\"9\" text-anchor=\"middle\" fill=\"#111827\">2,160</text></svg>",
      "alignment": "center",
      "margin": [0, 8, 0, 12]
    },
    {
      "markdown": "# Outlook\n\nWe expect Q4 to follow the seasonal pattern of previous years."
    },
    {
      "callout": {
        "tone": "info",
        "title": "Next steps",
        "markdown": "1. Extend the enterprise pilot to two more regions.\n2. Review SMB pricing by **15 November**."
      }
    }
  ]
}
```

## 2. Invoice (columns, table with merged total row)

```json
{
  "filename": "invoice-2026-0142",
  "title": "Invoice 2026-0142",
  "language": "en",
  "theme": "minimal",
  "pageNumbers": false,
  "blocks": [
    {
      "columns": [
        { "width": "*", "markdown": "**Example GmbH**  \nMain Street 1  \n10115 Berlin" },
        {
          "width": "auto",
          "table": {
            "body": [
              ["Invoice no.", "2026-0142"],
              ["Date", "30 Sep 2026"],
              ["Due", "30 Oct 2026"]
            ]
          },
          "layout": "ihubPlain"
        }
      ],
      "margin": [0, 0, 0, 24]
    },
    { "markdown": "**Bill to**  \nCustomer AG  \nHarbour Road 7  \n20457 Hamburg" },
    {
      "table": {
        "headerRows": 1,
        "widths": ["*", 50, 80, 90],
        "body": [
          [
            "Description",
            { "text": "Qty", "alignment": "right" },
            { "text": "Unit price", "alignment": "right" },
            { "text": "Amount", "alignment": "right" }
          ],
          [
            "Consulting (days)",
            { "text": "5", "alignment": "right" },
            { "text": "1,200.00 €", "alignment": "right" },
            { "text": "6,000.00 €", "alignment": "right" }
          ],
          [
            "Travel expenses",
            { "text": "1", "alignment": "right" },
            { "text": "380.00 €", "alignment": "right" },
            { "text": "380.00 €", "alignment": "right" }
          ],
          [
            { "text": "Net", "colSpan": 3, "alignment": "right" },
            {},
            {},
            { "text": "6,380.00 €", "alignment": "right" }
          ],
          [
            { "text": "VAT 19 %", "colSpan": 3, "alignment": "right" },
            {},
            {},
            { "text": "1,212.20 €", "alignment": "right" }
          ],
          [
            { "text": "Total", "colSpan": 3, "alignment": "right", "bold": true },
            {},
            {},
            { "text": "7,592.20 €", "alignment": "right", "bold": true }
          ]
        ]
      },
      "layout": "lightHorizontalLines",
      "margin": [0, 18, 0, 18]
    },
    {
      "markdown": "Please transfer the amount to IBAN DE00 0000 0000 0000 0000 00 by the due date, quoting the invoice number.",
      "style": "small"
    }
  ]
}
```

## 3. Letter

```json
{
  "filename": "letter-offer-follow-up",
  "title": "Your enquiry of 22 September",
  "showTitle": false,
  "language": "en",
  "pageNumbers": false,
  "blocks": [
    {
      "text": "Example GmbH · Main Street 1 · 10115 Berlin",
      "style": "small",
      "margin": [0, 0, 0, 16]
    },
    { "text": "Customer AG\nMs Jane Doe\nHarbour Road 7\n20457 Hamburg", "margin": [0, 0, 0, 28] },
    { "text": "Berlin, 30 September 2026", "alignment": "right", "margin": [0, 0, 0, 20] },
    {
      "markdown": "**Your enquiry of 22 September**\n\nDear Ms Doe,\n\nthank you for your enquiry. Please find our offer attached …\n\nKind regards\n\nJohn Smith"
    }
  ]
}
```

Setting `"showTitle": false` keeps `title` in the PDF metadata while letting the sender/recipient address block open the page and placing the bold subject line directly above the salutation.

## 4. One-pager with key figures (columns of boxes)

```json
{
  "filename": "project-status-one-pager",
  "title": "Project Atlas — Status",
  "subtitle": "Week 39",
  "language": "en",
  "primaryColor": "#0f766e",
  "blocks": [
    {
      "columns": [
        {
          "width": "*",
          "box": {
            "fillColor": "#f0fdfa",
            "borderColor": "#99f6e4",
            "markdown": "**Budget used**\n\n## 62 %"
          }
        },
        {
          "width": "*",
          "box": {
            "fillColor": "#f0fdfa",
            "borderColor": "#99f6e4",
            "markdown": "**Milestones**\n\n## 7 / 11"
          }
        },
        {
          "width": "*",
          "box": {
            "fillColor": "#fef2f2",
            "borderColor": "#fecaca",
            "markdown": "**Open risks**\n\n## 3"
          }
        }
      ],
      "columnGap": 12
    },
    {
      "markdown": "## Done this week\n- Data migration completed\n- Pilot users onboarded\n\n## Next week\n- Load test\n- Go/no-go meeting on Friday"
    },
    {
      "callout": {
        "tone": "danger",
        "title": "Blocker",
        "markdown": "Firewall change **CHG-2231** still pending approval."
      }
    }
  ]
}
```

## 5. Visual poster / event one-pager (Swiss grid, SVG hero artwork, `showTitle: false`)

```json
{
  "filename": "ai-engineering-summit-poster",
  "title": "AI Engineering Summit 2026",
  "showTitle": false,
  "pageNumbers": false,
  "language": "en",
  "primaryColor": "#0f172a",
  "accentColor": "#e11d48",
  "margins": [36, 36, 36, 36],
  "blocks": [
    {
      "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"520\" height=\"240\" viewBox=\"0 0 520 240\" font-family=\"sans-serif\"><rect x=\"0\" y=\"0\" width=\"520\" height=\"240\" fill=\"#0f172a\"/><rect x=\"0\" y=\"0\" width=\"14\" height=\"240\" fill=\"#e11d48\"/><circle cx=\"430\" cy=\"120\" r=\"78\" fill=\"none\" stroke=\"#334155\" stroke-width=\"1.5\"/><circle cx=\"430\" cy=\"120\" r=\"48\" fill=\"none\" stroke=\"#e11d48\" stroke-width=\"2\"/><line x1=\"330\" y1=\"120\" x2=\"510\" y2=\"120\" stroke=\"#334155\" stroke-width=\"1\"/><line x1=\"430\" y1=\"24\" x2=\"430\" y2=\"216\" stroke=\"#334155\" stroke-width=\"1\"/><text x=\"36\" y=\"52\" font-size=\"10\" font-weight=\"bold\" fill=\"#e11d48\">ANNUAL ARCHITECTURE SYMPOSIUM · MUNICH</text><text x=\"36\" y=\"104\" font-size=\"28\" font-weight=\"bold\" fill=\"#f8fafc\">AI ENGINEERING</text><text x=\"36\" y=\"140\" font-size=\"28\" font-weight=\"bold\" fill=\"#f8fafc\">SUMMIT 2026</text><text x=\"36\" y=\"182\" font-size=\"12\" fill=\"#94a3b8\">18–19 NOVEMBER 2026 · BAUHAUS AUDITORIUM</text><text x=\"36\" y=\"208\" font-size=\"10\" fill=\"#cbd5e1\">SYSTEMS · RETRIEVAL · AUTONOMOUS AGENTS · VERIFICATION</text></svg>",
      "alignment": "center",
      "margin": [0, 0, 0, 20]
    },
    {
      "columns": [
        {
          "width": "*",
          "box": {
            "fillColor": "#f8fafc",
            "borderColor": "#cbd5e1",
            "padding": 12,
            "markdown": "**01 · Retrieval at Scale**\n\nHybrid indexing, late interaction, and sub-50 ms permission filtering across enterprise repositories."
          }
        },
        {
          "width": "*",
          "box": {
            "fillColor": "#f8fafc",
            "borderColor": "#cbd5e1",
            "padding": 12,
            "markdown": "**02 · Deterministic Agents**\n\nSandboxed tool execution, bounded loops, and adversarial verification for production workflows."
          }
        },
        {
          "width": "*",
          "box": {
            "fillColor": "#fff1f2",
            "borderColor": "#fecdd3",
            "padding": 12,
            "markdown": "**03 · EU AI Act Readiness**\n\nProvenance, audit trails, cryptographic export signing, and on-premise model governance."
          }
        }
      ],
      "columnGap": 12,
      "margin": [0, 0, 0, 20]
    },
    {
      "columns": [
        {
          "width": "*",
          "markdown": "### Keynotes & Workshops\n\n- **09:30** — Opening Keynote: *Beyond Chat Interfaces*\n- **11:15** — Deep Dive: *Zero-Trust Document Extraction*\n- **14:00** — Hands-on Lab: *Multi-Agent Evaluation Harnesses*\n- **16:30** — Panel: *Operating Sovereign LLMs in Production*"
        },
        {
          "width": 120,
          "stack": [
            { "qr": "https://example.com/summit-2026", "fit": 96, "alignment": "right" },
            {
              "text": "Scan to register",
              "style": "small",
              "alignment": "right",
              "margin": [0, 6, 0, 0]
            }
          ]
        }
      ],
      "columnGap": 20
    }
  ]
}
```
