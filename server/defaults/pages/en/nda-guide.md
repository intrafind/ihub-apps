# NDA Risk Analyzer - User Guide

## Overview

The NDA Risk Analyzer is an AI-powered tool that analyzes Non-Disclosure Agreement (NDA) documents and identifies potential legal risks. It evaluates NDAs against a set of standard clauses plus your organization's custom policy preferences.

## How the Analysis Works

### 1. Standard Evaluation Clauses

The NDA Risk Analyzer **always** evaluates these 8 standard clauses:

1. **Mutuality** (Einseitigkeit/Gegenseitigkeit): Whether the NDA is mutual or unilateral
2. **Cooperation Subject** (Gegenstand der Zusammenarbeit): Clear definition of collaboration purpose
3. **Confidential Information Definition** (Definition geheimer Informationen): Clear scope of what's confidential
4. **Duration** (Dauer des NDA): Term length
5. **Penalties** (Vertragsstrafen): Contractual penalties and damages
6. **Third Party Disclosure** (Herausgabe an Dritte): Rules for sharing with third parties
7. **Project/Customer Protection** (Projekt-/Kundenschutz): Protection of business relationships
8. **Non-Compete** (Wettbewerbsklausel): Competition restrictions

### 2. Custom Policy Rules

In addition to the standard clauses, the analyzer can evaluate **additional clauses** based on your organization's custom policy preferences. The AI will automatically extract and evaluate any additional requirements you specify (e.g., GDPR Compliance, Audit Rights, Insurance Requirements, etc.). Also the rules for the default clauses can be adjusted. We don't recommend to delete rules for the default clauses.

## Default Policy Rules

The NDA Risk Analyzer comes with the following default policy rules:

### English Default Rules

```
- Duration: Maximum months acceptable (RED if > 24 months, YELLOW if 13-24 months, GREEN if ≤ 12 months)
- Mutuality: Mutual NDAs strongly preferred (RED if unilateral with broad scope, YELLOW if unilateral with limited scope, GREEN if mutual)
- Liability: Must be capped and reasonable (RED if unlimited liability, YELLOW if high cap, GREEN if reasonable cap)
- Jurisdiction: DE, AT, CH preferred (RED if unfavorable jurisdiction like US/UK, YELLOW if EU but not DACH, GREEN if DE/AT/CH)
- Residual clauses: Not allowed (RED if present, GREEN if absent)
- Third Party Disclosure: Must require prior written consent (RED if allowed without consent, YELLOW if vague, GREEN if requires consent)
- Non-Compete: Should be limited in scope and time (RED if broad/unlimited, YELLOW if moderate, GREEN if narrow/absent)
- Penalties: Should be reasonable and capped (RED if excessive, YELLOW if unclear, GREEN if reasonable or absent)
```

### German Default Rules (Deutsche Standardregeln)

```
- Laufzeit: Maximum Monate akzeptabel (ROT wenn > 24 Monate, GELB wenn 13-24 Monate, GRÜN wenn ≤ 12 Monate)
- Gegenseitigkeit: Gegenseitige NDAs stark bevorzugt (ROT wenn einseitig mit breitem Umfang, GELB wenn einseitig mit begrenztem Umfang, GRÜN wenn gegenseitig)
- Haftung: Muss begrenzt und angemessen sein (ROT wenn unbegrenzte Haftung, GELB wenn hohe Obergrenze, GRÜN wenn angemessene Obergrenze)
- Gerichtsstand: DE, AT, CH bevorzugt (ROT wenn ungünstiger Gerichtsstand wie US/UK, GELB wenn EU aber nicht DACH, GRÜN wenn DE/AT/CH)
- Residualklauseln: Nicht erlaubt (ROT wenn vorhanden, GRÜN wenn nicht vorhanden)
- Weitergabe an Dritte: Muss vorherige schriftliche Zustimmung erfordern (ROT wenn ohne Zustimmung erlaubt, GELB wenn vage, GRÜN wenn Zustimmung erforderlich)
- Wettbewerbsverbot: Sollte in Umfang und Zeit begrenzt sein (ROT wenn breit/unbegrenzt, GELB wenn moderat, GRÜN wenn eng/nicht vorhanden)
- Vertragsstrafen: Sollten angemessen und begrenzt sein (ROT wenn übermäßig, GELB wenn unklar, GRÜN wenn angemessen oder nicht vorhanden)
```

## Risk Classification

The analyzer uses a three-level risk classification system:

| Risk Level | Color | Description |
|------------|-------|-------------|
| **RED** 🔴 | High Risk | Problematic clauses that violate policy preferences OR important clauses that are completely absent |
| **YELLOW** 🟡 | Medium Risk | Unclear definitions, unclear terms, moderate restrictions, or missing optional clauses |
| **GREEN** 🟢 | Low Risk | Acceptable clauses that meet the policy preferences |

## How to Use the NDA Risk Analyzer

### Step 1: Access the App

Navigate to the NDA Risk Analyzer app in your iHub Apps interface.

### Step 2: Configure Custom Policy Rules (Optional)

Before analyzing your NDA, you can customize the policy rules:

1. Locate the **"Custom Policy Rules"** text field at the top of the app
2. By default, it shows the organization's default rules
3. You can modify these rules to match your specific requirements

**Rule Format:**
- Each rule should be on a separate line
- Start with a dash `-`
- Include the clause name and conditions
- Specify risk levels: RED, YELLOW, GREEN
- Example: `- Duration: Maximum 18 months acceptable (RED if > 18 months, YELLOW if 12-18 months, GREEN if < 12 months)`

### Step 3: Upload or Paste Your NDA

You have two options:

**Option A: Upload a Document**
- Click the upload button
- Select your NDA document (PDF, TXT, or Markdown format)
- Maximum file size: 10MB

**Option B: Paste Text**
- Copy the NDA text
- Paste it directly into the message input field

### Step 4: Analyze

Click the submit button to start the analysis. The AI will:
1. Evaluate all 8 standard clauses
2. Extract additional clauses from your custom policy rules
3. Analyze each clause against the NDA text
4. Provide citations (exact quotes from the NDA)
5. Assign risk levels (RED/YELLOW/GREEN)

### Step 5: Review Results

The results are displayed in a user-friendly format:

- **Overall Risk Assessment**: Summary card showing the highest risk level found
- **Summary Statistics**: Count of high, medium, and low risk items
- **Detailed Analysis**: Individual cards for each clause with:
  - Risk level indicator (color-coded)
  - Explanation of why the risk level was assigned
  - Expandable citations from the NDA document

## Changing Custom Rules

You can change the custom policy rules at any time:

1. **Before Analysis**: Edit the "Custom Policy Rules" field before submitting your NDA
2. **For New Analysis**: Change the rules and submit the NDA again with the new rules

### Example: Adding a New Clause

To add a new clause (e.g., Data Protection):

```
- Data Protection: Must include GDPR compliance clause (RED if absent, YELLOW if vague, GREEN if explicit GDPR compliance mentioned)
```

The AI will automatically detect this new clause and evaluate it alongside the 8 standard clauses.

### Example: Modifying Existing Rules

To change the duration threshold:

```
- Duration: Maximum 18 months acceptable (RED if > 18 months, YELLOW if 12-18 months, GREEN if ≤ 12 months)
```

## Resetting to Default Rules

**Important**: When you refresh the page or restart the app, the custom policy rules will **automatically reset to the default rules** configured in the system.

To restore defaults:
1. Refresh the browser page (F5 or Ctrl+R / Cmd+R)
2. Or clear the "Custom Policy Rules" field and reload the app

The default rules are stored in the app configuration file (`contents/apps/nda-risk-analyzer.json`) and cannot be changed from the user interface. Contact your administrator to modify the system-wide default rules.

## Tips for Best Results

1. **Be Specific**: When defining custom rules, be as specific as possible about what constitutes RED, YELLOW, and GREEN
2. **Use Clear Language**: Write rules in clear, unambiguous language
3. **Include Thresholds**: Specify numeric thresholds where applicable (e.g., "Maximum 24 months")
4. **Test Incrementally**: Start with the default rules, then add custom rules one at a time
5. **Review Citations**: Always expand and review the citations to verify the AI's interpretation

## Understanding the Output Schema

The NDA Risk Analyzer returns results in a structured JSON format:

```json
{
  "overall_risk": "red|yellow|green",
  "clauses": [
    {
      "clause_name": "Clause Name",
      "citation": ["Quote 1 from NDA", "Quote 2 from NDA"],
      "risk_level": "red|yellow|green",
      "reason": "Explanation of risk assessment"
    }
  ]
}
```

- **overall_risk**: The highest risk level found (red if any clause is red, yellow if any is yellow but none are red, otherwise green)
- **clauses**: Array of at least 8 items (the standard clauses) plus any additional clauses from custom rules

## Troubleshooting

### Issue: Not All Custom Rules Are Evaluated

**Solution**: Ensure your custom rules are clearly formatted with explicit risk level indicators (RED, YELLOW, GREEN). The AI extracts clauses based on these keywords.

### Issue: Citations Are Missing

**Solution**: Some clauses may have empty citations if the clause is completely absent from the NDA. This is expected behavior and will be marked as RED.

### Issue: Results Seem Incorrect

**Solution**:
1. Review the citations to see what text the AI found
2. Check if your custom rules are specific enough
3. Try rephrasing your custom rules with clearer conditions

## Administrator Configuration

The default rules and app behavior are configured in:

```
contents/apps/nda-risk-analyzer.json
```

To modify system-wide defaults:
1. Edit the `defaultValue` field in the `variables` section
2. Save the file
3. The changes will be applied automatically (no server restart needed)

## Support

For questions or issues with the NDA Risk Analyzer:
- Contact your organization's iHub Apps administrator
- Refer to the main iHub Apps documentation
- Report bugs at: https://github.com/intrafind/ihub-apps/issues
