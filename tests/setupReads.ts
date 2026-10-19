// Core's entry names the read helper in the app; tests use the entries tests/globalSetup.ts builds.
import { join } from 'node:path';
import { setArchiveReadEntry } from '../src/core/reads/helperEntry';

setArchiveReadEntry(join(import.meta.dirname, '../out/read-tests/archiveReadProcess.js'));
