import { basename } from "node:path";
import { call } from "../http.js";
import { contentPart, openFile } from "../input.js";
import { confirm } from "../prompt.js";
import { crud } from "./crud.js";

const fields = {
    slug: { value: "<slug>", description: "Skill slug." },
    description: { value: "<text>", description: "Skill description." },
    instructions: { alias: "i", value: "<text>", source: true, description: "Skill instructions. Use @file or - to read them." }
};

export default {
    description: "Skills management commands.",
    commands: {
        ...crud({ base: "/api/v1/skills", noun: "skill", updateMethod: "PUT", fields }),
        import: {
            description: "Import skills from a JSONL file. Existing skills with the same slug are overwritten.",
            options: { file: { alias: "f", value: "<file>", required: true, description: "JSONL file with one skill per line." } },
            async run(ctx) {
                const form = new FormData();
                form.append("skills", await openFile(ctx.options.file), basename(ctx.options.file));

                await call(ctx, "POST", "/api/v1/skills/management/import", { body: form });
            }
        },
        export: {
            description: "Export every skill as JSONL.",
            options: { output: { alias: "o", value: "<file>", description: "Write the export to a file." } },
            run: ctx => call(ctx, "GET", "/api/v1/skills/management/export.jsonl", { agentOutput: false })
        },
        clear: {
            description: "Delete every skill of the account.",
            async run(ctx) {
                await confirm(ctx, "Delete every skill of the account?");
                await call(ctx, "DELETE", "/api/v1/skills/management/clear");
            }
        },
        teach: {
            description: "Generate skill instructions from tutorial videos.",
            options: { file: { alias: "f", value: "<file|url>", list: true, required: true, description: "Tutorial video file or URL. Repeatable." } },
            async run(ctx) {
                const videos = await Promise.all(ctx.options.file.map(contentPart));
                await call(ctx, "POST", "/api/v1/generations/teach-skill", { body: { videos } });
            }
        }
    }
};
