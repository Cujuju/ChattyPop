// A Markdown link: opened outside the app, and only for http(s).
import { Show, useContext, type JSX } from 'solid-js';
import { linkSpoilerKey } from '@shared/localSpoilers';
import { SenderSpoiler, SpoilerMessage } from './spoilers';
import { LocalSpoiler } from './LocalSpoiler';
import { isSafeMarkdownHref } from './mdParse';

/** Chat and attachment Markdown use the same external-link behavior and URL policy. */
export function MarkdownLink(props: { href: string; class?: string; children: JSX.Element }) {
  const message = useContext(SpoilerMessage);
  const senderSpoiler = useContext(SenderSpoiler);
  const key = () => message() ? linkSpoilerKey(message()!.id, props.href) : null;
  return (
    <Show when={isSafeMarkdownHref(props.href)} fallback={props.children}>
      <LocalSpoiler spoilerKey={key()} senderSpoiler={senderSpoiler} inline label="link">
        <a class={props.class} href={props.href} target="_blank" rel="noreferrer" title={props.href}>{props.children}</a>
      </LocalSpoiler>
    </Show>
  );
}
