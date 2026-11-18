module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // React Compiler must run FIRST so subsequent transforms see compiled output.
    // react-native-reanimated/plugin must remain LAST per its own docs.
    'babel-plugin-react-compiler',
    '@babel/plugin-transform-export-namespace-from',
    // Inlines the build-time SF_DEV_TICKET_KEY flag (META-ANON-06); see the plugin file.
    './babel-plugin-dev-ticket-key',
    'react-native-reanimated/plugin',
  ],
  overrides: [
    {
      include: /packages\/(shared|library-db)\//,
      presets: [
        [
          '@babel/preset-typescript',
          {
            allowDeclareFields: true,
            onlyRemoveTypeImports: true,
          },
        ],
      ],
    },
  ],
};
