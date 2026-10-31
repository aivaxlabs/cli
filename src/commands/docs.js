import { UsageError } from "../errors.js";
import { fetchData, print, request } from "../http.js";

const REFERENCE_URL = "https://inference.aivax.net/apidocs/llms.txt";

const GUIDE = `AIVAX CLI guidance

Authentication
  aivax auth login                       Prompts for the login key and, when enabled, the 2FA code.
  aivax auth login --login-key <key> --2fa <code> --profile-name work
  AIVAX_API_KEY=<key> aivax ...          Uses an API key instead of a saved profile.
  AIVAX_ENDPOINT=<url> aivax ...         Overrides the API endpoint.

Request bodies
  -d '{"json": true}'                    Inline JSON body.
  -d @body.json                          Reads the body from a file.
  -d -                                   Reads the body from stdin.
  Field flags (such as --name) are merged over the -d body.

Output
  Responses are agent-optimized by default (X-Response-Truncating: agent-optimized).
  Use --verbose for the complete JSON response.
  Use -o <file> on export and download commands to save the result.

Destructive commands
  Delete, reset, clear and similar commands ask for confirmation. Pass --yes to skip it.

Raw access
  aivax api <METHOD> <path> [-d body]    Calls any endpoint not covered by a dedicated command.

API reference
  aivax docs reference                   Lists every endpoint.
  aivax docs reference <Endpoint>        Shows one endpoint, e.g. "aivax docs reference EditAIGateway".
  aivax docs search <terms...>           Semantic search over the manual and API reference.
`;

const reference = {
    description: "Show the API reference index, or one endpoint by name.",
    args: "[endpoint]",
    async run(ctx) {
        const url = new URL(REFERENCE_URL);
        if (ctx.args[0]) url.searchParams.set("endpoint", ctx.args[0]);

        const response = await fetch(url, { headers: { "X-Response-Truncating": "agent-optimized" } });
        print(await response.text());
    }
};

const search = {
    description: "Search the AIVAX manual and API reference.",
    options: {
        type: { alias: "t", value: "<library>", description: "api-function-reference, documentation-manual or all (default)." }
    },
    args: "<terms...>",
    minArgs: 1,
    async run(ctx) {
        const response = await request(ctx, "POST", "/v1/mcp/documentation", {
            agentOutput: false,
            headers: { Accept: "application/json, text/event-stream" },
            body: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name: "aivax_search_documentation",
                    arguments: { search_terms: ctx.args, search_type: ctx.options.type ?? "all" }
                }
            }
        });

        const message = await response.json();
        if (message.error) {
            throw new UsageError(message.error.message);
        }

        print(message.result.content.map(part => part.text).join("\n"));
    }
};

export default {
    description: "Documentation-specific commands and CLI guidance.",
    commands: {
        guide: { description: "Show CLI usage guidance.", run: () => print(GUIDE) },
        reference,
        search,
        setup: {
            description: "Generate a setup prompt URL to configure an agent with this account.",
            run: async ctx => print(await fetchData(ctx, "GET", "/api/v1/accounts/agent-setup-prompt"))
        }
    }
};
