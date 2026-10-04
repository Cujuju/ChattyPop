import { createMemo } from 'solid-js';
import { encode } from 'uqr';
import styles from './QrCode.module.css';

/** Light margin the QR spec requires around the code, in modules; scanners fail without it. */
const QUIET_ZONE_MODULES = 4;
/** Level M survives ~15% damage (screen glare, moiré) and keeps a URL-sized code small. */
const ERROR_CORRECTION = 'M';

/** `text` as a QR code: one SVG path of the dark modules on a light square. Colours and size come from QrCode.module.css. */
export function QrCode(props: { text: string; label: string }) {
  const qr = createMemo(() => encode(props.text, { border: QUIET_ZONE_MODULES, ecc: ERROR_CORRECTION }));
  const path = () => qr().data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : ''))).join('');
  return (
    <svg class={styles.qr} viewBox={`0 0 ${qr().size} ${qr().size}`} role="img" aria-label={props.label} shape-rendering="crispEdges">
      <rect class={styles.light} width={qr().size} height={qr().size} />
      <path class={styles.dark} d={path()} />
    </svg>
  );
}
