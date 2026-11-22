// The apps' real icons (`./assets/*.png`), bundled by Vite in each app's window as a URL.
declare module "*.png" {
  const src: string;
  export default src;
}
