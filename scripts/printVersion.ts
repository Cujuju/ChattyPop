// Prints this checkout's version (appVersion.ts): `node scripts/runTs.mjs scripts/printVersion.ts`. A release's tag is
// `v` and this version.
import { appVersion } from '../appVersion';

export function main(): number {
  console.log(appVersion(process.cwd()));
  return 0;
}
