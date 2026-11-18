module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    '@babel/plugin-transform-export-namespace-from',
    // Inlines the build-time PARROT_API_BASE_URL (dev-stack test builds only); see the plugin file.
    './babel-plugin-api-base-url',
    // Reanimated's worklets (the shared starry sky, UX-SKY-01); must stay last.
    'react-native-worklets/plugin',
  ],
  overrides: [
    {
      include: /packages\/(shared|library-db-definition|mobile-shell|mobile-media-proxy|mobile-audio-playback|sdk)\//,
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
