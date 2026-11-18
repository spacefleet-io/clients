/** Our patch branch of one library version in its fork: `sf/<version>`; its tip is the commit the build pins. */
export const sfBranchName = (version: string): string => `sf/${version.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
