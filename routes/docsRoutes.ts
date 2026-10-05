import express from "express";
import { openapiSpec } from "../lib/openapi.ts";

// Swagger UI from the CDN (no npm dependency), reading the spec from this same
// server, so "Try it out" is same-origin and never needs a CORS allow-list entry.
const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MDW Wellness API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: "/api/docs/openapi.json", dom_id: "#swagger", deepLinking: true });
  </script>
</body>
</html>`;

const docsRouter = express.Router();
docsRouter.get("/openapi.json", (_req, res) => res.json(openapiSpec));
docsRouter.get("/", (_req, res) => res.type("html").send(PAGE));

export default docsRouter;
