export declare const TEST_BUILD_FLAG: "--test-build";
export declare const TEST_BUILD_ENV: "SF_PACKAGE_TEST_BUILD";

export declare const testBuildVersion: (version: string) => string;
export declare const isTestBuildVersion: (version: string) => boolean;
export declare const packageBuildEnv: (o: { testBuild: boolean; env: Record<string, string | undefined> }) => { VITE_SF_DEV_TICKET_KEY: string };
