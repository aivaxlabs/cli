import { openAsBlob } from "node:fs";
import { basename, extname } from "node:path";
import { text } from "node:stream/consumers";
import mime from "mime";
import { UsageError } from "./errors.js";

export const isUrl = value => /^https?:\/\//i.test(value);

const fileType = path => mime.getType(path) ?? "application/octet-stream";

export async function openFile(path) {
    try {
        return await openAsBlob(path, { type: fileType(path) });
    }
    catch {
        throw new UsageError(`File not found: ${path}`);
    }
}

export async function readSource(value) {
    if (value === "-" || value === "@-") {
        return await text(process.stdin);
    }

    if (value.startsWith("@")) {
        return await (await openFile(value.slice(1))).text();
    }

    return value;
}

export async function readJson(value, flag = "--data") {
    const text = await readSource(value);

    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new UsageError(`${flag} is not valid JSON: ${error.message}`);
    }
}

export async function readContent(value, flag) {
    const text = await readSource(value);

    if (!/^\s*[[{]/.test(text)) {
        return text;
    }

    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new UsageError(`${flag} is not valid JSON: ${error.message}`);
    }
}

export async function payload(ctx, fields = {}) {
    const data = ctx.options.data === undefined ? {} : await readJson(ctx.options.data);
    const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

    return Object.keys(defined).length ? { ...data, ...defined } : data;
}

export async function base64(path) {
    const file = await openFile(path);
    return Buffer.from(await file.arrayBuffer()).toString("base64");
}

export async function dataUrl(path) {
    const file = await openFile(path);
    return `data:${file.type};base64,${await base64(path)}`;
}

export async function contentPart(source) {
    const remote = isUrl(source);
    const type = fileType(remote ? new URL(source).pathname : source);
    const kind = type.split("/")[0];
    const url = remote ? source : await dataUrl(source);

    if (kind === "image") {
        return { type: "image_url", image_url: { url } };
    }

    if (kind === "video") {
        return { type: "video_url", video_url: { url } };
    }

    if (kind === "audio" && !remote) {
        return { type: "input_audio", input_audio: { data: await base64(source), format: extname(source).slice(1).toLowerCase() } };
    }

    if (kind === "text" && !remote) {
        return { type: "text", text: await (await openFile(source)).text() };
    }

    return { type: "file", file: { filename: basename(remote ? new URL(source).pathname : source), file_data: url } };
}

export async function documentParts(ctx) {
    const parts = [
        ...await Promise.all((ctx.options.file ?? []).map(contentPart)),
        ...(ctx.options.text ?? []).map(text => ({ type: "text", text }))
    ];

    if (!parts.length) {
        throw new UsageError("Provide at least one document with -f <file|url> or --text <text>.");
    }

    return parts;
}

export async function textDocuments(ctx) {
    const documents = [
        ...await Promise.all((ctx.options.file ?? []).map(async path => (await openFile(path)).text())),
        ...(ctx.options.document ?? [])
    ];

    if (!documents.length) {
        throw new UsageError("Provide at least one document with -f <file> or --document <text>.");
    }

    return documents;
}

export const fileOption = description => ({ alias: "f", value: "<file>", list: true, description });

export const textOption = { value: "<text>", list: true, description: "Inline text document. Repeatable." };

export const dataOption = (required = false) => ({
    alias: "d",
    value: "<json>",
    required,
    description: "JSON request body, @file to read it from a file, or - for stdin."
});
