/*
Copyright 2026 zeront4e (https://github.com/zeront4e)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { join } from "path";
import { openapiSpec } from "../openapi.js";

const SWAGGER_DIR = join(import.meta.dir, "../../static/swagger");

const ASSET_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PocketTTS Server - API Docs</title>
  <link rel="stylesheet" href="/swagger/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger/swagger-ui-bundle.js"></script>
  <script src="/swagger/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
        filters: true,
      });
    };
  </script>
</body>
</html>`;

export function docsHtml(_req: Request): Response {
  return new Response(DOCS_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function openapiJson(_req: Request): Response {
  return Response.json(openapiSpec());
}

// Serves /swagger/<file> from static/swagger (vendored, works offline).
export function swaggerAsset(req: Request, fileName: string): Response {
  if (fileName.includes("..") || fileName.includes("/")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  
  const file = Bun.file(join(SWAGGER_DIR, fileName));
  
  const size = file.size;
  
  if (size === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  
  const mime = ASSET_MIME[fileName.slice(fileName.lastIndexOf("."))] ?? "application/octet-stream";

  return new Response(file, {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
