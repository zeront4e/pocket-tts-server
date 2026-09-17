/*
Copyright 2026 zeront4e (https://github.com/zeront4e)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

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
