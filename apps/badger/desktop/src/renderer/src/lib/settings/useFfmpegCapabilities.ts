import { useEffect, useState } from "react";
import { getFfmpegCapabilities, testFfmpegEncoder, type FfmpegCapability } from "@/lib/ffmpegCapabilities";

/**
 * Encapsulates the ffmpeg / GPU capability probe + quick-test + diagnostics
 * loaders, plus their loading flags — previously inline in the Settings God
 * component alongside a language dropdown. Keeps the low-level encoder-string
 * concern out of the presentational section.
 */
export function useFfmpegCapabilities() {
  const [caps, setCaps] = useState<FfmpegCapability | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  useEffect(() => {
    if (!window.sf?.getFfmpegCapabilities) return;
    let disposed = false;
    setCapsLoading(true);
    getFfmpegCapabilities()
      .then((next) => {
        if (!disposed && next) setCaps(next);
      })
      .finally(() => {
        if (!disposed) setCapsLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const runTest = async () => {
    if (!window.sf?.testFfmpegEncoder) return;
    setTestLoading(true);
    await testFfmpegEncoder(caps?.preferredEncoder)
      .then(() => getFfmpegCapabilities())
      .then((next) => {
        if (next) setCaps(next);
      })
      .finally(() => setTestLoading(false));
  };

  const loadDiagnostics = async () => {
    if (!window.sf?.getFfmpegCapabilities) return;
    setDiagnosticsLoading(true);
    await getFfmpegCapabilities()
      .then((next) => {
        if (next) setCaps(next);
      })
      .finally(() => setDiagnosticsLoading(false));
    setShowDiagnostics(true);
  };

  const canTest = Boolean(window.sf?.testFfmpegEncoder);
  const canDiagnose = Boolean(window.sf?.getFfmpegCapabilities);

  return {
    caps,
    capsLoading,
    testLoading,
    diagnosticsLoading,
    showDiagnostics,
    runTest,
    loadDiagnostics,
    canTest,
    canDiagnose,
  };
}
