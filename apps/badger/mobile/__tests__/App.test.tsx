/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('react-native', () => {
  const ReactLib = require('react');
  return {
    StatusBar: () => null,
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactLib.createElement('Text', null, children),
    TextInput: ({ children }: { children?: React.ReactNode }) =>
      ReactLib.createElement('TextInput', null, children),
  };
});

jest.mock('react-native-screens', () => ({
  enableScreens: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../src/navigation/AppNavigator', () => ({
  AppNavigator: () => null,
}));

jest.mock('../src/store/auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../src/store/library', () => ({
  LibraryProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../src/components/LoadingModalProvider', () => ({
  LoadingModalProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../src/components/MetadataTicketsController', () => ({
  MetadataTicketsController: () => null,
}));

jest.mock('../src/lib/apiConfig', () => ({
  initApiConfig: jest.fn(async () => undefined),
}));

jest.mock('../src/lib/appSettings', () => ({
  loadAppSettings: jest.fn(async () => undefined),
}));

// The real shell components paint the sky with `StyleSheet.create` at module load, which the react-native mock above
// leaves out: the smoke test mocks every shell module App imports, as it mocks its own providers.
jest.mock('@space/mobile-shell/components', () => ({
  MobileSkyModeProvider: ({ children }: { children: unknown }) => children,
  MobileSkyLayer: ({ children }: { children: unknown }) => children,
}));

jest.mock('@space/mobile-shell/render-boundary', () => ({
  MobileRenderBoundary: ({ children }: { children: unknown }) => children,
}));

jest.mock('@space/mobile-shell/account-language-prompt', () => ({
  AccountLanguagePromptHost: () => null,
}));

// REL-UPD-06: the self-update dialogs import the shell's setup step (lucide icons, native modules); a shell module like
// the others above.
jest.mock('@space/mobile-self-update', () => ({
  SelfUpdateConsent: () => null,
  SelfUpdateDialog: () => null,
  startSelfUpdate: jest.fn(async () => undefined),
}));

jest.mock('../src/lib/skyMode', () => ({
  loadLowRamDevice: jest.fn(async () => false),
  useSkyMode: () => 'animated',
}));

jest.mock('../src/lib/uiLanguage', () => ({
  ensureI18n: jest.fn(async () => undefined),
}));

const App = require('../App').default;

// Dump-on-failure: print which providers/navigators are mocked + the render
// error so a smoke-test crash points straight at the offending dependency.
// try/catch so a dump failure can't mask the real render error.
const dumpAppRenderSnapshot = (label: string, err: unknown) => {
  try {
    const mocked = [
      'react-native-gesture-handler',
      'react-native',
      'react-native-screens',
      'react-native-safe-area-context',
      'AppNavigator',
      'AuthProvider',
      'LibraryProvider',
      'LoadingModalProvider',
      'apiConfig.initApiConfig',
    ];
    console.error(`=== [app-test:${label}] snapshot ===`);
    console.error(`mocked dependencies: ${JSON.stringify(mocked)}`);
    console.error(`App export type=${typeof App}`);
    console.error(`render error: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`);
  } catch (dumpErr) {
    console.error(`(snapshot failed: ${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)})`);
  }
};

test('renders correctly', async () => {
  console.info('[app-test:render] mounting <App /> with mocked providers/navigators');
  try {
    await ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<App />);
    });
    console.info('[app-test:render] <App /> mounted without throwing');
  } catch (err) {
    dumpAppRenderSnapshot('render', err);
    throw err;
  }
});
