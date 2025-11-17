# iHub FAQ - Häufig gestellte Fragen

## Allgemeine Fragen

### Was ist iHub?
iHub ist eine komplette Installationspaketlösung (ZIP oder Container Image) von IntraFind für KI-gestützte Micro-Apps. Es ist sofort einsetzbar und kann on-premises oder DSGVO-konform in der Cloud betrieben werden.

### Ist iHub kostenlos?
Ja, iHub ist kostenlos und sofort einsetzbar. Die Micro-Apps sind zudem erweiterbar.

## Hardware & Infrastruktur

### Welche Hardware benötige ich für den iHub?
**Für den iHub selbst (ohne lokales LLM):**
- Sie benötigen nur eine normale Arbeitsstation oder VM mit Windows/macOS/Linux
- Keine GPU ist erforderlich, solange Sie ein externes LLM per API nutzen

**Wenn Sie ein lokales LLM betreiben möchten:**
- Die eigene GPU-Nutzung wird individuell mit IntraFind abgestimmt
- Alternativ kann IntraFind den LLM-Betrieb auf dedizierter GPU-Hardware in deutschen Rechenzentren für Sie übernehmen

### Welche GPU benötige ich?
Die GPU-Auswahl erfolgt fallbezogen gemeinsam mit IntraFind, abhängig von:
- Ihrem konkreten Use-Case
- Der gewünschten Modellgröße
- Ziel-Latenz und Nutzerzahl
- IntraFind berät Sie zur passenden GPU-Klasse oder bietet alternativ Managed-Betrieb an

## LLM-Integration

### Welche LLM-Betriebsoptionen gibt es?
1. **Cloud-LLM**: OpenAI, Mistral, Anthropic, Google mit API-Key (keine lokale GPU nötig)
2. **IntraFind-betriebenes LLM**: Dedizierte GPU-Hardware in deutschen Rechenzentren, mandantengetrennt und Ende-zu-Ende-verschlüsselt
3. **Eigenes lokales LLM**: Betrieb in Ihrer eigenen Infrastruktur mit eigener GPU (muss OpenAI API-kompatibel sein - wie LM Studio, ollama, llama.cpp, vLLM oder ähnlich)

### Wo kann ich ein LLM herunterladen?
**Option A - Cloud-Anbieter (kein Download nötig):**
- Nutzen Sie OpenAI, Mistral, Anthropic oder Google
- Tragen Sie einfach den API-Key im iHub ein

**Option B - LLM by IntraFind (kein Download durch Sie):**
- IntraFind betreibt dedizierte Open-Source-Modelle für Sie
- Verbindung per gesicherter Leitung ohne eigenes Modell

**Option C - Eigenes lokales LLM:**
- Download über gängige Model-Repos
- Konkrete Modellwahl wird projektbezogen mit IntraFind abgestimmt

### Wohin installiere ich das LLM?
- **Cloud-LLM**: Kein Install-Ziel nötig, nur API-Key eintragen
- **LLM durch IntraFind**: Läuft in der IntraFind-Cloud auf dedizierter GPU
- **Eigenes lokales LLM**: Installation in Ihrer Infrastruktur (Server/VM mit GPU)

### Wie binde ich das LLM in den iHub ein?
1. **iHub herunterladen & entpacken**
2. **API-Zugriff wählen:**
   - Cloud-Modelle: API-Key in `config.env` eintragen
   - Lokales Modell: Model-Konfig in `contents/models/local-vllm.json` anpassen oder neue erstellen
3. **iHub starten** mit dem passenden Start-Script
4. **Browser öffnen**: http://localhost:3001/

## Installation & Konfiguration

### Wie installiere ich iHub in 10 Minuten?
1. **iHub herunterladen** von der Produktseite oder GitHub
2. **ZIP entpacken**
3. **LLM-Option wählen**: Cloud-LLM, IntraFind-LLM oder eigenes lokales LLM
4. **Konfigurieren**: `config.env` mit API-Keys befüllen oder `contents/models/local-vllm.json` oder ähnlich anpassen
5. **Starten**: Passendes Start-Script ausführen (`.bat` für Windows, `.sh` für macOS/Linux) oder Container starten
6. **Browser öffnen**: http://localhost:3001/
7. **Testen**: Mitgelieferte Micro-Apps ausprobieren

### Was muss ich beim iHub noch konfigurieren?
- **config.env**: API-Keys für Cloud-Modelle eintragen
- **Model-Profile**: Bei lokalem LLM `contents/models/local-vllm.json` anpassen
- **Sicherer Betrieb**: E2E-Verschlüsselung und IP-Whitelisting bei IntraFind-LLM
- **Betriebsart**: Wahl zwischen on-premises oder Cloud-Betrieb

### Welche Cloud-Anbieter werden unterstützt?
- Google
- Mistral
- Anthropic
- OpenAI/Azure OpenAI

## Micro-Apps & Prompts

### Wie erstelle ich einen Prompt und eine neue Kachel?
1. **Bestehende Micro-App als Vorlage nutzen** (empfohlen):
   - iHub starten
   - Vorhandene Micro-App wählen (z.B. "E-Mail verfassen")
   - Einstellungen/Duplizieren
   - Prompt-Bausteine anpassen
   - Die Kachel erscheint automatisch im iHub-Startscreen

2. **Eigene Micro-App erstellen**:
   - GitHub-Repo enthält Beispiele und Dokumentation
   - Siehe Ordner `examples`, `docs`, sowie `AGENTS.md` und `LLM_GUIDELINES.md`
   - Komplette Dokumentation im laufenden iHub unter `/help`

### Sind Prompt-Kenntnisse erforderlich?
Nein, der iHub ist explizit auf "keine Prompt-Kenntnisse nötig" ausgelegt. Die Eingabemasken führen zum gewünschten Ergebnis.

### Wo finde ich weitere KI-Assistenten/iHub-Kacheln?
- **Offizielles iHub-Repo**: [github.com/intrafind/ihub-apps](https://github.com/intrafind/ihub-apps)
  - Beispiel-Apps
  - Dokumentation
  - Releases
- **IntraFind GitHub-Organisation**: [github.com/intrafind](https://github.com/intrafind)
- **IntraFind iHub Homepage**: [intrafind.com/ihub](http://intrafind.com/ihub)

## Sicherheit & Datenschutz

### Ist der iHub DSGVO-konform?
Ja, der iHub kann DSGVO-konform in der Cloud betrieben werden. Bei der IntraFind-LLM-Variante werden zudem:
- Ende-zu-Ende-Verschlüsselung verwendet
- IP-Whitelisting eingesetzt
- Daten nicht für Trainingszwecke genutzt
- Mandantentrennung gewährleistet

### Wo werden die Daten verarbeitet?
Je nach gewählter Option:
- **Cloud-LLM**: Beim jeweiligen Cloud-Anbieter
- **IntraFind-LLM**: In deutschen Rechenzentren (AWS, Azure, Hetzner)
- **Lokales LLM**: In Ihrer eigenen Infrastruktur

## Support & Dokumentation

### Wo finde ich die vollständige Dokumentation?
- **Im laufenden iHub**: Unter `/help` als mdBook
- **GitHub-Repository**: [github.com/intrafind/ihub-apps](https://github.com/intrafind/ihub-apps)
- **Dateien im iHub-Paket**: Ordner `docs` mit Anleitungen

### Wie erhalte ich Support?
- Konsultieren Sie zunächst die integrierte Dokumentation unter `/help`
- Prüfen Sie das GitHub-Repository für aktuelle Updates
- Kontaktieren Sie IntraFind für projektbezogene Beratung zu Modellauswahl und GPU-Konfiguration

### Welche Dateien sind für die Konfiguration wichtig?
- `config.env`: API-Keys für Cloud-Modelle
- `contents/models/local-vllm.json`: Konfiguration für lokale Modelle
- Start-Scripts: `ihub-apps-<version>-win.bat` / `-macos` / `-linux`

## Technische Details

### Welche Betriebssysteme werden unterstützt?
- Windows
- macOS
- Linux 

### Auf welchem Port läuft der iHub?
Der iHub läuft standardmäßig auf Port 3001 (http://localhost:3001/)

### Kann ich eigene Micro-Apps entwickeln?
Ja, der iHub ist erweiterbar. Sie können:
- Bestehende Apps duplizieren und anpassen
- Neue Apps basierend auf den Beispielen erstellen
- Die Dokumentation unter `/help` für Entwicklungsanleitungen nutzen

## Schnellstart-Anleitung

### Mit iHub starten - Schritt für Schritt
1. **iHub herunterladen** von [github.com/intrafind/ihub-apps](https://github.com/intrafind/ihub-apps)
2. **ZIP-Datei entpacken**
3. **LLM-Ansatz wählen**:
   - Cloud-LLM (API-Key erforderlich)
   - LLM via IntraFind (Managed Service)
   - Eigenes lokales LLM (GPU erforderlich)
4. **Konfigurieren**:
   - Für Cloud: API-Keys zu `config.env` hinzufügen
   - Für lokal: `contents/models/local-vllm.json` anpassen
5. **iHub starten**:
   - Windows: `ihub-apps-<version>-win.bat` ausführen
   - macOS: `ihub-apps-<version>-macos` ausführen
   - Linux: `ihub-apps-<version>-linux` ausführen
6. **Browser öffnen**: Zu http://localhost:3001/ navigieren
7. **Testen**: Eine der vorinstallierten Micro-Apps ausprobieren

### Best Practices für Einsteiger
- Beginnen Sie mit Cloud-LLMs für die einfachste Einrichtung
- Verwenden Sie bestehende Micro-Apps als Vorlagen
- Konsultieren Sie die `/help` Dokumentation im laufenden iHub
- Beginnen Sie mit einfachen Prompt-Modifikationen, bevor Sie neue Apps erstellen

## Erweiterte Themen

### Mandantenfähiger Betrieb
Bei Nutzung des verwalteten LLM-Service von IntraFind:
- Vollständige Mandantentrennung ist gewährleistet
- Jeder Kunde erhält dedizierte GPU-Ressourcen
- Datenisolation ist garantiert
- Keine Kreuzkontamination zwischen Kunden

### Skalierungsüberlegungen
- Für Anwendungsfälle mit hohem Volumen konsultieren Sie IntraFind
- GPU-Anforderungen skalieren mit:
  - Anzahl gleichzeitiger Benutzer
  - Modellgröße
  - Erforderliche Antwortzeit
- IntraFind kann maßgeschneiderte Empfehlungen geben

### Integrationsmöglichkeiten
- iHub kann in bestehende IT-Landschaften integriert werden
- API-Zugriff für programmatische Interaktion
- Anpassbare Micro-Apps für spezifische Workflows
- Unterstützung verschiedener Authentifizierungsmethoden (siehe Dokumentation)
