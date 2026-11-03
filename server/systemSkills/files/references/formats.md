# Schemas for Specialized Text Formats (`files`)

## 1. Jupyter Notebooks (`.ipynb`)

A `.ipynb` file is strict JSON following `nbformat` v4. Each cell's `source` is an array of strings (each line ending with `\n` except the last). Never leave `outputs` or `execution_count` missing on `"code"` cells.

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    },
    "language_info": {
      "name": "python",
      "version": "3.12.0"
    }
  },
  "cells": [
    {
      "id": "intro-cell",
      "cell_type": "markdown",
      "metadata": {},
      "source": [
        "# Revenue Cohort Analysis\n",
        "\n",
        "This notebook loads the quarterly dataset, computes retention by cohort, and plots the trend."
      ]
    },
    {
      "id": "setup-cell",
      "cell_type": "code",
      "execution_count": null,
      "metadata": {},
      "outputs": [],
      "source": [
        "import pandas as pd\n",
        "import matplotlib.pyplot as plt\n",
        "\n",
        "df = pd.read_csv('cohorts.csv')\n",
        "df.head()"
      ]
    }
  ]
}
```

## 2. Diagrams (`.drawio`, `.excalidraw`, `.mmd`, `.dot`, `.puml`)

- **Inline chat diagrams**: when the user asks to see a flowchart, sequence diagram, class diagram, state diagram or ER diagram in chat, write a fenced ` ```mermaid ` block directly in your message — iHub renders it interactively.
- **`.drawio` (diagrams.net / draw.io XML)**:
  ```xml
  <mxfile host="app.diagrams.net" version="24.0.0">
    <diagram id="arch-1" name="Architecture">
      <mxGraphModel dx="1000" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169">
        <root>
          <mxCell id="0"/>
          <mxCell id="1" parent="0"/>
          <mxCell id="2" value="API Gateway" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1" vertex="1" parent="1">
            <mxGeometry x="120" y="160" width="140" height="60" as="geometry"/>
          </mxCell>
          <mxCell id="3" value="Worker Service" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontStyle=1" vertex="1" parent="1">
            <mxGeometry x="360" y="160" width="140" height="60" as="geometry"/>
          </mxCell>
          <mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="2" target="3">
            <mxGeometry relative="1" as="geometry"/>
          </mxCell>
        </root>
      </mxGraphModel>
    </diagram>
  </mxfile>
  ```
- **`.excalidraw` (Excalidraw JSON)**:
  ```json
  {
    "type": "excalidraw",
    "version": 2,
    "source": "https://excalidraw.com",
    "elements": [
      {
        "id": "box-1",
        "type": "rectangle",
        "x": 100,
        "y": 100,
        "width": 180,
        "height": 80,
        "angle": 0,
        "strokeColor": "#1e3a8a",
        "backgroundColor": "#dbeafe",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "roughness": 1,
        "opacity": 100
      }
    ],
    "appState": { "viewBackgroundColor": "#ffffff", "gridSize": 20 },
    "files": {}
  }
  ```

## 3. Calendar Invites (`.ics`) & Contacts (`.vcf`)

Both formats require **CRLF (`\r\n`) line endings**. `create_file` keeps the bytes exactly as sent, so write every line break in the tool `content` as `\r\n` (not a bare `\n`), or strict clients may refuse to import the file.

- **`.ics` (RFC 5545 iCalendar)**:
  ```text
  BEGIN:VCALENDAR
  VERSION:2.0
  PRODID:-//iHub Apps//EN
  CALSCALE:GREGORIAN
  METHOD:PUBLISH
  BEGIN:VEVENT
  UID:20261015T090000Z-review@ihub.local
  DTSTAMP:20261015T080000Z
  DTSTART:20261020T090000Z
  DTEND:20261020T100000Z
  SUMMARY:Q3 Architecture Review
  DESCRIPTION:Agenda: 1. Throughput results 2. Rollout plan
  LOCATION:Conference Room B / Online
  END:VEVENT
  END:VCALENDAR
  ```
- **`.vcf` (vCard 3.0)**:
  ```text
  BEGIN:VCARD
  VERSION:3.0
  N:Mustermann;Erika;;;
  FN:Erika Mustermann
  ORG:ACME GmbH
  TITLE:VP Engineering
  TEL;TYPE=WORK,VOICE:+49 89 1234567
  EMAIL;TYPE=PREF,INTERNET:erika.mustermann@example.com
  END:VCARD
  ```
