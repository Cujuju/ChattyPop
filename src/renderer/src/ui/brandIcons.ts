import youtube from 'simple-icons/icons/youtube.svg?raw';
import reddit from 'simple-icons/icons/reddit.svg?raw';
import x from 'simple-icons/icons/x.svg?raw';
import instagram from 'simple-icons/icons/instagram.svg?raw';
import bluesky from 'simple-icons/icons/bluesky.svg?raw';
import tiktok from 'simple-icons/icons/tiktok.svg?raw';
import twitch from 'simple-icons/icons/twitch.svg?raw';
import threads from 'simple-icons/icons/threads.svg?raw';
import github from 'simple-icons/icons/github.svg?raw';
import gitlab from 'simple-icons/icons/gitlab.svg?raw';
import bitbucket from 'simple-icons/icons/bitbucket.svg?raw';
import stackoverflow from 'simple-icons/icons/stackoverflow.svg?raw';
import npm from 'simple-icons/icons/npm.svg?raw';
import huggingface from 'simple-icons/icons/huggingface.svg?raw';
import imgur from 'simple-icons/icons/imgur.svg?raw';
import giphy from 'simple-icons/icons/giphy.svg?raw';
import vimeo from 'simple-icons/icons/vimeo.svg?raw';
import pinterest from 'simple-icons/icons/pinterest.svg?raw';
import spotify from 'simple-icons/icons/spotify.svg?raw';
import soundcloud from 'simple-icons/icons/soundcloud.svg?raw';
import bandcamp from 'simple-icons/icons/bandcamp.svg?raw';
import applemusic from 'simple-icons/icons/applemusic.svg?raw';
import ebay from 'simple-icons/icons/ebay.svg?raw';
import etsy from 'simple-icons/icons/etsy.svg?raw';
import aliexpress from 'simple-icons/icons/aliexpress.svg?raw';
import steam from 'simple-icons/icons/steam.svg?raw';
import epicgames from 'simple-icons/icons/epicgames.svg?raw';
import gogdotcom from 'simple-icons/icons/gogdotcom.svg?raw';
import itchdotio from 'simple-icons/icons/itchdotio.svg?raw';
import facebook from 'simple-icons/icons/facebook.svg?raw';
import tumblr from 'simple-icons/icons/tumblr.svg?raw';
import mastodon from 'simple-icons/icons/mastodon.svg?raw';
import patreon from 'simple-icons/icons/patreon.svg?raw';
import kofi from 'simple-icons/icons/kofi.svg?raw';
import substack from 'simple-icons/icons/substack.svg?raw';
import discord from 'simple-icons/icons/discord.svg?raw';
import telegram from 'simple-icons/icons/telegram.svg?raw';
import medium from 'simple-icons/icons/medium.svg?raw';
import wikipedia from 'simple-icons/icons/wikipedia.svg?raw';
import imdb from 'simple-icons/icons/imdb.svg?raw';
import goodreads from 'simple-icons/icons/goodreads.svg?raw';
import googledrive from 'simple-icons/icons/googledrive.svg?raw';
import dropbox from 'simple-icons/icons/dropbox.svg?raw';
import notion from 'simple-icons/icons/notion.svg?raw';

/** The package's SVG files contain one filled 24-unit path. */
function pathOf(svg: string): string {
  const path = /<path\b[^>]*\bd="([^"]+)"/.exec(svg)?.[1];
  if (!path) throw new Error('Brand SVG has no path.');
  return path;
}

/** Archive host names and aliases; each mark imports only its own SVG. */
export const BRAND_PATHS: Readonly<Record<string, string>> = {
  'youtube.com': pathOf(youtube),
  'youtu.be': pathOf(youtube),
  'youtube-nocookie.com': pathOf(youtube),
  'reddit.com': pathOf(reddit),
  'redd.it': pathOf(reddit),
  'x.com': pathOf(x),
  'twitter.com': pathOf(x),
  't.co': pathOf(x),
  'fxtwitter.com': pathOf(x),
  'vxtwitter.com': pathOf(x),
  'instagram.com': pathOf(instagram),
  'instagr.am': pathOf(instagram),
  'bsky.app': pathOf(bluesky),
  'bsky.social': pathOf(bluesky),
  'tiktok.com': pathOf(tiktok),
  'twitch.tv': pathOf(twitch),
  'threads.com': pathOf(threads),
  'threads.net': pathOf(threads),
  'github.com': pathOf(github),
  'github.io': pathOf(github),
  'githubusercontent.com': pathOf(github),
  'gitlab.com': pathOf(gitlab),
  'bitbucket.org': pathOf(bitbucket),
  'stackoverflow.com': pathOf(stackoverflow),
  'stackexchange.com': pathOf(stackoverflow),
  'npmjs.com': pathOf(npm),
  'huggingface.co': pathOf(huggingface),
  'imgur.com': pathOf(imgur),
  'giphy.com': pathOf(giphy),
  'vimeo.com': pathOf(vimeo),
  'pinterest.com': pathOf(pinterest),
  'pin.it': pathOf(pinterest),
  'spotify.com': pathOf(spotify),
  'spotify.link': pathOf(spotify),
  'soundcloud.com': pathOf(soundcloud),
  'bandcamp.com': pathOf(bandcamp),
  'music.apple.com': pathOf(applemusic),
  'ebay.com': pathOf(ebay),
  'ebay.co.uk': pathOf(ebay),
  'etsy.com': pathOf(etsy),
  'aliexpress.com': pathOf(aliexpress),
  'steampowered.com': pathOf(steam),
  'steamcommunity.com': pathOf(steam),
  'epicgames.com': pathOf(epicgames),
  'gog.com': pathOf(gogdotcom),
  'itch.io': pathOf(itchdotio),
  'facebook.com': pathOf(facebook),
  'fb.com': pathOf(facebook),
  'fb.watch': pathOf(facebook),
  'tumblr.com': pathOf(tumblr),
  'mastodon.social': pathOf(mastodon),
  'mastodon.online': pathOf(mastodon),
  'patreon.com': pathOf(patreon),
  'ko-fi.com': pathOf(kofi),
  'substack.com': pathOf(substack),
  'discord.com': pathOf(discord),
  'discord.gg': pathOf(discord),
  'discordapp.com': pathOf(discord),
  'telegram.org': pathOf(telegram),
  't.me': pathOf(telegram),
  'medium.com': pathOf(medium),
  'wikipedia.org': pathOf(wikipedia),
  'wikimedia.org': pathOf(wikipedia),
  'imdb.com': pathOf(imdb),
  'goodreads.com': pathOf(goodreads),
  'drive.google.com': pathOf(googledrive),
  'dropbox.com': pathOf(dropbox),
  'notion.so': pathOf(notion),
  'notion.site': pathOf(notion),
};

/** Exact hosts win; otherwise remove leading labels until a parent is known. */
export function brandPath(domain: string): string | undefined {
  let host = domain.toLowerCase();
  while (host) {
    if (Object.hasOwn(BRAND_PATHS, host)) return BRAND_PATHS[host];
    const dot = host.indexOf('.');
    if (dot < 0) return undefined;
    host = host.slice(dot + 1);
  }
  return undefined;
}
