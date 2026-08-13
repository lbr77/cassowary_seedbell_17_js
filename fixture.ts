import { resolve } from "node:path";

const root = resolve(import.meta.dir, "standalone");
const port = Number(Bun.env.SEEDBELL_PORT ?? "8137");
const mimeTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
]);

function contentType(path: string): string {
    for (const [extension, mimeType] of mimeTypes) {
        if (path.endsWith(extension))
            return mimeType;
    }
    return "application/octet-stream";
}

const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/report") {
            const message = url.searchParams.get("message");
            if (message === null)
                throw new Error("missing report message");
            process.stdout.write(`[DEVICE] ${message}\n`);
            return new Response("ok", { headers: { "Cache-Control": "no-store" } });
        }

        const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const filePath = resolve(root, `.${decodeURIComponent(requestedPath)}`);
        if (!filePath.startsWith(`${root}/`))
            throw new Error("request escaped fixture root");

        const file = Bun.file(filePath);
        if (!await file.exists())
            return new Response("missing", { status: 404 });

        return new Response(file, {
            headers: {
                "Cache-Control": "no-store",
                "Content-Type": contentType(filePath),
            },
        });
    },
});

process.stdout.write(`Seedbell fixture listening on http://192.168.2.100:${server.port}/\n`);
