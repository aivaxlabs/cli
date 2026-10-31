import { UsageError } from "../errors.js";
import { call, seg } from "../http.js";
import { dataOption, payload, readJson, readSource } from "../input.js";

import { confirm } from "../prompt.js";
export const idOption = noun => ({ value: "<id>", required: true, description: `${noun} identifier.` });

export const filterOption = { alias: "q", value: "<text>", description: "Optional search text." };

async function body(ctx, fields) {
    const entries = await Promise.all(Object.entries(fields).map(async ([key, spec]) => {
        const value = ctx.options[key];

        if (value === undefined) {
            return [spec.key ?? key, undefined];
        }

        return [spec.key ?? key, spec.json ? await readJson(value, `--${key}`) : spec.source ? await readSource(value) : value];
    }));

    const result = await payload(ctx, Object.fromEntries(entries));

    if (!Object.keys(result).length) {
        throw new UsageError(`Provide the request body with -d or with the field options.`);
    }

    return result;
}

export function crud({ base, noun, plural = `${noun}s`, updateMethod = "PATCH", fields = {} }) {
    const item = ctx => `${base}/${seg(ctx.options.id)}`;
    const id = { id: idOption(noun) };

    return {
        list: {
            aliases: ["ls"],
            description: `List ${plural}.`,
            options: { filter: filterOption },
            run: ctx => call(ctx, "GET", base, { query: { filter: ctx.options.filter } })
        },
        get: {
            aliases: ["view"],
            description: `Show one ${noun}.`,
            options: id,
            run: ctx => call(ctx, "GET", item(ctx))
        },
        create: {
            description: `Create a ${noun}.`,
            options: { data: dataOption(), ...fields },
            run: async ctx => call(ctx, "POST", base, { body: await body(ctx, fields) })
        },
        patch: {
            aliases: ["update", "edit"],
            description: `Update a ${noun}. Send only the fields to change.`,
            options: { ...id, data: dataOption(), ...fields },
            run: async ctx => call(ctx, updateMethod, item(ctx), { body: await body(ctx, fields) })
        },
        delete: {
            aliases: ["rm"],
            description: `Delete a ${noun}.`,
            options: id,
            run: async ctx => {
                await confirm(ctx, `Delete ${noun} ${ctx.options.id}?`);
                await call(ctx, "DELETE", item(ctx));
            }
        }
    };
}
