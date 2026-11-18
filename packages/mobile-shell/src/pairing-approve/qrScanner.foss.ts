// qrScanner.ts in the Google-free Android build (SF_FOSS=1, foss.cjs): no scanner, so react-native-camera-kit (and the
// ML Kit it links) stays out of the app. The pairing screen never renders this Camera: it asks for the typed code.
export const Camera = (_props: Record<string, unknown>): null => null;
export const CameraType = { Back: "back", Front: "front" } as const;

/** Whether this build can scan a QR code. */
export const qrScannerAvailable: boolean = false;
