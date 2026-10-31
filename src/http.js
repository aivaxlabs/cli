import { stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Agent, fetch as fetchWithoutTimeouts } from "undici";
import { ApiError, UsageError } from "./errors.js";
import { defaultEndpoint, resolveSession } from "./profiles.js";

export const VERSION = "1.1";

export const seg = encodeURIComponent;

const LONG_REQUEST_TIMEOUT_MS = 20 * 60_000;

// The global fetch gives up after 5 minutes without headers. Long routes only send JSON bodies,
// so undici's own fetch is safe here (it does not serialize the global FormData).
const noTimeouts = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// AI inference calls go to the direct host, which is not behind the Cloudflare request timeout.
// The pattern mirrors the direct host allowlist; any other route returns 404 there.
const LONG_INFERENCE_ROUTE = /^\/(?:v1\/chat\/completions|api\/v1\/(?:chat\/completions|generations\/.+|query|answer|web\/fetch|public\/chat-clients\/[^/]+\/prompt))$/i;

const directEndpoint = endpoint => endpoint.replace(/^(https?:\/\/)inference\.aivax\.net/i, "$1direct.inference.aivax.net");

const isRawBody = body => body instanceof FormData
    || body instanceof Blob
    || body instanceof Uint8Array
    || body instanceof ArrayBuffer;

function buildUrl(endpoint, path, query = {}) {
    const url = new URL(path, endpoint);

    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }

    return url;
}

export async function request(ctx, method, path, options = {}) {
    const {
        query,
        body,
        headers = {},
        auth = true,
        signal,
        agentOutput = !ctx.options.verbose
    } = options;

    const session = auth
        ? await resolveSession(ctx)
        : { endpoint: options.endpoint ?? defaultEndpoint() };

    const init = {
        method,
        signal,
        headers: { "User-Agent": `aivax-cli/${VERSION}`, ...headers }
    };

    if (session.token) {
        init.headers.Authorization = `Bearer ${session.token}`;
    }

    if (agentOutput) {
        init.headers["X-Response-Truncating"] = "agent-optimized";
    }

    if (body !== undefined) {
        init.body = isRawBody(body) ? body : JSON.stringify(body);

        if (!isRawBody(body)) {
            init.headers["Content-Type"] = "application/json";
        }
    }

    const longRunning = method === "POST" && LONG_INFERENCE_ROUTE.test(path.split("?")[0]);

    if (longRunning) {
        init.dispatcher = noTimeouts;
        init.signal = AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS);
    }

    const url = buildUrl(longRunning ? directEndpoint(session.endpoint) : session.endpoint, path, query);
    const response = longRunning ? await fetchWithoutTimeouts(url, init) : await fetch(url, init);

    if (!response.ok) {
        throw new ApiError(response.status, await response.text(), response.headers);
    }

    return response;
}

function unwrap(value) {
    while (value && typeof value === "object" && !Array.isArray(value) && "data" in value && "message" in value) {
        value = value.data;
    }

    return value;
}

export async function fetchData(ctx, method, path, options = {}) {
    const response = await request(ctx, method, path, { ...options, agentOutput: false });
    const text = await response.text();

    return text ? unwrap(JSON.parse(text)) : null;
}

export function print(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export async function output(ctx, response) {
    const type = response.headers.get("content-type") ?? "";

    if (ctx.options.output) {
        await writeFile(ctx.options.output, response.body ?? "");
        const { size } = await stat(ctx.options.output);
        process.stderr.write(`Saved ${size.toLocaleString("en-US")} bytes to ${ctx.options.output}\n`);
        return;
    }

    const isText = /json|toon|text|xml|jsonl|ndjson|event-stream/.test(type) || type === "";

    if (!isText) {
        if (process.stdout.isTTY) {
            throw new UsageError(`The response is binary (${type}). Use -o <file> to save it.`);
        }

        if (response.body) await pipeline(response.body, process.stdout, { end: false });
        return;
    }

    const text = await response.text();
    if (!text) {
        return;
    }

    if (ctx.options.verbose && type.includes("application/json")) {
        try {
            print(JSON.parse(text));
            return;
        }
        catch { }
    }

    print(text);
}

export async function call(ctx, method, path, options) {
    await output(ctx, await request(ctx, method, path, options));
}

export async function* events(response) {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });

        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);

            if (line.startsWith("data:")) {
                yield line.slice(5).trim();
            }
        }
    }

    if (buffer.startsWith("data:")) {
        yield buffer.slice(5).trim();
    }
}
