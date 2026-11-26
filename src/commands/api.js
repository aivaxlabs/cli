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

        let route = path.startsWith("/") ? path : `/${path}`;

        // Quick fix: Git Bash (MSYS) rewrites "/api/..." into "C:/<git>/api/..." before Node receives it.
        // The route is recovered from the first "/api/" or "/v1/" segment, so routes with other prefixes fail.
        // The real fix is on the caller side (MSYS_NO_PATHCONV=1 or "api/..."), since the original argument is lost.
        if (/^\/?[A-Za-z]:[\\/]/.test(path)) {
            const index = path.search(/\/(api|v1)\//);

            if (index < 0) {
                throw new UsageError(
                    `Path "${path}" looks like a Windows path. Git Bash converts arguments starting with "/" into paths; `
                    + `run with MSYS_NO_PATHCONV=1 or write the route without the leading slash ("api/...").`
                );
            }

            route = path.slice(index);
        }

        await call(ctx, upper, route, {
            body: ctx.options.data === undefined ? undefined : await readJson(ctx.options.data),
            query: Object.fromEntries((ctx.options.query ?? []).map(value => split(value, "="))),
            headers: Object.fromEntries((ctx.options.header ?? []).map(value => split(value, ":")))
        });
    }
};
