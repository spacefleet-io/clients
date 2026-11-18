import type { Env } from "@space/desktop-platform-contract";

/** The key of `name` in `env`, ignoring case (Windows variable names are case-insensitive: `Path`, `PATH`). An exact match wins. */
export const findEnvKey = (env: Env, name: string): string | undefined => {
  if (name in env) return name;
  const lower = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lower);
};

/** Value of `name` in `env`, ignoring case. */
export const readEnv = (env: Env, name: string): string | undefined => {
  const key = findEnvKey(env, name);
  return key === undefined ? undefined : env[key];
};
