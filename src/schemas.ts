import { z } from "zod";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const MAX_PATH_LENGTH = 256;
export const MAX_REQUEST_BYTES = 512 * 1024;

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Normalise a memory path: trim, lowercase, ensure a leading `/` and a `.md`
 * suffix, collapse duplicate slashes. Every segment must be `[a-z0-9._-]` and
 * must not start with a dot, so `..` traversal is impossible.
 */
export const pathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .transform((raw) => {
    let p = raw.trim().toLowerCase().replace(/\/+/g, "/");
    if (!p.startsWith("/")) p = `/${p}`;
    if (!p.endsWith(".md")) p = `${p}.md`;
    return p;
  })
  .refine((p) => p.length <= MAX_PATH_LENGTH, "path is too long")
  .refine(
    (p) => p.slice(1).split("/").every((s) => SEGMENT.test(s)),
    "path segments may only contain a-z, 0-9, '.', '_' and '-', and must not start with '.'",
  );

/** A prefix for list_memories, e.g. `/writing` or `/writing/`. No `.md` added. */
export const prefixSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .transform((raw) => {
    let p = raw.trim().toLowerCase().replace(/\/+/g, "/");
    if (!p.startsWith("/")) p = `/${p}`;
    return p;
  })
  .refine((p) => /^\/[a-z0-9._\/-]*$/.test(p), "invalid prefix");

export const descriptionSchema = z
  .string()
  .transform((d) => d.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1, "description is required").max(300));

export const sourceSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, "source must be a short client name such as 'claude'"));

export const tagsSchema = z
  .array(z.string())
  .max(20)
  .transform((tags) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))])
  .pipe(z.array(z.string().max(50)));

export const querySchema = z
  .string()
  .transform((q) => q.trim())
  .pipe(z.string().min(1, "query is required").max(500));

export const limitSchema = z.number().int().min(1).max(50);

export function bodySchema(maxBytes: number) {
  return z
    .string()
    .refine((b) => byteLength(b) <= maxBytes, `body exceeds ${maxBytes} bytes`);
}

export function nonEmptyBodySchema(maxBytes: number) {
  return z
    .string()
    .refine((b) => b.trim().length > 0, "content is required")
    .refine((b) => byteLength(b) <= maxBytes, `content exceeds ${maxBytes} bytes`);
}

/** Format a ZodError as a short, client-readable message. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/**
 * If the body has no YAML frontmatter, prepend one following the memory-file
 * convention (name + description), so every stored memory is a well-formed
 * markdown file.
 */
export function ensureFrontmatter(path: string, description: string, body: string): string {
  if (body.trimStart().startsWith("---")) return body;
  const name = path.split("/").pop()!.replace(/\.md$/, "");
  const desc = description.replace(/"/g, '\\"');
  const rest = body.trim();
  return `---\nname: ${name}\ndescription: "${desc}"\n---\n${rest ? `\n${rest}\n` : ""}`;
}
