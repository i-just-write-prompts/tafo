import type { Meta } from "../types";

declare const __TAFO_SLICE2__: string;

/** Slice 2 UI ships when the build flag or server meta agrees. */
export function slice2Enabled(meta: Meta | null): boolean {
  const build = typeof __TAFO_SLICE2__ !== "undefined" && __TAFO_SLICE2__ === "1";
  const server = Boolean(meta?.features?.slice2);
  return build || server;
}
