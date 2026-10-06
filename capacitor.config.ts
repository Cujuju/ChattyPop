import type { CapacitorConfig } from '@capacitor/cli';
import { SHELL_BUNDLE_ID, SHELL_USER_AGENT_TOKEN } from './src/shared/shell.ts';

const config: CapacitorConfig = {
  appId: SHELL_BUNDLE_ID,
  appName: 'ChattyPop',
  webDir: 'mobile/www',
  appendUserAgent: SHELL_USER_AGENT_TOKEN,
  server: { errorPath: 'offline.html' },
  // Default dark backdrop visible around the keyboard’s rounded corners.
  ios: { contentInset: 'never', backgroundColor: '#090b10' },
  // Foreground pushes show banners with sound. ShellViewController publishes keyboard insets to the page.
  plugins: { Keyboard: { resize: 'none' }, PushNotifications: { presentationOptions: ['alert', 'sound'] } },
};
export default config;
