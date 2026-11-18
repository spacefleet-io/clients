/**
 * The generated fetch client names the global `BodyInit`, which only exists with the DOM lib.
 * Programs that compile with `bun-types` and no DOM lib get `Bun.BodyInit` under that name; where
 * the DOM lib is present the real one wins (`skipLibCheck` skips this declaration file).
 */
declare type BodyInit = Bun.BodyInit;
