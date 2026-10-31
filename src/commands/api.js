import { UsageError } from "../errors.js";
import { call } from "../http.js";
import { dataOption, readJson } from "../input.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export default {
    description: "Call any API endpoint directly.",
    options: {
        data: dataOption(),
        query: { value: "<key=value>", list: true, description: "Query parameter. Repeatable." },
        header: { alias: "H", value: "<name:value>", list: true, description: "Extra request header. Repeatable." },
        output: { alias: "o", value: "<file>", description: "Write the response to a file." }
    },
    args: "<method> <path>",
    minArgs: 2,
    async run(ctx) {
        const [method, path] = ctx.args;
        const upper = method.toUpperCase();

        if (!METHODS.includes(upper)) {
            throw new UsageError(`Unsupported method "${method}". Use ${METHODS.join(", ")}.`);
        }

        const split = (value, separator) => {
            const index = value.indexOf(separator);
            if (index < 1) throw new UsageError(`Invalid value "${value}". Expected name${separator}value.`);
            return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
        };

        await call(ctx, upper, path.startsWith("/") ? path : `/${path}`, {
            body: ctx.options.data === undefined ? undefined : await readJson(ctx.options.data),
            query: Object.fromEntries((ctx.options.query ?? []).map(value => split(value, "="))),
            headers: Object.fromEntries((ctx.options.header ?? []).map(value => split(value, ":")))
        });
    }
};
