export declare const DEVELOPER_ID_INTERMEDIATE_CERT: string;
export declare const walkFiles: (dir: string) => string[];
export declare const sha256: (file: string) => Promise<string>;
export declare const sourcemapArchiveFiles: (outDir: string, appDir: string) => string[];
export declare const absentArtifacts: (patterns: RegExp[], names: string[]) => RegExp[];

type PackageTarget = {
  id: string;
  builderFlag: string;
  arch: string;
  unpackedDir: string;
  artifactPatterns: RegExp[];
  locales: { subpath: string; languages: readonly string[]; extension: string };
};
type Run = (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }) => void;

export declare function createPackageRun(o: { appDir: string; target: PackageTarget; testBuild: boolean; runEnv?: Record<string, string> }): {
  tag: string;
  repoRoot: string;
  distDir: string;
  windowsSigning: { configured: boolean } | null;
  macSigning: { configured: boolean } | null;
  step: (name: string, fn: () => unknown) => Promise<void>;
  run: Run;
  capture: (command: string, args: string[]) => string;
  assertLinuxTools: (formats: readonly string[], hint?: string) => void;
  symbols: (o: { project: string }) => Promise<void>;
  electronBuilder: (o?: { env?: Record<string, string> }) => Promise<void>;
  verifyLocales: () => void;
  signatures: () => Promise<void>;
  notarize: () => Promise<void>;
  report: (o?: { artifactPatterns?: RegExp[]; extra?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
};
