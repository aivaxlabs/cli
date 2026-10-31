export class UsageError extends Error { }

export class ApiError extends Error {
    constructor(status, body, headers) {
        let message = body.trim();

        try {
            const parsed = JSON.parse(body);
            message = [parsed.error?.message ?? parsed.error ?? parsed.message, parsed.details && JSON.stringify(parsed.details)]
                .filter(Boolean)
                .join(" ") || message;
        }
        catch { }

        super(message || `HTTP ${status}`);
        this.status = status;
        this.retryAfter = Number.parseFloat(headers?.get("retry-after") ?? "") * 1000 || 0;
    }
}
