declare const process: { env: Record<string, string | undefined> };

declare module "node:child_process" {
  export function execSync(command: string, options: { encoding: "utf8" }): string;
}
