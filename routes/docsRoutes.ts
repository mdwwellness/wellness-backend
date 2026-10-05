import express from "express";
import { openapiSpec, PRODUCTION_URL } from "../lib/openapi.ts";

// Scalar API reference from the CDN (no npm dependency), reading the spec from
// this same server, so "Try it out" is same-origin and needs no CORS entry.
// Pinned version + SRI hash: a changed or tampered CDN file won't run here.
const SCALAR_SRC = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.4/dist/browser/standalone.js";
const SCALAR_SRI = "sha384-omTRdD9MbjA1vm12DqRUVvqJlr3VzSixvAdF1Jruu9AJOiJKyTKraIB6DyX+m10M";

// Everything Scalar would otherwise send to its own servers is switched off:
// - proxyUrl "": its browser build defaults to routing "Try it out" requests
//   (phone numbers, OTPs, tokens) through proxy.scalar.com;
// - telemetry, the "Ask AI" agent (uploads the spec), MCP, hosted fonts, the
//   developer toolbar (its Share / Deploy push the spec to Scalar's cloud) and
//   the "Open API Client" link (Scalar's hosted client, which uses their proxy).
const CONFIG = {
  url: "/api/docs/openapi.json",
  proxyUrl: "",
  telemetry: false,
  agent: { disabled: true },
  mcp: { disabled: true },
  withDefaultFonts: false,
  showDeveloperTools: "never",
  hideClientButton: true,
  defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
  authentication: { preferredSecurityScheme: "bearer" },
  metaData: { title: "MDW Wellness API" },
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MDW Wellness API</title>
</head>
<body>
  <div id="app"></div>
  <script src="${SCALAR_SRC}" integrity="${SCALAR_SRI}" crossorigin="anonymous"></script>
  <script>
    // "Try it out" defaults to the server this page came from; production stays
    // selectable when the page is opened anywhere else (e.g. localhost).
    var here = window.location.origin;
    var config = ${JSON.stringify(CONFIG)};
    config.servers = [{ url: here, description: here === "${PRODUCTION_URL}" ? "Production" : "This server" }];
    if (here !== "${PRODUCTION_URL}") config.servers.push({ url: "${PRODUCTION_URL}", description: "Production" });
    Scalar.createApiReference("#app", config);
  </script>
</body>
</html>`;

const docsRouter = express.Router();
docsRouter.get("/openapi.json", (_req, res) => res.json(openapiSpec));
docsRouter.get("/", (_req, res) => res.type("html").send(PAGE));

export default docsRouter;
