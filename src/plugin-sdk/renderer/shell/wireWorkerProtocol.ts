import type { WireValue } from '@shared/wire';

export type DecodeFormat = 'wire' | 'json';
export interface WireDecodeRequest {
  id: number;
  text: string;
  format: DecodeFormat;
}
export type WireDecodeReply =
  | { id: number; ok: true; value: WireValue }
  | { id: number; ok: false; error: string };
