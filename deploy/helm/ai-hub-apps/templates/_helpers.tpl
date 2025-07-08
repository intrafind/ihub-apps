{{- define "ai-hub-apps.name" -}}
ai-hub-apps
{{- end -}}

{{- define "ai-hub-apps.fullname" -}}
{{ include "ai-hub-apps.name" . }}
{{- end -}}
