// The page's entry: the bridge installs first, then the shell starts the page once the registry installs.
import './bridge';
import { startPage } from '@plugin-sdk/renderer/shell';
import styles from './Page.module.css';

startPage(() => <main class={styles.page} />);
