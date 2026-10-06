// Prints appVersion for this checkout; release tags prepend v.
import { appVersion } from '../appVersion';

export function main(): number {
  console.log(appVersion(process.cwd()));
  return 0;
}
