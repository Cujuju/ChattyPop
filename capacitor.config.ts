import type { CapacitorConfig } from '@capacitor/cli';
import { SHELL_BUNDLE_ID, SHELL_USER_AGENT_TOKEN } from './src/shared/shell.ts';

const config: CapacitorConfig = {
  appId: SHELL_BUNDLE_ID,
  appName: 'ChattyPop',
  webDir: 'mobile/www',
  appendUserAgent: SHELL_USER_AGENT_TOKEN,
  server: { errorPath: 'offline.html' },
  // The default dark theme's ground: the native window behind the web view shows in the keyboard's rounded corners.
  ios: { contentInset: 'never', backgroundColor: '#090b10' },
  // Pushes show as banners with sound while the app is open too, as the web app's do.
  // The shell's controller resizes the web view for the keyboard, in step with it (ShellViewController.swift).
  plugins: { Keyboard: { resize: 'none' }, PushNotifications: { presentationOptions: ['alert', 'sound'] } },
};
export default config;
