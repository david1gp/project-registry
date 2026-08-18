export const caddyDocsTemplate = `{{ $doc := placeholder "http.regexp.project_docs.1" }}{{ if not (fileExists $doc) }}{{ httpError 404 }}{{ end }}<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{ $doc }}</title><style>body{max-width:72rem;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif;color:#1f2937}pre{overflow:auto;padding:1rem;background:#f3f4f6}code{font-family:ui-monospace,monospace}img{max-width:100%}</style></head>
<body><main>{{ markdown (readFile $doc) }}</main></body>
</html>`
