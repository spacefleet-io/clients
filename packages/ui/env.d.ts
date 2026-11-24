// Only for this package's own typecheck: the shared profile avatars (`@space/profile-avatars/web`) import webp files,
// which each app's Vite client types declare for the apps that import them. Until #3350 S12 this package borrowed two
// apps' env typings for it.
declare module "*.webp" {
  const url: string;
  export default url;
}
