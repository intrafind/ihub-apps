# NDA-Risikoanalyse - Benutzerhandbuch

## Übersicht

Der NDA-Risikoanalyzer ist ein KI-gestütztes Tool, das Geheimhaltungsvereinbarungen (NDAs) analysiert und potenzielle rechtliche Risiken identifiziert. Es bewertet NDAs anhand einer Reihe von Standardkriterien sowie der benutzerdefinierten Richtlinien Ihrer Organisation.

## Wie die Analyse funktioniert

### 1. Standard-Bewertungskriterien

Der NDA-Risikoanalyzer bewertet **immer** diese 8 Standardkriterien:

1. **Mutuality** (Einseitigkeit/Gegenseitigkeit): Ob das NDA gegenseitig oder einseitig ist
2. **Cooperation Subject** (Gegenstand der Zusammenarbeit): Klare Definition des Kooperationszwecks
3. **Confidential Information Definition** (Definition geheimer Informationen): Klarer Umfang dessen, was vertraulich ist
4. **Duration** (Dauer des NDA): Laufzeit
5. **Penalties** (Vertragsstrafen): Vertragsstrafen und Schadensersatz
6. **Third Party Disclosure** (Herausgabe an Dritte): Regeln für die Weitergabe an Dritte
7. **Project/Customer Protection** (Projekt-/Kundenschutz): Schutz von Geschäftsbeziehungen
8. **Non-Compete** (Wettbewerbsklausel): Wettbewerbsbeschränkungen

### 2. Benutzerdefinierte Richtlinien

Zusätzlich zu den Standardkriterien kann der Analyzer **zusätzliche Kriterien** basierend auf den benutzerdefinierten Richtlinien Ihrer Organisation bewerten. Die KI extrahiert und bewertet automatisch alle zusätzlichen Anforderungen, die Sie angeben (z.B. DSGVO-Konformität, Prüfrechte, Versicherungsanforderungen usw.). Die Regeln für die Standardkriterien können ebenfalls angepasst werden. Wir empfehlen jedoch nicht, Regeln für die Standardkriterien zu löschen.

## Standard-Richtlinien

Der NDA-Risikoanalyzer kommt mit den folgenden Standard-Richtlinien:

### Deutsche Standardregeln

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

## Risikoeinstufung

Der Analyzer verwendet ein dreistufiges Risikoeinstufungssystem:

| Risikostufe | Farbe | Beschreibung |
|-------------|-------|--------------|
| **ROT** 🔴 | Hohes Risiko | Problematische Klauseln, die gegen Richtlinien verstoßen ODER wichtige Klauseln, die vollständig fehlen |
| **GELB** 🟡 | Mittleres Risiko | Unklare Definitionen, unklare Begriffe, moderate Einschränkungen oder fehlende optionale Klauseln |
| **GRÜN** 🟢 | Geringes Risiko | Akzeptable Klauseln, die den Richtlinien entsprechen |

## Verwendung des NDA-Risikoanalyzers

### Schritt 1: Zugriff auf die App

Navigieren Sie zum NDA-Risikoanalyzer in Ihrer iHub Apps-Oberfläche.

### Schritt 2: Benutzerdefinierte Richtlinien konfigurieren (Optional)

Vor der Analyse Ihres NDAs können Sie die Richtlinien anpassen:

1. Suchen Sie das Textfeld **"Benutzerdefinierte Richtlinien"** oben in der App
2. Standardmäßig werden die Standard-Richtlinien der Organisation angezeigt
3. Sie können diese Regeln anpassen, um Ihren spezifischen Anforderungen zu entsprechen

**Regelformat:**
- Jede Regel sollte in einer separaten Zeile stehen
- Beginnen Sie mit einem Bindestrich `-`
- Fügen Sie den Kriteriumnamen und die Bedingungen hinzu
- Geben Sie Risikostufen an: ROT, GELB, GRÜN
- Beispiel: `- Laufzeit: Maximum 18 Monate akzeptabel (ROT wenn > 18 Monate, GELB wenn 12-18 Monate, GRÜN wenn < 12 Monate)`

### Schritt 3: NDA hochladen oder einfügen

Sie haben zwei Optionen:

**Option A: Dokument hochladen**
- Klicken Sie auf die Upload-Schaltfläche
- Wählen Sie Ihr NDA-Dokument aus (PDF, TXT oder Markdown-Format)
- Maximale Dateigröße: 10MB

**Option B: Text einfügen**
- Kopieren Sie den NDA-Text
- Fügen Sie ihn direkt in das Nachrichteneingabefeld ein

### Schritt 4: Analysieren

Klicken Sie auf die Absenden-Schaltfläche, um die Analyse zu starten. Die KI wird:
1. Alle 8 Standardkriterien bewerten
2. Zusätzliche Kriterien aus Ihren benutzerdefinierten Richtlinien extrahieren
3. Jedes Kriterium gegen den NDA-Text analysieren
4. Zitate bereitstellen (exakte Zitate aus dem NDA)
5. Risikostufen zuweisen (ROT/GELB/GRÜN)

### Schritt 5: Ergebnisse überprüfen

Die Ergebnisse werden in einem benutzerfreundlichen Format angezeigt:

- **Gesamtrisikobewertung**: Zusammenfassungskarte, die die höchste gefundene Risikostufe zeigt
- **Zusammenfassungsstatistik**: Anzahl der hohen, mittleren und niedrigen Risikoelemente
- **Detaillierte Analyse**: Einzelne Karten für jedes Kriterium mit:
  - Risikoindikator (farbcodiert)
  - Erklärung, warum die Risikostufe zugewiesen wurde
  - Erweiterbare Zitate aus dem NDA-Dokument

## Ändern benutzerdefinierter Regeln

Sie können die benutzerdefinierten Richtlinien jederzeit ändern:

1. **Vor der Analyse**: Bearbeiten Sie das Feld "Benutzerdefinierte Richtlinien", bevor Sie Ihr NDA einreichen
2. **Für neue Analyse**: Ändern Sie die Regeln und reichen Sie das NDA erneut mit den neuen Regeln ein

### Beispiel: Hinzufügen eines neuen Kriteriums

Um ein neues Kriterium hinzuzufügen (z.B. Datenschutz):

```
- Datenschutz: Muss DSGVO-Konformitätsklausel enthalten (ROT wenn fehlend, GELB wenn vage, GRÜN wenn explizite DSGVO-Konformität erwähnt)
```

Die KI wird dieses neue Kriterium automatisch erkennen und neben den 8 Standardkriterien bewerten.

### Beispiel: Ändern vorhandener Regeln

Um den Laufzeitschwellenwert zu ändern:

```
- Laufzeit: Maximum 18 Monate akzeptabel (ROT wenn > 18 Monate, GELB wenn 12-18 Monate, GRÜN wenn ≤ 12 Monate)
```

## Zurücksetzen auf Standardregeln

**Wichtig**: Wenn Sie die Seite aktualisieren oder die App neu starten, werden die benutzerdefinierten Richtlinien **automatisch auf die im System konfigurierten Standardregeln zurückgesetzt**.

So stellen Sie die Standardeinstellungen wieder her:
1. Aktualisieren Sie die Browser-Seite (F5 oder Strg+R / Cmd+R)
2. Oder löschen Sie das Feld "Benutzerdefinierte Richtlinien" und laden Sie die App neu

Die Standardregeln sind in der App-Konfigurationsdatei (`contents/apps/nda-risk-analyzer.json`) gespeichert und können nicht über die Benutzeroberfläche geändert werden. Wenden Sie sich an Ihren Administrator, um die systemweiten Standardregeln zu ändern.

## Tipps für beste Ergebnisse

1. **Seien Sie spezifisch**: Seien Sie bei der Definition benutzerdefinierter Regeln so spezifisch wie möglich darüber, was ROT, GELB und GRÜN ausmacht
2. **Verwenden Sie klare Sprache**: Schreiben Sie Regeln in klarer, eindeutiger Sprache
3. **Fügen Sie Schwellenwerte hinzu**: Geben Sie numerische Schwellenwerte an, wo zutreffend (z.B. "Maximum 24 Monate")
4. **Testen Sie schrittweise**: Beginnen Sie mit den Standardregeln und fügen Sie dann benutzerdefinierte Regeln einzeln hinzu
5. **Überprüfen Sie Zitate**: Erweitern und überprüfen Sie immer die Zitate, um die Interpretation der KI zu überprüfen

## Das Ausgabeschema verstehen

Der NDA-Risikoanalyzer gibt Ergebnisse in einem strukturierten JSON-Format zurück:

```json
{
  "overall_risk": "red|yellow|green",
  "criteria": [
    {
      "category": "Kriteriumsname",
      "citation": ["Zitat 1 aus NDA", "Zitat 2 aus NDA"],
      "risk_level": "red|yellow|green",
      "reason": "Erklärung der Risikobewertung"
    }
  ]
}
```

- **overall_risk**: Die höchste gefundene Risikostufe (rot wenn ein Kriterium rot ist, gelb wenn eines gelb ist, aber keines rot ist, sonst grün)
- **criteria**: Array mit mindestens 8 Elementen (die Standardkriterien) plus alle zusätzlichen Kriterien aus benutzerdefinierten Regeln

## Fehlerbehebung

### Problem: Nicht alle benutzerdefinierten Regeln werden bewertet

**Lösung**: Stellen Sie sicher, dass Ihre benutzerdefinierten Regeln klar formatiert sind mit expliziten Risikostufenindikatoren (ROT, GELB, GRÜN). Die KI extrahiert Kriterien basierend auf diesen Schlüsselwörtern.

### Problem: Zitate fehlen

**Lösung**: Einige Kriterien können leere Zitate haben, wenn die Klausel im NDA vollständig fehlt. Dies ist erwartetes Verhalten und wird als ROT markiert.

### Problem: Ergebnisse scheinen falsch

**Lösung**:
1. Überprüfen Sie die Zitate, um zu sehen, welchen Text die KI gefunden hat
2. Prüfen Sie, ob Ihre benutzerdefinierten Regeln spezifisch genug sind
3. Versuchen Sie, Ihre benutzerdefinierten Regeln mit klareren Bedingungen neu zu formulieren

## Administrator-Konfiguration

Die Standardregeln und das App-Verhalten sind konfiguriert in:

```
contents/apps/nda-risk-analyzer.json
```

Um systemweite Standardeinstellungen zu ändern:
1. Bearbeiten Sie das Feld `defaultValue` im Abschnitt `variables`
2. Speichern Sie die Datei
3. Die Änderungen werden automatisch angewendet (kein Server-Neustart erforderlich)

## Support

Für Fragen oder Probleme mit dem NDA-Risikoanalyzer:
- Kontaktieren Sie den iHub Apps-Administrator Ihrer Organisation
- Siehe die Haupt-iHub Apps-Dokumentation
- Melden Sie Fehler unter: https://github.com/intrafind/ihub-apps/issues
