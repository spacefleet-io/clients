// The QR scanner of the pairing screen (ACCT-PAIR-01). The Google-free Android build (SF_FOSS=1) has none: its scanner,
// react-native-camera-kit, links Google's ML Kit, so Metro takes qrScanner.foss.ts there (foss.cjs) and the screen
// asks for the typed code only.
export { Camera, CameraType } from "react-native-camera-kit";

/** Whether this build can scan a QR code. */
export const qrScannerAvailable: boolean = true;
