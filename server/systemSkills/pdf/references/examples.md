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
  "markdown": "# Summary\n\nRevenue grew **8.4 %** quarter over quarter, driven by the enterprise segment. Churn stayed below target.\n\n- Enterprise revenue: **€ 4.2 m** (+12 %)\n- SMB revenue: **€ 1.9 m** (+1 %)\n- Net retention: **112 %**\n\n# Revenue by month\n\n| Month | Enterprise (k€) | SMB (k€) | Total (k€) |\n|:------|---------------:|--------:|----------:|\n| July | 1,310 | 620 | 1,930 |\n| August | 1,380 | 630 | 2,010 |\n| September | 1,510 | 650 | 2,160 |\n\n# Outlook\n\nWe expect Q4 to follow the seasonal pattern of previous years.",
  "blocks": [
    {
      "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"420\" height=\"190\" viewBox=\"0 0 420 190\" font-family=\"sans-serif\"><text x=\"0\" y=\"14\" font-size=\"12\" font-weight=\"bold\">Total revenue (k€)</text><line x1=\"40\" y1=\"160\" x2=\"410\" y2=\"160\" stroke=\"#9ca3af\"/><rect x=\"70\" y=\"63\" width=\"70\" height=\"97\" fill=\"#495057\"/><rect x=\"180\" y=\"59\" width=\"70\" height=\"101\" fill=\"#495057\"/><rect x=\"290\" y=\"52\" width=\"70\" height=\"108\" fill=\"#1f4e79\"/><text x=\"105\" y=\"176\" font-size=\"10\" text-anchor=\"middle\">Jul</text><text x=\"215\" y=\"176\" font-size=\"10\" text-anchor=\"middle\">Aug</text><text x=\"325\" y=\"176\" font-size=\"10\" text-anchor=\"middle\">Sep</text><text x=\"105\" y=\"58\" font-size=\"9\" text-anchor=\"middle\">1,930</text><text x=\"215\" y=\"54\" font-size=\"9\" text-anchor=\"middle\">2,010</text><text x=\"325\" y=\"47\" font-size=\"9\" text-anchor=\"middle\">2,160</text></svg>",
      "alignment": "center",
      "margin": [0, 6, 0, 12]
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
      "markdown": "Dear Ms Doe,\n\nthank you for your enquiry. Please find our offer attached …\n\nKind regards\n\nJohn Smith"
    }
  ]
}
```

With a `title` and no cover page, the title is printed at the top of the letter. To leave it out and write the subject line yourself, put it in a bold paragraph and keep `title` for the metadata only.

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
