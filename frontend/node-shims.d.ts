declare const process: { env: Record<string, string | undefined> };
declare const __TAFO_REV__: string;
declare const __TAFO_SLICE2__: string;

declare module "node:child_process" {
  export function execSync(command: string, options: { encoding: "utf8" }): string;
}
