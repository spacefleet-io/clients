import React, { useMemo } from "react";
import Svg, { Path, Rect } from "react-native-svg";
import { encodeQr, qrPathData, qrViewSize } from "./pairing/qrMatrix";

/** Black modules on a white square with its quiet zone, the contrast phone cameras need, drawn as one path. */
export const QrCode = ({ payload, size, label }: { payload: string; size: number; label: string }) => {
  const drawing = useMemo(() => {
    const matrix = encodeQr(payload);
    return { path: qrPathData(matrix), view: qrViewSize(matrix) };
  }, [payload]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${drawing.view} ${drawing.view}`} accessibilityLabel={label}>
      <Rect x={0} y={0} width={drawing.view} height={drawing.view} fill="#ffffff" />
      <Path d={drawing.path} fill="#000000" />
    </Svg>
  );
};
