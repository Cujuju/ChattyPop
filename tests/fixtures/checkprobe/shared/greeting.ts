export interface Calls {
  greet(name: string): string;
}

export const greeting = (name: string): string => `Hello, ${name}`;
