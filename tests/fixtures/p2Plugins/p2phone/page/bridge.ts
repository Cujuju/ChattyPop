// Stands in for the preload: installs the phone's renderer API before the page renders.
import { createPhoneRendererApi, installRendererApi } from '@plugin-sdk/renderer/shell';

/** The page's media files' path on the desktop's server. */
const MEDIA_ROOT = '/media/';

installRendererApi(
  createPhoneRendererApi({ call: () => Promise.reject(new Error('Fixture: no desktop.')), listen: () => undefined }),
  MEDIA_ROOT,
);
