import { call } from "../http.js";
import { openFile } from "../input.js";
import { confirm } from "../prompt.js";

const user = { alias: "u", value: "<id>", required: true, description: "Shell user identifier (X-Shell-User-Id)." };

const path = { alias: "p", value: "<path>", required: true, description: "Path inside the shell sandbox." };

const shellCall = (ctx, method, route, options = {}) => call(ctx, method, `/api/v1/shell/io${route}`, {
    ...options,
    query: { path: ctx.options.path },
    headers: { "X-Shell-User-Id": ctx.options.user }
});

const destructive = (noun, route) => ({
    description: `Delete a ${noun}.`,
    options: { user, path },
    async run(ctx) {
        await confirm(ctx, `Delete ${noun} ${ctx.options.path}?`);
        await shellCall(ctx, "DELETE", route);
    }
});

export default {
    description: "Shell sandbox file commands.",
    commands: {
        ls: { description: "List a directory.", options: { user, path }, run: ctx => shellCall(ctx, "GET", "/listing") },
        stat: { description: "Show file details.", options: { user, path }, run: ctx => shellCall(ctx, "GET", "/file/details") },
        download: {
            aliases: ["get"],
            description: "Download a file.",
            options: { user, path, output: { alias: "o", value: "<file>", description: "Local output file." } },
            run: ctx => shellCall(ctx, "GET", "/file", { agentOutput: false })
        },
        upload: {
            aliases: ["put"],
            description: "Upload a local file.",
            options: { user, path, file: { alias: "f", value: "<file>", required: true, description: "Local file to upload." } },
            run: async ctx => shellCall(ctx, "POST", "/file", { body: await openFile(ctx.options.file) })
        },
        publish: { description: "Get a temporary public URL for a file.", options: { user, path }, run: ctx => shellCall(ctx, "GET", "/file/public-address") },
        mkdir: { description: "Create a directory.", options: { user, path }, run: ctx => shellCall(ctx, "POST", "/directory") },
        rm: destructive("file", "/file"),
        rmdir: destructive("directory", "/directory")
    }
};
