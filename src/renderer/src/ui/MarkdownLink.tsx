// A Markdown link: opened outside the app, and only for http(s).
import { Show, type JSX } from 'solid-js';
import { isSafeMarkdownHref } from './mdParse';

/** Chat and attachment Markdown use the same external-link behavior and URL policy. */
export function MarkdownLink(props: { href: string; class?: string; children: JSX.Element }) {
  return (
    <Show when={isSafeMarkdownHref(props.href)} fallback={props.children}>
      <a class={props.class} href={props.href} target="_blank" rel="noreferrer" title={props.href}>
        {props.children}
      </a>
    </Show>
  );
}
