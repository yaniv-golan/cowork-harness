export interface PluginPathRewrite {
  hostPath: string;
  vmPath: string;
}
export interface RewritePluginInput {
  vmPath: string;
  stagedPath: string;
  installPath: string;
}
export function buildPluginPathRewrites(_input: {
  vmMntRoot: string;
  plugins: RewritePluginInput[];
  skills?: { hostDirs: string[] };
}): PluginPathRewrite[] {
  return [];
}
export function rewritePluginPaths(command: string, _rewrites: readonly PluginPathRewrite[]): string {
  return command;
}
