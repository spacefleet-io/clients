// Only for this package's own typecheck: each app's bundler types (Vite's client types, React Native's globals) give
// these to the apps that import the entries.
declare module "*.webp" {
  const url: string;
  export default url;
}
declare function require(path: string): unknown;
