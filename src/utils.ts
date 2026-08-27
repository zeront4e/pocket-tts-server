import { join } from "path";

let uvPath: string | null = null;

export function getUvPath(): string {
  if (uvPath) return uvPath;
  
  const candidates = [
    join(Bun.env.HOME ?? "/home/gpbu", ".local/bin/uv"),
    "/usr/local/bin/uv",
    "/usr/bin/uv",
  ];
  
  for (const c of candidates) {
    if (Bun.file(c).size > 0) {
      uvPath = c;

      return c;
    }
  }

  uvPath = "uv";

  return "uv";
}

export function runUv(args: string[]): string[] {
  return [getUvPath(), "run", ...args];
}
