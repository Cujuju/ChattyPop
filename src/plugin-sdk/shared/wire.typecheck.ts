// Compile-time wire probe requires WireValue phone payloads and write declarations with decoders for writing core calls.
import { defineChannels, type Decoder, type IsWire } from '@plugin-sdk/shared';

interface Row {
  id: number;
  bytes: Uint8Array;
  note?: string;
  tags: readonly string[];
}
interface Calls {
  read(id: number): Row | null;
  write(ids: number[], note?: string): void;
  run(): Promise<Row[]>;
  dated(): Date;
  mapped(): Map<string, number>;
  callback(fn: () => void): void;
  loose(): unknown;
}
interface Events {
  changed: null;
  row: Row;
  at: Date;
}

const decodeWrite: Decoder<Parameters<Calls['write']>> = ([ids, note]) => [ids as number[], note as string | undefined];

export const wireShapes: [IsWire<Row>, IsWire<void>, IsWire<Date>, IsWire<Map<string, number>>, IsWire<unknown>, IsWire<() => void>] = [true, true, false, false, false, false];

export const phoneChannels = defineChannels<{ core: Calls; events: Events }>()({
  core: {
    read: { audiences: ['renderer', 'phone'], writes: false },
    write: { audiences: ['renderer', 'phone'], writes: true, decode: decodeWrite },
    run: { audiences: ['phone'], writes: false },
    // Not the phone's: structured clone carries these.
    dated: ['renderer'],
    mapped: ['renderer', 'main'],
    callback: ['main'],
    loose: ['renderer'],
  },
  events: { changed: ['renderer', 'phone'], row: ['phone'], at: ['renderer', 'main'] },
});

export const refused = [
  defineChannels<{ core: Calls }>()({
    core: {
      read: { audiences: ['phone'], writes: false },
      // @ts-expect-error A call the phone may make states whether it writes.
      write: ['renderer', 'phone'],
      run: ['renderer'],
      dated: ['renderer'],
      mapped: ['renderer'],
      callback: ['renderer'],
      loose: ['renderer'],
    },
  }),
  defineChannels<{ core: Calls }>()({
    core: {
      read: { audiences: ['phone'], writes: false },
      // @ts-expect-error One that writes needs a decoder.
      write: { audiences: ['phone'], writes: true },
      run: ['renderer'],
      dated: ['renderer'],
      mapped: ['renderer'],
      callback: ['renderer'],
      loose: ['renderer'],
    },
  }),
  defineChannels<{ core: Calls }>()({
    core: {
      read: ['renderer'],
      write: ['renderer'],
      run: ['renderer'],
      // @ts-expect-error A Date result isn't a WireValue.
      dated: { audiences: ['phone'], writes: false },
      // @ts-expect-error Nor a Map.
      mapped: { audiences: ['phone'], writes: false },
      // @ts-expect-error Nor a function argument.
      callback: { audiences: ['phone'], writes: false },
      // @ts-expect-error Nor unknown.
      loose: { audiences: ['phone'], writes: false },
    },
  }),
  defineChannels<{ events: Events }>()({
    // @ts-expect-error A Date payload isn't a WireValue.
    events: { changed: ['phone'], row: ['phone'], at: ['phone'] },
  }),
];
