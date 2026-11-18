// Metro side of the phone and TV apps' source maps (REL-LOG-06). A release built with SF_ERROR_REPORT_SOURCEMAPS=1
// gets @sentry/react-native's Metro plugin, which puts a debug ID into the bundle and its source map;
// `bun scripts/bugsink-sourcemaps.ts upload-hermes` then uploads the map to Bugsink, which matches a report by that ID.
// Everything else the plugin can add (dev-server middleware, options file, web replay/feedback) is off, and every other
// build does not load the plugin at all. The plugin is resolved from the app, which owns @sentry/react-native.
// CommonJS: metro.config.js files are plain Node modules.
function withErrorReportSourcemaps(config, appDir) {
  if (process.env.SF_ERROR_REPORT_SOURCEMAPS !== '1') return config;
  const { withSentryConfig } = require(require.resolve('@sentry/react-native/metro', { paths: [appDir] }));
  return withSentryConfig(config, {
    enableSourceContextInDevelopment: false,
    optionsFile: false,
    includeWebReplay: false,
    includeWebFeedback: false,
  });
}

module.exports = { withErrorReportSourcemaps };
