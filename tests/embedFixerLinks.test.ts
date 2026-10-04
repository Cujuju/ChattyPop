import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/core/derive/links';

describe('one URL per post', () => {
  it('slug, subreddit, short link and fixer mirrors are one post', () => {
    const canonical = normalizeUrl('https://www.reddit.com/comments/1abc2de');
    for (const form of [
      'https://www.reddit.com/r/example/comments/1abc2de/an_example_post_title/',
      'https://reddit.com/r/example/comments/1abc2de',
      'https://old.reddit.com/r/example/comments/1ABC2DE/x/?utm_source=share',
      'https://vxreddit.com/r/example/comments/1abc2de',
      'https://rxddit.com/r/example/comments/1abc2de',
      'https://redd.it/1abc2de',
    ]) {
      expect(normalizeUrl(form)).toBe(canonical);
    }
    expect(normalizeUrl('https://a.tnktok.com/ZN0aB1cDE')).toBe(normalizeUrl('https://vm.tiktok.com/ZN0aB1cDE'));
    expect(normalizeUrl('https://eeinstagram.com/reel/Ab1cD2eF3gH')).toBe(normalizeUrl('https://www.instagram.com/reel/Ab1cD2eF3gH/?igsh=abc'));
    // A subreddit link is not a post.
    expect(normalizeUrl('https://reddit.com/r/example')).toBe('https://www.reddit.com/r/example');
  });
});
