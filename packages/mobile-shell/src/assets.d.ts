declare module "*.png" {
  const source: import("react-native").ImageSourcePropType;
  export default source;
}
// The profile avatar pack's pictures (`@space/profile-avatars/native`, ACCT-PROF-05), bundled by Metro like the PNGs.
declare module "*.webp" {
  const source: import("react-native").ImageSourcePropType;
  export default source;
}
